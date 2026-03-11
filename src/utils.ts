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
export function describeADV(arousal: number, dominance: number, valence: number): string {
    const label = (value: number, scale: readonly string[]): string => {
        if (value <= 1.5) return scale[0];
        if (value <= 2.5) return scale[1];
        if (value <= 3.5) return scale[2];
        if (value <= 4.5) return scale[3];
        return scale[4];
    };

    const arousalWord = label(arousal, ["very calm", "calm", "moderate energy", "energized", "very intense"] as const);
    const valenceWord = label(valence, ["very negative", "negative", "neutral", "positive", "very positive"] as const);
    const dominanceWord = label(dominance, ["submissive", "yielding", "balanced", "assertive", "dominant"] as const);

    return `${arousalWord}, ${valenceWord}, ${dominanceWord}`;
}

/** Image file extensions recognized for photo sending. */
export const IMAGE_EXTENSIONS = new Set([
    "jpg", "jpeg", "png", "gif", "webp",
]);

/** Maximum characters for OpenAI TTS input. */
export const OPENAI_TTS_MAX_CHARS = 4096;
