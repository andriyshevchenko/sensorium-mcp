/**
 * OpenAI API client for voice services (TTS + Whisper transcription)
 * and vision services (video frame analysis).
 *
 * Separated from telegram.ts to maintain single responsibility:
 * TelegramClient handles Telegram API, this module handles OpenAI API.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

// Dedicated temp directory so crash-leftover files are cleaned on next startup.
const TEMP_DIR = join(homedir(), ".remote-copilot-mcp", "tmp");

/** Remove files older than 1 hour from TEMP_DIR; create the dir if absent. */
function cleanupTempDir(): void {
    mkdirSync(TEMP_DIR, { recursive: true });
    const ONE_HOUR = 60 * 60 * 1000;
    const now = Date.now();
    for (const name of readdirSync(TEMP_DIR)) {
        try {
            const fullPath = join(TEMP_DIR, name);
            const mtime = statSync(fullPath).mtimeMs;
            if (now - mtime > ONE_HOUR) {
                unlinkSync(fullPath);
            }
        } catch { /* ignore per-file errors */ }
    }
}

// Run once when the module loads.
cleanupTempDir();

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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
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
        signal: controller.signal,
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText);
        throw new Error(`OpenAI TTS failed: ${response.status} ${errText}`);
    }

    return Buffer.from(await response.arrayBuffer());
    } finally {
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
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
            signal: controller.signal,
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
        clearTimeout(timer);
    }
}

// ---------------------------------------------------------------------------
// Voice Emotion Analysis (optional external microservice)
// ---------------------------------------------------------------------------

export interface AudioEvent {
    label: string;
    score: number;
}

export interface Paralinguistics {
    speech_rate?: number;
    mean_pitch_hz?: number;
    pitch_std_hz?: number;
    jitter?: number;
    shimmer?: number;
    hnr_db?: number;
}

export interface VoiceAnalysisResult {
    emotion: string | null;
    emotion_scores?: Record<string, number>;
    arousal: number | null;
    dominance: number | null;
    valence: number | null;
    gender: string | null;
    age_estimate: number | null;
    duration_seconds: number;
    audio_events?: AudioEvent[];
    paralinguistics?: Paralinguistics;
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
    options?: { mimeType?: string; filename?: string; timeoutMs?: number },
): Promise<VoiceAnalysisResult | null> {
    const { mimeType = "audio/ogg", filename = "voice.ogg", timeoutMs = 120_000 } = options ?? {};
    const start = Date.now();
    const baseUrl = serviceUrl.replace(/\/+$/, "");
    process.stderr.write(`[voice-analysis] Starting analysis (timeout: ${timeoutMs}ms, format: ${mimeType})...\n`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const formData = new FormData();
        formData.append(
            "file",
            new Blob([new Uint8Array(audioBuffer)], { type: mimeType }),
            filename,
        );

        const response = await fetch(`${baseUrl}/analyze`, {
            method: "POST",
            body: formData,
            signal: controller.signal,
        });

        const elapsed = Date.now() - start;
        if (!response.ok) {
            process.stderr.write(`[voice-analysis] HTTP ${response.status} after ${elapsed}ms\n`);
            return null;
        }

        const result = (await response.json()) as VoiceAnalysisResult;
        process.stderr.write(`[voice-analysis] Success in ${elapsed}ms\n`);
        return result;
    } catch (err) {
        const elapsed = Date.now() - start;
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[voice-analysis] Failed after ${elapsed}ms: ${msg}\n`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// ---------------------------------------------------------------------------
// Video Frame Analysis (GPT-5-mini vision)
// ---------------------------------------------------------------------------

/** Maximum number of frames to extract from a video. */
const MAX_FRAMES = 6;

/**
 * Split a buffer of concatenated JPEG images by SOI marker (0xFFD8).
 */
function splitJpegs(buf: Buffer): Buffer[] {
    const frames: Buffer[] = [];
    let start = 0;
    for (let i = 2; i < buf.length - 1; i++) {
        if (buf[i] === 0xFF && buf[i + 1] === 0xD8) {
            frames.push(buf.subarray(start, i));
            start = i;
        }
    }
    if (start < buf.length) frames.push(buf.subarray(start));
    return frames.filter(f => f.length > 100); // drop tiny garbage
}

/**
 * Extract key frames from a video buffer using ffmpeg.
 * Writes video to a temp file and reads JPEG frames from stdout.
 * @param videoBuffer  Raw video file content (MP4).
 * @param durationSec  Video duration in seconds (used to calculate interval).
 * @returns Array of JPEG-encoded frame buffers.
 */
export function extractVideoFrames(
    videoBuffer: Buffer,
    durationSec: number,
): Promise<Buffer[]> {
    const tempPath = join(TEMP_DIR, `video-${randomUUID()}.mp4`);
    writeFileSync(tempPath, videoBuffer);

    return new Promise<Buffer[]>((resolve, reject) => {
        // Calculate frame interval: aim for ~1 frame every 5s, capped at MAX_FRAMES.
        const interval = Math.max(1, Math.ceil(durationSec / MAX_FRAMES));

        const args = [
            "-i", tempPath,
            "-vf", `fps=1/${interval}`,
            "-c:v", "mjpeg",
            "-f", "image2pipe",
            "-q:v", "3",
            "pipe:1",
        ];

        const proc = spawn("ffmpeg", args, {
            stdio: ["ignore", "pipe", "pipe"],
        });

        const chunks: Buffer[] = [];
        const errChunks: Buffer[] = [];

        proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
        proc.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));

        // Kill ffmpeg if it hangs for more than 30 seconds.
        const killTimer = setTimeout(() => proc.kill("SIGKILL"), 30_000);

        proc.on("error", (err) => {
            clearTimeout(killTimer);
            reject(new Error(`ffmpeg not found or failed to start: ${err.message}`));
        });

        proc.on("close", (code) => {
            clearTimeout(killTimer);
            if (code !== 0) {
                const stderr = Buffer.concat(errChunks).toString("utf8").slice(-500);
                reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
                return;
            }
            const combined = Buffer.concat(chunks);
            if (combined.length === 0) {
                resolve([]);
                return;
            }
            const frames = splitJpegs(combined).slice(0, MAX_FRAMES);
            resolve(frames);
        });
    }).finally(() => {
        try { unlinkSync(tempPath); } catch { /* ignore cleanup errors */ }
    });
}

/**
 * Analyze video frames using OpenAI GPT-5-mini vision.
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
            model: "gpt-5-mini",
            messages: [{ role: "user", content }],
            max_tokens: 300,
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
        const json = await response.json() as { data: [{ embedding: number[] }] };
        return new Float32Array(json.data[0].embedding);
    } finally {
        clearTimeout(timer);
    }
}

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
