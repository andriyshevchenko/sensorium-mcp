/**
 * Scheduled-task check extracted from wait-tool.ts.
 *
 * Checks for due scheduled tasks and returns an appropriate ToolResult
 * when a task fires (including DMN sentinel handling), or null if nothing is due.
 */

import { checkDueTasks } from "../../scheduler.js";
import { getReminders } from "../../response-builders.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ContentBlock = { type: string; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: Array<ContentBlock>; isError?: boolean };

export interface TaskContext {
  state: {
    lastOperatorMessageAt: number;
    sessionStartedAt: number;
  };
  generateDmnReflection: (threadId: number) => string;
  config: {
    AUTONOMOUS_MODE: boolean;
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Check whether any scheduled task is due for the given thread.
 *
 * Returns a `ToolResult` ready to be returned from the wait-tool when a task
 * fires, or `null` when nothing is due.
 *
 * Used from both the idle-poll check (inside the loop) and the post-timeout
 * check (after the loop exits).
 */
export function checkForDueTasks(
  ctx: TaskContext,
  effectiveThreadId: number,
): ToolResult | null {
  const { state, config } = ctx;

  const dueTask = checkDueTasks(effectiveThreadId, state.lastOperatorMessageAt, false);
  if (!dueTask) return null;

  // DMN sentinel: generate dynamic first-person reflection
  const taskPrompt = dueTask.prompt === "__DMN__"
    ? ctx.generateDmnReflection(effectiveThreadId)
    : `⏰ **Scheduled task fired: "${dueTask.task.label}"**\n\n` +
      `This task was scheduled by you. Execute it now using subagents, then report progress and continue waiting.\n\n` +
      `Task prompt: ${dueTask.prompt}`;

  return {
    content: [
      {
        type: "text",
        text: taskPrompt + getReminders(effectiveThreadId, state.sessionStartedAt, config.AUTONOMOUS_MODE),
      },
    ],
  };
}
