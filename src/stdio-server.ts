/**
 * stdio transport bootstrap for the MCP server.
 *
 * Used when MCP_HTTP_PORT is not set — the default transport mode.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { checkMaintenanceFlag } from "./data/file-storage.js";
import { abortPendingSpeech, pendingSpeechCount } from "./integrations/openai/speech.js";
import { log } from "./logger.js";
import {
  registerDashboardSession,
  markDashboardSessionDisconnected,
} from "./sessions.js";
import type { CreateMcpServerFn } from "./types.js";

export async function startStdioServer(
  createMcpServerFn: CreateMcpServerFn,
  closeMemoryDb: () => void,
): Promise<void> {
  const transport = new StdioServerTransport();
  const stdioSessionId = randomUUID();

  const server = createMcpServerFn(
    () => stdioSessionId,
    () => { try { transport.close?.(); } catch (_) { /* best-effort */ } },
  );
  await server.connect(transport);

  // Register the STDIO session so it appears on the dashboard
  registerDashboardSession(stdioSessionId, "stdio");

  log.info("Remote Copilot MCP server running on stdio.");

  let shuttingDown = false;
  const stdioShutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`[shutdown] Graceful stdio shutdown (${reason}) — aborting in-flight TTS…`);

    clearInterval(maintenancePollInterval);

    // 1. Abort pending TTS / transcription requests.
    abortPendingSpeech();

    // 2. Brief drain: wait up to 3 s for abort errors to propagate.
    const deadline = Date.now() + 3_000;
    while (pendingSpeechCount() > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
    }

    markDashboardSessionDisconnected(stdioSessionId);
    closeMemoryDb();
    process.exit(0);
  };
  process.on("SIGINT",  () => { void stdioShutdown("SIGINT"); });
  process.on("SIGTERM", () => { void stdioShutdown("SIGTERM"); });
  if (process.platform === "win32") {
    process.on("SIGBREAK", () => { void stdioShutdown("SIGBREAK"); });
  }
  process.on("exit", () => {
    markDashboardSessionDisconnected(stdioSessionId);
    closeMemoryDb();
  });

  // ── Maintenance flag poller — self-terminate before the update watcher
  //    force-kills us, giving in-flight requests a chance to complete. ────
  const maintenancePollInterval = setInterval(() => {
    if (shuttingDown) return;
    if (checkMaintenanceFlag()) {
      void stdioShutdown("maintenance flag detected");
    }
  }, 2_000);
}
