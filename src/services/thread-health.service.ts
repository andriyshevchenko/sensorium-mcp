import { getAllRegisteredTopics, getDashboardSessions, WAIT_LIVENESS_MS } from "../sessions.js";
import { getAllThreads, type ThreadRegistryEntry } from "../data/memory/thread-registry.js";
import { initMemoryDb } from "../data/memory/schema.js";
import { isProcessAlive, readPidFiles, spawnedThreads, type SpawnedThread } from "./process.service.js";

type ThreadStatus = "running" | "dormant" | "dead" | "unknown";

interface CollectedThread {
  threadId: number;
  name: string;
  pid: number | undefined;
  alive: boolean;
  hasActiveSession: boolean;
  hasRecentWait: boolean;
  sessionCount: number;
  lastActivity: number | undefined;
  spawnedStartedAt: number | undefined;
  registryStatus: string | undefined;
  keepAlive: boolean;
}

const formatRelativeTime = (ms: number) => ms < 0 ? "just now" : ms < 60_000 ? `${Math.floor(ms / 1000)}s ago` : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m ago` : ms < 86_400_000 ? `${Math.floor(ms / 3_600_000)}h ago` : `${Math.floor(ms / 86_400_000)}d ago`;
const formatUptime = (startedAt: number) => {
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
};

function collectThreadData(): CollectedThread[] {
  const topicsByChat = getAllRegisteredTopics();
  const sessions = getDashboardSessions();
  const pidFiles = readPidFiles();
  const now = Date.now();
  const registryByThread = new Map<number, ThreadRegistryEntry>();
  try {
    for (const entry of getAllThreads(initMemoryDb())) registryByThread.set(entry.threadId, entry);
  } catch {}
  const spawnedByThread = new Map<number, SpawnedThread>(spawnedThreads.map((s) => [s.threadId, s]));
  const pidByThread = new Map<number, number>(pidFiles.map((p) => [p.threadId, p.pid]));
  const threadNames = new Map<number, string>();
  const allThreadIds = new Set<number>();
  for (const chatTopics of Object.values(topicsByChat)) {
    for (const [name, threadId] of Object.entries(chatTopics)) {
      threadNames.set(threadId, name);
      allThreadIds.add(threadId);
    }
  }
  for (const session of sessions) if (session.threadId != null) allThreadIds.add(session.threadId);
  for (const s of spawnedThreads) allThreadIds.add(s.threadId);
  for (const p of pidFiles) allThreadIds.add(p.threadId);
  for (const [id, entry] of registryByThread) {
    allThreadIds.add(id);
    if (!threadNames.has(id) && entry.name) threadNames.set(id, entry.name);
  }
  const sessionsByThread = new Map<number, typeof sessions>();
  for (const session of sessions) {
    if (session.threadId == null) continue;
    const arr = sessionsByThread.get(session.threadId) ?? [];
    arr.push(session);
    sessionsByThread.set(session.threadId, arr);
  }
  return [...allThreadIds].map((threadId) => {
    const spawnedEntry = spawnedByThread.get(threadId);
    const pid = spawnedEntry?.pid ?? pidByThread.get(threadId);
    const threadSessions = sessionsByThread.get(threadId) ?? [];
    const activeSession = threadSessions.find((s) => s.status === "active");
    const anySession = activeSession ?? threadSessions[0];
    const regEntry = registryByThread.get(threadId);
    return {
      threadId,
      name: threadNames.get(threadId) ?? regEntry?.name ?? "unnamed",
      pid,
      alive: pid !== undefined && isProcessAlive(pid),
      hasActiveSession: !!activeSession,
      hasRecentWait: anySession?.lastWaitCallAt != null && now - anySession.lastWaitCallAt < WAIT_LIVENESS_MS,
      sessionCount: threadSessions.length,
      lastActivity: anySession?.lastActivity ?? (regEntry?.lastActiveAt ? new Date(regEntry.lastActiveAt).getTime() : undefined),
      spawnedStartedAt: spawnedEntry?.startedAt,
      registryStatus: regEntry?.status,
      keepAlive: regEntry?.keepAlive ?? false,
    };
  });
}

export function classifyThreadHealth(t: CollectedThread): ThreadStatus {
  if ((t.alive && t.hasActiveSession && t.hasRecentWait) || (t.hasActiveSession && t.hasRecentWait)) return "running";
  if (t.hasActiveSession || t.alive) return "dormant";
  if (t.pid !== undefined && !t.alive) return "dead";
  if (t.registryStatus === "archived" || t.registryStatus === "expired" || t.registryStatus === "exited") return "dead";
  if (t.registryStatus === "active" || t.keepAlive) return "dormant";
  return "unknown";
}

export function getThreadsHealth(): string {
  const threads = collectThreadData();
  if (threads.length === 0) return "No threads found. No topics registered, no active sessions, no PID files.";
  const now = Date.now();
  const rows = threads.map((t) => ({
    threadId: t.threadId,
    name: t.name.replace(/\|/g, "\\|"),
    status: classifyThreadHealth(t),
    pid: t.pid !== undefined ? String(t.pid) : "-",
    lastActivity: t.lastActivity ? formatRelativeTime(now - t.lastActivity) : "-",
    session: t.hasActiveSession ? "active" : t.sessionCount > 0 ? "disconnected" : "-",
    uptime: t.spawnedStartedAt && t.alive ? formatUptime(t.spawnedStartedAt) : "-",
  }));
  const statusOrder: Record<string, number> = { running: 0, dormant: 1, dead: 2, unknown: 3 };
  rows.sort((a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9));
  return [
    "## Thread Health Report",
    "",
    "| Thread ID | Name | Status | PID | Last Activity | Session | Uptime |",
    "|-----------|------|--------|-----|---------------|---------|--------|",
    ...rows.map((r) => `| ${r.threadId} | ${r.name} | ${r.status} | ${r.pid} | ${r.lastActivity} | ${r.session} | ${r.uptime} |`),
    "",
    `**Summary:** ${rows.length} threads -- ${rows.filter((r) => r.status === "running").length} running, ${rows.filter((r) => r.status === "dormant").length} dormant, ${rows.filter((r) => r.status === "dead").length} dead, ${rows.filter((r) => r.status === "unknown").length} unknown`,
  ].join("\n");
}
