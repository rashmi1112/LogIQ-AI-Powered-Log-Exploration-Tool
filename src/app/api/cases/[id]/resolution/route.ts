import { NextRequest } from "next/server";
import { z } from "zod";
import { MessageRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, handleApiError, requireCaseOwnership, requireUser } from "@/lib/api";
import { ANTHROPIC_DEFAULTS, ANTHROPIC_MODEL, getAnthropic } from "@/lib/claude";
import { RESOLUTION_SYSTEM_PROMPT } from "@/lib/analysis/pipeline";
import type { SubmitAnalysisInput } from "@/lib/analysis/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ResolutionBodySchema = z.object({
  engineerNote: z.string().max(500).optional(),
});

function sseEncode(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    await requireCaseOwnership(id, user.id);

    const { engineerNote } = ResolutionBodySchema.parse(await req.json());

    // Load all chat messages (exclude report/resolution meta-messages)
    const allMessages = await prisma.message.findMany({
      where: { caseId: id },
      orderBy: { createdAt: "asc" },
    });

    const chatMessages = allMessages.filter((m) => {
      const meta = m.meta as Record<string, unknown> | null;
      return !meta?.type || meta.type === "chat";
    });

    if (!chatMessages.length) {
      throw new ApiError(400, "No investigation conversation found. Chat with the assistant first before generating a resolution.");
    }

    // Find the most recent report (if any)
    const reportMessage = allMessages.find((m) => {
      const meta = m.meta as Record<string, unknown> | null;
      return meta?.type === "report";
    });
    const reportAnalysis = reportMessage
      ? (reportMessage.meta as Record<string, unknown> | null)?.analysis as SubmitAnalysisInput | undefined
      : undefined;

    // Build the synthesis prompt
    const conversationText = chatMessages
      .map((m) => {
        const role = m.role === MessageRole.USER ? "Engineer" : "LogIQ";
        const content = m.content.length > 3000 ? m.content.slice(0, 3000) + "\n[truncated]" : m.content;
        return `**${role}:** ${content}`;
      })
      .join("\n\n---\n\n");

    const reportSummary = reportAnalysis
      ? [
          "**Initial LLM Report Summary:**",
          `- Summary: ${reportAnalysis.summary?.join("; ")}`,
          `- Top hypothesis: ${reportAnalysis.hypotheses?.[0]?.claim ?? "none"} (confidence: ${reportAnalysis.hypotheses?.[0]?.confidence ?? "n/a"})`,
        ].join("\n")
      : "**Initial LLM Report:** Not generated.";

    const userPrompt = [
      reportSummary,
      "",
      "**Investigation Conversation:**",
      conversationText,
      "",
      engineerNote
        ? `**Engineer's confirmed root cause:** ${engineerNote}`
        : "**Engineer's confirmed root cause:** Not specified — infer the most supported conclusion from the conversation.",
    ].join("\n");

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: string, data: unknown) =>
          controller.enqueue(encoder.encode(sseEncode(event, data)));

        let resolutionText = "";

        try {
          const anthropic = getAnthropic();

          const messageStream = anthropic.messages.stream({
            model: ANTHROPIC_MODEL,
            max_tokens: ANTHROPIC_DEFAULTS.maxTokens,
            temperature: 0.3,
            system: RESOLUTION_SYSTEM_PROMPT,
            messages: [{ role: "user", content: userPrompt }],
          });

          for await (const event of messageStream) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              resolutionText += event.delta.text;
              send("delta", { text: event.delta.text });
            }
          }

          // Persist — overwrite any existing resolution for this case
          const existing = allMessages.find((m) => {
            const meta = m.meta as Record<string, unknown> | null;
            return meta?.type === "resolution";
          });

          const resolutionMessage = existing
            ? await prisma.message.update({
                where: { id: existing.id },
                data: {
                  content: resolutionText,
                  meta: { type: "resolution", engineerNote: engineerNote ?? null },
                  createdAt: new Date(),
                },
              })
            : await prisma.message.create({
                data: {
                  caseId: id,
                  role: MessageRole.ASSISTANT,
                  content: resolutionText,
                  meta: { type: "resolution", engineerNote: engineerNote ?? null },
                },
              });

          send("done", { messageId: resolutionMessage.id });
        } catch (err) {
          console.error("Resolution generation error:", err);
          send("error", { message: err instanceof Error ? err.message : "Resolution generation failed" });
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
