import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { Button } from "@/components/ui/button";
import { ChevronLeft } from "lucide-react";
import { WorkspaceShell } from "./workspace-shell";

export const dynamic = "force-dynamic";

export default async function CaseWorkspacePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const { id } = await params;
  const caseRecord = await prisma.case.findUnique({
    where: { id },
    include: {
      files: { orderBy: { createdAt: "asc" } },
      messages: { orderBy: { createdAt: "asc" } },
    },
  });

  if (!caseRecord) notFound();
  if (caseRecord.userId !== session.user.id) redirect("/dashboard");

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="border-b">
        <div className="container py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <Button asChild variant="ghost" size="sm">
              <Link href="/dashboard">
                <ChevronLeft className="h-4 w-4" />
                Cases
              </Link>
            </Button>
            <div className="min-w-0">
              <h1 className="text-lg font-semibold tracking-tight truncate">{caseRecord.name}</h1>
              {caseRecord.description && (
                <p className="text-xs text-muted-foreground truncate">{caseRecord.description}</p>
              )}
            </div>
          </div>
        </div>
      </div>

      <WorkspaceShell caseRecord={caseRecord} />
    </div>
  );
}
