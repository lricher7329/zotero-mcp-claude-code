import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { ClientConfigGenerator } from "./clientConfigGenerator";
import { bindEmbeddingSettings, bindApiUsageStats } from "./prefEmbedding";
import { bindSemanticStatsSettings } from "./prefSemanticIndex";

export async function registerPrefsScripts(_window: Window) {
  // This function is called when the prefs window is opened
  // See addon/content/preferences.xhtml onpaneload
  ztoolkit.log(
    `[PreferenceScript] [DIAGNOSTIC] Registering preference scripts...`,
  );

  addon.data.prefs = { window: _window };

  // Diagnose current preference state
  try {
    const currentEnabled = Zotero.Prefs.get(
      "extensions.zotero.zotero-mcp-plugin.mcp.server.enabled",
      true,
    );
    const currentPort = Zotero.Prefs.get(
      "extensions.zotero.zotero-mcp-plugin.mcp.server.port",
      true,
    );
    ztoolkit.log(
      `[PreferenceScript] [DIAGNOSTIC] Current preferences - enabled: ${currentEnabled}, port: ${currentPort}`,
    );

    // Check for environment compatibility issues
    const doc = _window.document;
    ztoolkit.log(
      `[PreferenceScript] [DIAGNOSTIC] Document available: ${!!doc}`,
    );

    if (doc) {
      const prefElements = doc.querySelectorAll("[preference]");
      ztoolkit.log(
        `[PreferenceScript] [DIAGNOSTIC] Found ${prefElements.length} preference-bound elements`,
      );

      // Specifically check the server enabled element
      const serverEnabledElement = doc.querySelector(
        "#zotero-prefpane-zotero-mcp-plugin-mcp-server-enabled",
      );
      if (serverEnabledElement) {
        ztoolkit.log(
          `[PreferenceScript] [DIAGNOSTIC] Server enabled element found, initial checked state: ${serverEnabledElement.hasAttribute("checked")}`,
        );
      } else {
        ztoolkit.log(
          `[PreferenceScript] [DIAGNOSTIC] WARNING: Server enabled element NOT found`,
        );
      }
    }
  } catch (error) {
    ztoolkit.log(
      `[PreferenceScript] [DIAGNOSTIC] Error in preference diagnostic: ${error}`,
      "error",
    );
  }

  bindPrefEvents();
}

function bindPrefEvents() {
  const doc = addon.data.prefs!.window.document;

  // Initialize collapsible sections
  initCollapsibleSections(doc);

  // Server enabled checkbox with manual event handling
  const serverEnabledCheckbox = doc?.querySelector(
    `#zotero-prefpane-${config.addonRef}-mcp-server-enabled`,
  ) as HTMLInputElement;

  if (serverEnabledCheckbox) {
    // Initialize checkbox state
    const currentEnabled = Zotero.Prefs.get(
      "extensions.zotero.zotero-mcp-plugin.mcp.server.enabled",
      true,
    );
    if (currentEnabled !== false) {
      serverEnabledCheckbox.setAttribute("checked", "true");
    } else {
      serverEnabledCheckbox.removeAttribute("checked");
    }
    ztoolkit.log(
      `[PreferenceScript] Initialized checkbox state: ${currentEnabled}`,
    );

    // Add command listener (XUL checkbox uses 'command' event)
    serverEnabledCheckbox.addEventListener("command", (event: Event) => {
      const checkbox = event.target as Element;
      const checked = checkbox.hasAttribute("checked");
      ztoolkit.log(
        `[PreferenceScript] Checkbox command event - checked: ${checked}`,
      );

      // Update preference manually
      Zotero.Prefs.set(
        "extensions.zotero.zotero-mcp-plugin.mcp.server.enabled",
        checked,
        true,
      );
      ztoolkit.log(`[PreferenceScript] Updated preference to: ${checked}`);

      // Verify the preference was set
      const verify = Zotero.Prefs.get(
        "extensions.zotero.zotero-mcp-plugin.mcp.server.enabled",
        true,
      );
      ztoolkit.log(`[PreferenceScript] Verified preference value: ${verify}`);

      // Directly control server since observer isn't working
      try {
        const httpServer = addon.data.httpServer;
        if (httpServer) {
          if (checked) {
            ztoolkit.log(`[PreferenceScript] Starting server manually...`);
            if (!httpServer.isServerRunning()) {
              const portPref = Zotero.Prefs.get(
                "extensions.zotero.zotero-mcp-plugin.mcp.server.port",
                true,
              );
              const port = typeof portPref === "number" ? portPref : 23120;
              httpServer.start(port);
              ztoolkit.log(`[PreferenceScript] Server started on port ${port}`);
            }
          } else {
            ztoolkit.log(`[PreferenceScript] Stopping server manually...`);
            if (httpServer.isServerRunning()) {
              httpServer.stop();
              ztoolkit.log(`[PreferenceScript] Server stopped`);
            }
          }
        }
      } catch (error) {
        ztoolkit.log(
          `[PreferenceScript] Error controlling server: ${error}`,
          "error",
        );
      }
    });

    // Add click listener for additional debugging
    serverEnabledCheckbox.addEventListener("click", (event: Event) => {
      const checkbox = event.target as Element;
      ztoolkit.log(
        `[PreferenceScript] Checkbox clicked - hasAttribute('checked'): ${checkbox.hasAttribute("checked")}`,
      );

      // Use setTimeout to check state after the click is processed
      setTimeout(() => {
        ztoolkit.log(
          `[PreferenceScript] Checkbox state after click: ${checkbox.hasAttribute("checked")}`,
        );
      }, 10);
    });
  }

  // Port input validation (preference binding handled by XUL)
  const portInput = doc?.querySelector(
    `#zotero-prefpane-${config.addonRef}-mcp-server-port`,
  ) as HTMLInputElement;

  portInput?.addEventListener("change", () => {
    if (portInput) {
      const port = parseInt(portInput.value, 10);
      if (isNaN(port) || port < 1024 || port > 65535) {
        addon.data.prefs!.window.alert(
          getString("pref-server-port-invalid" as any),
        );
        // Reset to previous valid value
        const originalPort =
          Zotero.Prefs.get(
            "extensions.zotero.zotero-mcp-plugin.mcp.server.port",
            true,
          ) || 23120;
        portInput.value = originalPort.toString();
      }
    }
  });

  // Client config generation
  const clientSelect = doc?.querySelector(
    "#client-type-select",
  ) as HTMLSelectElement;
  const serverNameInput = doc?.querySelector(
    "#server-name-input",
  ) as HTMLInputElement;
  const generateButton = doc?.querySelector(
    "#generate-config-button",
  ) as HTMLButtonElement;
  const copyConfigButton = doc?.querySelector(
    "#copy-config-button",
  ) as HTMLButtonElement;
  const configOutput = doc?.querySelector(
    "#config-output",
  ) as HTMLTextAreaElement;
  const configGuide = doc?.querySelector("#config-guide") as HTMLElement;

  let currentConfig = "";
  let currentGuide = "";

  generateButton?.addEventListener("click", () => {
    try {
      const clientType = clientSelect?.value || "claude-desktop";
      const serverName = serverNameInput?.value?.trim() || "zotero-mcp";
      const port = parseInt(portInput?.value || "23120", 10);

      // Generate configuration
      currentConfig = ClientConfigGenerator.generateConfig(
        clientType,
        port,
        serverName,
      );
      currentGuide = ClientConfigGenerator.generateFullGuide(
        clientType,
        port,
        serverName,
      );

      // Display configuration in textarea
      configOutput.value = currentConfig;

      // Display guide in separate area
      displayGuideInArea(currentGuide);

      // Enable copy button
      copyConfigButton.disabled = false;

      ztoolkit.log(`[PreferenceScript] Generated config for ${clientType}`);
    } catch (error) {
      addon.data.prefs!.window.alert(`Config generation failed: ${error}`);
      ztoolkit.log(
        `[PreferenceScript] Config generation failed: ${error}`,
        "error",
      );
    }
  });

  copyConfigButton?.addEventListener("click", async () => {
    try {
      const success =
        await ClientConfigGenerator.copyToClipboard(currentConfig);
      if (success) {
        // Show temporary success message
        const originalText = copyConfigButton.textContent;
        copyConfigButton.textContent = "Copied!";
        copyConfigButton.style.backgroundColor = "#4CAF50";
        setTimeout(() => {
          copyConfigButton.textContent = originalText;
          copyConfigButton.style.backgroundColor = "";
        }, 2000);
      } else {
        // Auto-select text in textarea for manual copy
        configOutput.select();
        configOutput.focus();
        addon.data.prefs!.window.alert(
          "Auto-copy failed. Text has been selected, please use Ctrl+C to copy manually.",
        );
      }
    } catch (error) {
      // Auto-select text in textarea for manual copy
      configOutput.select();
      configOutput.focus();
      addon.data.prefs!.window.alert(
        `Copy failed. Text has been selected, please use Ctrl+C to copy manually.\nError: ${error}`,
      );
      ztoolkit.log(`[PreferenceScript] Copy failed: ${error}`, "error");
    }
  });

  // Helper function to display guide in separate area
  function displayGuideInArea(guide: string) {
    if (!configGuide) return;

    try {
      // Use safe text content to avoid any HTML parsing issues
      configGuide.textContent = guide;
      configGuide.style.whiteSpace = "pre-wrap";
      configGuide.style.fontFamily = "monospace, 'Courier New', Courier";
    } catch (error) {
      ztoolkit.log(
        `[PreferenceScript] Error displaying guide: ${error}`,
        "error",
      );
      configGuide.textContent =
        "Error displaying configuration guide. Please try regenerating the config.";
    }
  }

  // Auto-generate config when client type changes
  clientSelect?.addEventListener("change", () => {
    if (currentConfig) {
      generateButton?.click();
    }
  });

  // Auto-generate config when server name changes
  serverNameInput?.addEventListener("input", () => {
    if (currentConfig) {
      generateButton?.click();
    }
  });

  // ============ Embedding API Settings ============
  bindEmbeddingSettings(doc);

  // ============ API Usage Stats ============
  bindApiUsageStats(doc);

  // ============ Semantic Index Stats ============
  bindSemanticStatsSettings(doc);
}

/**
 * Initialize collapsible accordion sections.
 * Adds toggle arrow indicators to section headings and binds hover styles.
 */
function initCollapsibleSections(doc: Document) {
  const sections = [
    { id: "server", defaultCollapsed: false },
    { id: "client-config", defaultCollapsed: false },
    { id: "content", defaultCollapsed: true },
    { id: "embedding", defaultCollapsed: true },
    { id: "semantic-index", defaultCollapsed: true },
    { id: "contact", defaultCollapsed: true },
  ];

  for (const section of sections) {
    const heading = doc?.querySelector(
      `#section-${section.id}-heading`,
    ) as HTMLElement;
    const body = doc?.querySelector(
      `#section-${section.id}-body`,
    ) as HTMLElement;
    if (!heading || !body) continue;

    // Check if section should start collapsed
    const isCollapsed =
      heading.getAttribute("data-collapsed") === "true" ||
      section.defaultCollapsed;

    // Set initial state
    body.style.display = isCollapsed ? "none" : "";
    heading.setAttribute("data-collapsed", isCollapsed ? "true" : "false");

    // Add toggle arrow indicator
    const currentText = heading.textContent || "";
    const arrow = isCollapsed ? "\u25B6" : "\u25BC"; // ▶ or ▼
    if (
      !currentText.startsWith("\u25B6") &&
      !currentText.startsWith("\u25BC")
    ) {
      heading.textContent = `${arrow} ${currentText}`;
    }

    // Add hover style
    heading.style.cursor = "pointer";
    heading.style.userSelect = "none";
    heading.addEventListener("mouseenter", () => {
      heading.style.opacity = "0.7";
    });
    heading.addEventListener("mouseleave", () => {
      heading.style.opacity = "1";
    });

    // Replace inline onclick with proper event listener
    heading.removeAttribute("onclick");
    heading.addEventListener("click", () => {
      const currentlyCollapsed =
        heading.getAttribute("data-collapsed") === "true";
      const newCollapsed = !currentlyCollapsed;

      body.style.display = newCollapsed ? "none" : "";
      heading.setAttribute("data-collapsed", newCollapsed ? "true" : "false");

      // Update arrow
      const text = heading.textContent || "";
      const newArrow = newCollapsed ? "\u25B6" : "\u25BC";
      heading.textContent = text.replace(/^[\u25B6\u25BC]\s*/, `${newArrow} `);
    });
  }
}
