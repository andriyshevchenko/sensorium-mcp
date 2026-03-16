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
        return JSON.stringify(err) ?? String(err);
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
 *
 * Thresholds are calibrated to the audeering model's output distribution,
 * which is trained on MSP-Podcast (original 1-7 Likert scale normalized to 0-1).
 * Neutral calm speech typically outputs ~0.2 across all three dimensions.
 */
export function describeADV(arousal: number, dominance: number, valence: number): string {
    // Normalize 1-5 scale to 0-1 if needed (backward compat with v1 fallback).
    // Values > 1.0 are on the 1-5 scale; values in [0, 1.0] are already normalized.
    // Note: 1.0 exactly is ambiguous but treated as 0-1 scale (= maximum),
    // which is correct since 1.0 on 1-5 would mean "minimum" and that score
    // only appears from the v1 fallback which always returns > 1.
    const norm = (v: number) => v > 1.0 ? (v - 1) / 4 : v;
    const a = norm(arousal);
    const d = norm(dominance);
    const v = norm(valence);

    const label = (value: number, scale: readonly string[]): string => {
        if (value <= 0.17) return scale[0];
        if (value <= 0.35) return scale[1];
        if (value <= 0.55) return scale[2];
        if (value <= 0.73) return scale[3];
        return scale[4];
    };

    const arousalWord = label(a, ["very calm", "calm", "moderate energy", "energized", "very intense"] as const);
    const valenceWord = label(v, ["very subdued", "restrained", "neutral", "warm", "very expressive"] as const);
    const dominanceWord = label(d, ["very soft-spoken", "reserved", "balanced", "assertive", "commanding"] as const);

    return `${arousalWord}, ${valenceWord}, ${dominanceWord}`;
}

/** Image file extensions recognized for photo sending. */
export const IMAGE_EXTENSIONS = new Set([
    "jpg", "jpeg", "png", "gif", "webp",
]);

/** Maximum characters for OpenAI TTS input. */
export const OPENAI_TTS_MAX_CHARS = 4096;
