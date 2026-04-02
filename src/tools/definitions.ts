/**
 * MCP tool definitions — thin hub that re-exports from defs/ sub-files.
 */

import { memoryToolDefs } from "./defs/memory-defs.js";
import { sessionToolDefs } from "./defs/session-defs.js";
import { skillToolDefs } from "./defs/skill-defs.js";
import { utilityToolDefs } from "./defs/utility-defs.js";
import { waitToolDefs } from "./defs/wait-defs.js";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const ALL_TOOL_DEFINITIONS: ToolDefinition[] = [
  ...sessionToolDefs,
  ...waitToolDefs,
  ...utilityToolDefs,
  ...memoryToolDefs,
  ...skillToolDefs,
];
