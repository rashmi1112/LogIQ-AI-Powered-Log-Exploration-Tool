/**
 * Manifest parsing and validation.
 * Port of the Python reference: archive/python-prototype/logiq.py
 */

const MANIFEST_LOG_KEYS = ["log_files", "logs", "logFiles", "log_file_list"] as const;
const MANIFEST_CONTEXT_KEYS = ["context_files", "context", "contextFiles", "context_file_list"] as const;

export interface ManifestPayload {
  case_id?: string;
  job_id?: string;
  catalog?: string;
  hypervisor?: string;
  failed_machines?: string[];
  log_files?: string[];
  context_files?: string[];
  [key: string]: unknown;
}

export interface ParsedManifest {
  filename: string;
  payload: ManifestPayload;
  text: string;
  logFilesNorm: string[];
  contextFilesNorm: string[];
}

export interface ManifestValidation {
  ok: boolean;
  text: string;
  missingLogs: string[];
  extraLogs: string[];
  missingContext: string[];
  extraContext: string[];
}

function normalizeFilename(name: string): string {
  return name.replace(/\\/g, "/").trim().toLowerCase();
}

function firstList(payload: Record<string, unknown>, keys: readonly string[]): string[] {
  for (const k of keys) {
    const v = payload[k];
    if (Array.isArray(v)) return v.map(String);
  }
  return [];
}

export function looksLikeManifest(filename: string, payload: ManifestPayload): boolean {
  const fn = filename.toLowerCase();
  if (fn.includes("manifest")) return true;

  const hasIds = ["case_id", "job_id", "catalog"].some((k) => k in payload);
  const hasLists =
    firstList(payload as Record<string, unknown>, MANIFEST_LOG_KEYS).length > 0 ||
    firstList(payload as Record<string, unknown>, MANIFEST_CONTEXT_KEYS).length > 0;
  return hasIds && hasLists;
}

export function parseManifest(filename: string, payload: ManifestPayload): ParsedManifest {
  const logs = firstList(payload as Record<string, unknown>, MANIFEST_LOG_KEYS).map(normalizeFilename);
  const ctx = firstList(payload as Record<string, unknown>, MANIFEST_CONTEXT_KEYS).map(normalizeFilename);

  return {
    filename,
    payload,
    text: manifestToText(payload),
    logFilesNorm: logs,
    contextFilesNorm: ctx,
  };
}

export function manifestToText(payload: ManifestPayload): string {
  const lines: string[] = ["Manifest summary:"];

  for (const k of ["case_id", "job_id", "catalog", "hypervisor"] as const) {
    if (payload[k]) lines.push(`- ${k}: ${payload[k]}`);
  }

  if (payload.failed_machines && Array.isArray(payload.failed_machines)) {
    const fm = payload.failed_machines;
    const preview = fm.slice(0, 20).join(", ");
    lines.push(`- failed_machines: ${fm.length} -> ${preview}${fm.length > 20 ? " ..." : ""}`);
  }

  const logs = firstList(payload as Record<string, unknown>, MANIFEST_LOG_KEYS);
  const ctx = firstList(payload as Record<string, unknown>, MANIFEST_CONTEXT_KEYS);

  if (logs.length) {
    lines.push(`- log_files: ${logs.length}`);
    logs.slice(0, 50).forEach((f) => lines.push(`  - ${f}`));
    if (logs.length > 50) lines.push("  - ...");
  }

  if (ctx.length) {
    lines.push(`- context_files: ${ctx.length}`);
    ctx.slice(0, 50).forEach((f) => lines.push(`  - ${f}`));
    if (ctx.length > 50) lines.push("  - ...");
  }

  return lines.join("\n");
}

export function validateManifest(
  manifest: ParsedManifest,
  actualLogs: string[],
  actualContext: string[]
): ManifestValidation {
  const wantedLogs = new Set(manifest.logFilesNorm.map((s) => s.split("/").pop()!.toLowerCase()));
  const actualLogSet = new Set(actualLogs.map((s) => s.toLowerCase()));
  const missingLogs = [...wantedLogs].filter((x) => !actualLogSet.has(x)).sort();
  const extraLogs = [...actualLogSet].filter((x) => !wantedLogs.has(x)).sort();

  const wantedCtx = new Set(manifest.contextFilesNorm.map((s) => s.split("/").pop()!.toLowerCase()));
  const actualCtxSet = new Set(actualContext.map((s) => s.toLowerCase()));
  const missingCtx = [...wantedCtx].filter((x) => !actualCtxSet.has(x)).sort();
  const extraCtx = [...actualCtxSet].filter((x) => !wantedCtx.has(x)).sort();

  const ok = !missingLogs.length && !missingCtx.length;
  const lines: string[] = ["Manifest check:"];

  if (wantedLogs.size) {
    if (!missingLogs.length && !extraLogs.length) lines.push("- logs: match manifest");
    else {
      if (missingLogs.length) {
        lines.push(`- logs missing: ${missingLogs.length}`);
        missingLogs.slice(0, 20).forEach((m) => lines.push(`  - ${m}`));
      }
      if (extraLogs.length) {
        lines.push(`- logs extra: ${extraLogs.length}`);
        extraLogs.slice(0, 20).forEach((e) => lines.push(`  - ${e}`));
      }
    }
  }

  if (wantedCtx.size) {
    if (!missingCtx.length && !extraCtx.length) lines.push("- context: match manifest");
    else {
      if (missingCtx.length) {
        lines.push(`- context missing: ${missingCtx.length}`);
        missingCtx.slice(0, 20).forEach((m) => lines.push(`  - ${m}`));
      }
      if (extraCtx.length) {
        lines.push(`- context extra: ${extraCtx.length}`);
        extraCtx.slice(0, 20).forEach((e) => lines.push(`  - ${e}`));
      }
    }
  }

  return {
    ok,
    text: lines.join("\n"),
    missingLogs,
    extraLogs,
    missingContext: missingCtx,
    extraContext: extraCtx,
  };
}
