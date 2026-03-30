/**
 * Topic-Shift Detector
 *
 * Detects when conversation drifts to a new topic by comparing
 * the semantic embedding of the latest message against the
 * centroid of recent conversation context.
 *
 * When a significant shift is detected, suggests creating a
 * scoped ghost thread so the main thread stays focused.
 */

import { generateEmbedding, cosineSimilarity } from "../../integrations/openai/chat.js";
import { getRecentEpisodes } from "./episodes.js";
import type { Database } from "./schema.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface TopicShiftResult {
  shifted: boolean;
  similarity: number;         // cosine similarity to recent context centroid
  suggestedTopic: string;     // extracted topic from the new message
  recentTopicSummary: string; // what the recent conversation is about
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Below this similarity, we consider it a topic shift */
const SHIFT_THRESHOLD = 0.55;

/** Number of recent messages to form the context centroid */
const CONTEXT_WINDOW = 8;

/** Minimum message length to consider for shift detection */
const MIN_MESSAGE_LENGTH = 30;

/** Embedding dimension (text-embedding-3-small) */
const EMBED_DIM = 1536;

// ─── Centroid Calculation ────────────────────────────────────────────────────

function meanEmbedding(embeddings: Float32Array[]): Float32Array {
  if (embeddings.length === 0) return new Float32Array(EMBED_DIM);
  if (embeddings.length === 1) return embeddings[0];

  const mean = new Float32Array(EMBED_DIM);
  for (const emb of embeddings) {
    for (let i = 0; i < EMBED_DIM; i++) {
      mean[i] += emb[i];
    }
  }
  for (let i = 0; i < EMBED_DIM; i++) {
    mean[i] /= embeddings.length;
  }
  return mean;
}

// ─── Episode Text Extraction ─────────────────────────────────────────────────

function extractText(content: Record<string, unknown>): string {
  return ((content.text || content.caption || content.message || "") as string).trim();
}

function extractTopicHint(text: string): string {
  // Take first sentence or first 100 chars as a topic hint
  const firstSentence = text.match(/^[^.!?\n]+[.!?]?/)?.[0] || text.slice(0, 100);
  return firstSentence.trim();
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Detect if a new message represents a topic shift from recent conversation.
 *
 * Returns null if detection can't run (too few messages, no API key, etc.)
 */
export async function detectTopicShift(
  db: Database,
  threadId: number,
  newMessage: string,
): Promise<TopicShiftResult | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  if (newMessage.length < MIN_MESSAGE_LENGTH) return null;

  // Get recent operator messages for context
  const recentEpisodes = getRecentEpisodes(db, threadId, CONTEXT_WINDOW * 2);
  const operatorMessages = recentEpisodes
    .filter((ep) => ep.type === "operator_message")
    .slice(0, CONTEXT_WINDOW);

  if (operatorMessages.length < 3) return null; // need enough context

  // Extract text from recent messages
  const recentTexts = operatorMessages
    .map((ep) => extractText(ep.content as Record<string, unknown>))
    .filter((t) => t.length >= MIN_MESSAGE_LENGTH);

  if (recentTexts.length < 2) return null;

  // Generate embeddings — new message + recent context
  try {
    const [newEmb, ...contextEmbs] = await Promise.all([
      generateEmbedding(newMessage, apiKey),
      ...recentTexts.slice(0, 5).map((t) => generateEmbedding(t, apiKey)),
    ]);

    // Compute centroid of recent context
    const centroid = meanEmbedding(contextEmbs);

    // Compare new message to centroid
    const similarity = cosineSimilarity(newEmb, centroid);

    return {
      shifted: similarity < SHIFT_THRESHOLD,
      similarity,
      suggestedTopic: extractTopicHint(newMessage),
      recentTopicSummary: extractTopicHint(recentTexts[0]),
    };
  } catch {
    return null; // embedding generation failed — skip silently
  }
}
