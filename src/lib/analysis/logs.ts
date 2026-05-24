/**
 * CSV log parsing and keyword/error-biased relevance scoring.
 * Port of the Python reference: archive/python-prototype/logiq.py
 */
import { parse } from "csv-parse/sync";

export const DEFAULTS = {
  MAX_ROWS: 1200,
  ERROR_ROWS: 450,
  STACK_ROWS: 250,
  RECENT_ROWS: 350,
  KW_ROWS: 250,
  CONTEXT_CHARS: 14000,
};

const TIME_COL = "Time";
const CPU_COL = "CPU";
const MSG_COL = "Message";
const COMMENTS_COL = "Comments";
const LEVEL_COL = "Level";
const MODULE_COL = "Module";

const TRACE_RE = /(trace[-_ ]?id|correlation[-_ ]?id|request[-_ ]?id)\s*[:=]\s*([A-Za-z0-9\-_.]+)/i;
const STACK_HINT_RE = /(Exception|StackTrace|at\s+[A-Za-z0-9_.]+\(|System\.)/;

export interface LogRow {
  sourceFile: string;
  rowId: number;
  ts: string;
  tsParsed: number | null; // epoch ms
  message: string;
  comments: string;
  level: string;
  cpu: string;
  module: string;
}

export interface ParsedLogFile {
  filename: string;
  rows: LogRow[];
}

export function parseLogCsv(filename: string, csvText: string): ParsedLogFile {
  // Permissive parsing: ignore inconsistent column counts so a slightly malformed row
  // doesn't kill the whole file.
  let records: Record<string, string>[];
  try {
    records = parse(csvText, {
      columns: (header) => header.map((c: string) => c.trim()),
      skip_empty_lines: true,
      relax_quotes: true,
      relax_column_count: true,
      trim: true,
      bom: true,
    }) as Record<string, string>[];
  } catch {
    // Fallback: parse without strict columns
    records = [];
  }

  const rows: LogRow[] = records.map((r, i) => {
    const ts = (r[TIME_COL] ?? "").trim();
    const parsed = ts ? Date.parse(ts) : NaN;
    return {
      sourceFile: filename,
      rowId: i,
      ts,
      tsParsed: Number.isFinite(parsed) ? parsed : null,
      message: (r[MSG_COL] ?? "").toString(),
      comments: (r[COMMENTS_COL] ?? "").toString(),
      level: (r[LEVEL_COL] ?? "").toString(),
      cpu: (r[CPU_COL] ?? "").toString(),
      module: (r[MODULE_COL] ?? "").toString(),
    };
  });

  return { filename, rows };
}

export function combineAndSort(files: ParsedLogFile[]): LogRow[] {
  const all = files.flatMap((f) => f.rows);
  all.sort((a, b) => {
    if (a.tsParsed != null && b.tsParsed != null) return a.tsParsed - b.tsParsed;
    if (a.tsParsed == null && b.tsParsed != null) return 1;
    if (a.tsParsed != null && b.tsParsed == null) return -1;
    return a.rowId - b.rowId;
  });
  return all;
}

function extractKeywords(question: string): string[] {
  const tokens = question
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length >= 4);
  return Array.from(new Set(tokens)).slice(0, 18);
}

function rowScore(row: LogRow, keywords: string[]): number {
  if (!keywords.length) return 0;
  const text = `${row.message} ${row.comments} ${row.module}`.toLowerCase();
  let s = 0;
  for (const k of keywords) if (text.includes(k)) s++;
  return s;
}

const ERRORISH_MSG_RE = /error|fail|timeout|exception/i;
const ERRORISH_LEVEL_RE = /ERROR|FATAL|WARN/;
const STACK_MSG_RE = /Exception|StackTrace|timeout/i;

export function pickRelevantRows(
  all: LogRow[],
  question: string,
  opts: Partial<typeof DEFAULTS> = {}
): LogRow[] {
  const {
    MAX_ROWS = DEFAULTS.MAX_ROWS,
    ERROR_ROWS = DEFAULTS.ERROR_ROWS,
    STACK_ROWS = DEFAULTS.STACK_ROWS,
    RECENT_ROWS = DEFAULTS.RECENT_ROWS,
    KW_ROWS = DEFAULTS.KW_ROWS,
  } = opts;

  const keywords = extractKeywords(question);

  const recent = all.slice(Math.max(0, all.length - RECENT_ROWS));

  const isErrorish = (r: LogRow) =>
    ERRORISH_LEVEL_RE.test(r.level.toUpperCase()) ||
    ERRORISH_MSG_RE.test(r.message) ||
    ERRORISH_MSG_RE.test(r.comments);

  const isStackish = (r: LogRow) =>
    TRACE_RE.test(r.comments) || STACK_HINT_RE.test(r.comments) || STACK_MSG_RE.test(r.message);

  const errish = all.filter(isErrorish);
  errish.sort((a, b) => rowScore(b, keywords) - rowScore(a, keywords));
  const errBucket = errish.slice(0, ERROR_ROWS);

  const stackish = all.filter(isStackish);
  stackish.sort((a, b) => rowScore(b, keywords) - rowScore(a, keywords));
  const stackBucket = stackish.slice(0, STACK_ROWS);

  let kwBucket: LogRow[] = [];
  if (keywords.length) {
    kwBucket = all
      .map((r) => ({ r, s: rowScore(r, keywords) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, KW_ROWS)
      .map((x) => x.r);
  }

  // De-duplicate by (sourceFile, rowId)
  const seen = new Set<string>();
  const combined: LogRow[] = [];
  for (const r of [...recent, ...errBucket, ...stackBucket, ...kwBucket]) {
    const key = `${r.sourceFile}#${r.rowId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    combined.push(r);
  }

  // Sort chronologically + by rowId for stable output
  combined.sort((a, b) => {
    if (a.tsParsed != null && b.tsParsed != null) return a.tsParsed - b.tsParsed;
    return a.rowId - b.rowId;
  });

  return combined.slice(-MAX_ROWS);
}

export function formatRowsForPrompt(rows: LogRow[]): string {
  const lines: string[] = [];
  for (const r of rows) {
    let cmt = r.comments.trim();
    if (cmt.length > 500) cmt = cmt.slice(0, 500) + " …";

    let line = `[${r.sourceFile}] [${r.ts}] [${r.level.trim()}] [${r.module.trim()}]`;
    if (r.cpu.trim()) line += ` [CPU=${r.cpu.trim()}]`;
    line += ` msg=${r.message.trim()}`;
    if (cmt) line += ` | comments=${cmt}`;
    lines.push(line);
  }
  return lines.join("\n");
}
