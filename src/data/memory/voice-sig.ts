import type { Database } from "./schema.js";
import { nowISO, jsonOrNull } from "./utils.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface VoiceBaseline {
  avgArousal: number | null;
  avgDominance: number | null;
  avgValence: number | null;
  avgSpeechRate: number | null;
  avgMeanPitchHz: number | null;
  avgPitchStdHz: number | null;
  avgJitter: number | null;
  avgShimmer: number | null;
  avgHnrDb: number | null;
  sampleCount: number;
}

// ─── Voice Signatures ────────────────────────────────────────────────────────

export function saveVoiceSignature(
  db: Database,
  sig: {
    episodeId: string;
    emotion?: string;
    arousal?: number;
    dominance?: number;
    valence?: number;
    speechRate?: number;
    meanPitchHz?: number;
    pitchStdHz?: number;
    jitter?: number;
    shimmer?: number;
    hnrDb?: number;
    audioEvents?: Array<{ label: string; confidence: number }>;
    durationSec?: number;
  }
): void {
  db.prepare(
    `INSERT INTO voice_signatures
       (episode_id, emotion, arousal, dominance, valence, speech_rate, mean_pitch_hz, pitch_std_hz, jitter, shimmer, hnr_db, audio_events, duration_sec, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sig.episodeId,
    sig.emotion ?? null,
    sig.arousal ?? null,
    sig.dominance ?? null,
    sig.valence ?? null,
    sig.speechRate ?? null,
    sig.meanPitchHz ?? null,
    sig.pitchStdHz ?? null,
    sig.jitter ?? null,
    sig.shimmer ?? null,
    sig.hnrDb ?? null,
    jsonOrNull(sig.audioEvents),
    sig.durationSec ?? null,
    nowISO()
  );
}

export function getVoiceBaseline(db: Database, dayRange = 30): VoiceBaseline | null {
  const cutoff = new Date(Date.now() - dayRange * 24 * 60 * 60 * 1000).toISOString();

  const row = db
    .prepare(
      `SELECT
         AVG(arousal)       AS avg_arousal,
         AVG(dominance)     AS avg_dominance,
         AVG(valence)       AS avg_valence,
         AVG(speech_rate)   AS avg_speech_rate,
         AVG(mean_pitch_hz) AS avg_mean_pitch_hz,
         AVG(pitch_std_hz)  AS avg_pitch_std_hz,
         AVG(jitter)        AS avg_jitter,
         AVG(shimmer)       AS avg_shimmer,
         AVG(hnr_db)        AS avg_hnr_db,
         COUNT(*)           AS sample_count
       FROM voice_signatures
       WHERE created_at >= ?`
    )
    .get(cutoff) as Record<string, unknown> | undefined;

  if (!row || (row.sample_count as number) === 0) return null;

  return {
    avgArousal: row.avg_arousal as number | null,
    avgDominance: row.avg_dominance as number | null,
    avgValence: row.avg_valence as number | null,
    avgSpeechRate: row.avg_speech_rate as number | null,
    avgMeanPitchHz: row.avg_mean_pitch_hz as number | null,
    avgPitchStdHz: row.avg_pitch_std_hz as number | null,
    avgJitter: row.avg_jitter as number | null,
    avgShimmer: row.avg_shimmer as number | null,
    avgHnrDb: row.avg_hnr_db as number | null,
    sampleCount: row.sample_count as number,
  };
}
