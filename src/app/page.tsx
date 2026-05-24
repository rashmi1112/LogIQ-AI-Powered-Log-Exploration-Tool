import Link from "next/link";
import { auth } from "@/auth";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/logo";
import { ArrowRight, FileText, GitBranch, ShieldCheck, Workflow } from "lucide-react";

export default async function HomePage() {
  const session = await auth();

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b">
        <div className="container flex h-14 items-center justify-between">
          <Logo />
          <nav className="flex items-center gap-2">
            {session ? (
              <Button asChild size="sm">
                <Link href="/dashboard">Open dashboard</Link>
              </Button>
            ) : (
              <Button asChild size="sm">
                <Link href="/login">Sign in</Link>
              </Button>
            )}
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <section className="container py-20 md:py-28">
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 rounded-full border bg-muted/40 px-3 py-1 text-xs font-medium text-muted-foreground mb-6">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Context-aware log investigation
            </div>
            <h1 className="text-4xl md:text-6xl font-semibold tracking-tight leading-[1.05]">
              Investigate incidents with{" "}
              <span className="bg-gradient-to-r from-indigo-500 to-purple-600 bg-clip-text text-transparent">
                logs and context
              </span>{" "}
              in one workspace.
            </h1>
            <p className="mt-6 text-lg text-muted-foreground max-w-2xl leading-relaxed">
              LogIQ analyzes large CSV log bundles alongside Jira tickets, customer notes, and runbooks. It surfaces what
              happened, where it failed, and what evidence supports each hypothesis — with citations to every log line it
              uses.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild size="lg">
                <Link href={session ? "/dashboard" : "/login"}>
                  {session ? "Go to dashboard" : "Get started"} <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link href="#how-it-works">How it works</Link>
              </Button>
            </div>
          </div>
        </section>

        <section id="how-it-works" className="border-t bg-muted/20">
          <div className="container py-16 md:py-24">
            <div className="max-w-2xl mb-12">
              <h2 className="text-3xl font-semibold tracking-tight">How an investigation works</h2>
              <p className="mt-3 text-muted-foreground">
                Each incident is a scoped case workspace anchored to a manifest. LogIQ keeps your analysis grounded in
                the actual log evidence — no hallucinated details.
              </p>
            </div>
            <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
              <FeatureCard
                icon={<FileText className="h-5 w-5" />}
                title="1. Upload bundle"
                body="Drop in CSV logs, Jira summaries, runbooks, customer notes — and an optional manifest JSON to define scope."
              />
              <FeatureCard
                icon={<ShieldCheck className="h-5 w-5" />}
                title="2. Scope check"
                body="LogIQ validates files against the manifest and flags missing or extra artifacts so you never analyze the wrong bundle."
              />
              <FeatureCard
                icon={<Workflow className="h-5 w-5" />}
                title="3. Targeted retrieval"
                body="Errors, timeouts, exceptions, stack hints, and question-relevant lines are prioritized — not random sampling."
              />
              <FeatureCard
                icon={<GitBranch className="h-5 w-5" />}
                title="4. Evidence-backed answer"
                body="Get a timeline, hypotheses with citations to log lines, and prioritized next actions you can take."
              />
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t">
        <div className="container py-6 flex items-center justify-between text-sm text-muted-foreground">
          <Logo className="opacity-70" />
          <p>Built with Next.js, Claude, and Postgres.</p>
        </div>
      </footer>
    </div>
  );
}

function FeatureCard({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-lg border bg-card p-5">
      <div className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary mb-4">
        {icon}
      </div>
      <h3 className="font-semibold mb-1">{title}</h3>
      <p className="text-sm text-muted-foreground leading-relaxed">{body}</p>
    </div>
  );
}
