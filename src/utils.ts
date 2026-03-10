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
 * Build a standard MCP success response object.
 */
export function successResult(text: string): {
    content: [{ type: "text"; text: string }];
} {
    return { content: [{ type: "text", text }] };
}

/** Image file extensions recognized for photo sending. */
export const IMAGE_EXTENSIONS = new Set([
    "jpg", "jpeg", "png", "gif", "webp",
]);

/** Maximum characters for OpenAI TTS input. */
export const OPENAI_TTS_MAX_CHARS = 4096;
