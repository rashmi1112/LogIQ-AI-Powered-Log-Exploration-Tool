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

const MAX_TURNS = 8;
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
          const messages: Anthropic.MessageParam[] = [{ role: "user", content: userPrompt }];

          for (let turn = 0; turn < MAX_TURNS; turn++) {
            const messageStream = anthropic.messages.stream({
              model: ANTHROPIC_MODEL,
              max_tokens: ANTHROPIC_DEFAULTS.maxTokens,
              temperature: ANTHROPIC_DEFAULTS.temperature,
              system: SYSTEM_PROMPT,
              tools: ANALYSIS_TOOLS,
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
            if (final.stop_reason !== "tool_use") break;

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
                toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result.text });
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
