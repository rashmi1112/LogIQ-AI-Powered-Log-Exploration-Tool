import { NextRequest, NextResponse } from "next/server";
import { FileKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { buildBlobPath, uploadToBlob } from "@/lib/blob";
import { handleApiError, requireCaseOwnership, requireUser, ApiError } from "@/lib/api";
import { looksLikeManifest, type ManifestPayload } from "@/lib/analysis/manifest";

// Per-file caps. Enforced server-side regardless of client.
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB per file
const MAX_FILES_PER_REQUEST = 30;
const ALLOWED_EXTENSIONS = new Set([".csv", ".txt", ".json", ".log"]);

function classifyFile(filename: string, content?: string): FileKind {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".csv") || lower.endsWith(".log")) return FileKind.LOG;
  if (lower.endsWith(".json")) {
    if (content) {
      try {
        const payload = JSON.parse(content);
        if (looksLikeManifest(filename, payload)) return FileKind.MANIFEST;
      } catch {
        // not valid JSON — treat as context
      }
    } else if (lower.includes("manifest")) {
      return FileKind.MANIFEST;
    }
  }
  return FileKind.CONTEXT;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    await requireCaseOwnership(id, user.id);
    const files = await prisma.caseFile.findMany({
      where: { caseId: id },
      orderBy: { createdAt: "asc" },
    });
    return NextResponse.json({ files });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    await requireCaseOwnership(id, user.id);

    const form = await req.formData();
    const files = form.getAll("files").filter((v): v is File => v instanceof File);

    if (!files.length) throw new ApiError(400, "No files provided");
    if (files.length > MAX_FILES_PER_REQUEST)
      throw new ApiError(400, `Too many files in one request (max ${MAX_FILES_PER_REQUEST})`);

    for (const f of files) {
      if (f.size > MAX_FILE_BYTES)
        throw new ApiError(413, `${f.name} exceeds ${MAX_FILE_BYTES / 1024 / 1024}MB`);
      const ext = "." + (f.name.split(".").pop() ?? "").toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext))
        throw new ApiError(400, `${f.name}: unsupported file type. Allowed: csv, txt, json, log`);
    }

    let manifestPayload: ManifestPayload | null = null;

    const created = await Promise.all(
      files.map(async (file) => {
        const isTextual =
          file.type.startsWith("text/") ||
          /\.(csv|txt|json|log)$/i.test(file.name);

        let textContent: string | undefined;
        if (isTextual && file.size < 2 * 1024 * 1024) {
          // Sniff small textual files to classify
          try {
            textContent = await file.text();
          } catch {
            // ignore
          }
        }

        const kind = classifyFile(file.name, textContent);
        const blobPath = buildBlobPath(user.id, id, file.name);

        const uploaded = await uploadToBlob(blobPath, file, file.type || "text/plain");

        if (kind === FileKind.MANIFEST && textContent) {
          try {
            manifestPayload = JSON.parse(textContent);
          } catch {
            // already validated above; ignore
          }
        }

        return prisma.caseFile.create({
          data: {
            caseId: id,
            filename: file.name,
            kind,
            mimeType: file.type || null,
            size: file.size,
            blobUrl: uploaded.url,
            blobPath,
          },
        });
      })
    );

    // If a manifest was uploaded, hydrate case metadata from it.
    if (manifestPayload) {
      const m = manifestPayload as ManifestPayload;
      await prisma.case.update({
        where: { id },
        data: {
          caseId: typeof m.case_id === "string" ? m.case_id : undefined,
          jobId: typeof m.job_id === "string" ? m.job_id : undefined,
          catalog: typeof m.catalog === "string" ? m.catalog : undefined,
          hypervisor: typeof m.hypervisor === "string" ? m.hypervisor : undefined,
          failedMachines: Array.isArray(m.failed_machines) ? m.failed_machines.map(String) : undefined,
          manifestPayload: m as object,
        },
      });
    }

    return NextResponse.json({ files: created }, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
