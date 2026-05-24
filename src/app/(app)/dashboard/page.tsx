import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatRelativeTime } from "@/lib/utils";
import { FileText, MessageSquare, Plus, FolderOpen } from "lucide-react";
import { DeleteCaseButton } from "./delete-case-button";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const cases = await prisma.case.findMany({
    where: { userId: session.user.id },
    orderBy: { updatedAt: "desc" },
    include: {
      _count: { select: { files: true, messages: true } },
    },
  });

  return (
    <div className="container py-8 md:py-12">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Your cases</h1>
          <p className="text-muted-foreground mt-1">
            {cases.length === 0
              ? "Create your first investigation to get started."
              : `${cases.length} ${cases.length === 1 ? "case" : "cases"} in your workspace.`}
          </p>
        </div>
        <Button asChild size="lg">
          <Link href="/cases/new">
            <Plus className="h-4 w-4" /> New case
          </Link>
        </Button>
      </div>

      {cases.length === 0 ? (
        <Card className="border-dashed p-12 text-center">
          <FolderOpen className="h-10 w-10 mx-auto text-muted-foreground mb-4" />
          <h2 className="text-lg font-semibold mb-2">No cases yet</h2>
          <p className="text-sm text-muted-foreground mb-6 max-w-md mx-auto">
            A case is one investigation workspace. Upload logs, context artifacts, and an optional
            manifest, then ask LogIQ questions about what happened.
          </p>
          <Button asChild>
            <Link href="/cases/new">
              <Plus className="h-4 w-4" /> Create first case
            </Link>
          </Button>
        </Card>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {cases.map((c) => (
            <Card key={c.id} className="group flex flex-col p-5 hover:border-primary/50 transition">
              <Link href={`/cases/${c.id}`} className="flex-1">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <h3 className="font-semibold leading-snug line-clamp-2 group-hover:text-primary transition">
                    {c.name}
                  </h3>
                </div>
                {(c.caseId || c.jobId) && (
                  <div className="flex flex-wrap gap-1.5 mb-3">
                    {c.caseId && (
                      <Badge variant="secondary" className="font-mono text-[10px]">
                        {c.caseId}
                      </Badge>
                    )}
                    {c.jobId && (
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {c.jobId}
                      </Badge>
                    )}
                  </div>
                )}
                {c.description && (
                  <p className="text-sm text-muted-foreground line-clamp-2 mb-4">{c.description}</p>
                )}
                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <FileText className="h-3.5 w-3.5" /> {c._count.files}
                  </span>
                  <span className="flex items-center gap-1">
                    <MessageSquare className="h-3.5 w-3.5" /> {c._count.messages}
                  </span>
                  <span className="ml-auto">{formatRelativeTime(c.updatedAt)}</span>
                </div>
              </Link>
              <div className="border-t mt-4 pt-3 flex justify-end">
                <DeleteCaseButton id={c.id} name={c.name} />
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
