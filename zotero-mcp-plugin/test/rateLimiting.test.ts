import { expect } from "chai";
import {
  RateLimiter,
  RequestRateLimiter,
  isLightweightProtocolRequest,
  isLoopbackAddress,
  resolveRateLimitKey,
} from "../src/modules/rateLimiting";

const SESSION_A = "mcp-aaaaaaaa-1111";
const SESSION_B = "mcp-bbbbbbbb-2222";
const active = new Set([SESSION_A, SESSION_B]);
const isActiveSession = (id: string) => active.has(id);

function generalKey(host: string, sessionId?: string): string {
  return resolveRateLimitKey({
    host,
    sessionId,
    isActiveSession,
    sessionKeyForRemote: false,
  });
}

/** Spend tokens until the limiter refuses; returns how many were allowed. */
function drain(allow: () => boolean, max = 10000): number {
  let n = 0;
  while (n < max && allow()) n++;
  return n;
}

const TOOL_CALL = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "search_library", arguments: {} },
});
const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {},
});

describe("rateLimiting", function () {
  describe("isLoopbackAddress", function () {
    it("accepts IPv4, IPv6 and IPv4-mapped loopback", function () {
      expect(isLoopbackAddress("127.0.0.1")).to.equal(true);
      expect(isLoopbackAddress("::1")).to.equal(true);
      expect(isLoopbackAddress("[::1]")).to.equal(true);
      expect(isLoopbackAddress("::ffff:127.0.0.1")).to.equal(true);
    });

    it("rejects other addresses", function () {
      expect(isLoopbackAddress("192.168.1.5")).to.equal(false);
      expect(isLoopbackAddress("0.0.0.0")).to.equal(false);
      expect(isLoopbackAddress(undefined)).to.equal(false);
    });
  });

  describe("resolveRateLimitKey", function () {
    it("keys loopback requests by an active session", function () {
      expect(generalKey("127.0.0.1", SESSION_A)).to.equal(
        `session:${SESSION_A}`,
      );
      expect(generalKey("::1", SESSION_B)).to.equal(`session:${SESSION_B}`);
    });

    it("falls back to the host for an unknown session", function () {
      expect(generalKey("127.0.0.1", "mcp-cccccccc-3333")).to.equal(
        "client:127.0.0.1",
      );
    });

    it("falls back to the host when no session is presented", function () {
      expect(generalKey("127.0.0.1")).to.equal("client:127.0.0.1");
    });

    it("keeps remote hosts on a per-IP key for the general limiter", function () {
      expect(generalKey("192.168.1.5", SESSION_A)).to.equal(
        "client:192.168.1.5",
      );
    });

    it("allows session keys for remote hosts when asked (write limiter)", function () {
      expect(
        resolveRateLimitKey({
          host: "192.168.1.5",
          sessionId: SESSION_A,
          isActiveSession,
          sessionKeyForRemote: true,
        }),
      ).to.equal(`session:${SESSION_A}`);
    });
  });

  describe("isLightweightProtocolRequest", function () {
    it("accepts initialize, notifications, tools/list and ping", function () {
      expect(isLightweightProtocolRequest(INITIALIZE)).to.equal(true);
      expect(
        isLightweightProtocolRequest(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/initialized",
          }),
        ),
      ).to.equal(true);
      expect(
        isLightweightProtocolRequest(
          JSON.stringify([
            { jsonrpc: "2.0", id: 2, method: "tools/list" },
            { jsonrpc: "2.0", id: 3, method: "ping" },
          ]),
        ),
      ).to.equal(true);
    });

    it("rejects tool calls, mixed batches and bad bodies", function () {
      expect(isLightweightProtocolRequest(TOOL_CALL)).to.equal(false);
      expect(
        isLightweightProtocolRequest(`[${INITIALIZE},${TOOL_CALL}]`),
      ).to.equal(false);
      expect(isLightweightProtocolRequest("[]")).to.equal(false);
      expect(isLightweightProtocolRequest("")).to.equal(false);
      expect(isLightweightProtocolRequest("{not json")).to.equal(false);
    });
  });

  describe("RequestRateLimiter", function () {
    // Frozen clock: no refill during a test.
    const frozen = () => 1_000_000;

    it("gives two loopback sessions independent buckets", function () {
      const limiter = new RequestRateLimiter(frozen);
      const keyA = generalKey("127.0.0.1", SESSION_A);
      const keyB = generalKey("127.0.0.1", SESSION_B);

      const allowedA = drain(() => limiter.check(keyA, false) === null);
      expect(allowedA).to.equal(60);
      expect(limiter.check(keyA, false)).to.equal("client");

      // Session B is untouched by A's burst.
      expect(limiter.check(keyB, false)).to.equal(null);
    });

    it("sends an unknown session to the shared host bucket", function () {
      const limiter = new RequestRateLimiter(frozen);
      const hostKey = generalKey("127.0.0.1");
      drain(() => limiter.check(hostKey, false) === null);

      const unknownKey = generalKey("127.0.0.1", "mcp-dddddddd-4444");
      expect(unknownKey).to.equal(hostKey);
      expect(limiter.check(unknownKey, false)).to.equal("client");

      // A real session still has its own allowance.
      expect(limiter.check(generalKey("127.0.0.1", SESSION_A), false)).to.equal(
        null,
      );
    });

    it("still applies the global cap across sessions", function () {
      const limiter = new RequestRateLimiter(frozen);
      // Many sessions, each well under its own limit, together hit the cap.
      let allowed = 0;
      let rejection: string | null = null;
      for (let i = 0; i < 1000 && rejection === null; i++) {
        rejection = limiter.check(`session:mcp-${i}`, false);
        if (rejection === null) allowed++;
      }
      expect(rejection).to.equal("global");
      expect(allowed).to.equal(240);
      // Lightweight requests don't bypass the global cap.
      expect(limiter.check("session:mcp-fresh", true)).to.equal("global");
    });

    it("lets reconnect traffic through a drained bucket from a reserve", function () {
      const limiter = new RequestRateLimiter(frozen);
      const key = generalKey("127.0.0.1");
      drain(() => limiter.check(key, false) === null);
      expect(limiter.check(key, false)).to.equal("client");

      // initialize / notifications / tools/list still get through...
      const reserve = drain(() => limiter.check(key, true) === null);
      expect(reserve).to.equal(20);
      // ...but the reserve is bounded, and tool calls stay blocked.
      expect(limiter.check(key, true)).to.equal("client");
      expect(limiter.check(key, false)).to.equal("client");
    });
  });

  describe("RateLimiter", function () {
    it("refills over time", function () {
      let now = 0;
      const limiter = new RateLimiter(2, 1, 10, () => now);
      expect(drain(() => limiter.allow("k"))).to.equal(2);
      now += 1000;
      expect(limiter.allow("k")).to.equal(true);
      expect(limiter.allow("k")).to.equal(false);
    });
  });
});
