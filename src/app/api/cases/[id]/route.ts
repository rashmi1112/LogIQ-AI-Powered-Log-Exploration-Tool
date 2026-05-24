import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { deleteFromBlob } from "@/lib/blob";
import { handleApiError, requireCaseOwnership, requireUser } from "@/lib/api";

const UpdateCaseSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
});

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    await requireCaseOwnership(id, user.id);

    const c = await prisma.case.findUnique({
      where: { id },
      include: {
        files: { orderBy: { createdAt: "asc" } },
        messages: { orderBy: { createdAt: "asc" } },
      },
    });
    return NextResponse.json({ case: c });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    await requireCaseOwnership(id, user.id);

    const body = UpdateCaseSchema.parse(await req.json());
    const c = await prisma.case.update({
      where: { id },
      data: body,
    });
    return NextResponse.json({ case: c });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    await requireCaseOwnership(id, user.id);

    // Delete blobs first (best-effort) so we don't leave orphans on storage.
    const files = await prisma.caseFile.findMany({ where: { caseId: id }, select: { blobUrl: true } });
    await Promise.allSettled(files.map((f) => deleteFromBlob(f.blobUrl)));

    await prisma.case.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
