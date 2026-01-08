import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { ClientConfigGenerator } from "./clientConfigGenerator";

export async function registerPrefsScripts(_window: Window) {
  // This function is called when the prefs window is opened
  // See addon/content/preferences.xhtml onpaneload
  ztoolkit.log(`[PreferenceScript] [DIAGNOSTIC] Registering preference scripts...`);
  
  addon.data.prefs = { window: _window };
  
  // 诊断当前偏好设置状态
  try {
    const currentEnabled = Zotero.Prefs.get("extensions.zotero.zotero-mcp-plugin.mcp.server.enabled", true);
    const currentPort = Zotero.Prefs.get("extensions.zotero.zotero-mcp-plugin.mcp.server.port", true);
    ztoolkit.log(`[PreferenceScript] [DIAGNOSTIC] Current preferences - enabled: ${currentEnabled}, port: ${currentPort}`);
    
    // 检查是否是环境兼容性问题
    const doc = _window.document;
    ztoolkit.log(`[PreferenceScript] [DIAGNOSTIC] Document available: ${!!doc}`);
    
    if (doc) {
      const prefElements = doc.querySelectorAll('[preference]');
      ztoolkit.log(`[PreferenceScript] [DIAGNOSTIC] Found ${prefElements.length} preference-bound elements`);
      
      // 特别检查服务器启用元素
      const serverEnabledElement = doc.querySelector('#zotero-prefpane-zotero-mcp-plugin-mcp-server-enabled');
      if (serverEnabledElement) {
        ztoolkit.log(`[PreferenceScript] [DIAGNOSTIC] Server enabled element found, initial checked state: ${serverEnabledElement.hasAttribute('checked')}`);
      } else {
        ztoolkit.log(`[PreferenceScript] [DIAGNOSTIC] WARNING: Server enabled element NOT found`);
      }
    }
  } catch (error) {
    ztoolkit.log(`[PreferenceScript] [DIAGNOSTIC] Error in preference diagnostic: ${error}`, 'error');
  }
  
  bindPrefEvents();
}

function bindPrefEvents() {
  const doc = addon.data.prefs!.window.document;
  
  // Server enabled checkbox with manual event handling
  const serverEnabledCheckbox = doc?.querySelector(
    `#zotero-prefpane-${config.addonRef}-mcp-server-enabled`,
  ) as HTMLInputElement;
  
  if (serverEnabledCheckbox) {
    // Initialize checkbox state
    const currentEnabled = Zotero.Prefs.get("extensions.zotero.zotero-mcp-plugin.mcp.server.enabled", true);
    if (currentEnabled !== false) {
      serverEnabledCheckbox.setAttribute('checked', 'true');
    } else {
      serverEnabledCheckbox.removeAttribute('checked');
    }
    ztoolkit.log(`[PreferenceScript] Initialized checkbox state: ${currentEnabled}`);
    
    // Add command listener (XUL checkbox uses 'command' event)
    serverEnabledCheckbox.addEventListener("command", (event: Event) => {
      const checkbox = event.target as Element;
      const checked = checkbox.hasAttribute('checked');
      ztoolkit.log(`[PreferenceScript] Checkbox command event - checked: ${checked}`);
      
      // Update preference manually
      Zotero.Prefs.set("extensions.zotero.zotero-mcp-plugin.mcp.server.enabled", checked, true);
      ztoolkit.log(`[PreferenceScript] Updated preference to: ${checked}`);
      
      // Verify the preference was set
      const verify = Zotero.Prefs.get("extensions.zotero.zotero-mcp-plugin.mcp.server.enabled", true);
      ztoolkit.log(`[PreferenceScript] Verified preference value: ${verify}`);
      
      // Directly control server since observer isn't working
      try {
        const httpServer = addon.data.httpServer;
        if (httpServer) {
          if (checked) {
            ztoolkit.log(`[PreferenceScript] Starting server manually...`);
            if (!httpServer.isServerRunning()) {
              const portPref = Zotero.Prefs.get("extensions.zotero.zotero-mcp-plugin.mcp.server.port", true);
              const port = typeof portPref === 'number' ? portPref : 23120;
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
        ztoolkit.log(`[PreferenceScript] Error controlling server: ${error}`, 'error');
      }
    });
    
    // Add click listener for additional debugging
    serverEnabledCheckbox.addEventListener("click", (event: Event) => {
      const checkbox = event.target as Element;
      ztoolkit.log(`[PreferenceScript] Checkbox clicked - hasAttribute('checked'): ${checkbox.hasAttribute('checked')}`);
      
      // Use setTimeout to check state after the click is processed
      setTimeout(() => {
        ztoolkit.log(`[PreferenceScript] Checkbox state after click: ${checkbox.hasAttribute('checked')}`);
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
        const originalPort = Zotero.Prefs.get("extensions.zotero.zotero-mcp-plugin.mcp.server.port", true) || 23120;
        portInput.value = originalPort.toString();
      }
    }
  });

  // Client config generation
  const clientSelect = doc?.querySelector("#client-type-select") as HTMLSelectElement;
  const serverNameInput = doc?.querySelector("#server-name-input") as HTMLInputElement;
  const generateButton = doc?.querySelector("#generate-config-button") as HTMLButtonElement;
  const copyConfigButton = doc?.querySelector("#copy-config-button") as HTMLButtonElement;
  const configOutput = doc?.querySelector("#config-output") as HTMLTextAreaElement;
  const configGuide = doc?.querySelector("#config-guide") as HTMLElement;

  let currentConfig = "";
  let currentGuide = "";

  generateButton?.addEventListener("click", () => {
    try {
      const clientType = clientSelect?.value || "claude-desktop";
      const serverName = serverNameInput?.value?.trim() || "zotero-mcp";
      const port = parseInt(portInput?.value || "23120", 10);

      // Generate configuration
      currentConfig = ClientConfigGenerator.generateConfig(clientType, port, serverName);
      currentGuide = ClientConfigGenerator.generateFullGuide(clientType, port, serverName);

      // Display configuration in textarea
      configOutput.value = currentConfig;

      // Display guide in separate area
      displayGuideInArea(currentGuide);

      // Enable copy button
      copyConfigButton.disabled = false;

      ztoolkit.log(`[PreferenceScript] Generated config for ${clientType}`);
    } catch (error) {
      addon.data.prefs!.window.alert(`配置生成失败: ${error}`);
      ztoolkit.log(`[PreferenceScript] Config generation failed: ${error}`, "error");
    }
  });

  copyConfigButton?.addEventListener("click", async () => {
    try {
      const success = await ClientConfigGenerator.copyToClipboard(currentConfig);
      if (success) {
        // Show temporary success message
        const originalText = copyConfigButton.textContent;
        copyConfigButton.textContent = "已复制!";
        copyConfigButton.style.backgroundColor = "#4CAF50";
        setTimeout(() => {
          copyConfigButton.textContent = originalText;
          copyConfigButton.style.backgroundColor = "";
        }, 2000);
      } else {
        // Auto-select text in textarea for manual copy
        configOutput.select();
        configOutput.focus();
        addon.data.prefs!.window.alert("自动复制失败，已选中文本，请使用 Ctrl+C 手动复制");
      }
    } catch (error) {
      // Auto-select text in textarea for manual copy
      configOutput.select();
      configOutput.focus();
      addon.data.prefs!.window.alert(`复制失败，已选中文本，请使用 Ctrl+C 手动复制\n错误: ${error}`);
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
      ztoolkit.log(`[PreferenceScript] Error displaying guide: ${error}`, "error");
      configGuide.textContent = "配置指南显示出错，请尝试重新生成配置。";
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

  // ============ Semantic Index Stats ============
  bindSemanticStatsSettings(doc);
}

/**
 * Bind embedding API settings handlers
 */
function bindEmbeddingSettings(doc: Document) {
  const apiBaseInput = doc?.querySelector(`#zotero-prefpane-${config.addonRef}-embedding-api-base`) as HTMLInputElement;
  const apiKeyInput = doc?.querySelector(`#zotero-prefpane-${config.addonRef}-embedding-api-key`) as HTMLInputElement;
  const modelInput = doc?.querySelector(`#zotero-prefpane-${config.addonRef}-embedding-model`) as HTMLInputElement;
  const dimensionsInput = doc?.querySelector(`#zotero-prefpane-${config.addonRef}-embedding-dimensions`) as HTMLInputElement;
  const testButton = doc?.querySelector("#test-embedding-button") as HTMLButtonElement;
  const testResult = doc?.querySelector("#embedding-test-result") as HTMLSpanElement;

  // Initialize input values from preferences
  const initValue = (input: HTMLInputElement, prefKey: string, defaultValue: string) => {
    if (input) {
      const value = Zotero.Prefs.get(prefKey, true);
      input.value = value ? String(value) : defaultValue;
    }
  };

  initValue(apiBaseInput, "extensions.zotero.zotero-mcp-plugin.embedding.apiBase", "https://api.openai.com/v1");
  initValue(apiKeyInput, "extensions.zotero.zotero-mcp-plugin.embedding.apiKey", "");
  initValue(modelInput, "extensions.zotero.zotero-mcp-plugin.embedding.model", "text-embedding-3-small");
  initValue(dimensionsInput, "extensions.zotero.zotero-mcp-plugin.embedding.dimensions", "512");

  // Save preference on change
  const bindSave = (input: HTMLInputElement, prefKey: string, isNumber = false) => {
    input?.addEventListener("change", () => {
      const value = isNumber ? parseInt(input.value, 10) : input.value;
      Zotero.Prefs.set(prefKey, value, true);
      ztoolkit.log(`[PreferenceScript] Saved embedding pref: ${prefKey} = ${value}`);

      // Update embedding service config
      updateEmbeddingServiceConfig();
    });
  };

  bindSave(apiBaseInput, "extensions.zotero.zotero-mcp-plugin.embedding.apiBase");
  bindSave(apiKeyInput, "extensions.zotero.zotero-mcp-plugin.embedding.apiKey");
  bindSave(modelInput, "extensions.zotero.zotero-mcp-plugin.embedding.model");
  bindSave(dimensionsInput, "extensions.zotero.zotero-mcp-plugin.embedding.dimensions", true);

  // Test connection button
  testButton?.addEventListener("click", async () => {
    testResult.textContent = "Testing...";
    testResult.style.color = "#666";
    testButton.disabled = true;

    try {
      // Get current values from inputs (not saved prefs) for testing
      const apiBase = apiBaseInput?.value?.trim() || "";
      const apiKey = apiKeyInput?.value || "";
      const model = modelInput?.value?.trim() || "";

      if (!apiBase || !model) {
        testResult.textContent = getString("pref-embedding-test-failed" as any) + ": Missing API Base or Model";
        testResult.style.color = "#d32f2f";
        testButton.disabled = false;
        return;
      }

      // Test the connection using Zotero.HTTP
      const url = `${apiBase}/embeddings`;
      const response = await Zotero.HTTP.request('POST', url, {
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify({
          model: model,
          input: ["test"]
        }),
        timeout: 30000,
        responseType: 'json'
      });

      const data = response.response;
      if (data && data.data && data.data.length > 0) {
        const dims = data.data[0].embedding?.length || 0;
        testResult.textContent = getString("pref-embedding-test-success" as any) + ` (${dims} dims)`;
        testResult.style.color = "#2e7d32";

        // Auto-update dimensions if detected
        if (dims > 0 && dimensionsInput) {
          dimensionsInput.value = String(dims);
          Zotero.Prefs.set("extensions.zotero.zotero-mcp-plugin.embedding.dimensions", dims, true);
        }
      } else {
        testResult.textContent = getString("pref-embedding-test-failed" as any) + ": Invalid response";
        testResult.style.color = "#d32f2f";
      }
    } catch (error: any) {
      const errorMsg = error.message || error.status || String(error);
      testResult.textContent = getString("pref-embedding-test-failed" as any) + `: ${errorMsg.substring(0, 50)}`;
      testResult.style.color = "#d32f2f";
      ztoolkit.log(`[PreferenceScript] Embedding test failed: ${error}`, "warn");
    } finally {
      testButton.disabled = false;
    }
  });
}

/**
 * Update embedding service configuration from preferences
 */
function updateEmbeddingServiceConfig() {
  try {
    // Import and update embedding service
    const { getEmbeddingService } = require("./semantic/embeddingService");
    const embeddingService = getEmbeddingService();

    const apiBase = Zotero.Prefs.get("extensions.zotero.zotero-mcp-plugin.embedding.apiBase", true) || "";
    const apiKey = Zotero.Prefs.get("extensions.zotero.zotero-mcp-plugin.embedding.apiKey", true) || "";
    const model = Zotero.Prefs.get("extensions.zotero.zotero-mcp-plugin.embedding.model", true) || "";
    const dimensions = Zotero.Prefs.get("extensions.zotero.zotero-mcp-plugin.embedding.dimensions", true);

    embeddingService.updateConfig({
      apiBase: apiBase as string,
      apiKey: apiKey as string,
      model: model as string,
      dimensions: dimensions ? parseInt(String(dimensions), 10) : undefined
    });

    ztoolkit.log(`[PreferenceScript] Updated embedding service config`);
  } catch (error) {
    ztoolkit.log(`[PreferenceScript] Failed to update embedding service: ${error}`, "warn");
  }
}

/**
 * Bind semantic stats display handlers
 */
function bindSemanticStatsSettings(doc: Document) {
  const loadingEl = doc?.querySelector("#semantic-stats-loading") as HTMLElement;
  const contentEl = doc?.querySelector("#semantic-stats-content") as HTMLElement;
  const refreshButton = doc?.querySelector("#refresh-semantic-stats-button") as HTMLButtonElement;

  const totalItemsEl = doc?.querySelector("#semantic-stats-total-items") as HTMLElement;
  const totalVectorsEl = doc?.querySelector("#semantic-stats-total-vectors") as HTMLElement;
  const zhVectorsEl = doc?.querySelector("#semantic-stats-zh-vectors") as HTMLElement;
  const enVectorsEl = doc?.querySelector("#semantic-stats-en-vectors") as HTMLElement;
  const cachedItemsEl = doc?.querySelector("#semantic-stats-cached-items") as HTMLElement;
  const cacheSizeEl = doc?.querySelector("#semantic-stats-cache-size") as HTMLElement;
  const statusEl = doc?.querySelector("#semantic-stats-status") as HTMLElement;
  const progressRowEl = doc?.querySelector("#semantic-stats-progress-row") as HTMLElement;
  const progressEl = doc?.querySelector("#semantic-stats-progress") as HTMLElement;

  // Load stats on page load
  loadSemanticStats();

  // Refresh button
  refreshButton?.addEventListener("click", () => {
    loadSemanticStats();
  });

  async function loadSemanticStats() {
    if (!loadingEl || !contentEl) return;

    // Show loading, hide content
    loadingEl.style.display = "block";
    contentEl.style.display = "none";

    try {
      // Import semantic search service
      const { getSemanticSearchService } = require("./semantic");
      const semanticService = getSemanticSearchService();

      // Initialize if needed
      await semanticService.initialize();

      // Get stats
      const stats = await semanticService.getStats();

      // Format size nicely
      const formatSize = (bytes: number) => {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
      };

      // Get status text
      const getStatusText = (status: string) => {
        const statusMap: Record<string, string> = {
          'idle': getString("pref-semantic-stats-status-idle" as any) || 'Idle',
          'indexing': getString("pref-semantic-stats-status-indexing" as any) || 'Indexing',
          'paused': getString("pref-semantic-stats-status-paused" as any) || 'Paused',
          'completed': getString("pref-semantic-stats-status-completed" as any) || 'Completed',
          'error': getString("pref-semantic-stats-status-error" as any) || 'Error',
          'aborted': 'Aborted'
        };
        return statusMap[status] || status;
      };

      // Update UI
      if (totalItemsEl) totalItemsEl.textContent = String(stats.indexStats.totalItems);
      if (totalVectorsEl) totalVectorsEl.textContent = String(stats.indexStats.totalVectors);
      if (zhVectorsEl) zhVectorsEl.textContent = String(stats.indexStats.zhVectors);
      if (enVectorsEl) enVectorsEl.textContent = String(stats.indexStats.enVectors);
      if (cachedItemsEl) cachedItemsEl.textContent = String(stats.indexStats.cachedContentItems || 0);
      if (cacheSizeEl) cacheSizeEl.textContent = formatSize(stats.indexStats.cachedContentSizeBytes || 0);
      if (statusEl) statusEl.textContent = getStatusText(stats.indexProgress.status);

      // Show progress if indexing
      if (progressRowEl && progressEl) {
        if (stats.indexProgress.status === 'indexing' || stats.indexProgress.status === 'paused') {
          progressRowEl.style.display = "flex";
          const progressText = `${stats.indexProgress.processed}/${stats.indexProgress.total}`;
          progressEl.textContent = progressText;
        } else {
          progressRowEl.style.display = "none";
        }
      }

      // Hide loading, show content
      loadingEl.style.display = "none";
      contentEl.style.display = "block";

      ztoolkit.log(`[PreferenceScript] Loaded semantic stats: ${stats.indexStats.totalItems} items, ${stats.indexStats.totalVectors} vectors`);

    } catch (error) {
      ztoolkit.log(`[PreferenceScript] Failed to load semantic stats: ${error}`, "warn");

      // Show error message
      loadingEl.textContent = getString("pref-semantic-stats-not-initialized" as any) || "Semantic search service not initialized";
      loadingEl.style.display = "block";
      contentEl.style.display = "none";
    }
  }
}
