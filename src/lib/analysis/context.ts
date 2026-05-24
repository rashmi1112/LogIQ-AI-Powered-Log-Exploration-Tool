import { DEFAULTS } from "./logs";

export interface ContextItem {
  filename: string;
  type: "text" | "json";
  text: string;
}

export function buildContextBlob(items: ContextItem[], maxChars = DEFAULTS.CONTEXT_CHARS): string {
  const parts: string[] = [];
  let total = 0;

  for (const it of items) {
    const header = `\n--- ${it.filename} ---\n`;
    const body = (it.text || "").trim();
    const chunk = `${header}${body}\n`;

    if (total + chunk.length > maxChars) {
      const remaining = Math.max(0, maxChars - total);
      if (remaining > header.length + 50) {
        parts.push(`${header}${body.slice(0, remaining - header.length)}\n...\n`);
      }
      break;
    }
    parts.push(chunk);
    total += chunk.length;
  }

  return parts.join("").trim();
}
