import { NextRequest } from "next/server";
import type Anthropic from "@anthropic-ai/sdk";
import { MessageRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, handleApiError, requireCaseOwnership, requireUser } from "@/lib/api";
import { ANTHROPIC_DEFAULTS, ANTHROPIC_MODEL, getAnthropic } from "@/lib/claude";
import {
  assemblePromptFromFiles,
  buildUserPrompt,
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TURNS = 10;
const REPORT_QUESTION =
  "Generate a comprehensive investigation report for this incident. " +
  "Analyse all available evidence across every uploaded file, build a complete timeline, " +
  "identify root cause hypotheses with cited evidence, and provide prioritised next actions.";

function sseEncode(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    await requireCaseOwnership(id, user.id);

    const dbFiles = await prisma.caseFile.findMany({ where: { caseId: id } });
    if (!dbFiles.length) {
      throw new ApiError(400, "No files uploaded. Add logs and context before generating a report.");
    }

    const fileRefs: FileRef[] = dbFiles.map((f) => ({
      filename: f.filename,
      kind: f.kind,
      blobUrl: f.blobUrl,
    }));

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: string, data: unknown) =>
          controller.enqueue(encoder.encode(sseEncode(event, data)));

        let assistantText = "";
        let analysis: Analysis | null = null;
        const toolEvents: { name: string; input: unknown }[] = [];

        try {
          const assembled = await assemblePromptFromFiles(fileRefs, REPORT_QUESTION);
          send("stats", assembled.stats);

          const userPrompt = buildUserPrompt({
            question: REPORT_QUESTION,
            manifestBlock: assembled.manifestBlock,
            manifestValidation: assembled.manifestValidation,
            contextBlob: assembled.contextBlob,
            logBlob: assembled.logBlob,
          });

          const anthropic = getAnthropic();
          // cache_control on the user prompt caches the large log blob so agentic-loop
          // turns 2-N read it from cache instead of re-processing it.
          // SDK 0.32.x doesn't include cache_control in TextBlockParam types; the cast
          // bridges the gap while preserving the property in the JSON sent to the API.
          const messages: Anthropic.MessageParam[] = [
            { role: "user", content: [{ type: "text" as const, text: userPrompt, cache_control: { type: "ephemeral" as const } }] as unknown as Array<Anthropic.TextBlockParam> },
          ];

          // A report run always needs a structured submit_analysis. forceSubmit makes
          // the model deliver it via tool_choice when it stalls or runs out of turns,
          // so the report can never end as bare "let me compile the findings" text.
          let forceSubmit = false;
          let nudgedToSubmit = false;

          for (let turn = 0; turn < MAX_TURNS; turn++) {
            if (turn === MAX_TURNS - 1 && !analysis) forceSubmit = true;

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
                assistantText += event.delta.text;
                send("delta", { text: event.delta.text });
              }
            }

            const final = await messageStream.finalMessage();
            messages.push({ role: "assistant", content: final.content });
            if (final.stop_reason !== "tool_use") {
              // Model ended with text but no report — nudge once and force the tool.
              if (!analysis && !nudgedToSubmit) {
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

            const toolResults: Anthropic.ToolResultBlockParam[] = [];
            for (const block of final.content) {
              if (block.type !== "tool_use") continue;
              if (block.name === "search_logs") {
                const parsed = SearchLogsInput.safeParse(block.input);
                if (!parsed.success) {
                  toolResults.push({ type: "tool_result", tool_use_id: block.id, content: "Invalid search input.", is_error: true });
                  continue;
                }
                send("tool", { name: "search_logs", input: parsed.data });
                toolEvents.push({ name: "search_logs", input: parsed.data });
                const result = runSearchLogs(assembled.allRows, parsed.data);
                const historyContent = result.text.length > 3000
                  ? result.text.slice(0, 3000) + "\n[truncated — raise limit or narrow query to see more]"
                  : result.text;
                toolResults.push({ type: "tool_result", tool_use_id: block.id, content: historyContent });
              } else if (block.name === "submit_analysis") {
                const parsed = SubmitAnalysisInput.safeParse(block.input);
                if (!parsed.success) {
                  toolResults.push({ type: "tool_result", tool_use_id: block.id, content: `Schema error: ${parsed.error.message}. Please resubmit.`, is_error: true });
                  continue;
                }
                analysis = parsed.data;
                send("analysis", analysis);
                toolResults.push({ type: "tool_result", tool_use_id: block.id, content: "Report recorded." });
              } else {
                toolResults.push({ type: "tool_result", tool_use_id: block.id, content: `Unknown tool: ${block.name}`, is_error: true });
              }
            }
            if (analysis) break;
            messages.push({ role: "user", content: toolResults });
          }

          // Persist — overwrite any existing report for this case
          const existing = await prisma.message.findFirst({
            where: { caseId: id, meta: { path: ["type"], equals: "report" } },
          });
          const reportMessage = existing
            ? await prisma.message.update({
                where: { id: existing.id },
                data: {
                  content: assistantText,
                  meta: { type: "report", analysis: (analysis as unknown as object) ?? undefined, toolCalls: toolEvents as unknown as object },
                  createdAt: new Date(),
                },
              })
            : await prisma.message.create({
                data: {
                  caseId: id,
                  role: MessageRole.ASSISTANT,
                  content: assistantText,
                  meta: { type: "report", analysis: (analysis as unknown as object) ?? undefined, toolCalls: toolEvents as unknown as object },
                },
              });

          await prisma.case.update({ where: { id }, data: { updatedAt: new Date() } });
          send("done", { messageId: reportMessage.id });
        } catch (err) {
          console.error("Report generation error:", err);
          send("error", { message: err instanceof Error ? err.message : "Report generation failed" });
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
