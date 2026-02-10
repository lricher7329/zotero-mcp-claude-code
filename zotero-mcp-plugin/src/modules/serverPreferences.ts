import { config } from "../../package.json";

declare let ztoolkit: ZToolkit;

const PREFS_PREFIX = config.prefsPrefix;
const MCP_SERVER_PORT = `${PREFS_PREFIX}.mcp.server.port`;
const MCP_SERVER_ENABLED = `${PREFS_PREFIX}.mcp.server.enabled`;
const MCP_SERVER_ALLOW_REMOTE = `${PREFS_PREFIX}.mcp.server.allowRemote`;

type PreferenceObserver = (name: string) => void;

class ServerPreferences {
  private observers: PreferenceObserver[] = [];
  private observerID: symbol | null = null;

  constructor() {
    this.initializeDefaults();
    this.register();
  }

  private initializeDefaults(): void {
    // Set default values if not defined
    const currentPort = Zotero.Prefs.get(MCP_SERVER_PORT, true);
    const currentEnabled = Zotero.Prefs.get(MCP_SERVER_ENABLED, true);

    if (currentPort === undefined || currentPort === null) {
      Zotero.Prefs.set(MCP_SERVER_PORT, 23120, true);
    }

    if (currentEnabled === undefined || currentEnabled === null) {
      Zotero.Prefs.set(MCP_SERVER_ENABLED, true, true);
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
    } catch (error) {
      return DEFAULT_PORT;
    }
  }

  public isServerEnabled(): boolean {
    const DEFAULT_ENABLED = true;
    try {
      const enabled = Zotero.Prefs.get(MCP_SERVER_ENABLED, true);

      if (enabled === undefined || enabled === null) {
        return DEFAULT_ENABLED;
      }

      return Boolean(enabled);
    } catch (error) {
      ztoolkit.log(
        `[ServerPreferences] Error getting server enabled status: ${error}`,
        "error",
      );
      return DEFAULT_ENABLED;
    }
  }

  public isRemoteAccessAllowed(): boolean {
    const DEFAULT_ALLOW_REMOTE = false;
    try {
      const allowRemote = Zotero.Prefs.get(MCP_SERVER_ALLOW_REMOTE, true);

      if (allowRemote === undefined || allowRemote === null) {
        return DEFAULT_ALLOW_REMOTE;
      }

      return Boolean(allowRemote);
    } catch (error) {
      ztoolkit.log(
        `[ServerPreferences] Error getting allow remote status: ${error}`,
        "error",
      );
      return DEFAULT_ALLOW_REMOTE;
    }
  }

  public addObserver(observer: PreferenceObserver): void {
    this.observers.push(observer);
  }

  public removeObserver(observer: PreferenceObserver): void {
    const index = this.observers.indexOf(observer);
    if (index > -1) {
      this.observers.splice(index, 1);
    }
  }

  private register(): void {
    try {
      this.observerID = Zotero.Prefs.registerObserver(
        MCP_SERVER_ENABLED,
        (name: string) => {
          this.observers.forEach((observer) => observer(name));
        },
      );
    } catch (error) {
      if (typeof ztoolkit !== "undefined") {
        ztoolkit.log(
          `[ServerPreferences] Error registering observer: ${error}`,
          "error",
        );
      }
    }
  }

  public unregister(): void {
    if (this.observerID) {
      Zotero.Prefs.unregisterObserver(this.observerID);
      this.observerID = null;
    }
    this.observers = [];
  }
}

export const serverPreferences = new ServerPreferences();
