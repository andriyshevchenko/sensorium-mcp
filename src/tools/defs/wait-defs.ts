/**
 * Wait tool definition — remote_copilot_wait_for_instructions.
 */

import type { ToolDefinition } from "../definitions.js";

export const waitToolDefs: ToolDefinition[] = [
  {
    name: "remote_copilot_wait_for_instructions",
    description:
      "Wait for a new instruction message from the operator via Telegram. " +
      "The call blocks (long-polls) until a message arrives or the configured " +
      "timeout elapses. If the timeout elapses with no message the tool output " +
      "explicitly instructs the agent to call this tool again.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: {
          type: "number",
          description:
            "The Telegram thread ID of the active session. " +
            "ALWAYS pass this if you received it from start_session.",
        },
      },
      required: [],
    },
  },
];
