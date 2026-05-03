import { config } from "../../package.json";

declare let ztoolkit: ZToolkit;
declare let Zotero: any;

const PREFS_PREFIX = config.prefsPrefix;

const MCP_SERVER_PORT = `${PREFS_PREFIX}.mcp.server.port`;
const MCP_SERVER_ENABLED = `${PREFS_PREFIX}.mcp.server.enabled`;
const MCP_SERVER_ALLOW_REMOTE = `${PREFS_PREFIX}.mcp.server.allowRemote`;
const MCP_SERVER_AUTH_TOKEN = `${PREFS_PREFIX}.mcp.server.authToken`;
const MCP_SERVER_REQUIRE_AUTH = `${PREFS_PREFIX}.mcp.server.requireAuth`;

// Per-scope write opt-ins. Default false; the user enables granularly.
// Splitting these reduces blast radius when an LLM is prompt-injected.
const MCP_WRITE_NOTES = `${PREFS_PREFIX}.mcp.write.notes`;
const MCP_WRITE_TAGS = `${PREFS_PREFIX}.mcp.write.tags`;
const MCP_WRITE_COLLECTIONS = `${PREFS_PREFIX}.mcp.write.collections`;
const MCP_WRITE_METADATA = `${PREFS_PREFIX}.mcp.write.metadata`;
const MCP_WRITE_DELETE = `${PREFS_PREFIX}.mcp.write.delete`;
const MCP_WRITE_BULK = `${PREFS_PREFIX}.mcp.write.bulk`;
const MCP_WRITE_IMPORT = `${PREFS_PREFIX}.mcp.write.import`;

// Legacy single boolean. We honor it on first read for upgrade compatibility:
// if it was true and the per-scope prefs are unset, the user previously had
// "all writes on" — keep that posture until they tighten it.
const MCP_WRITE_ENABLED_LEGACY = `${PREFS_PREFIX}.mcp.write.enabled`;

export type WriteScope =
  | "notes"
  | "tags"
  | "collections"
  | "metadata"
  | "delete"
  | "bulk"
  | "import";

const SCOPE_PREFS: Record<WriteScope, string> = {
  notes: MCP_WRITE_NOTES,
  tags: MCP_WRITE_TAGS,
  collections: MCP_WRITE_COLLECTIONS,
  metadata: MCP_WRITE_METADATA,
  delete: MCP_WRITE_DELETE,
  bulk: MCP_WRITE_BULK,
  import: MCP_WRITE_IMPORT,
};

type PreferenceObserver = (name: string) => void;

class ServerPreferences {
  private observers: PreferenceObserver[] = [];
  private observerIDs: symbol[] = [];

  constructor() {
    this.initializeDefaults();
    this.register();
  }

  private initializeDefaults(): void {
    const setIfUnset = (name: string, value: any) => {
      const current = Zotero.Prefs.get(name, true);
      if (current === undefined || current === null) {
        Zotero.Prefs.set(name, value, true);
      }
    };

    setIfUnset(MCP_SERVER_PORT, 23120);
    setIfUnset(MCP_SERVER_ENABLED, true);
    // Auth defaults: required when remote, optional on loopback. Token is
    // generated on first start (see ensureAuthToken).
    setIfUnset(MCP_SERVER_REQUIRE_AUTH, false);

    // Migrate legacy mcp.write.enabled into per-scope prefs on first run.
    const legacy = Zotero.Prefs.get(MCP_WRITE_ENABLED_LEGACY, true);
    const anyScopeSet = (Object.values(SCOPE_PREFS) as string[]).some(
      (p) => Zotero.Prefs.get(p, true) !== undefined,
    );
    if (legacy === true && !anyScopeSet) {
      // Preserve the user's prior posture: writes were on, keep them on
      // for the everyday-safe scopes only. Destructive scopes stay off so
      // the upgrade can never expand surface area silently.
      Zotero.Prefs.set(MCP_WRITE_NOTES, true, true);
      Zotero.Prefs.set(MCP_WRITE_TAGS, true, true);
      Zotero.Prefs.set(MCP_WRITE_COLLECTIONS, true, true);
      Zotero.Prefs.set(MCP_WRITE_METADATA, true, true);
      Zotero.Prefs.set(MCP_WRITE_DELETE, false, true);
      Zotero.Prefs.set(MCP_WRITE_BULK, false, true);
      Zotero.Prefs.set(MCP_WRITE_IMPORT, false, true);
    } else {
      for (const p of Object.values(SCOPE_PREFS)) {
        setIfUnset(p, false);
      }
    }
  }

  public getPort(): number {
    const DEFAULT_PORT = 23120;
    try {
      const port = Zotero.Prefs.get(MCP_SERVER_PORT, true);
      if (port === undefined || port === null || isNaN(Number(port))) {
        return DEFAULT_PORT;
      }
      return Number(port);
    } catch {
      return DEFAULT_PORT;
    }
  }

  public isServerEnabled(): boolean {
    try {
      const enabled = Zotero.Prefs.get(MCP_SERVER_ENABLED, true);
      if (enabled === undefined || enabled === null) return true;
      return Boolean(enabled);
    } catch (error) {
      ztoolkit.log(
        `[ServerPreferences] Error getting server enabled status: ${error}`,
        "error",
      );
      return true;
    }
  }

  public isRemoteAccessAllowed(): boolean {
    try {
      const allowRemote = Zotero.Prefs.get(MCP_SERVER_ALLOW_REMOTE, true);
      if (allowRemote === undefined || allowRemote === null) return false;
      return Boolean(allowRemote);
    } catch (error) {
      ztoolkit.log(
        `[ServerPreferences] Error getting allow remote status: ${error}`,
        "error",
      );
      return false;
    }
  }

  /**
   * Auth token gates /mcp access. When remote access is enabled, auth is
   * mandatory regardless of the requireAuth pref; the pref only governs
   * whether loopback callers must also present the token.
   */
  public requiresAuth(): boolean {
    if (this.isRemoteAccessAllowed()) return true;
    try {
      const v = Zotero.Prefs.get(MCP_SERVER_REQUIRE_AUTH, true);
      if (v === undefined || v === null) return false;
      return Boolean(v);
    } catch {
      return false;
    }
  }

  public getAuthToken(): string {
    try {
      const t = Zotero.Prefs.get(MCP_SERVER_AUTH_TOKEN, true);
      return typeof t === "string" ? t : "";
    } catch {
      return "";
    }
  }

  /**
   * Generate and persist a fresh auth token. Returns the new token.
   * Token format: zmcp_<48 lowercase hex chars>. Long enough to defeat brute
   * force; short enough to paste into client config.
   */
  public regenerateAuthToken(): string {
    const bytes = new Uint8Array(24);
    try {
      (globalThis as any).crypto.getRandomValues(bytes);
    } catch {
      // Fallback: Math.random is weak but better than zeros if crypto missing.
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
    }
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
    const token = `zmcp_${hex}`;
    Zotero.Prefs.set(MCP_SERVER_AUTH_TOKEN, token, true);
    return token;
  }

  /**
   * Returns the current token, generating one if missing. Always returns a
   * usable token so the prefs UI never has to handle an empty state.
   */
  public ensureAuthToken(): string {
    const existing = this.getAuthToken();
    if (existing) return existing;
    return this.regenerateAuthToken();
  }

  /**
   * Constant-time string comparison to avoid timing oracle on token check.
   * Both sides are normalized to UTF-8 byte arrays first.
   */
  public verifyAuthToken(presented: string): boolean {
    const expected = this.getAuthToken();
    if (!expected) return false;
    if (typeof presented !== "string") return false;
    // Reject obviously-too-long inputs cheaply.
    if (presented.length > 256) return false;
    if (presented.length !== expected.length) {
      // Still walk the string to keep timing flat-ish.
      let acc = 1;
      for (let i = 0; i < expected.length; i++) {
        acc |= expected.charCodeAt(i) ^ (presented.charCodeAt(i) || 0);
      }
      void acc;
      return false;
    }
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
    }
    return diff === 0;
  }

  public isScopeEnabled(scope: WriteScope): boolean {
    const prefName = SCOPE_PREFS[scope];
    if (!prefName) return false;
    try {
      const v = Zotero.Prefs.get(prefName, true);
      if (v === undefined || v === null) return false;
      return Boolean(v);
    } catch {
      return false;
    }
  }

  /** Any write scope on → at least some write tools should be exposed. */
  public isAnyWriteScopeEnabled(): boolean {
    return (Object.keys(SCOPE_PREFS) as WriteScope[]).some((s) =>
      this.isScopeEnabled(s),
    );
  }

  public addObserver(observer: PreferenceObserver): void {
    this.observers.push(observer);
  }

  public removeObserver(observer: PreferenceObserver): void {
    const index = this.observers.indexOf(observer);
    if (index > -1) this.observers.splice(index, 1);
  }

  private register(): void {
    // Watch every pref that affects how the listener binds or what it serves.
    // Without this, port/allowRemote changes silently fail to take effect
    // until the user toggles the master enable.
    const watched = [
      MCP_SERVER_ENABLED,
      MCP_SERVER_PORT,
      MCP_SERVER_ALLOW_REMOTE,
      MCP_SERVER_REQUIRE_AUTH,
      MCP_SERVER_AUTH_TOKEN,
      ...Object.values(SCOPE_PREFS),
    ];
    for (const name of watched) {
      try {
        const id = Zotero.Prefs.registerObserver(name, (changed: string) => {
          this.observers.forEach((o) => o(changed));
        });
        if (id) this.observerIDs.push(id);
      } catch (error) {
        if (typeof ztoolkit !== "undefined") {
          ztoolkit.log(
            `[ServerPreferences] Error registering observer for ${name}: ${error}`,
            "error",
          );
        }
      }
    }
  }

  public unregister(): void {
    for (const id of this.observerIDs) {
      try {
        Zotero.Prefs.unregisterObserver(id);
      } catch {
        // best-effort
      }
    }
    this.observerIDs = [];
    this.observers = [];
  }
}

export const serverPreferences = new ServerPreferences();
