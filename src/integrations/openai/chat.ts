/**
 * Chat completion and embedding functions using the OpenAI API.
 *
 * Extracted from openai.ts to keep that module focused on
 * voice / vision services while this module handles text-level
 * AI calls (chat completions, embeddings, cosine similarity).
 */

// ─── Chat Completion (lightweight GPT-4o-mini calls) ──────────────────────

export interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

/**
 * Lightweight chat completion using GPT-4o-mini.
 * Used for context preprocessing, not for agent dialogue.
 * Returns the assistant's text response.
 * Retries on 429/5xx with exponential backoff (up to 3 attempts).
 */
export async function chatCompletion(
    messages: ChatMessage[],
    apiKey: string,
    options?: {
        maxTokens?: number;
        temperature?: number;
        timeoutMs?: number;
        model?: string;
        responseFormat?: { type: string };
    },
): Promise<string> {
    const body: Record<string, unknown> = {
        model: options?.model ?? "gpt-4o-mini",
        messages,
        max_completion_tokens: options?.maxTokens ?? 300,
        temperature: options?.temperature ?? 0,
    };
    if (options?.responseFormat) {
        body.response_format = options.responseFormat;
    }
    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? 15_000);
        try {
            const response = await fetch("https://api.openai.com/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            if (response.status === 429 || response.status >= 500) {
                if (attempt < MAX_RETRIES - 1) {
                    const retryAfter = parseInt(response.headers.get("retry-after") ?? "", 10);
                    const delayMs = (Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000 * 2 ** attempt)
                        + Math.random() * 500;
                    await new Promise(r => setTimeout(r, delayMs));
                    continue;
                }
            }
            if (!response.ok) {
                throw new Error(`OpenAI chat API error: ${response.status} ${response.statusText}`);
            }
            const json = await response.json() as {
                choices?: { message?: { content?: string } }[];
            };
            return json.choices?.[0]?.message?.content ?? "";
        } finally {
            clearTimeout(timer);
        }
    }
    throw new Error("OpenAI chat API: max retries exhausted");
}

// ─── Embeddings ───────────────────────────────────────────────────────────

/**
 * Generate an embedding vector for text using OpenAI's text-embedding-3-small model.
 * Returns a Float32Array of 1536 dimensions.
 */
export async function generateEmbedding(text: string, apiKey: string): Promise<Float32Array> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
        const response = await fetch("https://api.openai.com/v1/embeddings", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: "text-embedding-3-small",
                input: text.slice(0, 8000), // model supports 8191 tokens
            }),
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(`OpenAI embedding API error: ${response.status} ${response.statusText}`);
        }
        const json = await response.json() as { data?: { embedding?: number[] }[] };
        const embedding = json.data?.[0]?.embedding;
        if (!embedding) {
            throw new Error("OpenAI embedding response missing data[0].embedding");
        }
        return new Float32Array(embedding);
    } finally {
        clearTimeout(timer);
    }
}

// ─── Vector Similarity ───────────────────────────────────────────────────

/** Compute cosine similarity between two embedding vectors. Returns value in [-1, 1]. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}
