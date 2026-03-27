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

// Re-export video frame extraction
export { extractVideoFrames } from "./integrations/openai/video.js";

// Re-export vision analysis (video frame analysis)
export { analyzeVideoFrames } from "./integrations/openai/vision.js";
