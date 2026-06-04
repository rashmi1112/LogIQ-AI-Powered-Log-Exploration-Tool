"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import type { Case, CaseFile, Message } from "@prisma/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FilesPanel } from "./files-panel";
import { ChatPanel } from "./chat-panel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  FileText,
  CheckCircle,
  Loader2,
  RefreshCw,
  Clock,
  Lightbulb,
  ListChecks,
  FileSearch,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { SubmitAnalysisInput as Analysis } from "@/lib/analysis/tools";

type CaseWithRelations = Case & { files: CaseFile[]; messages: Message[] };
type MessageMeta = Record<string, unknown> | null;

function readAnalysis(msg: Message): Analysis | undefined {
  const meta = msg.meta as MessageMeta;
  return meta?.analysis as Analysis | undefined;
}

function getSpecialMessage(messages: Message[], type: "report" | "resolution"): Message | undefined {
  return messages.find((m) => (m.meta as MessageMeta)?.type === type);
}

// ─── SSE streaming hook ──────────────────────────────────────────────────────

function useSSEStream(url: string) {
  const [streaming, setStreaming] = React.useState(false);
  const [text, setText] = React.useState("");
  const [analysis, setAnalysis] = React.useState<Analysis | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function start(body?: Record<string, unknown>) {
    setStreaming(true);
    setText("");
    setAnalysis(null);
    setError(null);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      if (!res.ok || !res.body) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? "Request failed");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const frames = pending.split("\n\n");
        pending = frames.pop() ?? "";
        for (const frame of frames) {
          const lines = frame.split("\n");
          let event = "message";
          let dataLine = "";
          for (const line of lines) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
          }
          if (!dataLine) continue;
          try {
            const data = JSON.parse(dataLine) as Record<string, unknown>;
            if (event === "delta") setText((t) => t + (data.text as string));
            else if (event === "analysis") setAnalysis(data as unknown as Analysis);
            else if (event === "error") setError(data.message as string);
          } catch { /* skip */ }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Streaming failed");
    } finally {
      setStreaming(false);
    }
  }

  return { streaming, text, analysis, error, start };
}

// ─── WorkspaceShell ──────────────────────────────────────────────────────────

export function WorkspaceShell({ caseRecord }: { caseRecord: CaseWithRelations }) {
  const router = useRouter();
  const [files, setFiles] = React.useState<CaseFile[]>(caseRecord.files);
  const [messages, setMessages] = React.useState<Message[]>(caseRecord.messages);

  const [reportOpen, setReportOpen] = React.useState(false);
  const [resolutionOpen, setResolutionOpen] = React.useState(false);

  const existingReport = getSpecialMessage(messages, "report");
  const existingResolution = getSpecialMessage(messages, "resolution");
  const hasChatMessages = messages.some((m) => {
    const meta = m.meta as MessageMeta;
    return !meta?.type || meta.type === "chat";
  });

  const report = useSSEStream(`/api/cases/${caseRecord.id}/report`);
  const resolution = useSSEStream(`/api/cases/${caseRecord.id}/resolution`);
  const [engineerNote, setEngineerNote] = React.useState("");

  async function generateReport() {
    setReportOpen(true);
    await report.start();
    router.refresh();
  }

  async function generateResolution() {
    await resolution.start({ engineerNote: engineerNote.trim() || undefined });
    router.refresh();
  }

  // Active analysis to display: live stream first, then persisted
  const reportAnalysis = report.analysis ?? (existingReport ? readAnalysis(existingReport) : null);
  const reportText = report.text || existingReport?.content || "";

  const resolutionText = resolution.text || existingResolution?.content || "";

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Action bar */}
      <div className="border-b bg-muted/20 px-4 py-2 flex items-center justify-end gap-2 shrink-0">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setResolutionOpen(true)}
          disabled={!hasChatMessages}
          className="gap-1.5"
        >
          <CheckCircle className="h-3.5 w-3.5" />
          {existingResolution ? "View Resolution" : "Generate Resolution"}
        </Button>
        <Button
          variant="default"
          size="sm"
          onClick={() => { setReportOpen(true); if (!existingReport && !report.streaming) generateReport(); }}
          disabled={files.length === 0}
          className="gap-1.5"
        >
          <FileText className="h-3.5 w-3.5" />
          {existingReport ? "View Report" : "Generate Report"}
        </Button>
      </div>

      {/* Main workspace */}
      <div className="flex-1 grid grid-cols-1 md:grid-cols-[340px_1fr] min-h-0">
        <FilesPanel
          caseRecord={caseRecord}
          files={files}
          onFilesChange={(next) => { setFiles(next); router.refresh(); }}
        />
        <ChatPanel
          caseId={caseRecord.id}
          hasFiles={files.length > 0}
          initialMessages={messages.filter((m) => {
            const meta = m.meta as MessageMeta;
            return !meta?.type || meta.type === "chat";
          })}
        />
      </div>

      {/* ── Dialogs ── */}
      {/* Report */}
      <Dialog open={reportOpen} onOpenChange={setReportOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col">
          <DialogHeader className="flex-shrink-0">
            <DialogTitle className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <FileText className="h-4 w-4" /> Investigation Report
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 text-xs"
                disabled={report.streaming || files.length === 0}
                onClick={generateReport}
              >
                <RefreshCw className={cn("h-3 w-3", report.streaming && "animate-spin")} />
                Regenerate
              </Button>
            </DialogTitle>
          </DialogHeader>

          <ScrollArea className="flex-1 pr-1">
            {report.streaming && !reportAnalysis && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
                <Loader2 className="h-4 w-4 animate-spin" /> Investigating…
              </div>
            )}
            {report.error && (
              <p className="text-sm text-destructive py-4">{report.error}</p>
            )}
            {reportAnalysis ? (
              <ReportCard analysis={reportAnalysis} />
            ) : reportText ? (
              <div className="prose-chat px-1 py-2">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{reportText}</ReactMarkdown>
              </div>
            ) : !report.streaming ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                <FileText className="h-8 w-8 mx-auto mb-3 opacity-40" />
                <p>No report yet.</p>
                <Button size="sm" className="mt-4 gap-1.5" onClick={generateReport} disabled={files.length === 0}>
                  <Sparkles className="h-3.5 w-3.5" /> Generate Report
                </Button>
              </div>
            ) : null}
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {/* ── Resolution Dialog ── */}
      <Dialog open={resolutionOpen} onOpenChange={setResolutionOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
          <DialogHeader className="flex-shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle className="h-4 w-4" /> Resolution Document
            </DialogTitle>
          </DialogHeader>

          <div className="flex-shrink-0 space-y-3 border-b pb-4">
            <div className="space-y-1.5">
              <Label htmlFor="engineer-note" className="text-sm">
                Confirmed root cause{" "}
                <span className="text-muted-foreground font-normal">(optional — one sentence)</span>
              </Label>
              <Textarea
                id="engineer-note"
                value={engineerNote}
                onChange={(e) => setEngineerNote(e.target.value)}
                placeholder="e.g. The shard router TTL increase caused writes to be misdirected for 5 minutes after each nightly rebalance."
                rows={2}
                className="resize-none text-sm"
                disabled={resolution.streaming}
              />
            </div>
            <Button
              size="sm"
              onClick={generateResolution}
              disabled={resolution.streaming || !hasChatMessages}
              className="gap-1.5"
            >
              {resolution.streaming
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Generating…</>
                : <><RefreshCw className="h-3.5 w-3.5" /> {existingResolution ? "Regenerate" : "Generate"}</>}
            </Button>
          </div>

          <ScrollArea className="flex-1 pr-1">
            {resolution.error && (
              <p className="text-sm text-destructive py-4">{resolution.error}</p>
            )}
            {resolutionText ? (
              <div className="prose-chat px-1 py-3">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{resolutionText}</ReactMarkdown>
                {resolution.streaming && (
                  <span className="inline-block w-2 h-4 bg-foreground/40 animate-pulse ml-0.5 align-middle" />
                )}
              </div>
            ) : !resolution.streaming ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                Add your confirmed root cause above (optional) and click Generate.
              </p>
            ) : null}
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── ReportCard ──────────────────────────────────────────────────────────────

type Confidence = "high" | "medium" | "low";
type Priority = "high" | "medium" | "low";

const CONFIDENCE_STYLES: Record<Confidence, string> = {
  high: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20",
  medium: "bg-amber-500/10 text-amber-600 border-amber-500/20",
  low: "bg-muted text-muted-foreground border-border",
};
const PRIORITY_STYLES: Record<Priority, string> = {
  high: "bg-red-500/10 text-red-600 border-red-500/20",
  medium: "bg-amber-500/10 text-amber-600 border-amber-500/20",
  low: "bg-muted text-muted-foreground border-border",
};

function SectionHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2 text-sm font-semibold mb-2">
      <span className="text-primary">{icon}</span>
      {title}
    </div>
  );
}

function ReportCard({ analysis }: { analysis: Analysis }) {
  return (
    <div className="space-y-5 py-2">
      <section>
        <SectionHeader icon={<Sparkles className="h-4 w-4" />} title="Summary" />
        <ul className="space-y-1.5">
          {analysis.summary.map((s, i) => (
            <li key={i} className="text-sm flex gap-2">
              <span className="mt-1.5 h-1 w-1 rounded-full bg-primary shrink-0" />
              <span>{s}</span>
            </li>
          ))}
        </ul>
      </section>

      {analysis.scope && (
        <section>
          <SectionHeader icon={<FileSearch className="h-4 w-4" />} title="Scope" />
          <p className="text-sm text-muted-foreground">{analysis.scope}</p>
        </section>
      )}

      {analysis.timeline.length > 0 && (
        <section>
          <SectionHeader icon={<Clock className="h-4 w-4" />} title="Timeline" />
          <ol className="space-y-2 border-l-2 border-border pl-4">
            {analysis.timeline.map((e, i) => (
              <li key={i} className="relative">
                <span className="absolute -left-[21px] top-1 h-2 w-2 rounded-full bg-primary" />
                <div className="text-sm">{e.event}</div>
                <div className="text-[11px] text-muted-foreground font-mono mt-0.5">
                  {e.timestamp} · {e.citation}
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {analysis.hypotheses.length > 0 && (
        <section>
          <SectionHeader icon={<Lightbulb className="h-4 w-4" />} title="Hypotheses" />
          <div className="space-y-2">
            {analysis.hypotheses.map((h, i) => (
              <div key={i} className="rounded-md border p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-medium">{h.claim}</p>
                  <span className={cn("text-[10px] px-1.5 py-0.5 rounded border font-medium shrink-0", CONFIDENCE_STYLES[h.confidence])}>
                    {h.confidence}
                  </span>
                </div>
                {h.evidence.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {h.evidence.map((ev, j) => (
                      <li key={j} className="text-[11px] text-muted-foreground font-mono">{ev}</li>
                    ))}
                  </ul>
                )}
                <p className="mt-2 text-xs">
                  <span className="text-muted-foreground">Confirm/deny: </span>
                  {h.how_to_confirm}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      {analysis.next_actions.length > 0 && (
        <section>
          <SectionHeader icon={<ListChecks className="h-4 w-4" />} title="Recommended next actions" />
          <ul className="space-y-1.5">
            {analysis.next_actions.map((a, i) => (
              <li key={i} className="text-sm flex items-start gap-2">
                <span className={cn("text-[10px] px-1.5 py-0.5 rounded border font-medium shrink-0 mt-0.5", PRIORITY_STYLES[a.priority])}>
                  {a.priority}
                </span>
                <span>{a.action}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {analysis.additional_artifacts && analysis.additional_artifacts.length > 0 && (
        <section>
          <SectionHeader icon={<FileSearch className="h-4 w-4" />} title="Artifacts that would help" />
          <ul className="space-y-1">
            {analysis.additional_artifacts.map((a, i) => (
              <li key={i} className="text-sm text-muted-foreground flex gap-2">
                <span className="mt-1.5 h-1 w-1 rounded-full bg-muted-foreground shrink-0" />
                <span>{a}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="pt-2 border-t">
        <Badge variant="outline" className="text-[10px]">
          Generated by LogIQ Deep mode · Evidence-grounded
        </Badge>
      </div>
    </div>
  );
}
