/**
 * OpenAI API client for voice services (TTS + Whisper transcription).
 *
 * Separated from telegram.ts to maintain single responsibility:
 * TelegramClient handles Telegram API, this module handles OpenAI API.
 */

/** Valid TTS voice names. */
export const TTS_VOICES = [
    "alloy", "echo", "fable", "onyx", "nova", "shimmer",
] as const;
export type TTSVoice = typeof TTS_VOICES[number];

/**
 * Convert text to speech using OpenAI TTS API.
 * Returns OGG Opus audio suitable for Telegram's sendVoice.
 */
export async function textToSpeech(
    text: string,
    apiKey: string,
    voice: TTSVoice = "nova",
): Promise<Buffer> {
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
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText);
        throw new Error(`OpenAI TTS failed: ${response.status} ${errText}`);
    }

    return Buffer.from(await response.arrayBuffer());
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
): Promise<string> {
    // Telegram stores voice as .oga (OGG Opus). Whisper accepts .ogg but
    // not .oga, so we hardcode the extension.
    const formData = new FormData();
    formData.append(
        "file",
        new Blob([new Uint8Array(audioBuffer)]),
        "voice.ogg",
    );
    formData.append("model", "whisper-1");

    const response = await fetch(
        "https://api.openai.com/v1/audio/transcriptions",
        {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}` },
            body: formData,
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
}

// ---------------------------------------------------------------------------
// Voice Emotion Analysis (optional external microservice)
// ---------------------------------------------------------------------------

export interface VoiceAnalysisResult {
    emotion: string | null;
    gender: string | null;
    age_estimate: number | null;
    duration_seconds: number;
}

/**
 * Analyze a voice message for emotion using an external microservice.
 * @param audioBuffer  Raw audio content (OGG).
 * @param serviceUrl   Base URL of the voice analysis service (e.g. https://voice-analysis.example.com).
 * @param timeoutMs    Request timeout in milliseconds (default: 15000).
 * @returns Analysis result, or null if the service is unavailable or errors.
 */
export async function analyzeVoiceEmotion(
    audioBuffer: Buffer,
    serviceUrl: string,
    timeoutMs = 30000,
): Promise<VoiceAnalysisResult | null> {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        const formData = new FormData();
        formData.append(
            "file",
            new Blob([new Uint8Array(audioBuffer)]),
            "voice.ogg",
        );

        const response = await fetch(`${serviceUrl.replace(/\/+$/, "")}/analyze`, {
            method: "POST",
            body: formData,
            signal: controller.signal,
        });

        clearTimeout(timer);

        if (!response.ok) {
            return null;
        }

        const result = (await response.json()) as VoiceAnalysisResult;
        return result;
    } catch (err) {
        // Service unavailable, timeout, or network error — non-fatal.
        process.stderr.write(
            `Voice analysis unavailable: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return null;
    }
}
