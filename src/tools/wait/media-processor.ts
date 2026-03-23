/**
 * Media processing handlers extracted from wait-tool.ts (Phase 4).
 *
 * Handles voice messages, animations/GIFs, and video notes —
 * downloading, transcribing, analyzing, and building content blocks.
 */

import { saveFileToDisk } from "../../config.js";
import type { StoredMessage } from "../../dispatcher.js";
import { log } from "../../logger.js";
import {
  saveEpisode,
  saveVoiceSignature,
  type Database,
} from "../../memory.js";
import {
  analyzeVideoFrames,
  analyzeVoiceEmotion,
  extractVideoFrames,
  transcribeAudio,
} from "../../openai.js";
import { buildAnalysisTags } from "../../response-builders.js";
import type { TelegramClient } from "../../telegram.js";
import type { ContentBlock } from "../../types.js";
import { errorMessage } from "../../utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { ContentBlock };

/** Focused context that media processors need — not the full WaitToolContext. */
export interface MediaContext {
  telegram: TelegramClient;
  openaiApiKey: string;
  voiceAnalysisUrl: string;
  effectiveThreadId: number;
  sessionStartedAt: number;
  getMemoryDb: () => Database;
}

// ---------------------------------------------------------------------------
// Voice handler
// ---------------------------------------------------------------------------

/**
 * Process a voice message: download → parallel transcription + VANPY →
 * build tags → text block → save episode + voice signature.
 *
 * @returns Content blocks to append, and whether an episode was auto-saved.
 */
export async function processVoice(
  msg: StoredMessage,
  ctx: MediaContext,
): Promise<{ blocks: ContentBlock[]; episodeSaved: boolean }> {
  const voice = msg.message.voice!;
  const blocks: ContentBlock[] = [];

  if (!ctx.openaiApiKey) {
    blocks.push({
      type: "text",
      text: `[Voice message received — ${voice.duration}s — cannot transcribe: OPENAI_API_KEY not set]`,
    });
    return { blocks, episodeSaved: false };
  }

  try {
    log.verbose("voice", `Downloading voice file ${voice.file_id}...`);
    const { buffer } = await ctx.telegram.downloadFileAsBuffer(voice.file_id);
    log.verbose("voice", `Downloaded ${buffer.length} bytes. Starting transcription + analysis...`);

    // Run transcription and voice analysis in parallel.
    const [transcript, analysis] = await Promise.all([
      transcribeAudio(buffer, ctx.openaiApiKey),
      ctx.voiceAnalysisUrl
        ? analyzeVoiceEmotion(buffer, ctx.voiceAnalysisUrl)
        : Promise.resolve(null),
    ]);

    // Build rich voice analysis tag from VANPY results.
    const tags = buildAnalysisTags(analysis);
    const analysisTag = tags.length > 0 ? ` | ${tags.join(", ")}` : "";

    blocks.push({
      type: "text",
      text: transcript
        ? `[Voice message — ${voice.duration}s${analysisTag}, transcribed]: ${transcript}`
        : `[Voice message — ${voice.duration}s${analysisTag}, transcribed]: (empty — no speech detected)`,
    });

    // Auto-save voice signature
    let episodeSaved = false;
    if (analysis && ctx.effectiveThreadId !== undefined) {
      try {
        const db = ctx.getMemoryDb();
        const sessionId = `session_${ctx.sessionStartedAt}`;
        const epId = saveEpisode(db, {
          sessionId,
          threadId: ctx.effectiveThreadId,
          type: "operator_message",
          modality: "voice",
          content: { text: transcript ?? "", duration: voice.duration },
          importance: 0.6,
        });
        saveVoiceSignature(db, {
          episodeId: epId,
          emotion: analysis.emotion ?? undefined,
          arousal: analysis.arousal ?? undefined,
          dominance: analysis.dominance ?? undefined,
          valence: analysis.valence ?? undefined,
          speechRate: analysis.paralinguistics?.speech_rate ?? undefined,
          meanPitchHz: analysis.paralinguistics?.mean_pitch_hz ?? undefined,
          pitchStdHz: analysis.paralinguistics?.pitch_std_hz ?? undefined,
          jitter: analysis.paralinguistics?.jitter ?? undefined,
          shimmer: analysis.paralinguistics?.shimmer ?? undefined,
          hnrDb: analysis.paralinguistics?.hnr_db ?? undefined,
          audioEvents: analysis.audio_events?.map(e => ({ label: e.label, confidence: e.score })),
          durationSec: voice.duration,
        });
        episodeSaved = true;
      } catch (_) { /* non-fatal */ }
    }

    return { blocks, episodeSaved };
  } catch (err) {
    blocks.push({
      type: "text",
      text: `[Voice message — ${voice.duration}s — transcription failed: ${errorMessage(err)}]`,
    });
    return { blocks, episodeSaved: false };
  }
}

// ---------------------------------------------------------------------------
// Animation / GIF handler
// ---------------------------------------------------------------------------

/**
 * Process an animation/GIF: download → disk save → extractVideoFrames →
 * analyzeVideoFrames → text block.
 */
export async function processAnimation(
  msg: StoredMessage,
  ctx: MediaContext,
): Promise<ContentBlock[]> {
  const anim = msg.message.animation!;
  const animDuration = anim.duration ?? 3; // default to 3s if Telegram omits duration
  const blocks: ContentBlock[] = [];

  if (!ctx.openaiApiKey) {
    blocks.push({
      type: "text",
      text: `(The operator sent a GIF — cannot analyze: OPENAI_API_KEY not set)`,
    });
    return blocks;
  }

  try {
    log.verbose("gif", `Downloading animation ${anim.file_id} (~${animDuration}s)...`);
    const { buffer } = await ctx.telegram.downloadFileAsBuffer(anim.file_id);
    const diskPath = saveFileToDisk(buffer, "gif-animation.mp4");
    log.verbose("gif", `Downloaded ${buffer.length} bytes. Extracting frames...`);

    // Extract frames with ffmpeg (same as video_notes).
    const frames = await extractVideoFrames(buffer, animDuration).catch((err) => {
      log.error(`[gif] Frame extraction failed: ${errorMessage(err)}`);
      return [] as Buffer[];
    });

    // Analyze frames with GPT-4o-mini vision (same as video_notes).
    let sceneDescription: string | null = null;
    if (frames.length > 0) {
      try {
        log.verbose("gif", `Analyzing ${frames.length} frames with GPT-4o-mini vision...`);
        sceneDescription = await analyzeVideoFrames(frames, animDuration, ctx.openaiApiKey);
        log.verbose("gif", `Vision analysis complete.`);
      } catch (visionErr) {
        log.error(`[gif] Vision analysis failed: ${visionErr}`);
        sceneDescription = null;
      }
    }

    const caption = msg.message.caption || "";
    const parts: string[] = [];
    parts.push(`(The operator sent a GIF — ${animDuration}s)`);
    if (sceneDescription) parts.push(`Scene: ${sceneDescription}`);
    if (!sceneDescription) parts.push("(no visual content could be extracted)");
    parts.push(`Saved to: ${diskPath}`);
    if (caption) parts.push(`Caption: ${caption}`);
    blocks.push({ type: "text", text: parts.join("\n") });
  } catch (err) {
    blocks.push({
      type: "text",
      text: `(The operator sent a GIF — analysis failed: ${errorMessage(err)})`,
    });
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Video note handler
// ---------------------------------------------------------------------------

/**
 * Process a video note (circle video): download → parallel(frames, transcribe,
 * VANPY) → vision analysis → tags → text block → save episode + voice signature.
 *
 * @returns Content blocks to append, and whether an episode was auto-saved.
 */
export async function processVideoNote(
  msg: StoredMessage,
  ctx: MediaContext,
): Promise<{ blocks: ContentBlock[]; episodeSaved: boolean }> {
  const vn = msg.message.video_note!;
  const blocks: ContentBlock[] = [];

  if (!ctx.openaiApiKey) {
    blocks.push({
      type: "text",
      text: `[Video note received — ${vn.duration}s — cannot analyze: OPENAI_API_KEY not set]`,
    });
    return { blocks, episodeSaved: false };
  }

  try {
    log.verbose("video-note", `Downloading circle video ${vn.file_id} (${vn.duration}s)...`);
    const { buffer } = await ctx.telegram.downloadFileAsBuffer(vn.file_id);
    log.verbose("video-note", `Downloaded ${buffer.length} bytes. Extracting frames + transcribing...`);

    // Run frame extraction, audio transcription, and voice analysis in parallel.
    const [frames, transcript, analysis] = await Promise.all([
      extractVideoFrames(buffer, vn.duration).catch((err) => {
        log.error(`[video-note] Frame extraction failed: ${errorMessage(err)}`);
        return [] as Buffer[];
      }),
      transcribeAudio(buffer, ctx.openaiApiKey, "video.mp4").catch(() => ""),
      ctx.voiceAnalysisUrl
        ? analyzeVoiceEmotion(buffer, ctx.voiceAnalysisUrl, {
            mimeType: "video/mp4",
            filename: "video.mp4",
          }).catch(() => null)
        : Promise.resolve(null),
    ]);

    // Analyze frames with GPT-4o-mini vision.
    let sceneDescription: string | null = "";
    if (frames.length > 0) {
      try {
        log.verbose("video-note", `Analyzing ${frames.length} frames with GPT-4o-mini vision...`);
        sceneDescription = await analyzeVideoFrames(frames, vn.duration, ctx.openaiApiKey);
        log.verbose("video-note", `Vision analysis complete.`);
      } catch (visionErr) {
        log.error(`[video-note] Vision analysis failed: ${visionErr}`);
        sceneDescription = null;
      }
    }

    // Build analysis tags (same as voice messages).
    const tags = buildAnalysisTags(analysis);
    const analysisTag = tags.length > 0 ? ` | ${tags.join(", ")}` : "";

    const parts: string[] = [];
    parts.push(`[Video note — ${vn.duration}s${analysisTag}]`);
    if (sceneDescription) parts.push(`Scene: ${sceneDescription}`);
    if (transcript) parts.push(`Audio: "${transcript}"`);
    if (!sceneDescription && !transcript) parts.push("(no visual or audio content could be extracted)");

    blocks.push({ type: "text", text: parts.join("\n") });

    // Auto-save voice signature for video notes
    let episodeSaved = false;
    if (analysis && ctx.effectiveThreadId !== undefined) {
      try {
        const db = ctx.getMemoryDb();
        const sessionId = `session_${ctx.sessionStartedAt}`;
        const epId = saveEpisode(db, {
          sessionId,
          threadId: ctx.effectiveThreadId,
          type: "operator_message",
          modality: "video_note",
          content: { text: transcript ?? "", scene: sceneDescription ?? "", duration: vn.duration },
          importance: 0.6,
        });
        saveVoiceSignature(db, {
          episodeId: epId,
          emotion: analysis.emotion ?? undefined,
          arousal: analysis.arousal ?? undefined,
          dominance: analysis.dominance ?? undefined,
          valence: analysis.valence ?? undefined,
          speechRate: analysis.paralinguistics?.speech_rate ?? undefined,
          meanPitchHz: analysis.paralinguistics?.mean_pitch_hz ?? undefined,
          pitchStdHz: analysis.paralinguistics?.pitch_std_hz ?? undefined,
          jitter: analysis.paralinguistics?.jitter ?? undefined,
          shimmer: analysis.paralinguistics?.shimmer ?? undefined,
          hnrDb: analysis.paralinguistics?.hnr_db ?? undefined,
          audioEvents: analysis.audio_events?.map(e => ({ label: e.label, confidence: e.score })),
          durationSec: vn.duration,
        });
        episodeSaved = true;
      } catch (_) { /* non-fatal */ }
    }

    return { blocks, episodeSaved };
  } catch (err) {
    blocks.push({
      type: "text",
      text: `[Video note — ${vn.duration}s — analysis failed: ${errorMessage(err)}]`,
    });
    return { blocks, episodeSaved: false };
  }
}
