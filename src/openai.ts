/**
 * OpenAI API facade — re-exports all OpenAI-related functions from
 * their dedicated modules under integrations/openai/.
 *
 * Kept as the single import path so existing consumers don't break.
 */

// Re-export chat completion + embedding functions
export { chatCompletion, cosineSimilarity, generateEmbedding } from "./integrations/openai/chat.js";
export type { ChatMessage } from "./integrations/openai/chat.js";

// Re-export TTS & transcription
export { TTS_VOICES, type TTSVoice, textToSpeech, transcribeAudio } from "./integrations/openai/speech.js";

// Re-export voice emotion analysis
export { analyzeVoiceEmotion } from "./integrations/openai/voice-emotion.js";
export type { AudioEvent, Paralinguistics, VoiceAnalysisResult } from "./integrations/openai/voice-emotion.js";

// Re-export video frame extraction & analysis
export { extractVideoFrames, analyzeVideoFrames } from "./integrations/openai/video.js";

// ─── Image / Vision Analysis ──────────────────────────────────────────────

/**
 * Analyze an image using GPT-4o vision capability.
 * Sends the image as base64 with a text prompt and returns the analysis.
 * @param imageBuffer  Raw image content (JPEG, PNG, etc.).
 * @param prompt       The analysis prompt to send alongside the image.
 * @param apiKey       OpenAI API key.
 * @returns The vision model's text response.
 */
export async function analyzeImage(
    imageBuffer: Buffer,
    prompt: string,
    apiKey: string,
): Promise<string> {
    const base64 = imageBuffer.toString("base64");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: "gpt-4o",
                messages: [
                    {
                        role: "user",
                        content: [
                            { type: "text", text: prompt },
                            {
                                type: "image_url",
                                image_url: {
                                    url: `data:image/jpeg;base64,${base64}`,
                                    detail: "low",
                                },
                            },
                        ],
                    },
                ],
                max_completion_tokens: 150,
                temperature: 0,
            }),
            signal: controller.signal,
        });
        if (!response.ok) {
            const errText = await response.text().catch(() => response.statusText);
            throw new Error(`OpenAI vision analysis failed: ${response.status} ${errText}`);
        }
        const json = await response.json() as {
            choices?: Array<{ message?: { content?: string } }>;
        };
        return json.choices?.[0]?.message?.content?.trim() ?? "";
    } finally {
        clearTimeout(timer);
    }
}
