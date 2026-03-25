/**
 * OpenAI speech services: TTS (text-to-speech) and Whisper transcription.
 *
 * Extracted from openai.ts for modular decomposition (Phase 3B).
 */

// ─── TTS ──────────────────────────────────────────────────────────────────

/** Valid TTS voice names. */
export const TTS_VOICES = [
    "alloy", "echo", "fable", "onyx", "nova", "shimmer",
] as const;
export type TTSVoice = typeof TTS_VOICES[number];

/**
 * Module-level AbortController for graceful shutdown.
 * When aborted, all in-flight TTS (and transcription) requests are cancelled
 * so that error responses reach the agent before the process exits.
 */
let shutdownController = new AbortController();
let inFlightSpeechCount = 0;

/** Abort all pending TTS / transcription requests (called during graceful shutdown). */
export function abortPendingSpeech(): void {
    shutdownController.abort();
}

/** Number of speech API requests currently in flight. */
export function pendingSpeechCount(): number {
    return inFlightSpeechCount;
}

/**
 * Convert text to speech using OpenAI TTS API.
 * Returns OGG Opus audio suitable for Telegram's sendVoice.
 */
export async function textToSpeech(
    text: string,
    apiKey: string,
    voice: TTSVoice = "nova",
): Promise<Buffer> {
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), 60_000);
    // Abort on either timeout or process shutdown.
    const signal = AbortSignal.any([timeoutController.signal, shutdownController.signal]);
    inFlightSpeechCount++;
    try {
        const response = await fetch("https://api.openai.com/v1/audio/speech", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: "tts-1",
                input: text,
                voice,
                response_format: "opus",
            }),
            signal,
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => response.statusText);
            throw new Error(`OpenAI TTS failed: ${response.status} ${errText}`);
        }

        return Buffer.from(await response.arrayBuffer());
    } finally {
        inFlightSpeechCount--;
        clearTimeout(timer);
    }
}

/**
 * Transcribe an audio buffer using OpenAI Whisper API.
 * @param audioBuffer  Raw audio content (OGG Opus from Telegram voice messages).
 * @param apiKey       OpenAI API key.
 * @returns The transcribed text (empty string if no speech detected).
 */
export async function transcribeAudio(
    audioBuffer: Buffer,
    apiKey: string,
    filename: string = "voice.ogg",
): Promise<string> {
    // Telegram stores voice as .oga (OGG Opus). Whisper accepts .ogg but
    // not .oga, so we hardcode the extension.
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), 60_000);
    const signal = AbortSignal.any([timeoutController.signal, shutdownController.signal]);
    inFlightSpeechCount++;
    try {
        const formData = new FormData();
        formData.append(
            "file",
            new Blob([new Uint8Array(audioBuffer)]),
            filename,
        );
        formData.append("model", "whisper-1");

        const response = await fetch(
            "https://api.openai.com/v1/audio/transcriptions",
            {
                method: "POST",
                headers: { Authorization: `Bearer ${apiKey}` },
                body: formData,
                signal,
            },
        );

        if (!response.ok) {
            const errText = await response.text().catch(() => response.statusText);
            throw new Error(
                `OpenAI Whisper transcription failed: ${response.status} ${errText}`,
            );
        }

        const result = (await response.json()) as { text?: string };
        return result.text ?? "";
    } finally {
        inFlightSpeechCount--;
        clearTimeout(timer);
    }
}
