import { put, del, head } from "@vercel/blob";

const BLOB_PREFIX = "logiq";

/** Generate a deterministic-ish, namespaced path for a case file. */
export function buildBlobPath(userId: string, caseId: string, filename: string): string {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${BLOB_PREFIX}/${userId}/${caseId}/${Date.now()}-${safe}`;
}

export async function uploadToBlob(path: string, file: File | Blob | ArrayBuffer | string, contentType?: string) {
  return put(path, file, {
    access: "public",
    contentType,
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

export async function deleteFromBlob(urlOrPath: string) {
  return del(urlOrPath);
}

export async function headBlob(url: string) {
  return head(url);
}

/** Fetch the content of a blob as text (for parsing). */
export async function fetchBlobText(url: string): Promise<string> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch blob: ${res.status} ${res.statusText}`);
  return res.text();
}
