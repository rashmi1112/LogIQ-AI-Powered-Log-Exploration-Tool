import { NextRequest } from "next/server";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { MessageRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, handleApiError, requireCaseOwnership, requireUser } from "@/lib/api";
import { ANTHROPIC_DEFAULTS, ANTHROPIC_MODEL, getAnthropic } from "@/lib/claude";
import {
  assemblePromptFromFiles,
  buildUserPrompt,
  FAST_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  type FileRef,
} from "@/lib/analysis/pipeline";
import {
  ANALYSIS_TOOLS,
  runSearchLogs,
  SearchLogsInput,
  SubmitAnalysisInput,
  type SubmitAnalysisInput as Analysis,
} from "@/lib/analysis/tools";
import { fastModelLabel, streamFast } from "@/lib/fast-provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ChatBodySchema = z.object({
  question: z.string().min(1).max(4000),
  mode: z.enum(["fast", "deep"]).default("deep"),
});

/** Hard cap on agentic turns so a misbehaving loop can't run forever. */
const MAX_TURNS = 10;

/** Server-Sent Events payload encoder. */
function sseEncode(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    await requireCaseOwnership(id, user.id);

    const { question, mode } = ChatBodySchema.parse(await req.json());

    // Snapshot files at the time of the question
    const dbFiles = await prisma.caseFile.findMany({ where: { caseId: id } });
    if (!dbFiles.length) {
      throw new ApiError(400, "This case has no files yet. Upload logs and context before asking.");
    }

    const fileRefs: FileRef[] = dbFiles.map((f) => ({
      filename: f.filename,
      kind: f.kind,
      blobUrl: f.blobUrl,
    }));

    // Load prior chat messages for conversation history (exclude report/resolution)
    const priorMessages = await prisma.message.findMany({
      where: { caseId: id },
      orderBy: { createdAt: "asc" },
    });
    const chatHistory = priorMessages
      .filter((m) => {
        const meta = m.meta as Record<string, unknown> | null;
        return !meta?.type || meta.type === "chat";
      })
      .map((m) => ({
        role: m.role === MessageRole.USER ? ("user" as const) : ("assistant" as const),
        // Truncate very long individual messages so a single response can't consume the full window.
        content: m.content.length > 2000 ? m.content.slice(0, 2000) + "\n[truncated]" : m.content,
      }));

    // Persist the user message before streaming
    const userMessage = await prisma.message.create({
      data: { caseId: id, role: MessageRole.USER, content: question },
    });

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: string, data: unknown) =>
          controller.enqueue(encoder.encode(sseEncode(event, data)));

        let assistantText = "";
        let analysis: Analysis | null = null;
        const toolEvents: { name: string; input: unknown }[] = [];

        try {
          send("user_message", userMessage);

          // Assemble prompt (this fetches blob contents in parallel) + keep all rows for search_logs
          const assembled = await assemblePromptFromFiles(fileRefs, question);

          send("stats", assembled.stats);

          const userPrompt = buildUserPrompt({
            question,
            manifestBlock: assembled.manifestBlock,
            manifestValidation: assembled.manifestValidation,
            contextBlob: assembled.contextBlob,
            logBlob: assembled.logBlob,
          });

          // ---- Fast mode: single-shot, no tools, cheaper provider ----
          if (mode === "fast") {
            for await (const delta of streamFast({ system: FAST_SYSTEM_PROMPT, user: userPrompt })) {
              assistantText += delta;
              send("delta", { text: delta });
            }

            const fastMessage = await prisma.message.create({
              data: {
                caseId: id,
                role: MessageRole.ASSISTANT,
                content: assistantText,
                meta: {
                  mode: "fast",
                  model: fastModelLabel(),
                  stats: assembled.stats as unknown as object,
                },
              },
            });

            await prisma.case.update({ where: { id }, data: { updatedAt: new Date() } });
            send("done", { messageId: fastMessage.id });
            return;
          }

          // ---- Deep mode: Claude agentic loop ----
          const anthropic = getAnthropic();

          // Prior turns provide memory; only the current turn carries full file context.
          // cache_control on the user prompt caches the large log blob so agentic-loop
          // turns 2-N read it from cache instead of re-processing it.
          // SDK 0.32.x doesn't include cache_control in TextBlockParam types; the cast
          // bridges the gap while preserving the property in the JSON sent to the API.
          const messages: Anthropic.MessageParam[] = [
            ...chatHistory,
            { role: "user", content: [{ type: "text" as const, text: userPrompt, cache_control: { type: "ephemeral" as const } }] as unknown as Array<Anthropic.TextBlockParam> },
          ];

          // Agentic loop: let Claude search the logs, then submit a structured analysis.
          // forceSubmit makes the next turn call submit_analysis via tool_choice — used
          // when the model has investigated but stalls without delivering a report.
          let forceSubmit = false;
          let nudgedToSubmit = false;

          for (let turn = 0; turn < MAX_TURNS; turn++) {
            // On the final allowed turn, if we've gathered evidence but have no report
            // yet, force the structured submission so the run can't end empty-handed.
            if (turn === MAX_TURNS - 1 && !analysis && toolEvents.length > 0) {
              forceSubmit = true;
            }

            const messageStream = anthropic.messages.stream({
              model: ANTHROPIC_MODEL,
              max_tokens: ANTHROPIC_DEFAULTS.maxTokens,
              temperature: ANTHROPIC_DEFAULTS.temperature,
              system: [{ type: "text" as const, text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" as const } }] as unknown as Anthropic.TextBlockParam[],
              tools: ANALYSIS_TOOLS,
              tool_choice: forceSubmit ? { type: "tool", name: "submit_analysis" } : undefined,
              messages,
            });

            for await (const event of messageStream) {
              if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
                const delta = event.delta.text;
                assistantText += delta;
                send("delta", { text: delta });
              }
            }

            const final = await messageStream.finalMessage();
            messages.push({ role: "assistant", content: final.content });

            if (final.stop_reason !== "tool_use") {
              // The model ended its turn with plain text instead of a tool call.
              // If it had been investigating (ran searches) but never submitted a
              // structured report, nudge it once to finish via submit_analysis —
              // otherwise the user sees "let me compile the findings" and nothing else.
              if (!analysis && toolEvents.length > 0 && !nudgedToSubmit) {
                nudgedToSubmit = true;
                forceSubmit = true;
                messages.push({
                  role: "user",
                  content:
                    "Finish now: call submit_analysis exactly once with your complete structured findings. Do not reply with plain text.",
                });
                continue;
              }
              break;
            }

            // Execute every tool call in this turn and feed results back.
            const toolResults: Anthropic.ToolResultBlockParam[] = [];
            for (const block of final.content) {
              if (block.type !== "tool_use") continue;

              if (block.name === "search_logs") {
                const parsed = SearchLogsInput.safeParse(block.input);
                if (!parsed.success) {
                  toolResults.push({
                    type: "tool_result",
                    tool_use_id: block.id,
                    content: "Invalid search input. Provide at least a non-empty `pattern`.",
                    is_error: true,
                  });
                  continue;
                }
                send("tool", { name: "search_logs", input: parsed.data });
                toolEvents.push({ name: "search_logs", input: parsed.data });
                const result = runSearchLogs(assembled.allRows, parsed.data);
                // Truncate the content stored in the conversation history to cap token
                // accumulation across turns. The model already processed the full result;
                // the history only needs enough context to cite it. Full text goes to UI.
                const historyContent = result.text.length > 3000
                  ? result.text.slice(0, 3000) + "\n[truncated — raise limit or narrow query to see more]"
                  : result.text;
                toolResults.push({ type: "tool_result", tool_use_id: block.id, content: historyContent });
              } else if (block.name === "submit_analysis") {
                const parsed = SubmitAnalysisInput.safeParse(block.input);
                if (!parsed.success) {
                  toolResults.push({
                    type: "tool_result",
                    tool_use_id: block.id,
                    content: `Analysis did not match the required schema: ${parsed.error.message}. Please resubmit.`,
                    is_error: true,
                  });
                  continue;
                }
                analysis = parsed.data;
                send("analysis", analysis);
                toolResults.push({ type: "tool_result", tool_use_id: block.id, content: "Analysis recorded." });
              } else {
                toolResults.push({
                  type: "tool_result",
                  tool_use_id: block.id,
                  content: `Unknown tool: ${block.name}`,
                  is_error: true,
                });
              }
            }

            // Got the structured report — no need for another model turn.
            if (analysis) break;

            messages.push({ role: "user", content: toolResults });
          }

          // Persist assistant message + structured analysis in meta.
          const assistantMessage = await prisma.message.create({
            data: {
              caseId: id,
              role: MessageRole.ASSISTANT,
              content: assistantText,
              meta: {
                mode: "deep",
                analysis: (analysis as unknown as object) ?? undefined,
                toolCalls: toolEvents as unknown as object,
                stats: assembled.stats as unknown as object,
              },
            },
          });

          // Bump case updatedAt so it sorts to the top of the dashboard
          await prisma.case.update({ where: { id }, data: { updatedAt: new Date() } });

          send("done", { messageId: assistantMessage.id });
        } catch (err) {
          console.error("Chat stream error:", err);
          send("error", {
            message: err instanceof Error ? err.message : "Streaming failed",
          });

          // Best effort: persist whatever we managed to receive
          if (assistantText.trim() || analysis) {
            await prisma.message
              .create({
                data: {
                  caseId: id,
                  role: MessageRole.ASSISTANT,
                  content: assistantText,
                  meta: { error: true, analysis: (analysis as unknown as object) ?? undefined },
                },
              })
              .catch(() => {});
          }
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
