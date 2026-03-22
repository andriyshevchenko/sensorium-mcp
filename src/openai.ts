/**
 * OpenAI API client for voice services (TTS + Whisper transcription)
 * and vision services (video frame analysis).
 *
 * Separated from telegram.ts to maintain single responsibility:
 * TelegramClient handles Telegram API, this module handles OpenAI API.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./logger.js";

// Re-export chat completion + embedding functions extracted to integrations/openai/chat.ts
export { chatCompletion, cosineSimilarity, generateEmbedding } from "./integrations/openai/chat.js";
export type { ChatMessage } from "./integrations/openai/chat.js";

// Dedicated temp directory so crash-leftover files are cleaned on next startup.
const TEMP_DIR = join(homedir(), ".remote-copilot-mcp", "tmp");

/** Remove stale files from TEMP_DIR; create the dir if absent. */
function cleanupTempDir(): void {
    mkdirSync(TEMP_DIR, { recursive: true });
    const STALE_AGE = 5 * 60 * 1000; // 5 minutes — any temp file this old is a crash leftover
    const now = Date.now();
    for (const name of readdirSync(TEMP_DIR)) {
        try {
            const fullPath = join(TEMP_DIR, name);
            const mtime = statSync(fullPath).mtimeMs;
            if (now - mtime > STALE_AGE) {
                unlinkSync(fullPath);
            }
        } catch { /* ignore per-file errors */ }
    }
}

// Track in-flight temp files for cleanup on unexpected exit.
const activeTempFiles = new Set<string>();

function registerTempFile(path: string): void {
    activeTempFiles.add(path);
}

function unregisterTempFile(path: string): void {
    activeTempFiles.delete(path);
    try { unlinkSync(path); } catch { /* ignore */ }
}

// Clean up in-flight temp files on graceful/forced shutdown.
for (const sig of ["exit", "SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
        for (const f of activeTempFiles) {
            try { unlinkSync(f); } catch { /* ignore */ }
        }
    });
}

// Run once when the module loads.
cleanupTempDir();

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

// ─── TTS & Transcription (re-exported from integrations/openai/speech.ts) ─

export { TTS_VOICES, type TTSVoice, textToSpeech, transcribeAudio } from "./integrations/openai/speech.js";

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
    log.verbose("voice-analysis", `Starting analysis (timeout: ${timeoutMs}ms, format: ${mimeType})...`);

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
            log.warn(`[voice-analysis] HTTP ${response.status} after ${elapsed}ms`);
            return null;
        }

        const result = (await response.json()) as VoiceAnalysisResult;
        log.verbose("voice-analysis", `Success in ${elapsed}ms`);
        return result;
    } catch (err) {
        const elapsed = Date.now() - start;
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`[voice-analysis] Failed after ${elapsed}ms: ${msg}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// ---------------------------------------------------------------------------
// Video Frame Analysis (GPT-4o-mini vision)
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
    registerTempFile(tempPath);

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
        unregisterTempFile(tempPath);
    });
}

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


