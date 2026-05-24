"use client";
import * as React from "react";
import type { Message } from "@prisma/client";
import { MessageRole } from "@prisma/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ArrowUp, Search, Sparkles, User as UserIcon, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

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

const SUGGESTED_QUESTIONS = [
  "Summarize what happened and what likely caused the failure.",
  "Build a timeline of the most important events with citations.",
  "What evidence supports the leading hypothesis? What would confirm it?",
  "Which next actions are highest priority?",
];

export function ChatPanel({ caseId, hasFiles, initialMessages }: ChatPanelProps) {
  const [messages, setMessages] = React.useState<Message[]>(initialMessages);
  const [input, setInput] = React.useState("");
  const [streaming, setStreaming] = React.useState(false);
  const [streamingText, setStreamingText] = React.useState("");
  const [stats, setStats] = React.useState<Stats | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streamingText]);

  async function send(question: string) {
    if (!question.trim() || streaming) return;
    setError(null);
    setInput("");
    setStreaming(true);
    setStreamingText("");
    setStats(null);

    let assistantBuffer = "";
    let savedUserMessage: Message | null = null;

    try {
      const res = await fetch(`/api/cases/${caseId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
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
            savedUserMessage = data as Message;
            setMessages((prev) => [...prev, savedUserMessage!]);
          } else if (event === "stats" && data) {
            setStats(data as Stats);
          } else if (event === "delta" && data) {
            const { text } = data as { text: string };
            assistantBuffer += text;
            setStreamingText(assistantBuffer);
          } else if (event === "done" && data) {
            const { messageId } = data as { messageId: string };
            const final: Message = {
              id: messageId,
              caseId,
              role: MessageRole.ASSISTANT,
              content: assistantBuffer,
              meta: null,
              createdAt: new Date(),
            };
            setMessages((prev) => [...prev, final]);
            setStreamingText("");
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

  return (
    <section className="flex flex-col min-h-0 max-h-[calc(100vh-8rem)]">
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="container max-w-3xl mx-auto py-6 px-4">
          {showEmpty ? (
            <EmptyState hasFiles={hasFiles} onPick={send} />
          ) : (
            <div className="space-y-6">
              {messages.map((m) => (
                <MessageBubble key={m.id} role={m.role} content={m.content} />
              ))}
              {streaming && streamingText && (
                <MessageBubble role={MessageRole.ASSISTANT} content={streamingText} streaming />
              )}
              {streaming && !streamingText && <ThinkingIndicator stats={stats} />}
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
            LogIQ stays grounded in your uploaded logs. Press <kbd>Enter</kbd> to send,{" "}
            <kbd>Shift + Enter</kbd> for a new line.
          </p>
        </div>
      </div>
    </section>
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
          ? "Ask a focused question. LogIQ will prioritize errors, timeouts, exceptions, and lines relevant to your question, then answer with citations."
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

function MessageBubble({
  role,
  content,
  streaming,
}: {
  role: MessageRole;
  content: string;
  streaming?: boolean;
}) {
  const isUser = role === MessageRole.USER;
  return (
    <div className={cn("flex gap-3", isUser ? "flex-row-reverse" : "")}>
      <div
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
          isUser ? "bg-primary text-primary-foreground" : "bg-gradient-to-br from-indigo-500 to-purple-600 text-white"
        )}
      >
        {isUser ? <UserIcon className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
      </div>
      <div className={cn("flex-1 min-w-0", isUser && "flex justify-end")}>
        <div
          className={cn(
            "rounded-lg px-4 py-2.5 max-w-[90%]",
            isUser ? "bg-primary text-primary-foreground" : "bg-muted"
          )}
        >
          {isUser ? (
            <p className="text-sm whitespace-pre-wrap leading-relaxed">{content}</p>
          ) : (
            <div className="prose-chat">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
              {streaming && <span className="inline-block w-2 h-4 bg-foreground/40 animate-pulse ml-0.5 align-middle" />}
            </div>
          )}
        </div>
      </div>
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
              {stats.selectedLogRows} / {stats.totalLogRows} lines selected
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
