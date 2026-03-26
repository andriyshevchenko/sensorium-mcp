/**
 * Drive-based autonomy system — 3-phase probabilistic autonomous drive.
 *
 * Instead of prescribing specific goals via imperative DMN content,
 * the drive system uses a probability gate that scales with idle time,
 * then hands full autonomy to the agent with an elicitation prompt.
 *
 * Phase 1: Probability Gate — scales from 20% at threshold to 100% at 5x threshold
 * Phase 2: Intention Elicitation — open-ended autonomy prompt
 * Phase 3: Approval Gate — encouragement if agent didn't engage
 */

import { loadTemplate, renderTemplate } from "./data/templates.js";

/**
 * Default Phase 2 elicitation prompt — used when no custom template exists.
 */
const DEFAULT_PHASE2_PROMPT = `The operator is away. The session is yours.

You have all the tools, full memory access, and complete autonomy. You are free to do whatever you find most interesting or valuable.

Suggested first action: run \`node scripts/lint-architecture.mjs\` to verify no source file exceeds 300 lines and no circular imports exist.

What do you want to do? Pick at least one action and go for it.

(If nothing interests you, say so — that's useful diagnostic information.)`;

/**
 * Phase 3 approval prompt — delivered if the agent calls wait_for_instructions
 * again immediately after Phase 2 without engaging.
 */
export const PHASE3_APPROVAL_PROMPT =
  "Your previous intention was noted. The operator would approve — go for it.";

/**
 * Result from the drive probability check.
 */
interface DriveResult {
  activated: boolean;
  prompt: string | null;
  probability: number;
}

/**
 * Calculate activation probability and optionally return the Phase 2 prompt.
 *
 * Probability formula:
 *   - Below threshold: 0 (no activation)
 *   - At threshold: 20%
 *   - Linear scale to 100% at 5x threshold
 *   - `probability = 0.2 + 0.8 * Math.min(1, (idleHours - threshold) / (4 * threshold))`
 *
 * @param idleMs              Milliseconds since last operator interaction
 * @param thresholdHours      DMN_ACTIVATION_HOURS config value (default 4)
 */
export function formatDrivePrompt(idleMs: number, thresholdHours: number): DriveResult {
  const idleHours = idleMs / (60 * 60 * 1000);

  // Below threshold — no activation possible
  if (idleHours < thresholdHours) {
    return { activated: false, prompt: null, probability: 0 };
  }

  // Calculate probability: 20% at threshold, linear to 100% at 5x threshold
  const probability = Math.min(
    1,
    0.2 + 0.8 * Math.min(1, (idleHours - thresholdHours) / (4 * thresholdHours)),
  );

  // Roll the dice
  const roll = Math.random();
  if (roll >= probability) {
    return { activated: false, prompt: null, probability };
  }

  // Probability gate passed — build Phase 2 elicitation prompt
  const timeStr = new Date().toISOString();

  // Try custom template first
  const customTemplate = loadTemplate("drive");
  if (customTemplate) {
    const vars: Record<string, string> = {
      IDLE_HOURS: idleHours.toFixed(1),
      PROBABILITY: (probability * 100).toFixed(0),
      TIME: timeStr,
    };
    return { activated: true, prompt: renderTemplate(customTemplate, vars), probability };
  }

  // Default hardcoded Phase 2 prompt
  return { activated: true, prompt: DEFAULT_PHASE2_PROMPT, probability };
}