/**
 * Provider abstraction for "Fast mode" — a single-shot, no-tools, streaming
 * answer from a cheaper/faster model than the Claude agentic loop used in
 * "Deep mode".
 *
 * Both OpenRouter and Hugging Face expose an OpenAI-compatible
 * /chat/completions endpoint with SSE streaming, so a single parser serves
 * both. Pick the provider with FAST_PROVIDER; pick the model with FAST_MODEL.
 */

type ProviderName = "openrouter" | "huggingface";

interface FastProviderConfig {
  provider: ProviderName;
  baseUrl: string;
  apiKey: string;
  keyEnvName: string;
  model: string;
  extraHeaders: Record<string, string>;
}

const DEFAULTS: Record<ProviderName, { baseUrl: string; keyEnvName: string; model: string }> = {
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    keyEnvName: "OPENROUTER_API_KEY",
    model: "openai/gpt-4o-mini",
  },
  huggingface: {
    baseUrl: "https://router.huggingface.co/v1/chat/completions",
    keyEnvName: "HF_TOKEN",
    model: "meta-llama/Llama-3.1-8B-Instruct",
  },
};

export function getFastProviderConfig(): FastProviderConfig {
  const provider = (process.env.FAST_PROVIDER as ProviderName) || "openrouter";
  const base = DEFAULTS[provider] ?? DEFAULTS.openrouter;
  const resolved = provider in DEFAULTS ? provider : "openrouter";

  const extraHeaders: Record<string, string> =
    resolved === "openrouter"
      ? {
          // OpenRouter uses these for attribution/rankings; harmless if unset upstream.
          "HTTP-Referer": process.env.AUTH_URL || "http://localhost:3000",
          "X-Title": "LogIQ",
        }
      : {};

  return {
    provider: resolved,
    baseUrl: base.baseUrl,
    apiKey: process.env[base.keyEnvName] || "",
    keyEnvName: base.keyEnvName,
    model: process.env.FAST_MODEL || base.model,
    extraHeaders,
  };
}

/** Human-readable label for stamping into message metadata. */
export function fastModelLabel(): string {
  const cfg = getFastProviderConfig();
  return `${cfg.provider}:${cfg.model}`;
}

export interface FastStreamArgs {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Stream a fast completion as text deltas. Yields incremental content strings.
 * Throws with a clear message if the provider key is missing or the request fails.
 */
export async function* streamFast(args: FastStreamArgs): AsyncGenerator<string, void, unknown> {
  const cfg = getFastProviderConfig();
  if (!cfg.apiKey) {
    throw new Error(`Fast mode provider "${cfg.provider}" is not configured: set ${cfg.keyEnvName}.`);
  }

  const res = await fetch(cfg.baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
      ...cfg.extraHeaders,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: "system", content: args.system },
        { role: "user", content: args.user },
      ],
      stream: true,
      temperature: args.temperature ?? 0.2,
      max_tokens: args.maxTokens ?? 1500,
    }),
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Fast provider (${cfg.provider}) returned ${res.status}: ${detail.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are newline-delimited "data: {...}" lines.
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const json = JSON.parse(data) as {
          choices?: { delta?: { content?: string } }[];
        };
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // keepalive / partial frame — ignore
      }
    }
  }
}
