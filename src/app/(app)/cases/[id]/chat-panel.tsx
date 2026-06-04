"use client";
import * as React from "react";
import type { Message } from "@prisma/client";
import { MessageRole } from "@prisma/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  ArrowUp,
  Search,
  Sparkles,
  User as UserIcon,
  AlertTriangle,
  Clock,
  Lightbulb,
  ListChecks,
  FileSearch,
  Zap,
  Telescope,
} from "lucide-react";
import { cn } from "@/lib/utils";

type Mode = "fast" | "deep";

interface ChatPanelProps {
  caseId: string;
  hasFiles: boolean;
  initialMessages: Message[];
}

interface Stats {
  totalLogRows: number;
  selectedLogRows: number;
  contextItems: number;
  logFiles: number;
  manifestPresent: boolean;
  validation?: {
    ok: boolean;
    missingLogs: string[];
    extraLogs: string[];
    missingContext: string[];
    extraContext: string[];
  };
}

type Confidence = "high" | "medium" | "low";
type Priority = "high" | "medium" | "low";

interface Analysis {
  summary: string[];
  scope?: string;
  timeline: { timestamp: string; event: string; citation: string }[];
  hypotheses: { claim: string; confidence: Confidence; evidence: string[]; how_to_confirm: string }[];
  next_actions: { action: string; priority: Priority }[];
  additional_artifacts?: string[];
}

interface ToolCall {
  name: string;
  input: { pattern?: string; file?: string; level?: string; after?: string; before?: string; limit?: number };
}

/** Structured payload we persist into Message.meta and also build live on "done". */
interface MessageMeta {
  mode?: Mode;
  model?: string;
  analysis?: Analysis;
  toolCalls?: ToolCall[];
  error?: boolean;
}

function readMeta(meta: Message["meta"]): MessageMeta {
  if (meta && typeof meta === "object" && !Array.isArray(meta)) return meta as MessageMeta;
  return {};
}

const SUGGESTED_QUESTIONS = [
  "Summarize what happened and what likely caused the failure.",
  "Build a timeline of the most important events with citations.",
  "What evidence supports the leading hypothesis? What would confirm it?",
  "Which next actions are highest priority?",
];

export function ChatPanel({ caseId, hasFiles, initialMessages }: ChatPanelProps) {
  const [messages, setMessages] = React.useState<Message[]>(initialMessages);
  const [input, setInput] = React.useState("");
  const [mode, setMode] = React.useState<Mode>("deep");
  const [streaming, setStreaming] = React.useState(false);
  const [streamingText, setStreamingText] = React.useState("");
  const [liveToolCalls, setLiveToolCalls] = React.useState<ToolCall[]>([]);
  const [liveAnalysis, setLiveAnalysis] = React.useState<Analysis | null>(null);
  const [stats, setStats] = React.useState<Stats | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streamingText, liveToolCalls, liveAnalysis]);

  async function send(question: string) {
    if (!question.trim() || streaming) return;
    setError(null);
    setInput("");
    setStreaming(true);
    setStreamingText("");
    setLiveToolCalls([]);
    setLiveAnalysis(null);
    setStats(null);

    let assistantBuffer = "";
    const toolCalls: ToolCall[] = [];
    let analysis: Analysis | null = null;

    try {
      const res = await fetch(`/api/cases/${caseId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, mode }),
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Failed to start analysis");
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
          let data: unknown;
          try {
            data = JSON.parse(dataLine);
          } catch {
            continue;
          }

          if (event === "user_message" && data) {
            setMessages((prev) => [...prev, data as Message]);
          } else if (event === "stats" && data) {
            setStats(data as Stats);
          } else if (event === "delta" && data) {
            const { text } = data as { text: string };
            assistantBuffer += text;
            setStreamingText(assistantBuffer);
          } else if (event === "tool" && data) {
            toolCalls.push(data as ToolCall);
            setLiveToolCalls([...toolCalls]);
          } else if (event === "analysis" && data) {
            analysis = data as Analysis;
            setLiveAnalysis(analysis);
          } else if (event === "done" && data) {
            const { messageId } = data as { messageId: string };
            const final: Message = {
              id: messageId,
              caseId,
              role: MessageRole.ASSISTANT,
              content: assistantBuffer,
              meta: { mode, analysis: analysis ?? undefined, toolCalls } as unknown as Message["meta"],
              createdAt: new Date(),
            };
            setMessages((prev) => [...prev, final]);
            setStreamingText("");
            setLiveToolCalls([]);
            setLiveAnalysis(null);
          } else if (event === "error" && data) {
            const { message } = data as { message: string };
            setError(message);
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Streaming failed");
    } finally {
      setStreaming(false);
    }
  }

  const showEmpty = !messages.length && !streaming;
  const showLiveAssistant = streaming && (streamingText || liveToolCalls.length > 0 || liveAnalysis);

  return (
    <section className="flex flex-col min-h-0 max-h-[calc(100vh-8rem)]">
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="container max-w-3xl mx-auto py-6 px-4">
          {showEmpty ? (
            <EmptyState hasFiles={hasFiles} onPick={send} />
          ) : (
            <div className="space-y-6">
              {messages.map((m) => (
                <MessageBubble key={m.id} message={m} />
              ))}
              {showLiveAssistant && (
                <AssistantTurn
                  text={streamingText}
                  toolCalls={liveToolCalls}
                  analysis={liveAnalysis}
                  mode={mode}
                  streaming
                />
              )}
              {streaming && !showLiveAssistant && <ThinkingIndicator stats={stats} />}
            </div>
          )}
          {error && (
            <div className="mt-4 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md p-3 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>
      </div>

      <div className="border-t bg-background">
        <div className="container max-w-3xl mx-auto p-4">
          <div className="mb-2 flex items-center gap-2">
            <ModeToggle mode={mode} onChange={setMode} disabled={streaming} />
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="relative"
          >
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                hasFiles
                  ? "Ask LogIQ about this case..."
                  : "Upload at least one file to start asking questions"
              }
              disabled={!hasFiles || streaming}
              rows={2}
              className="resize-none pr-12 min-h-[60px]"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
            />
            <Button
              type="submit"
              size="icon"
              disabled={!hasFiles || streaming || !input.trim()}
              className="absolute right-2 bottom-2 h-8 w-8"
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
          </form>
          <p className="text-[10px] text-muted-foreground mt-2 px-1">
            {mode === "deep"
              ? "Deep mode: Claude searches your logs and returns a structured, cited report."
              : "Fast mode: a quick single-shot answer from a lighter model — no log search."}{" "}
            Press <kbd>Enter</kbd> to send, <kbd>Shift + Enter</kbd> for a new line.
          </p>
        </div>
      </div>
    </section>
  );
}

function ModeToggle({
  mode,
  onChange,
  disabled,
}: {
  mode: Mode;
  onChange: (m: Mode) => void;
  disabled?: boolean;
}) {
  const opts: { value: Mode; label: string; icon: React.ReactNode }[] = [
    { value: "fast", label: "Fast", icon: <Zap className="h-3 w-3" /> },
    { value: "deep", label: "Deep", icon: <Telescope className="h-3 w-3" /> },
  ];
  return (
    <div className="inline-flex rounded-md border p-0.5 bg-muted/30" role="group" aria-label="Answer mode">
      {opts.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(o.value)}
          aria-pressed={mode === o.value}
          className={cn(
            "inline-flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium transition disabled:opacity-50",
            mode === o.value
              ? "bg-background shadow-sm text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

function EmptyState({ hasFiles, onPick }: { hasFiles: boolean; onPick: (q: string) => void }) {
  return (
    <div className="py-12 text-center">
      <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary mb-4">
        <Sparkles className="h-6 w-6" />
      </div>
      <h2 className="text-xl font-semibold mb-2">Start your investigation</h2>
      <p className="text-sm text-muted-foreground max-w-md mx-auto mb-8">
        {hasFiles
          ? "Ask a focused question. LogIQ searches your logs for the evidence it needs, then answers with a structured, cited report."
          : "Add at least one log or context file from the panel on the left, then come back to ask questions."}
      </p>
      {hasFiles && (
        <div className="grid sm:grid-cols-2 gap-2 max-w-lg mx-auto">
          {SUGGESTED_QUESTIONS.map((q) => (
            <button
              key={q}
              onClick={() => onPick(q)}
              className="text-left text-sm border rounded-md p-3 hover:border-primary/50 hover:bg-muted/30 transition"
            >
              <Search className="h-3.5 w-3.5 inline-block text-muted-foreground mr-1.5" />
              {q}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === MessageRole.USER;
  if (isUser) {
    return (
      <div className="flex gap-3 flex-row-reverse">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <UserIcon className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0 flex justify-end">
          <div className="rounded-lg px-4 py-2.5 max-w-[90%] bg-primary text-primary-foreground">
            <p className="text-sm whitespace-pre-wrap leading-relaxed">{message.content}</p>
          </div>
        </div>
      </div>
    );
  }

  const meta = readMeta(message.meta);
  return (
    <AssistantTurn
      text={message.content}
      toolCalls={meta.toolCalls ?? []}
      analysis={meta.analysis ?? null}
      mode={meta.mode}
      model={meta.model}
    />
  );
}

/** An assistant turn: optional "thinking" text + tool-call chips + structured report. */
function AssistantTurn({
  text,
  toolCalls,
  analysis,
  mode,
  model,
  streaming,
}: {
  text: string;
  toolCalls: ToolCall[];
  analysis: Analysis | null;
  mode?: Mode;
  model?: string;
  streaming?: boolean;
}) {
  return (
    <div className="flex gap-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 text-white">
        <Sparkles className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0 space-y-3">
        {mode && (
          <Badge variant="outline" className="text-[10px] gap-1">
            {mode === "fast" ? <Zap className="h-3 w-3" /> : <Telescope className="h-3 w-3" />}
            {mode === "fast" ? `Fast${model ? ` · ${model}` : ""}` : "Deep · Claude"}
          </Badge>
        )}
        {toolCalls.length > 0 && <ToolCallChips toolCalls={toolCalls} />}

        {text.trim() && (
          <div className="bg-muted rounded-lg px-4 py-2.5 prose-chat">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
            {streaming && !analysis && (
              <span className="inline-block w-2 h-4 bg-foreground/40 animate-pulse ml-0.5 align-middle" />
            )}
          </div>
        )}

        {analysis ? (
          <AnalysisReport analysis={analysis} />
        ) : (
          streaming &&
          !text.trim() && (
            <div className="inline-flex items-center gap-2 bg-muted rounded-lg px-4 py-2.5 text-sm text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5" /> Compiling structured report…
            </div>
          )
        )}
      </div>
    </div>
  );
}

function ToolCallChips({ toolCalls }: { toolCalls: ToolCall[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {toolCalls.map((t, i) => (
        <Badge key={i} variant="outline" className="text-[10px] font-mono gap-1 max-w-full">
          <FileSearch className="h-3 w-3 shrink-0" />
          <span className="truncate">
            {t.name === "search_logs" ? `search "${t.input.pattern ?? ""}"` : t.name}
            {t.input.file ? ` in ${t.input.file}` : ""}
            {t.input.level ? ` · ${t.input.level}` : ""}
          </span>
        </Badge>
      ))}
    </div>
  );
}

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

function AnalysisReport({ analysis }: { analysis: Analysis }) {
  return (
    <div className="space-y-4 rounded-lg border bg-card p-4">
      {/* Summary */}
      <section>
        <SectionHeader icon={<Sparkles className="h-4 w-4" />} title="Summary" />
        <ul className="mt-2 space-y-1.5">
          {analysis.summary.map((s, i) => (
            <li key={i} className="text-sm flex gap-2">
              <span className="text-primary mt-1.5 h-1 w-1 rounded-full bg-primary shrink-0" />
              <span>{s}</span>
            </li>
          ))}
        </ul>
      </section>

      {analysis.scope && (
        <section>
          <SectionHeader icon={<FileSearch className="h-4 w-4" />} title="Scope" />
          <p className="mt-2 text-sm text-muted-foreground">{analysis.scope}</p>
        </section>
      )}

      {/* Timeline */}
      {analysis.timeline.length > 0 && (
        <section>
          <SectionHeader icon={<Clock className="h-4 w-4" />} title="Timeline" />
          <ol className="mt-2 space-y-2 border-l-2 border-border pl-4">
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

      {/* Hypotheses */}
      {analysis.hypotheses.length > 0 && (
        <section>
          <SectionHeader icon={<Lightbulb className="h-4 w-4" />} title="Hypotheses" />
          <div className="mt-2 space-y-2">
            {analysis.hypotheses.map((h, i) => (
              <div key={i} className="rounded-md border p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-medium">{h.claim}</p>
                  <span
                    className={cn(
                      "text-[10px] px-1.5 py-0.5 rounded border font-medium shrink-0",
                      CONFIDENCE_STYLES[h.confidence]
                    )}
                  >
                    {h.confidence}
                  </span>
                </div>
                {h.evidence.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {h.evidence.map((ev, j) => (
                      <li key={j} className="text-[11px] text-muted-foreground font-mono">
                        {ev}
                      </li>
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

      {/* Next actions */}
      {analysis.next_actions.length > 0 && (
        <section>
          <SectionHeader icon={<ListChecks className="h-4 w-4" />} title="Recommended next actions" />
          <ul className="mt-2 space-y-1.5">
            {analysis.next_actions.map((a, i) => (
              <li key={i} className="text-sm flex items-start gap-2">
                <span
                  className={cn(
                    "text-[10px] px-1.5 py-0.5 rounded border font-medium shrink-0 mt-0.5",
                    PRIORITY_STYLES[a.priority]
                  )}
                >
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
          <ul className="mt-2 space-y-1">
            {analysis.additional_artifacts.map((a, i) => (
              <li key={i} className="text-sm text-muted-foreground flex gap-2">
                <span className="mt-1.5 h-1 w-1 rounded-full bg-muted-foreground shrink-0" />
                <span>{a}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function SectionHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2 text-sm font-semibold">
      <span className="text-primary">{icon}</span>
      {title}
    </div>
  );
}

function ThinkingIndicator({ stats }: { stats: Stats | null }) {
  return (
    <div className="flex gap-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 text-white">
        <Sparkles className="h-4 w-4" />
      </div>
      <div className="flex-1 space-y-2">
        <div className="inline-flex items-center gap-2 bg-muted rounded-lg px-4 py-2.5 text-sm">
          <span className="flex gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-foreground/50 animate-bounce [animation-delay:-0.3s]" />
            <span className="h-1.5 w-1.5 rounded-full bg-foreground/50 animate-bounce [animation-delay:-0.15s]" />
            <span className="h-1.5 w-1.5 rounded-full bg-foreground/50 animate-bounce" />
          </span>
          <span className="text-muted-foreground">
            {stats ? "Reasoning over evidence..." : "Loading bundle..."}
          </span>
        </div>
        {stats && (
          <div className="flex flex-wrap gap-1.5 pl-1">
            <Badge variant="outline" className="text-[10px]">
              {stats.logFiles} log {stats.logFiles === 1 ? "file" : "files"}
            </Badge>
            <Badge variant="outline" className="text-[10px]">
              {stats.selectedLogRows} / {stats.totalLogRows} lines seeded
            </Badge>
            <Badge variant="outline" className="text-[10px]">
              {stats.contextItems} context items
            </Badge>
            {stats.manifestPresent && (
              <Badge
                variant={stats.validation?.ok ? "success" : "warning"}
                className="text-[10px]"
              >
                manifest {stats.validation?.ok ? "matches" : "mismatch"}
              </Badge>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
