import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { deleteFromBlob } from "@/lib/blob";
import { ApiError, handleApiError, requireCaseOwnership, requireUser } from "@/lib/api";

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; fileId: string }> }
) {
  try {
    const user = await requireUser();
    const { id, fileId } = await ctx.params;
    await requireCaseOwnership(id, user.id);

    const file = await prisma.caseFile.findUnique({ where: { id: fileId } });
    if (!file || file.caseId !== id) throw new ApiError(404, "File not found");

    // Best-effort blob delete; continue even if it fails so DB doesn't keep
    // a dangling row.
    await deleteFromBlob(file.blobUrl).catch((err) => {
      console.warn("Blob delete failed:", err);
    });

    await prisma.caseFile.delete({ where: { id: fileId } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
