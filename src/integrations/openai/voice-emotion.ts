/**
 * Voice emotion analysis via an external microservice.
 * Extracted from openai.ts for modular decomposition (Phase 3).
 */

import { log } from "../../logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AudioEvent {
    label: string;
    score: number;
}

interface Paralinguistics {
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

// ---------------------------------------------------------------------------
// Service client
// ---------------------------------------------------------------------------

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
