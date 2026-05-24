/**
 * High-level orchestration:
 *   loadCaseData → assemble prompt → return blocks for the model.
 *
 * Pulls files from Vercel Blob, parses, and runs relevance scoring.
 */
import { fetchBlobText } from "@/lib/blob";
import { buildContextBlob, type ContextItem } from "./context";
import { combineAndSort, formatRowsForPrompt, parseLogCsv, pickRelevantRows, type LogRow } from "./logs";
import {
  looksLikeManifest,
  parseManifest,
  validateManifest,
  type ManifestPayload,
  type ManifestValidation,
  type ParsedManifest,
} from "./manifest";

export type FileRef = {
  filename: string;
  kind: "LOG" | "CONTEXT" | "MANIFEST";
  blobUrl: string;
};

export interface AssembledPrompt {
  manifestBlock: string;
  manifestValidation: string;
  contextBlob: string;
  logBlob: string;
  stats: {
    totalLogRows: number;
    selectedLogRows: number;
    contextItems: number;
    logFiles: number;
    manifestPresent: boolean;
    validation?: ManifestValidation;
  };
}

export async function assemblePromptFromFiles(
  files: FileRef[],
  question: string
): Promise<AssembledPrompt> {
  // Fetch all in parallel
  const fileContents = await Promise.all(
    files.map(async (f) => ({
      ...f,
      text: await fetchBlobText(f.blobUrl),
    }))
  );

  // Detect manifest (prefer MANIFEST kind; otherwise sniff JSON context files)
  let manifest: ParsedManifest | null = null;

  const manifestCandidates = fileContents.filter(
    (f) => f.kind === "MANIFEST" || (f.kind === "CONTEXT" && f.filename.toLowerCase().endsWith(".json"))
  );
  for (const f of manifestCandidates) {
    try {
      const payload = JSON.parse(f.text) as ManifestPayload;
      if (looksLikeManifest(f.filename, payload)) {
        manifest = parseManifest(f.filename, payload);
        break;
      }
    } catch {
      // not JSON or malformed — skip
    }
  }

  // Build context items (TXT + JSON that are not the manifest)
  const contextItems: ContextItem[] = [];
  for (const f of fileContents) {
    if (f.kind !== "CONTEXT" && f.kind !== "MANIFEST") continue;
    if (manifest && f.filename === manifest.filename) continue;

    if (f.filename.toLowerCase().endsWith(".json")) {
      // Pretty-print JSON for the model
      try {
        contextItems.push({ filename: f.filename, type: "json", text: JSON.stringify(JSON.parse(f.text), null, 2) });
      } catch {
        contextItems.push({ filename: f.filename, type: "text", text: f.text });
      }
    } else {
      contextItems.push({ filename: f.filename, type: "text", text: f.text });
    }
  }

  // Parse log CSVs (respecting manifest scope if present)
  let logFiles = fileContents.filter((f) => f.kind === "LOG");
  if (manifest && manifest.logFilesNorm.length) {
    const wanted = new Set(manifest.logFilesNorm.map((s) => s.split("/").pop()!.toLowerCase()));
    const filtered = logFiles.filter((f) => wanted.has(f.filename.toLowerCase()));
    if (filtered.length) logFiles = filtered;
  }

  const parsedLogs = logFiles.map((f) => parseLogCsv(f.filename, f.text));
  const allRows: LogRow[] = combineAndSort(parsedLogs);
  const selected = pickRelevantRows(allRows, question);

  const logBlob = formatRowsForPrompt(selected);
  const contextBlob = buildContextBlob(contextItems);

  let manifestBlock = "(not provided)";
  let manifestValidationText = "";
  let validation: ManifestValidation | undefined;

  if (manifest) {
    manifestBlock = manifest.text;
    validation = validateManifest(
      manifest,
      logFiles.map((f) => f.filename),
      contextItems.map((f) => f.filename)
    );
    manifestValidationText = `\n${validation.text}\n`;
  }

  return {
    manifestBlock,
    manifestValidation: manifestValidationText,
    contextBlob,
    logBlob,
    stats: {
      totalLogRows: allRows.length,
      selectedLogRows: selected.length,
      contextItems: contextItems.length,
      logFiles: logFiles.length,
      manifestPresent: !!manifest,
      validation,
    },
  };
}

export const SYSTEM_PROMPT = `You are LogIQ, an assistant that helps engineers investigate production incidents using logs and attached artifacts.

Guidelines:
- When a manifest is present, treat it as authoritative scope/metadata. If scope mismatches, call it out.
- Prefer evidence over speculation. If you are uncertain, state what would confirm or deny each hypothesis.
- Do not invent details that aren't supported by the provided data.
- Include inline citations using the provided log line prefixes (e.g., [file.csv] [timestamp] ...). Cite the specific lines that support each claim.
- Respond in clean markdown with these sections:
  1) **Summary** (3-5 bullets)
  2) **Scope** (based on manifest; note missing/extra if relevant)
  3) **Timeline** (5-12 key events with citations)
  4) **Hypotheses** (2-4) with evidence + how to confirm/deny
  5) **Recommended next actions** (prioritized)
  6) **Additional artifacts that would increase confidence**`;

export function buildUserPrompt(args: {
  question: string;
  manifestBlock: string;
  manifestValidation: string;
  contextBlob: string;
  logBlob: string;
}): string {
  return [
    `Question:`,
    args.question.trim(),
    ``,
    `Manifest:`,
    args.manifestBlock.trim(),
    args.manifestValidation.trim() ? `\n${args.manifestValidation.trim()}\n` : "",
    `Context:`,
    args.contextBlob.trim() || "(none)",
    ``,
    `Logs (citeable lines):`,
    args.logBlob.trim() || "(none)",
  ].join("\n");
}
