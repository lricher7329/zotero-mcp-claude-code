import { StreamableMCPServer } from "./streamableMCPServer";
import { serverPreferences } from "./serverPreferences";
import { testMCPIntegration } from "./mcpTest";

declare let ztoolkit: ZToolkit;

/**
 * Helper to get UTF-8 byte length of a string
 */
function getByteLength(str: string): number {
  try {
    return new TextEncoder().encode(str).length;
  } catch {
    let bytes = 0;
    for (let i = 0; i < str.length; i++) {
      const charCode = str.charCodeAt(i);
      if (charCode < 0x80) bytes += 1;
      else if (charCode < 0x800) bytes += 2;
      else if (charCode < 0xd800 || charCode >= 0xe000) bytes += 3;
      else {
        i++;
        bytes += 4;
      }
    }
    return bytes;
  }
}

function writeStringToStream(output: any, str: string): void {
  const converterStream = Cc[
    "@mozilla.org/intl/converter-output-stream;1"
  ].createInstance(Ci.nsIConverterOutputStream);
  (converterStream as any).init(output, "UTF-8", 0, 0);
  converterStream.writeString(str);
  converterStream.flush();
}

/**
 * Two-tier token-bucket rate limiter:
 *   - per-key bucket (per IP, or per session for loopback)
 *   - global bucket as a final cap
 *
 * Both run on every accepted request, regardless of allowRemote, because a
 * prompt-injected LLM or runaway local client can flood the server just as
 * easily as a remote attacker.
 */
class RateLimiter {
  private buckets: Map<string, { tokens: number; lastRefill: number }> =
    new Map();
  private maxTokens: number;
  private refillRate: number; // tokens per second
  private maxBuckets: number;

  constructor(maxTokens = 60, refillRate = 10, maxBuckets = 1024) {
    this.maxTokens = maxTokens;
    this.refillRate = refillRate;
    this.maxBuckets = maxBuckets;
  }

  allow(key: string): boolean {
    const now = Date.now();
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
    const now = Date.now();
    const staleThreshold = 60000;
    for (const [k, b] of this.buckets.entries()) {
      if (now - b.lastRefill > staleThreshold) this.buckets.delete(k);
    }
  }
}

const SESSION_ID_RE = /^mcp-[a-f0-9-]{8,80}$/i;
const MAX_ACTIVE_SESSIONS = 256;

export class HttpServer {
  public static testServer() {
    Zotero.debug("Static testServer method called.");
  }
  private serverSocket: any;
  private isRunning: boolean = false;
  private mcpServer: StreamableMCPServer | null = null;
  private port: number = 8080;
  private activeSessions: Map<string, { createdAt: Date; lastActivity: Date }> =
    new Map();
  private keepAliveTimeout: number = 30000;
  private sessionTimeout: number = 300000; // 5 minutes
  private sessionCleanupInterval: ReturnType<typeof setInterval> | null = null;
  private activeTransports: Set<any> = new Set();

  // Per-key (IP or session) limiter for general traffic.
  private rateLimiter: RateLimiter = new RateLimiter(60, 10, 2048);
  // Stricter limiter for write tool calls — destructive operations should
  // never need to be issued at high frequency.
  private writeRateLimiter: RateLimiter = new RateLimiter(15, 0.5, 2048);
  // Global cap independent of caller identity.
  private globalRateLimiter: RateLimiter = new RateLimiter(120, 30, 4);

  public isServerRunning(): boolean {
    return this.isRunning;
  }

  public start(port: number) {
    if (this.isRunning) {
      Zotero.debug("[HttpServer] Server is already running.");
      return;
    }

    if (!port || isNaN(port) || port < 1 || port > 65535) {
      const errorMsg = `[HttpServer] Invalid port number: ${port}. Port must be between 1 and 65535.`;
      Zotero.debug(errorMsg);
      throw new Error(errorMsg);
    }

    try {
      this.port = port;
      Zotero.debug(
        `[HttpServer] Attempting to start server on port ${port}...`,
      );

      this.serverSocket = Cc[
        "@mozilla.org/network/server-socket;1"
      ].createInstance(Ci.nsIServerSocket);

      const loopbackOnly = !serverPreferences.isRemoteAccessAllowed();
      Zotero.debug(
        `[HttpServer] Binding to ${loopbackOnly ? "127.0.0.1" : "0.0.0.0"}:${port}`,
      );
      this.serverSocket.init(port, loopbackOnly, -1);
      this.serverSocket.asyncListen(this.listener);
      this.isRunning = true;

      Zotero.debug(
        `[HttpServer] Successfully started HTTP server on port ${port}`,
      );

      // Make sure an auth token exists so the prefs UI never has to handle an
      // empty state and so remote-allowed servers always require auth.
      try {
        serverPreferences.ensureAuthToken();
      } catch (e) {
        Zotero.debug(`[HttpServer] Could not ensure auth token: ${e}`);
      }

      this.initializeMCPServer();
      this.startSessionCleanup();
    } catch (e) {
      const errorMsg = `[HttpServer] Failed to start server on port ${port}: ${e}`;
      Zotero.debug(errorMsg);
      this.stop();
      throw new Error(errorMsg);
    }
  }

  private initializeMCPServer(): void {
    try {
      this.mcpServer = new StreamableMCPServer();
      ztoolkit.log(`[HttpServer] Integrated MCP server initialized`);
    } catch (error) {
      ztoolkit.log(`[HttpServer] Failed to initialize MCP server: ${error}`);
    }
  }

  public stop() {
    if (!this.isRunning || !this.serverSocket) {
      Zotero.debug(
        "[HttpServer] Server is not running or socket is null, nothing to stop.",
      );
      return;
    }

    ztoolkit.log(
      `[HttpServer] Closing ${this.activeTransports.size} active connections...`,
    );
    for (const transport of this.activeTransports) {
      try {
        transport.close(0);
      } catch {
        // best-effort
      }
    }
    this.activeTransports.clear();

    try {
      this.serverSocket.close();
      this.isRunning = false;
      Zotero.debug("[HttpServer] HTTP server stopped successfully.");
    } catch (e) {
      Zotero.debug(`[HttpServer] Error stopping server: ${e}`);
    }

    this.stopSessionCleanup();
    this.activeSessions.clear();
    this.cleanupMCPServer();
  }

  private cleanupMCPServer(): void {
    if (this.mcpServer) {
      this.mcpServer = null;
      ztoolkit.log("[HttpServer] MCP server cleaned up");
    }
  }

  private generateSessionId(): string {
    try {
      return "mcp-" + (globalThis as any).crypto.randomUUID();
    } catch {
      const bytes = new Uint8Array(16);
      (globalThis as any).crypto.getRandomValues(bytes);
      const hex = Array.from(bytes, (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      return `mcp-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
  }

  private startSessionCleanup(): void {
    this.stopSessionCleanup();
    this.sessionCleanupInterval = setInterval(() => {
      const now = new Date();
      for (const [sessionId, session] of this.activeSessions.entries()) {
        if (
          now.getTime() - session.lastActivity.getTime() >
          this.sessionTimeout
        ) {
          this.activeSessions.delete(sessionId);
          ztoolkit.log(`[HttpServer] Cleaned up expired session: ${sessionId}`);
        }
      }
      this.rateLimiter.prune();
      this.writeRateLimiter.prune();
      this.globalRateLimiter.prune();
    }, 60000);
  }

  private stopSessionCleanup(): void {
    if (this.sessionCleanupInterval) {
      clearInterval(this.sessionCleanupInterval);
      this.sessionCleanupInterval = null;
      ztoolkit.log(`[HttpServer] Session cleanup timer stopped`);
    }
  }

  private updateSessionActivity(sessionId: string): void {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.lastActivity = new Date();
    }
  }

  /**
   * Read a header value from the raw request text (case-insensitive name).
   * Returns the first matching value, trimmed, or undefined if not present.
   *
   * Header parsing is intentionally line-based and bounded to the headers
   * section so a body containing a header-shaped line cannot impersonate one.
   */
  private getRequestHeader(
    requestText: string,
    name: string,
  ): string | undefined {
    const headersEnd = requestText.indexOf("\r\n\r\n");
    const headersText =
      headersEnd === -1 ? requestText : requestText.substring(0, headersEnd);
    const wantedLower = name.toLowerCase();
    const lines = headersText.split("\r\n");
    // First line is the request line; skip it.
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      const headerName = line.substring(0, colon).trim().toLowerCase();
      if (headerName === wantedLower) {
        return line.substring(colon + 1).trim();
      }
    }
    return undefined;
  }

  /**
   * Count occurrences of a header (case-insensitive). Used to reject
   * duplicate Host (RFC 7230 §5.4) which is otherwise smuggleable through
   * fronting proxies.
   */
  private countHeaderOccurrences(requestText: string, name: string): number {
    const headersEnd = requestText.indexOf("\r\n\r\n");
    const headersText =
      headersEnd === -1 ? requestText : requestText.substring(0, headersEnd);
    const wantedLower = name.toLowerCase();
    const lines = headersText.split("\r\n");
    let count = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      if (line.substring(0, colon).trim().toLowerCase() === wantedLower) {
        count++;
      }
    }
    return count;
  }

  /**
   * Validate Host, Origin, and Content-Type to prevent DNS-rebinding and
   * browser simple-form CSRF.
   *
   * - Host: must be a real loopback name when remote access is disabled.
   *   `0.0.0.0` is no longer accepted as a loopback alias — Chrome stopped
   *   treating it as one in 2024 and we follow suit.
   * - Origin: when present, must be loopback or browser-extension. `null`
   *   (sandboxed iframe, file://, cross-origin redirect) is REJECTED — the
   *   previous code special-cased null-as-allowed which opened the CSRF gap.
   * - Content-Type: POST /mcp must be application/json. Browsers can submit
   *   text/plain via simple form POST without preflight, which would
   *   otherwise sneak JSON-shaped bodies through CORS.
   *
   * Returns null when allowed, otherwise a short reason string for logging.
   */
  private validateRequestHeaders(
    requestText: string,
    method: string,
    path: string,
  ): string | null {
    const allowRemote = serverPreferences.isRemoteAccessAllowed();

    const isLoopbackName = (n: string): boolean => {
      const s = n.toLowerCase().replace(/^\[|\]$/g, "");
      return (
        s === "127.0.0.1" ||
        s === "localhost" ||
        s === "::1" ||
        s.endsWith(".localhost")
      );
    };

    if (this.countHeaderOccurrences(requestText, "Host") > 1) {
      return "duplicate Host header";
    }

    const host = this.getRequestHeader(requestText, "Host");
    if (!host) return "missing Host header";
    const hostName = host.replace(/:\d+$/, "");
    if (!allowRemote && !isLoopbackName(hostName)) {
      return `non-loopback Host header (${host})`;
    }

    // Origin: any non-loopback, non-extension origin (including null) is
    // rejected. Native MCP clients usually omit Origin entirely.
    const origin = this.getRequestHeader(requestText, "Origin");
    if (origin !== undefined) {
      if (origin === "null") {
        return "Origin: null is not permitted";
      }
      let originUrl: URL;
      try {
        originUrl = new URL(origin);
      } catch {
        return `invalid Origin header (${origin})`;
      }
      const isExtensionOrigin =
        originUrl.protocol === "chrome-extension:" ||
        originUrl.protocol === "moz-extension:" ||
        originUrl.protocol === "safari-web-extension:";
      if (
        !isExtensionOrigin &&
        !(allowRemote || isLoopbackName(originUrl.hostname))
      ) {
        return `disallowed Origin (${origin})`;
      }
    }

    // Content-Type enforcement on POST /mcp specifically. We don't enforce on
    // /ping or GET endpoints because they don't accept bodies; we don't
    // enforce on DELETE /mcp because session termination has no body.
    if (method === "POST" && (path === "/mcp" || path.startsWith("/mcp/"))) {
      const ct = this.getRequestHeader(requestText, "Content-Type");
      if (!ct || !/^application\/json(\s*;|$)/i.test(ct)) {
        return `unsupported Content-Type for /mcp (${ct ?? "<missing>"})`;
      }
    }

    return null;
  }

  /**
   * Validate Accept header per MCP Streamable HTTP transport spec. Clients
   * must accept application/json or text/event-stream (or a wildcard). We
   * only enforce on /mcp endpoints; other endpoints serve plain JSON.
   */
  private validateAcceptHeader(
    requestText: string,
    path: string,
  ): string | null {
    if (path !== "/mcp" && !path.startsWith("/mcp/")) return null;
    const accept = this.getRequestHeader(requestText, "Accept");
    if (!accept) return null; // permissive: missing Accept is fine
    const lower = accept.toLowerCase();
    if (
      lower.includes("application/json") ||
      lower.includes("text/event-stream") ||
      lower.includes("*/*")
    ) {
      return null;
    }
    return `unacceptable Accept header (${accept})`;
  }

  /**
   * Per MCP spec, the bearer token gates /mcp access; /ping and the
   * capabilities/help endpoints stay public so health checks and config
   * generators can reach them.
   *
   * Returns null when authorized.
   */
  private validateAuth(
    requestText: string,
    path: string,
    method: string,
  ): string | null {
    if (path.startsWith("/ping")) return null;
    // Allow the GET-only discovery endpoints to stay open for tooling.
    if (
      method === "GET" &&
      (path === "/capabilities" ||
        path === "/help" ||
        path === "/mcp/capabilities" ||
        path === "/mcp/status" ||
        path === "/mcp")
    ) {
      // Auth not required for these read-only descriptors.
      return null;
    }

    if (!serverPreferences.requiresAuth()) return null;

    const authz = this.getRequestHeader(requestText, "Authorization");
    let token = "";
    if (authz) {
      const m = authz.match(/^Bearer\s+(.+)$/i);
      if (m) token = m[1].trim();
    }
    if (!token) {
      // Also accept a custom header so clients that can't set Authorization
      // (e.g. some browser extensions) still have a path. Custom headers
      // trigger CORS preflight for browser callers, defeating simple-form
      // CSRF.
      const custom = this.getRequestHeader(requestText, "X-Zotero-MCP-Token");
      if (custom) token = custom.trim();
    }
    if (!token) return "missing bearer token";
    if (!serverPreferences.verifyAuthToken(token))
      return "invalid bearer token";
    return null;
  }

  private shouldKeepAlive(requestText: string, path: string): boolean {
    if (path === "/mcp" || path.startsWith("/mcp/")) return true;
    const v = this.getRequestHeader(requestText, "Connection");
    if (v && v.toLowerCase().includes("keep-alive")) return true;
    return false;
  }

  private buildHttpHeaders(
    result: any,
    keepAlive: boolean,
    sessionId?: string,
  ): string {
    let headers =
      `HTTP/1.1 ${result.status} ${result.statusText}\r\n` +
      `Content-Type: ${result.headers?.["Content-Type"] || "application/json; charset=utf-8"}\r\n`;

    if (sessionId) headers += `Mcp-Session-Id: ${sessionId}\r\n`;

    if (keepAlive) {
      headers +=
        `Connection: keep-alive\r\n` +
        `Keep-Alive: timeout=${this.keepAliveTimeout / 1000}, max=100\r\n`;
    } else {
      headers += `Connection: close\r\n`;
    }

    return headers;
  }

  private writeJsonResponse(
    output: any,
    status: number,
    statusText: string,
    body: string,
    keepAlive = false,
    extraHeaders = "",
  ): void {
    const result = {
      status,
      statusText,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    };
    const headers =
      this.buildHttpHeaders(result, keepAlive) +
      extraHeaders +
      `Content-Length: ${getByteLength(body)}\r\n` +
      "\r\n";
    output.write(headers, headers.length);
    if (body.length > 0) writeStringToStream(output, body);
  }

  private listener = {
    onSocketAccepted: async (_socket: any, transport: any) => {
      let input: any = null;
      let output: any = null;
      let sin: any = null;

      this.activeTransports.add(transport);

      ztoolkit.log(
        `[HttpServer] New connection accepted from transport: ${transport.host || "unknown"}:${transport.port || "unknown"}`,
      );

      try {
        input = transport.openInputStream(0, 0, 0);
        output = transport.openOutputStream(0, 0, 0);

        const converterStream = Cc[
          "@mozilla.org/intl/converter-input-stream;1"
        ].createInstance(Ci.nsIConverterInputStream);
        converterStream.init(input, "UTF-8", 0, 0);

        sin = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
          Ci.nsIScriptableInputStream,
        );
        sin.init(input);

        let requestText = "";
        let totalBytesRead = 0;
        const maxRequestSize = 1024 * 1024; // 1MB
        const readDeadline = Date.now() + 10000; // 10s wall clock for full read
        let waitAttempts = 0;
        const maxWaitAttempts = 50;
        let headersComplete = false;
        let contentLength = 0;
        let bodyStartIndex = -1;
        let bodyByteCount = 0;

        try {
          // Step 1: Read headers until we find \r\n\r\n.
          while (totalBytesRead < maxRequestSize && !headersComplete) {
            if (Date.now() > readDeadline) {
              ztoolkit.log(
                `[HttpServer] Read deadline exceeded during header parse`,
                "warn",
              );
              break;
            }
            const bytesToRead = Math.min(4096, maxRequestSize - totalBytesRead);
            const available = input.available();

            if (available === 0) {
              waitAttempts++;
              if (waitAttempts > maxWaitAttempts) break;
              await new Promise((resolve) => setTimeout(resolve, 10));
              continue;
            }

            let chunk = "";
            let chunkBytes = 0;
            try {
              const str: { value?: string } = {};
              const bytesRead = converterStream.readString(
                Math.min(bytesToRead, available),
                str,
              );
              chunk = str.value || "";
              chunkBytes = bytesRead;
              if (bytesRead === 0) break;
            } catch (converterError) {
              ztoolkit.log(
                `[HttpServer] Converter failed, using fallback: ${converterError}`,
                "error",
              );
              chunk = sin.read(Math.min(bytesToRead, available));
              chunkBytes = getByteLength(chunk);
              if (!chunk) break;
            }

            requestText += chunk;
            totalBytesRead += chunkBytes;

            bodyStartIndex = requestText.indexOf("\r\n\r\n");
            if (bodyStartIndex !== -1) {
              headersComplete = true;
              const headersSection = requestText.substring(0, bodyStartIndex);
              const m = headersSection.match(/Content-Length:\s*(\d+)/i);
              if (m) contentLength = parseInt(m[1], 10);
              // Reject oversized bodies up front so an attacker can't tie up
              // the listener feeding 1MB of dribble.
              if (contentLength > maxRequestSize) {
                this.writeJsonResponse(
                  output,
                  413,
                  "Payload Too Large",
                  JSON.stringify({ error: "Request body too large" }),
                );
                return;
              }
              // Bytes already read past the header boundary.
              bodyByteCount = getByteLength(
                requestText.substring(bodyStartIndex + 4),
              );
            }
          }

          // Step 2: Read body based on Content-Length.
          if (headersComplete && contentLength > 0) {
            ztoolkit.log(
              `[HttpServer] Reading body: Content-Length=${contentLength}, alreadyRead=${bodyByteCount}`,
            );
            waitAttempts = 0;
            while (bodyByteCount < contentLength) {
              if (Date.now() > readDeadline) {
                ztoolkit.log(
                  `[HttpServer] Read deadline exceeded during body read`,
                  "warn",
                );
                break;
              }
              const available = input.available();
              if (available === 0) {
                waitAttempts++;
                if (waitAttempts > maxWaitAttempts) break;
                await new Promise((resolve) => setTimeout(resolve, 10));
                continue;
              }

              const bytesToRead = Math.min(
                8192,
                contentLength - bodyByteCount,
                available,
              );
              let chunk = "";
              let chunkBytes = 0;
              try {
                const str: { value?: string } = {};
                const bytesRead = converterStream.readString(bytesToRead, str);
                chunk = str.value || "";
                chunkBytes = bytesRead;
                if (bytesRead === 0) break;
              } catch {
                chunk = sin.read(bytesToRead);
                chunkBytes = getByteLength(chunk);
                if (!chunk) break;
              }

              requestText += chunk;
              totalBytesRead += chunkBytes;
              bodyByteCount += chunkBytes;
            }
          }
        } catch (readError) {
          ztoolkit.log(
            `[HttpServer] Error reading request: ${readError}, BytesRead: ${totalBytesRead}`,
            "error",
          );
          requestText = requestText || "INVALID_REQUEST";
        }

        ztoolkit.log(
          `[HttpServer] Total bytes read: ${totalBytesRead}, request text length: ${requestText.length}`,
        );

        try {
          if (converterStream) converterStream.close();
        } catch (e) {
          ztoolkit.log(
            `[HttpServer] Error closing converter stream: ${e}`,
            "error",
          );
        }
        if (sin) sin.close();

        // Empty connection (probe / health check)
        if (totalBytesRead === 0 && requestText.length === 0) {
          ztoolkit.log(
            `[HttpServer] Empty connection - likely health check. Closing.`,
            "info",
          );
          return;
        }

        const requestLine = requestText.split("\r\n")[0];
        ztoolkit.log(
          `[HttpServer] Received request: ${requestLine} (${requestText.length} chars)`,
        );

        if (!requestLine || !requestLine.includes("HTTP/")) {
          ztoolkit.log(
            `[HttpServer] Invalid request format - RequestLine preview: "${requestLine.substring(0, 80)}"`,
            "error",
          );
          this.writeJsonResponse(
            output,
            400,
            "Bad Request",
            JSON.stringify({ error: "Bad Request" }),
          );
          return;
        }

        try {
          const parts = requestLine.split(" ");
          const method = parts[0];
          const urlPath = parts[1] || "/";
          const url = new URL(urlPath, "http://127.0.0.1");
          const query = new URLSearchParams(url.search);
          const path = url.pathname;
          void query;

          // 1. Origin / Host / Content-Type checks.
          const headerRejection = this.validateRequestHeaders(
            requestText,
            method,
            path,
          );
          if (headerRejection !== null) {
            ztoolkit.log(
              `[HttpServer] Rejecting request: ${headerRejection}`,
              "warn",
            );
            this.writeJsonResponse(
              output,
              403,
              "Forbidden",
              JSON.stringify({
                error:
                  "Forbidden: request blocked by host/origin/content-type policy",
              }),
            );
            return;
          }

          // 2. Accept header (per MCP Streamable HTTP spec).
          const acceptRejection = this.validateAcceptHeader(requestText, path);
          if (acceptRejection !== null) {
            ztoolkit.log(`[HttpServer] ${acceptRejection}`, "warn");
            this.writeJsonResponse(
              output,
              406,
              "Not Acceptable",
              JSON.stringify({ error: acceptRejection }),
            );
            return;
          }

          // 3. Auth.
          const authRejection = this.validateAuth(requestText, path, method);
          if (authRejection !== null) {
            ztoolkit.log(
              `[HttpServer] Auth rejection: ${authRejection}`,
              "warn",
            );
            this.writeJsonResponse(
              output,
              401,
              "Unauthorized",
              JSON.stringify({ error: authRejection }),
              false,
              `WWW-Authenticate: Bearer realm="zotero-mcp"\r\n`,
            );
            return;
          }

          // 4. Rate limiting (always on, regardless of allowRemote).
          const clientKey =
            (transport.host && String(transport.host)) || "unknown";
          if (!this.globalRateLimiter.allow("global")) {
            ztoolkit.log(`[HttpServer] Global rate limit exceeded`, "warn");
            this.writeJsonResponse(
              output,
              429,
              "Too Many Requests",
              JSON.stringify({
                error: "Server is busy. Try again later.",
              }),
              false,
              `Retry-After: 5\r\n`,
            );
            return;
          }
          if (!this.rateLimiter.allow(clientKey)) {
            ztoolkit.log(
              `[HttpServer] Rate limit exceeded for ${clientKey}`,
              "warn",
            );
            this.writeJsonResponse(
              output,
              429,
              "Too Many Requests",
              JSON.stringify({
                error: "Rate limit exceeded. Try again later.",
              }),
              false,
              `Retry-After: 5\r\n`,
            );
            return;
          }

          // POST body extraction.
          let requestBody = "";
          if (method === "POST") {
            const bodyStart = requestText.indexOf("\r\n\r\n");
            if (bodyStart !== -1) {
              requestBody = requestText.substring(bodyStart + 4);
            }
          }

          // 5. Session-ID handling.
          let sessionId: string | undefined;
          const presentedSessionId = this.getRequestHeader(
            requestText,
            "Mcp-Session-Id",
          );

          if (path === "/mcp" || path.startsWith("/mcp/")) {
            if (presentedSessionId !== undefined) {
              if (!SESSION_ID_RE.test(presentedSessionId)) {
                this.writeJsonResponse(
                  output,
                  400,
                  "Bad Request",
                  JSON.stringify({ error: "Invalid Mcp-Session-Id format" }),
                );
                return;
              }
              if (this.activeSessions.has(presentedSessionId)) {
                sessionId = presentedSessionId;
                this.updateSessionActivity(sessionId);
                ztoolkit.log(
                  `[HttpServer] Using existing MCP session: ${sessionId}`,
                );
              } else {
                // Per MCP spec, an unrecognized session-id should cause the
                // server to start a new session rather than honor the client
                // claim. We mint a fresh one and return it; the client must
                // pick up the new value from the response header.
                sessionId = this.generateSessionId();
                this.recordSession(sessionId);
                ztoolkit.log(
                  `[HttpServer] Unknown session presented; minted new ${sessionId}`,
                );
              }
            } else {
              sessionId = this.generateSessionId();
              this.recordSession(sessionId);
              ztoolkit.log(
                `[HttpServer] Created new MCP session: ${sessionId}`,
              );
            }
          }

          // Stricter bucket on writeable MCP POSTs.
          if (
            method === "POST" &&
            path === "/mcp" &&
            sessionId &&
            !this.writeRateLimiter.allow(sessionId)
          ) {
            ztoolkit.log(
              `[HttpServer] Per-session write rate limit exceeded for ${sessionId}`,
              "warn",
            );
            this.writeJsonResponse(
              output,
              429,
              "Too Many Requests",
              JSON.stringify({
                error: "Per-session rate limit exceeded.",
              }),
              false,
              `Retry-After: 2\r\n`,
            );
            return;
          }

          const keepAlive = this.shouldKeepAlive(requestText, path);

          let result: any;

          if (path === "/mcp") {
            if (method === "POST") {
              if (this.mcpServer) {
                result = await this.mcpServer.handleMCPRequest(requestBody);
              } else {
                result = {
                  status: 503,
                  statusText: "Service Unavailable",
                  headers: {
                    "Content-Type": "application/json; charset=utf-8",
                  },
                  body: JSON.stringify({ error: "MCP server not enabled" }),
                };
              }
            } else if (method === "GET") {
              result = {
                status: 200,
                statusText: "OK",
                headers: { "Content-Type": "application/json; charset=utf-8" },
                body: JSON.stringify({
                  endpoint: "/mcp",
                  protocol: "MCP (Model Context Protocol)",
                  transport: "Streamable HTTP",
                  versions: ["2024-11-05", "2025-03-26"],
                  description:
                    "POST JSON-RPC 2.0 messages here; DELETE to end a session.",
                  status: this.mcpServer ? "available" : "disabled",
                }),
              };
            } else if (method === "DELETE") {
              // Session termination per MCP 2025-03-26.
              if (
                presentedSessionId &&
                this.activeSessions.has(presentedSessionId)
              ) {
                this.activeSessions.delete(presentedSessionId);
                ztoolkit.log(
                  `[HttpServer] Terminated session ${presentedSessionId}`,
                );
              }
              const headers =
                this.buildHttpHeaders(
                  {
                    status: 204,
                    statusText: "No Content",
                    headers: { "Content-Type": "application/json" },
                  },
                  false,
                ) +
                "Content-Length: 0\r\n" +
                "\r\n";
              output.write(headers, headers.length);
              return;
            } else {
              result = {
                status: 405,
                statusText: "Method Not Allowed",
                headers: {
                  "Content-Type": "application/json; charset=utf-8",
                  Allow: "GET, POST, DELETE",
                },
                body: JSON.stringify({
                  error: `Method ${method} not allowed.`,
                }),
              };
            }
          } else if (path === "/mcp/status") {
            if (this.mcpServer) {
              result = {
                status: 200,
                statusText: "OK",
                headers: { "Content-Type": "application/json; charset=utf-8" },
                body: JSON.stringify(this.mcpServer.getStatus()),
              };
            } else {
              result = {
                status: 503,
                statusText: "Service Unavailable",
                headers: { "Content-Type": "application/json; charset=utf-8" },
                body: JSON.stringify({
                  error: "MCP server not enabled",
                  enabled: false,
                }),
              };
            }
          } else if (
            path === "/mcp/capabilities" ||
            path === "/capabilities" ||
            path === "/help"
          ) {
            result = {
              status: 200,
              statusText: "OK",
              headers: { "Content-Type": "application/json; charset=utf-8" },
              body: JSON.stringify(this.getCapabilities()),
            };
          } else if (path === "/test/mcp") {
            const testResult = await testMCPIntegration();
            result = {
              status: 200,
              statusText: "OK",
              headers: { "Content-Type": "application/json; charset=utf-8" },
              body: JSON.stringify(testResult),
            };
          } else if (path.startsWith("/ping")) {
            const pingResult = {
              status: 200,
              statusText: "OK",
              headers: { "Content-Type": "text/plain; charset=utf-8" },
            };
            const pingHeaders =
              this.buildHttpHeaders(pingResult, keepAlive) +
              "Content-Length: 4\r\n" +
              "\r\n";
            const response = pingHeaders + "pong";
            output.write(response, response.length);
            return;
          } else {
            const notFoundResult = {
              status: 404,
              statusText: "Not Found",
              headers: { "Content-Type": "text/plain; charset=utf-8" },
            };
            const notFoundHeaders =
              this.buildHttpHeaders(notFoundResult, false) +
              "Content-Length: 9\r\n" +
              "\r\n";
            const response = notFoundHeaders + "Not Found";
            output.write(response, response.length);
            return;
          }

          const body = result.body || "";
          const byteLength = getByteLength(body);

          const finalHeaders =
            this.buildHttpHeaders(result, keepAlive, sessionId) +
            `Content-Length: ${byteLength}\r\n` +
            "\r\n";

          ztoolkit.log(
            `[HttpServer] Sending response: ${byteLength} bytes (chars: ${body.length})`,
          );

          output.write(finalHeaders, finalHeaders.length);
          if (byteLength > 0) writeStringToStream(output, body);

          try {
            output.flush();
          } catch {
            // some streams don't flush
          }
        } catch (e) {
          const error = e instanceof Error ? e : new Error(String(e));
          ztoolkit.log(
            `[HttpServer] Error in request handling: ${error.message}`,
            "error",
          );
          // Don't reflect raw error message — could leak internal paths/IDs.
          this.writeJsonResponse(
            output,
            500,
            "Internal Server Error",
            JSON.stringify({ error: "Internal Server Error" }),
          );
        }
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        ztoolkit.log(
          `[HttpServer] Error handling request: ${error.message}`,
          "error",
        );
        ztoolkit.log(`[HttpServer] Error stack: ${error.stack}`, "error");
        try {
          if (!output) {
            output = transport.openOutputStream(0, 0, 0);
          }
          this.writeJsonResponse(
            output,
            500,
            "Internal Server Error",
            JSON.stringify({ error: "Internal Server Error" }),
          );
        } catch (closeError) {
          ztoolkit.log(
            `[HttpServer] Error sending error response: ${closeError}`,
            "error",
          );
        }
      } finally {
        this.activeTransports.delete(transport);
        try {
          if (output) {
            output.close();
          }
        } catch (e) {
          ztoolkit.log(
            `[HttpServer] Error closing output stream: ${e}`,
            "error",
          );
        }
        try {
          if (input) {
            input.close();
          }
        } catch (e) {
          ztoolkit.log(
            `[HttpServer] Error closing input stream: ${e}`,
            "error",
          );
        }
      }
    },
    onStopListening: () => {
      this.isRunning = false;
    },
  };

  /**
   * Insert into activeSessions with LRU eviction so an attacker can't grow
   * the Map by spraying random session IDs into the Mcp-Session-Id header.
   */
  private recordSession(sessionId: string): void {
    if (this.activeSessions.size >= MAX_ACTIVE_SESSIONS) {
      const firstKey = this.activeSessions.keys().next().value;
      if (firstKey) this.activeSessions.delete(firstKey);
    }
    this.activeSessions.set(sessionId, {
      createdAt: new Date(),
      lastActivity: new Date(),
    });
  }

  private getCapabilities() {
    // Trimmed: don't broadcast security posture (auth/rate-limit details) —
    // it's reconnaissance for an attacker that reached the port.
    return {
      serverInfo: {
        name: "Zotero MCP for Claude Code",
        version: SERVER_INFO_VERSION,
        description:
          "Model Context Protocol integration for Zotero research management (Claude Code fork)",
        author: "lricher7329",
        repository: "https://github.com/lricher7329/zotero-mcp-claude-code",
        documentation:
          "https://github.com/lricher7329/zotero-mcp-claude-code/blob/main/README.md",
      },
      protocols: {
        mcp: {
          versions: ["2024-11-05", "2025-03-26"],
          transport: "streamable-http",
          endpoint: "/mcp",
          description: "MCP protocol support for AI clients",
        },
        rest: {
          version: SERVER_INFO_VERSION,
          description: "REST API for direct HTTP access",
          baseUrl: `http://127.0.0.1:${this.port}`,
        },
      },
      endpoints: {
        mcp: {
          "/mcp": {
            methods: ["POST", "GET", "DELETE"],
            description:
              "MCP protocol endpoint (POST), info (GET), session termination (DELETE)",
            contentType: "application/json",
          },
        },
        rest: {
          "/ping": {
            method: "GET",
            description: "Health check endpoint",
            response: "text/plain",
          },
          "/mcp/status": {
            method: "GET",
            description: "MCP server status",
            response: "application/json",
          },
          "/capabilities": {
            method: "GET",
            description: "API capabilities",
            response: "application/json",
          },
        },
      },
      timestamp: new Date().toISOString(),
      status: this.mcpServer ? "ready" : "mcp-disabled",
    };
  }
}

// Single source of truth for the version reported in /capabilities and
// /mcp/status. Bumped during release per zotero-mcp-plugin/CLAUDE.md.
export const SERVER_INFO_VERSION = "1.8.3";

export const httpServer = new HttpServer();
