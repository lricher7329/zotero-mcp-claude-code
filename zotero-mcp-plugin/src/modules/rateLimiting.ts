/**
 * Rate limiting for the HTTP server.
 *
 * Kept free of Zotero/Mozilla globals so it can be unit-tested in Node.
 */

/**
 * Token-bucket rate limiter keyed by an arbitrary string. Used for the
 * per-client bucket (per IP, or per session for loopback), the write bucket,
 * the protocol reserve, and the global cap.
 */
export class RateLimiter {
  private buckets: Map<string, { tokens: number; lastRefill: number }> =
    new Map();
  private maxTokens: number;
  private refillRate: number; // tokens per second
  private maxBuckets: number;
  private now: () => number;

  constructor(
    maxTokens = 60,
    refillRate = 10,
    maxBuckets = 1024,
    now: () => number = Date.now,
  ) {
    this.maxTokens = maxTokens;
    this.refillRate = refillRate;
    this.maxBuckets = maxBuckets;
    this.now = now;
  }

  allow(key: string): boolean {
    const now = this.now();
    let bucket = this.buckets.get(key);

    if (!bucket) {
      // Cap unique-key memory so an attacker can't grow the Map unboundedly
      // by spraying random session IDs.
      if (this.buckets.size >= this.maxBuckets) {
        // Evict the oldest entry. Maps preserve insertion order so the first
        // key out of .keys() is the oldest.
        const firstKey = this.buckets.keys().next().value;
        if (firstKey) this.buckets.delete(firstKey);
      }
      bucket = { tokens: this.maxTokens - 1, lastRefill: now };
      this.buckets.set(key, bucket);
      return true;
    }

    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(
      this.maxTokens,
      bucket.tokens + elapsed * this.refillRate,
    );
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }

  prune(): void {
    const now = this.now();
    const staleThreshold = 60000;
    for (const [k, b] of this.buckets.entries()) {
      if (now - b.lastRefill > staleThreshold) this.buckets.delete(k);
    }
  }
}

/**
 * True for the socket peer addresses Mozilla reports for local connections.
 * This is the transport address, not the Host header.
 */
export function isLoopbackAddress(host: string | undefined): boolean {
  if (!host) return false;
  const s = host.toLowerCase().replace(/^\[|\]$/g, "");
  return s === "::1" || s.startsWith("127.") || s.startsWith("::ffff:127.");
}

/**
 * Pick the bucket key for a request.
 *
 * A validated, active Mcp-Session-Id gets its own bucket; anything else
 * (no header, malformed, expired or unknown) falls back to the client host so
 * a client can't mint a fresh bucket per request by inventing session IDs.
 *
 * `sessionKeyForRemote` is false for the general limiter: sessions are minted
 * on demand, so a remote peer could otherwise multiply its allowance by
 * opening many sessions. On loopback every local MCP client (Claude Code,
 * its subagents, Claude Desktop via mcp-remote) shares one address, so per-
 * session buckets are what keep them from starving each other.
 */
export function resolveRateLimitKey(opts: {
  host: string;
  sessionId: string | undefined;
  isActiveSession: (sessionId: string) => boolean;
  sessionKeyForRemote: boolean;
}): string {
  const { host, sessionId, isActiveSession, sessionKeyForRemote } = opts;
  if (
    sessionId &&
    (sessionKeyForRemote || isLoopbackAddress(host)) &&
    isActiveSession(sessionId)
  ) {
    return `session:${sessionId}`;
  }
  return `client:${host}`;
}

const LIGHTWEIGHT_METHODS = new Set([
  "initialize",
  "ping",
  "tools/list",
  "prompts/list",
  "resources/list",
  "resources/templates/list",
]);

/**
 * True when every JSON-RPC message in the body is connection housekeeping
 * (`initialize`, `notifications/*`, the `*\/list` discovery calls, `ping`).
 * These must keep working on reconnect even after a burst of tool calls has
 * drained the client's bucket.
 */
export function isLightweightProtocolRequest(requestBody: string): boolean {
  if (!requestBody.trim()) return false;
  try {
    const parsed = JSON.parse(requestBody);
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    if (messages.length === 0) return false;
    return messages.every((msg: any) => {
      const method = typeof msg?.method === "string" ? msg.method : "";
      return (
        LIGHTWEIGHT_METHODS.has(method) || method.startsWith("notifications/")
      );
    });
  } catch {
    return false;
  }
}

export type RateLimitRejection = "global" | "client";

/**
 * Global cap, per-client bucket, and a small protocol reserve.
 *
 * Every request spends a global token. Ordinary requests then spend from the
 * client bucket. Lightweight protocol requests spend from the client bucket
 * when it has tokens and from the reserve when it doesn't, so a drained
 * bucket can still reconnect without opening an unlimited side channel.
 */
export class RequestRateLimiter {
  readonly global: RateLimiter;
  readonly client: RateLimiter;
  readonly protocolReserve: RateLimiter;

  constructor(now: () => number = Date.now) {
    this.global = new RateLimiter(240, 30, 4, now);
    this.client = new RateLimiter(60, 10, 2048, now);
    this.protocolReserve = new RateLimiter(20, 1, 2048, now);
  }

  /** Returns null when allowed, otherwise which limit rejected it. */
  check(key: string, lightweight: boolean): RateLimitRejection | null {
    if (!this.global.allow("global")) return "global";
    if (this.client.allow(key)) return null;
    if (lightweight && this.protocolReserve.allow(key)) return null;
    return "client";
  }

  prune(): void {
    this.global.prune();
    this.client.prune();
    this.protocolReserve.prune();
  }
}
