/**
 * OpenAI vision services: video frame analysis (GPT-4o-mini).
 *
 * Extracted from openai.ts for modular decomposition (Phase 3C).
 */

import { MAX_FRAMES } from "./video.js";

// ─── Video Frame Vision Analysis ──────────────────────────────────────────

/**
 * Analyze video frames using OpenAI GPT-4o-mini vision.
 * @param frames     Array of JPEG frame buffers.
 * @param durationSec  Video duration for timestamp context.
 * @param apiKey     OpenAI API key.
 * @returns Human-readable description of the video content.
 */
export async function analyzeVideoFrames(
    frames: Buffer[],
    durationSec: number,
    apiKey: string,
): Promise<string> {
    if (frames.length === 0) {
        return "(no frames could be extracted from the video)";
    }

    const interval = Math.max(1, Math.ceil(durationSec / MAX_FRAMES));
    const timestamps = frames.map((_, i) => `${i * interval}s`).join(", ");

    // Build multi-image content array.
    type ContentPart =
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string; detail: "low" | "high" } };

    const content: ContentPart[] = [
        {
            type: "text",
            text: `These are ${frames.length} sequential frames extracted from a ${durationSec}s video message at timestamps: [${timestamps}]. ` +
                `Describe what is happening in the video concisely (2-3 sentences). ` +
                `Note any people, actions, objects, movement, text, or scene changes.`,
        },
        ...frames.map((frame): ContentPart => ({
            type: "image_url",
            image_url: {
                url: `data:image/jpeg;base64,${frame.toString("base64")}`,
                detail: "low", // circle videos are small (240-384px)
            },
        })),
    ];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [{ role: "user", content }],
                max_completion_tokens: 300,
            }),
            signal: controller.signal,
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => response.statusText);
            throw new Error(`OpenAI vision analysis failed: ${response.status} ${errText}`);
        }

        const result = (await response.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
        };
        return result.choices?.[0]?.message?.content?.trim() ?? "(no description generated)";
    } finally {
        clearTimeout(timer);
    }
}
