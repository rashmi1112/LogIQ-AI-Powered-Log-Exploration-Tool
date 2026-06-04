/**
 * Tool definitions for the agentic analysis loop.
 *
 *  - search_logs:     lets Claude query the full parsed log set on demand,
 *                     instead of being limited to a one-shot pre-selected slice.
 *  - submit_analysis: forces a typed, structured final report the UI can render
 *                     as cards (summary / timeline / hypotheses / next actions).
 */
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { formatRowsForPrompt, type LogRow } from "./logs";

// ---------------- search_logs ----------------

export const SearchLogsInput = z.object({
  pattern: z
    .string()
    .min(1)
    .max(200)
    .describe("Substring or case-insensitive regex matched against message, comments, and module."),
  file: z.string().max(200).optional().describe("Only match rows whose source filename contains this string."),
  level: z.string().max(40).optional().describe("Only match rows whose level contains this (e.g. ERROR, WARN, FATAL)."),
  after: z.string().max(60).optional().describe("ISO timestamp lower bound (inclusive)."),
  before: z.string().max(60).optional().describe("ISO timestamp upper bound (inclusive)."),
  limit: z.number().int().min(1).max(200).optional().describe("Max rows to return. Defaults to 50."),
});
export type SearchLogsInput = z.infer<typeof SearchLogsInput>;

const SEARCH_DEFAULT_LIMIT = 50;
const SEARCH_MAX_LIMIT = 200;

export interface SearchLogsResult {
  text: string;
  matched: number;
  returned: number;
}

/** Execute a search against the in-memory log rows. Pure + synchronous. */
export function runSearchLogs(allRows: LogRow[], input: SearchLogsInput): SearchLogsResult {
  // Compile the pattern as a regex when possible, else fall back to substring.
  let regex: RegExp | null = null;
  try {
    regex = new RegExp(input.pattern, "i");
  } catch {
    regex = null;
  }
  const needle = input.pattern.toLowerCase();
  const fileNeedle = input.file?.toLowerCase();
  const levelNeedle = input.level?.toLowerCase();
  const after = input.after ? Date.parse(input.after) : NaN;
  const before = input.before ? Date.parse(input.before) : NaN;
  const limit = Math.min(input.limit ?? SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT);

  const matches = allRows.filter((r) => {
    if (fileNeedle && !r.sourceFile.toLowerCase().includes(fileNeedle)) return false;
    if (levelNeedle && !r.level.toLowerCase().includes(levelNeedle)) return false;
    if (Number.isFinite(after) && (r.tsParsed == null || r.tsParsed < after)) return false;
    if (Number.isFinite(before) && (r.tsParsed == null || r.tsParsed > before)) return false;

    const hay = `${r.message} ${r.comments} ${r.module}`;
    return regex ? regex.test(hay) : hay.toLowerCase().includes(needle);
  });

  const returned = matches.slice(0, limit);
  const body = returned.length ? formatRowsForPrompt(returned) : "(no matching log lines)";
  const header =
    `Matched ${matches.length} line(s); returning ${returned.length}` +
    (matches.length > returned.length ? ` (raise "limit" or narrow the query to see more).` : ".");

  return { text: `${header}\n\n${body}`, matched: matches.length, returned: returned.length };
}

// ---------------- submit_analysis ----------------

export const ConfidenceEnum = z.enum(["high", "medium", "low"]);
export const PriorityEnum = z.enum(["high", "medium", "low"]);

export const SubmitAnalysisInput = z.object({
  summary: z.array(z.string()).min(1).max(8).describe("3-5 plain-language bullets covering what happened."),
  scope: z.string().optional().describe("Scope assessment based on the manifest; note missing/extra artifacts."),
  timeline: z
    .array(
      z.object({
        timestamp: z.string().describe("Timestamp of the event, copied from the log line."),
        event: z.string().describe("What happened."),
        citation: z.string().describe("The log line prefix that supports this, e.g. [file.csv] [ts]."),
      })
    )
    .max(15)
    .describe("Key events in chronological order, each backed by a citation."),
  hypotheses: z
    .array(
      z.object({
        claim: z.string(),
        confidence: ConfidenceEnum,
        evidence: z.array(z.string()).describe("Citations / log lines supporting the claim."),
        how_to_confirm: z.string().describe("What would confirm or deny this hypothesis."),
      })
    )
    .min(1)
    .max(5),
  next_actions: z
    .array(z.object({ action: z.string(), priority: PriorityEnum }))
    .min(1)
    .max(8),
  additional_artifacts: z
    .array(z.string())
    .optional()
    .describe("Other artifacts that would increase confidence, if any."),
});
export type SubmitAnalysisInput = z.infer<typeof SubmitAnalysisInput>;

// ---------------- Anthropic tool specs ----------------

export const ANALYSIS_TOOLS: Anthropic.Tool[] = [
  {
    name: "search_logs",
    description:
      "Search the full set of parsed log lines on demand. Use this to dig deeper than the seed lines in the prompt: " +
      "look up specific errors, trace IDs, time windows, or files. Returns matching log lines you can cite.",
    input_schema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Substring or case-insensitive regex matched against message, comments, and module.",
        },
        file: { type: "string", description: "Only match rows whose source filename contains this string." },
        level: { type: "string", description: "Only match rows whose level contains this (e.g. ERROR, WARN, FATAL)." },
        after: { type: "string", description: "ISO timestamp lower bound (inclusive)." },
        before: { type: "string", description: "ISO timestamp upper bound (inclusive)." },
        limit: { type: "integer", description: "Max rows to return. Defaults to 50, max 200." },
      },
      required: ["pattern"],
    },
  },
  {
    name: "submit_analysis",
    description:
      "Submit the final structured investigation report. Call this exactly once, after you have gathered enough " +
      "evidence (using search_logs as needed). This is the only way to deliver your conclusions to the user.",
    input_schema: {
      type: "object",
      properties: {
        summary: {
          type: "array",
          items: { type: "string" },
          description: "3-5 plain-language bullets covering what happened.",
        },
        scope: { type: "string", description: "Scope assessment based on the manifest; note missing/extra artifacts." },
        timeline: {
          type: "array",
          items: {
            type: "object",
            properties: {
              timestamp: { type: "string" },
              event: { type: "string" },
              citation: { type: "string", description: "Log line prefix that supports this, e.g. [file.csv] [ts]." },
            },
            required: ["timestamp", "event", "citation"],
          },
          description: "Key events in chronological order, each backed by a citation.",
        },
        hypotheses: {
          type: "array",
          items: {
            type: "object",
            properties: {
              claim: { type: "string" },
              confidence: { type: "string", enum: ["high", "medium", "low"] },
              evidence: { type: "array", items: { type: "string" } },
              how_to_confirm: { type: "string" },
            },
            required: ["claim", "confidence", "evidence", "how_to_confirm"],
          },
        },
        next_actions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              action: { type: "string" },
              priority: { type: "string", enum: ["high", "medium", "low"] },
            },
            required: ["action", "priority"],
          },
        },
        additional_artifacts: { type: "array", items: { type: "string" } },
      },
      required: ["summary", "timeline", "hypotheses", "next_actions"],
    },
  },
];
