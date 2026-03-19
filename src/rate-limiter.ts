/**
 * Rate Limiter — Coordinates API usage across concurrent agent sessions.
 *
 * Problem: When 4+ agents run simultaneously, each making GitHub/OpenAI/web
 * requests, external APIs start returning 429 (Too Many Requests).
 *
 * Solution: A shared in-process rate limiter that:
 *   1. Tracks API calls per service per sliding window
 *   2. Implements token-bucket rate limiting per service
 *   3. Provides an MCP tool for agents to check/acquire capacity
 *   4. Advises agents to back off when limits approach
 *
 * Architecture:
 *   - ServiceBucket: token-bucket per service (GitHub, OpenAI, etc.)
 *   - SessionTracker: per-session call counts for fair queuing
 *   - acquireCapacity(): agents call this before making API calls
 *   - getUsageStats(): dashboard visibility into rate state
 */

// ─── Configuration ──────────────────────────────────────────────────────────

/** Default rate limits per service. Can be overridden via env vars. */
export interface ServiceConfig {
  /** Max requests per window */
  maxRequests: number;
  /** Window duration in milliseconds */
  windowMs: number;
  /** Max burst (initial bucket capacity) */
  burstSize: number;
  /** Refill rate (tokens per second) */
  refillRate: number;
  /** Description for user-facing messages */
  description: string;
}

const DEFAULT_SERVICES: Record<string, ServiceConfig> = {
  github: {
    maxRequests: 5000,
    windowMs: 60 * 60 * 1000, // 1 hour (GitHub API limit)
    burstSize: 30,
    refillRate: 1.4, // ~5000/hour
    description: "GitHub API",
  },
  openai: {
    maxRequests: 500,
    windowMs: 60 * 1000, // 1 minute
    burstSize: 20,
    refillRate: 8.3, // ~500/min
    description: "OpenAI API",
  },
  web: {
    maxRequests: 60,
    windowMs: 60 * 1000, // 1 minute
    burstSize: 10,
    refillRate: 1, // 60/min
    description: "Web requests",
  },
  telegram: {
    maxRequests: 30,
    windowMs: 1000, // 1 second (Telegram bot limit: 30 msg/s)
    burstSize: 30,
    refillRate: 30,
    description: "Telegram API",
  },
};

// ─── Token Bucket ───────────────────────────────────────────────────────────

interface TokenBucket {
  tokens: number;
  lastRefill: number;
  config: ServiceConfig;
  /** Rolling window call timestamps for stats */
  callLog: number[];
  /** Separate hourly call counter (not pruned by short windows) */
  hourlyCallCount: number;
  hourlyWindowStart: number;
}

function createBucket(config: ServiceConfig): TokenBucket {
  return {
    tokens: config.burstSize,
    lastRefill: Date.now(),
    config,
    callLog: [],
    hourlyCallCount: 0,
    hourlyWindowStart: Date.now(),
  };
}

function refillBucket(bucket: TokenBucket): void {
  const now = Date.now();
  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(
    bucket.config.burstSize,
    bucket.tokens + elapsed * bucket.config.refillRate,
  );
  bucket.lastRefill = now;

  // Reset hourly counter if window expired
  if (now - bucket.hourlyWindowStart >= 60 * 60 * 1000) {
    bucket.hourlyCallCount = 0;
    bucket.hourlyWindowStart = now;
  }

  // Prune old call log entries — find cutoff via binary search instead of O(n) shift
  const windowStart = now - bucket.config.windowMs;
  let pruneIndex = 0;
  while (pruneIndex < bucket.callLog.length && bucket.callLog[pruneIndex] < windowStart) {
    pruneIndex++;
  }
  if (pruneIndex > 0) {
    bucket.callLog = bucket.callLog.slice(pruneIndex);
  }
}

// ─── Session Tracker ─────────────────────────────────────────────────────────

interface SessionUsage {
  mcpSessionId: string;
  threadId?: number;
  /** Per-service call counts in current window */
  serviceCalls: Record<string, number>;
  /** Last activity timestamp */
  lastActivity: number;
  /** Total calls across all services */
  totalCalls: number;
}

// ─── Rate Limiter ───────────────────────────────────────────────────────────

export interface AcquireResult {
  allowed: boolean;
  /** If not allowed, suggested wait time in ms */
  waitMs?: number;
  /** Current usage as fraction (0.0 - 1.0) */
  usage: number;
  /** Number of active sessions competing for this service */
  activeSessions: number;
  /** Human-readable status message */
  message: string;
}

export interface ServiceStats {
  service: string;
  description: string;
  /** Calls in current window */
  callsInWindow: number;
  /** Max allowed per window */
  maxPerWindow: number;
  /** Usage percentage (0-100) */
  usagePercent: number;
  /** Available tokens (burst capacity) */
  availableTokens: number;
  /** Burst capacity */
  burstCapacity: number;
  /** Per-session breakdown */
  sessionBreakdown: Array<{
    mcpSessionId: string;
    threadId?: number;
    calls: number;
  }>;
}

export interface RateLimiterStats {
  services: ServiceStats[];
  activeSessions: number;
  totalCallsLastHour: number;
}

class RateLimiter {
  private buckets: Map<string, TokenBucket> = new Map();
  private sessions: Map<string, SessionUsage> = new Map();
  private serviceConfigs: Record<string, ServiceConfig>;

  constructor(customConfigs?: Partial<Record<string, Partial<ServiceConfig>>>) {
    // Merge defaults with custom configs
    this.serviceConfigs = { ...DEFAULT_SERVICES };
    if (customConfigs) {
      for (const [service, overrides] of Object.entries(customConfigs)) {
        if (overrides) {
          this.serviceConfigs[service] = {
            ...(this.serviceConfigs[service] ?? DEFAULT_SERVICES.web),
            ...overrides,
          } as ServiceConfig;
        }
      }
    }

    // Initialize buckets
    for (const [service, config] of Object.entries(this.serviceConfigs)) {
      this.buckets.set(service, createBucket(config));
    }
  }

  /**
   * Try to acquire capacity for an API call.
   * Call this BEFORE making an external API request.
   */
  acquire(
    service: string,
    mcpSessionId: string,
    threadId?: number,
    count = 1
  ): AcquireResult {
    // Ensure bucket exists (auto-create for unknown services)
    if (!this.buckets.has(service)) {
      const config = this.serviceConfigs[service] ?? { ...DEFAULT_SERVICES.web, description: service };
      this.serviceConfigs[service] = config;
      this.buckets.set(service, createBucket(config));
    }

    const bucket = this.buckets.get(service)!;
    refillBucket(bucket);

    // Validate count
    if (count <= 0) count = 1;

    const activeSessions = this.getActiveSessionCount();
    const usage = Math.min(1.0, bucket.callLog.length / bucket.config.maxRequests);

    // Fair share: if multiple sessions, each gets proportional quota
    const fairShare = activeSessions > 1 ? bucket.config.burstSize / activeSessions : bucket.config.burstSize;
    const sessionCalls = this.sessions.get(mcpSessionId)?.serviceCalls[service] ?? 0;

    // Check if this session is hogging the resource
    const isHogging = activeSessions > 1 && sessionCalls > fairShare * 1.5;

    if (bucket.tokens < count) {
      // Not enough tokens — DON'T track denied requests in session stats (bug fix)
      const waitMs = Math.ceil((count - bucket.tokens) / bucket.config.refillRate * 1000);
      return {
        allowed: false,
        waitMs,
        usage,
        activeSessions,
        message: `Rate limit reached for ${bucket.config.description}. ` +
          `${activeSessions} active agents sharing capacity. ` +
          `Wait ${Math.ceil(waitMs / 1000)}s before retrying.` +
          (isHogging ? " You're using more than your fair share — please slow down." : ""),
      };
    }

    // Only track session AFTER confirming the request is allowed
    this.touchSession(mcpSessionId, threadId, service, count);

    // Warning thresholds
    const warningLevel = usage > 0.8 ? "high"
      : usage > 0.5 ? "moderate"
        : "normal";

    // Consume tokens and track
    bucket.tokens -= count;
    const now = Date.now();
    for (let i = 0; i < count; i++) {
      bucket.callLog.push(now);
    }
    bucket.hourlyCallCount += count;

    let message = `OK — ${bucket.config.description}: ${Math.floor(bucket.tokens)}/${bucket.config.burstSize} tokens available`;
    if (activeSessions > 1) {
      message += `, ${activeSessions} agents sharing`;
    }
    if (warningLevel === "high") {
      message += ". ⚠️ Approaching rate limit — consider spacing out requests.";
    } else if (warningLevel === "moderate") {
      message += ". Usage moderate — monitoring.";
    }
    if (isHogging) {
      message += " ⚠️ You're using more than your fair share — other agents need capacity too.";
    }

    return {
      allowed: true,
      usage,
      activeSessions,
      message,
    };
  }

  /**
   * Record API calls that bypass the acquire() flow (e.g., implicit calls).
   * Use this for tracking only — doesn't block.
   */
  record(service: string, mcpSessionId: string, threadId?: number, count = 1): void {
    if (count <= 0) count = 1;
    if (!this.buckets.has(service)) return;
    const bucket = this.buckets.get(service)!;
    refillBucket(bucket);
    const now = Date.now();
    for (let i = 0; i < count; i++) {
      bucket.callLog.push(now);
    }
    bucket.hourlyCallCount += count;
    // Consume tokens for record-only too — keeps stats consistent
    bucket.tokens = Math.max(0, bucket.tokens - count);
    this.touchSession(mcpSessionId, threadId, service, count);
  }

  /** Get comprehensive usage statistics for the dashboard. */
  getStats(): RateLimiterStats {
    const now = Date.now();
    const services: ServiceStats[] = [];

    for (const [service, bucket] of this.buckets) {
      refillBucket(bucket);
      const sessionBreakdown: ServiceStats["sessionBreakdown"] = [];

      for (const [sessionId, session] of this.sessions) {
        const calls = session.serviceCalls[service] ?? 0;
        if (calls > 0) {
          sessionBreakdown.push({
            mcpSessionId: sessionId,
            threadId: session.threadId,
            calls,
          });
        }
      }

      services.push({
        service,
        description: bucket.config.description,
        callsInWindow: bucket.callLog.length,
        maxPerWindow: bucket.config.maxRequests,
        usagePercent: Math.min(100, Math.round(
          (bucket.callLog.length / bucket.config.maxRequests) * 100
        )),
        availableTokens: Math.floor(bucket.tokens),
        burstCapacity: bucket.config.burstSize,
        sessionBreakdown,
      });
    }

    // Total calls in last hour — use dedicated hourly counter (not callLog which
    // gets pruned to short windows for services like telegram/openai)
    let totalCallsLastHour = 0;
    for (const bucket of this.buckets.values()) {
      totalCallsLastHour += bucket.hourlyCallCount;
    }

    return {
      services,
      activeSessions: this.getActiveSessionCount(),
      totalCallsLastHour,
    };
  }

  /** Remove a session from tracking (called when session ends). */
  removeSession(mcpSessionId: string): void {
    this.sessions.delete(mcpSessionId);
  }

  /** Reset all counters (useful for testing). */
  reset(): void {
    for (const [service, config] of Object.entries(this.serviceConfigs)) {
      this.buckets.set(service, createBucket(config));
    }
    this.sessions.clear();
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private touchSession(
    mcpSessionId: string,
    threadId: number | undefined,
    service: string,
    count: number
  ): void {
    let session = this.sessions.get(mcpSessionId);
    if (!session) {
      session = {
        mcpSessionId,
        threadId,
        serviceCalls: {},
        lastActivity: Date.now(),
        totalCalls: 0,
      };
      this.sessions.set(mcpSessionId, session);
    }
    session.lastActivity = Date.now();
    session.serviceCalls[service] = (session.serviceCalls[service] ?? 0) + count;
    session.totalCalls += count;
    if (threadId !== undefined) session.threadId = threadId;
  }

  private getActiveSessionCount(): number {
    const staleThreshold = Date.now() - 5 * 60 * 1000; // 5 min
    let active = 0;
    for (const session of this.sessions.values()) {
      if (session.lastActivity > staleThreshold) active++;
    }
    return active;
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

/** Global rate limiter instance — shared across all MCP sessions in-process. */
export const rateLimiter = new RateLimiter(
  parseEnvOverrides()
);

/**
 * Parse environment variable overrides for rate limits.
 * Format: RATE_LIMIT_{SERVICE}_{FIELD}=value
 * Example: RATE_LIMIT_GITHUB_MAX_REQUESTS=3000
 */
function parseEnvOverrides(): Partial<Record<string, Partial<ServiceConfig>>> | undefined {
  const overrides: Record<string, Partial<ServiceConfig>> = {};
  let hasOverrides = false;

  for (const [key, value] of Object.entries(process.env)) {
    const match = key.match(/^RATE_LIMIT_(\w+)_(MAX_REQUESTS|WINDOW_MS|BURST_SIZE|REFILL_RATE)$/i);
    if (match && value) {
      const service = match[1].toLowerCase();
      const field = match[2].toLowerCase();
      const num = Number(value);
      if (!Number.isFinite(num)) continue;

      if (!overrides[service]) overrides[service] = {};
      hasOverrides = true;

      switch (field) {
        case "max_requests": overrides[service].maxRequests = num; break;
        case "window_ms": overrides[service].windowMs = num; break;
        case "burst_size": overrides[service].burstSize = num; break;
        case "refill_rate": overrides[service].refillRate = num; break;
      }
    }
  }

  return hasOverrides ? overrides : undefined;
}
