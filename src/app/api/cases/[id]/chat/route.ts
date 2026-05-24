import { NextRequest } from "next/server";
import { z } from "zod";
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ChatBodySchema = z.object({
  question: z.string().min(1).max(4000),
});

/** Server-Sent Events payload encoder. */
function sseEncode(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    await requireCaseOwnership(id, user.id);

    const { question } = ChatBodySchema.parse(await req.json());

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

        try {
          send("user_message", userMessage);

          // Assemble prompt (this fetches blob contents in parallel)
          const assembled = await assemblePromptFromFiles(fileRefs, question);

          send("stats", assembled.stats);

          const userPrompt = buildUserPrompt({
            question,
            manifestBlock: assembled.manifestBlock,
            manifestValidation: assembled.manifestValidation,
            contextBlob: assembled.contextBlob,
            logBlob: assembled.logBlob,
          });

          const anthropic = getAnthropic();

          const messageStream = anthropic.messages.stream({
            model: ANTHROPIC_MODEL,
            max_tokens: ANTHROPIC_DEFAULTS.maxTokens,
            temperature: ANTHROPIC_DEFAULTS.temperature,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: userPrompt }],
          });

          for await (const event of messageStream) {
            if (
              event.type === "content_block_delta" &&
              event.delta.type === "text_delta"
            ) {
              const delta = event.delta.text;
              assistantText += delta;
              send("delta", { text: delta });
            }
          }

          const final = await messageStream.finalMessage();

          // Persist assistant message + usage
          const assistantMessage = await prisma.message.create({
            data: {
              caseId: id,
              role: MessageRole.ASSISTANT,
              content: assistantText,
              meta: {
                model: final.model,
                stop_reason: final.stop_reason,
                usage: final.usage as unknown as object,
                stats: assembled.stats as unknown as object,
              },
            },
          });

          // Bump case updatedAt so it sorts to the top of the dashboard
          await prisma.case.update({
            where: { id },
            data: { updatedAt: new Date() },
          });

          send("done", { messageId: assistantMessage.id });
        } catch (err) {
          console.error("Chat stream error:", err);
          send("error", {
            message: err instanceof Error ? err.message : "Streaming failed",
          });

          // Best effort: persist whatever assistant text we managed to receive
          if (assistantText.trim()) {
            await prisma.message
              .create({
                data: {
                  caseId: id,
                  role: MessageRole.ASSISTANT,
                  content: assistantText,
                  meta: { error: true },
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
