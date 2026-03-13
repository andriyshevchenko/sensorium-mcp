/**
 * Shared utility functions.
 */

/**
 * Extract a human-readable message from an unknown error value.
 */
export function errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    try {
        return JSON.stringify(err);
    } catch {
        return String(err);
    }
}

/**
 * Build a standard MCP error response object.
 */
export function errorResult(text: string): {
    content: [{ type: "text"; text: string }];
    isError: true;
} {
    return { content: [{ type: "text", text }], isError: true };
}


/**
 * Map arousal/dominance/valence scores (1–5) to human-readable descriptors
 * based on Russell's circumplex model of affect.
 *
 * Returns a compact string like "calm, neutral, balanced".
 */
/**
 * Describe arousal/dominance/valence as human-readable text.
 * Accepts values on 0-1 scale (v2 audeering models) or 1-5 scale (v1 lookup).
 * Auto-detects scale: values > 1 are treated as 1-5 and normalized to 0-1.
 */
export function describeADV(arousal: number, dominance: number, valence: number): string {
    // Normalize 1-5 scale to 0-1 if needed (backward compat with v1 fallback)
    const norm = (v: number) => v > 1 ? (v - 1) / 4 : v;
    const a = norm(arousal);
    const d = norm(dominance);
    const v = norm(valence);

    const label = (value: number, scale: readonly string[]): string => {
        if (value <= 0.2) return scale[0];
        if (value <= 0.4) return scale[1];
        if (value <= 0.6) return scale[2];
        if (value <= 0.8) return scale[3];
        return scale[4];
    };

    const arousalWord = label(a, ["very calm", "calm", "moderate energy", "energized", "very intense"] as const);
    const valenceWord = label(v, ["very negative", "negative", "neutral", "positive", "very positive"] as const);
    const dominanceWord = label(d, ["submissive", "yielding", "balanced", "assertive", "dominant"] as const);

    return `${arousalWord}, ${valenceWord}, ${dominanceWord}`;
}

/** Image file extensions recognized for photo sending. */
export const IMAGE_EXTENSIONS = new Set([
    "jpg", "jpeg", "png", "gif", "webp",
]);

/** Maximum characters for OpenAI TTS input. */
export const OPENAI_TTS_MAX_CHARS = 4096;
