/* eslint-disable @typescript-eslint/no-require-imports */
import { config } from "../../package.json";
import { getString } from "../utils/locale";

declare let ztoolkit: ZToolkit;
declare let addon: any;
declare let Zotero: any;

// Embedding provider presets - single source of truth for provider dropdown and config
const EMBEDDING_PROVIDER_PRESETS: Record<
  string,
  {
    displayName: string;
    apiBase: string;
    modelPlaceholder: string;
    needsApiKey: boolean;
  }
> = {
  openai: {
    displayName: "OpenAI",
    apiBase: "https://api.openai.com/v1",
    modelPlaceholder: "text-embedding-3-small",
    needsApiKey: true,
  },
  google: {
    displayName: "Google Gemini",
    apiBase: "https://generativelanguage.googleapis.com/v1beta/openai",
    modelPlaceholder: "gemini-embedding-001",
    needsApiKey: true,
  },
  alibaba: {
    displayName: "Alibaba DashScope",
    apiBase: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    modelPlaceholder: "text-embedding-v3",
    needsApiKey: true,
  },
  zhipu: {
    displayName: "Zhipu AI",
    apiBase: "https://open.bigmodel.cn/api/paas/v4",
    modelPlaceholder: "embedding-3",
    needsApiKey: true,
  },
  openrouter: {
    displayName: "OpenRouter",
    apiBase: "https://openrouter.ai/api/v1",
    modelPlaceholder: "openai/text-embedding-3-small",
    needsApiKey: true,
  },
  siliconflow: {
    displayName: "SiliconFlow",
    apiBase: "https://api.siliconflow.cn/v1",
    modelPlaceholder: "BAAI/bge-m3",
    needsApiKey: true,
  },
  voyage: {
    displayName: "Voyage AI",
    apiBase: "https://api.voyageai.com/v1",
    modelPlaceholder: "voyage-3-lite",
    needsApiKey: true,
  },
  ollama: {
    displayName: "Ollama (Local)",
    apiBase: "http://localhost:11434/v1",
    modelPlaceholder: "nomic-embed-text",
    needsApiKey: false,
  },
};

/**
 * Bind embedding API settings handlers
 */
export function bindEmbeddingSettings(doc: Document) {
  const providerSelect = doc?.querySelector(
    `#zotero-prefpane-${config.addonRef}-embedding-provider`,
  ) as HTMLSelectElement;
  const apiBaseInput = doc?.querySelector(
    `#zotero-prefpane-${config.addonRef}-embedding-api-base`,
  ) as HTMLInputElement;
  const apiKeyInput = doc?.querySelector(
    `#zotero-prefpane-${config.addonRef}-embedding-api-key`,
  ) as HTMLInputElement;
  const modelInput = doc?.querySelector(
    `#zotero-prefpane-${config.addonRef}-embedding-model`,
  ) as HTMLInputElement;
  const dimensionsInput = doc?.querySelector(
    `#zotero-prefpane-${config.addonRef}-embedding-dimensions`,
  ) as HTMLInputElement;
  const dimensionsRow =
    dimensionsInput?.closest("hbox") || dimensionsInput?.parentElement;
  const testButton = doc?.querySelector(
    "#test-embedding-button",
  ) as HTMLButtonElement;
  const testResult = doc?.querySelector(
    "#embedding-test-result",
  ) as HTMLSpanElement;

  // Populate provider dropdown options from EMBEDDING_PROVIDER_PRESETS
  if (providerSelect) {
    for (const [key, preset] of Object.entries(EMBEDDING_PROVIDER_PRESETS)) {
      const option = doc.createElement("option") as HTMLOptionElement;
      option.value = key;
      option.textContent = preset.displayName;
      providerSelect.appendChild(option);
    }
  }

  // Detect current provider from saved apiBase
  const detectProvider = (apiBase: string): string => {
    for (const [key, preset] of Object.entries(EMBEDDING_PROVIDER_PRESETS)) {
      try {
        if (apiBase && apiBase.includes(new URL(preset.apiBase).hostname)) {
          return key;
        }
      } catch {
        // Invalid URL, continue
      }
    }
    return "custom";
  };

  // Initialize provider select from saved apiBase
  if (providerSelect) {
    const savedApiBase = Zotero.Prefs.get(
      "extensions.zotero.zotero-mcp-plugin.embedding.apiBase",
      true,
    ) as string;
    providerSelect.value = detectProvider(savedApiBase || "");
  }

  // Initialize input values from preferences
  const initValue = (
    input: HTMLInputElement,
    prefKey: string,
    defaultValue: string,
  ) => {
    if (input) {
      const value = Zotero.Prefs.get(prefKey, true);
      input.value = value ? String(value) : defaultValue;
    }
  };

  initValue(
    apiBaseInput,
    "extensions.zotero.zotero-mcp-plugin.embedding.apiBase",
    "https://api.openai.com/v1",
  );
  initValue(
    apiKeyInput,
    "extensions.zotero.zotero-mcp-plugin.embedding.apiKey",
    "",
  );
  initValue(
    modelInput,
    "extensions.zotero.zotero-mcp-plugin.embedding.model",
    "text-embedding-3-small",
  );
  initValue(
    dimensionsInput,
    "extensions.zotero.zotero-mcp-plugin.embedding.dimensions",
    "512",
  );

  // Check if model supports custom dimensions
  const supportsCustomDimensions = (model: string) =>
    model.includes("text-embedding-3");

  // Update dimensions input visibility based on model
  const updateDimensionsVisibility = () => {
    const model = modelInput?.value || "";
    const supportsCustom = supportsCustomDimensions(model);

    if (dimensionsInput) {
      dimensionsInput.disabled = !supportsCustom;
      if (!supportsCustom) {
        dimensionsInput.placeholder =
          getString("pref-embedding-dimensions-auto" as any) || "Auto";
      } else {
        dimensionsInput.placeholder = "";
      }
    }

    // Show hint text about dimensions
    if (dimensionsRow && testResult) {
      if (!supportsCustom) {
        // For non-supporting models, show info about auto-detection
        const detectedDims = Zotero.Prefs.get(
          "extensions.zotero.zotero-mcp-plugin.embedding.detectedDimensions",
          true,
        );
        if (detectedDims) {
          testResult.textContent = `${getString("pref-embedding-detected-dims" as any) || "Detected dimensions"}: ${detectedDims}`;
          testResult.style.color = "#666";
        }
      }
    }
  };

  // Initial visibility update
  updateDimensionsVisibility();

  // Handle provider preset selection change
  if (providerSelect) {
    providerSelect.addEventListener("change", () => {
      const provider = providerSelect.value;
      if (provider !== "custom" && EMBEDDING_PROVIDER_PRESETS[provider]) {
        const preset = EMBEDDING_PROVIDER_PRESETS[provider];

        // Only fill in API Base URL
        if (apiBaseInput) {
          apiBaseInput.value = preset.apiBase;
          Zotero.Prefs.set(
            "extensions.zotero.zotero-mcp-plugin.embedding.apiBase",
            preset.apiBase,
            true,
          );
        }

        // Update model placeholder hint (don't change the value)
        if (modelInput) {
          modelInput.placeholder = preset.modelPlaceholder;
        }

        // Update API key placeholder hint based on whether it's needed
        if (apiKeyInput) {
          apiKeyInput.placeholder = preset.needsApiKey
            ? "sk-..."
            : getString("pref-embedding-api-key-optional" as any) ||
              "(Optional)";
        }

        // Update embedding service config
        updateEmbeddingServiceConfig();

        ztoolkit.log(`[PreferenceScript] Applied provider preset: ${provider}`);
      }
    });
  }

  // Save preference on change
  const bindSave = (
    input: HTMLInputElement,
    prefKey: string,
    isNumber = false,
  ) => {
    input?.addEventListener("change", () => {
      const value = isNumber ? parseInt(input.value, 10) : input.value;
      Zotero.Prefs.set(prefKey, value, true);
      ztoolkit.log(
        `[PreferenceScript] Saved embedding pref: ${prefKey} = ${value}`,
      );

      // Update embedding service config
      updateEmbeddingServiceConfig();
    });
  };

  bindSave(
    apiBaseInput,
    "extensions.zotero.zotero-mcp-plugin.embedding.apiBase",
  );
  bindSave(apiKeyInput, "extensions.zotero.zotero-mcp-plugin.embedding.apiKey");
  bindSave(
    dimensionsInput,
    "extensions.zotero.zotero-mcp-plugin.embedding.dimensions",
    true,
  );

  // Model change handler - update dimensions visibility and clear detected dimensions
  modelInput?.addEventListener("change", async () => {
    const model = modelInput.value;
    Zotero.Prefs.set(
      "extensions.zotero.zotero-mcp-plugin.embedding.model",
      model,
      true,
    );
    ztoolkit.log(`[PreferenceScript] Saved embedding pref: model = ${model}`);

    // Clear detected dimensions when model changes
    try {
      const { getEmbeddingService } = require("./semantic/embeddingService");
      const embeddingService = getEmbeddingService();
      embeddingService.clearDetectedDimensions();
    } catch (e) {
      // Ignore
    }

    // Check if there are existing indexed vectors - warn user about potential incompatibility
    try {
      const { getVectorStore } = require("./semantic/vectorStore");
      const vectorStore = getVectorStore();
      await vectorStore.initialize();
      const stats = await vectorStore.getStats();
      if (stats.totalVectors > 0) {
        // Show warning alert
        addon.data.prefs!.window.alert(
          getString("pref-embedding-model-change-warning" as any) ||
            "Model changed. Existing index may be incompatible. Please test connection and rebuild index.",
        );
      }
    } catch (e) {
      ztoolkit.log(
        `[PreferenceScript] Failed to check existing index: ${e}`,
        "warn",
      );
    }

    // Update visibility
    updateDimensionsVisibility();

    // Update embedding service config
    updateEmbeddingServiceConfig();
  });

  // Test connection button
  testButton?.addEventListener("click", async () => {
    testResult.textContent =
      getString("pref-embedding-testing" as any) || "Testing...";
    testResult.style.color = "#666";
    testButton.disabled = true;

    try {
      // Get current values from inputs (not saved prefs) for testing
      const apiBase = apiBaseInput?.value?.trim() || "";
      const apiKey = apiKeyInput?.value || "";
      const model = modelInput?.value?.trim() || "";

      if (!apiBase || !model) {
        testResult.textContent =
          getString("pref-embedding-test-failed" as any) +
          ": Missing API Base or Model";
        testResult.style.color = "#d32f2f";
        testButton.disabled = false;
        return;
      }

      // Test the connection using Zotero.HTTP
      const url = `${apiBase}/embeddings`;
      const response = await Zotero.HTTP.request("POST", url, {
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: model,
          input: ["test"],
        }),
        timeout: 30000,
        responseType: "json",
      });

      const data = response.response;
      if (data && data.data && data.data.length > 0) {
        const dims = data.data[0].embedding?.length || 0;

        // Check if stored vectors have different dimensions
        let storedDims: number | null = null;
        let hasStoredVectors = false;
        try {
          const { getVectorStore } = require("./semantic/vectorStore");
          const vectorStore = getVectorStore();
          await vectorStore.initialize();
          const stats = await vectorStore.getStats();
          storedDims = stats.storedDimensions || null;
          hasStoredVectors = stats.totalVectors > 0;
        } catch (e) {
          // Ignore errors checking stored dimensions
        }

        // Decide whether to update dimensions based on stored vectors
        if (hasStoredVectors && storedDims && storedDims !== dims) {
          // Dimension mismatch with existing index - warn but don't auto-update
          testResult.textContent = `${getString("pref-embedding-test-success" as any)} (${dims} dims) - ⚠️ ${getString("pref-embedding-dimension-mismatch" as any) || `Index has ${storedDims} dims, API returns ${dims} dims. Rebuild index to use new dimensions.`}`;
          testResult.style.color = "#ef6c00";

          // Save detected dimensions but don't update config dimensions
          Zotero.Prefs.set(
            "extensions.zotero.zotero-mcp-plugin.embedding.detectedDimensions",
            dims,
            true,
          );
        } else {
          // No mismatch or no existing vectors - safe to update
          testResult.textContent =
            getString("pref-embedding-test-success" as any) + ` (${dims} dims)`;
          testResult.style.color = "#2e7d32";

          // Update dimensions
          if (dims > 0) {
            // Save detected dimensions
            Zotero.Prefs.set(
              "extensions.zotero.zotero-mcp-plugin.embedding.detectedDimensions",
              dims,
              true,
            );

            // Only update config dimensions for models that support custom dimensions
            if (supportsCustomDimensions(model) && dimensionsInput) {
              dimensionsInput.value = String(dims);
              Zotero.Prefs.set(
                "extensions.zotero.zotero-mcp-plugin.embedding.dimensions",
                dims,
                true,
              );
            }

            // Update embedding service
            try {
              const {
                getEmbeddingService,
              } = require("./semantic/embeddingService");
              const embeddingService = getEmbeddingService();
              embeddingService.updateConfig({ dimensions: dims });
            } catch (e) {
              // Ignore
            }
          }
        }
      } else {
        testResult.textContent =
          getString("pref-embedding-test-failed" as any) + ": Invalid response";
        testResult.style.color = "#d32f2f";
      }
    } catch (error: any) {
      const errorMsg = error.message || error.status || String(error);
      testResult.textContent =
        getString("pref-embedding-test-failed" as any) +
        `: ${errorMsg.substring(0, 50)}`;
      testResult.style.color = "#d32f2f";
      ztoolkit.log(
        `[PreferenceScript] Embedding test failed: ${error}`,
        "warn",
      );
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

    const apiBase =
      Zotero.Prefs.get(
        "extensions.zotero.zotero-mcp-plugin.embedding.apiBase",
        true,
      ) || "";
    const apiKey =
      Zotero.Prefs.get(
        "extensions.zotero.zotero-mcp-plugin.embedding.apiKey",
        true,
      ) || "";
    const model =
      Zotero.Prefs.get(
        "extensions.zotero.zotero-mcp-plugin.embedding.model",
        true,
      ) || "";
    const dimensions = Zotero.Prefs.get(
      "extensions.zotero.zotero-mcp-plugin.embedding.dimensions",
      true,
    );

    embeddingService.updateConfig({
      apiBase: apiBase as string,
      apiKey: apiKey as string,
      model: model as string,
      dimensions: dimensions ? parseInt(String(dimensions), 10) : undefined,
    });

    ztoolkit.log(`[PreferenceScript] Updated embedding service config`);
  } catch (error) {
    ztoolkit.log(
      `[PreferenceScript] Failed to update embedding service: ${error}`,
      "warn",
    );
  }
}

/**
 * Bind API usage stats display handlers
 */
export function bindApiUsageStats(doc: Document) {
  // Rate limit inputs
  const rpmInput = doc?.querySelector(
    `#zotero-prefpane-${config.addonRef}-embedding-rpm`,
  ) as HTMLInputElement;
  const tpmInput = doc?.querySelector(
    `#zotero-prefpane-${config.addonRef}-embedding-tpm`,
  ) as HTMLInputElement;
  const costInput = doc?.querySelector(
    `#zotero-prefpane-${config.addonRef}-embedding-cost`,
  ) as HTMLInputElement;

  // Usage stats elements
  const totalTokensEl = doc?.querySelector(
    "#api-usage-total-tokens",
  ) as HTMLElement;
  const totalRequestsEl = doc?.querySelector(
    "#api-usage-total-requests",
  ) as HTMLElement;
  const totalTextsEl = doc?.querySelector(
    "#api-usage-total-texts",
  ) as HTMLElement;
  const estimatedCostEl = doc?.querySelector(
    "#api-usage-estimated-cost",
  ) as HTMLElement;
  const sessionTokensEl = doc?.querySelector(
    "#api-usage-session-tokens",
  ) as HTMLElement;
  const sessionRequestsEl = doc?.querySelector(
    "#api-usage-session-requests",
  ) as HTMLElement;
  const currentRpmEl = doc?.querySelector(
    "#api-usage-current-rpm",
  ) as HTMLElement;
  const currentTpmEl = doc?.querySelector(
    "#api-usage-current-tpm",
  ) as HTMLElement;
  const rateLimitHitsEl = doc?.querySelector(
    "#api-usage-rate-limit-hits",
  ) as HTMLElement;

  // Buttons
  const refreshButton = doc?.querySelector(
    "#refresh-api-usage-button",
  ) as HTMLButtonElement;
  const resetButton = doc?.querySelector(
    "#reset-api-usage-button",
  ) as HTMLButtonElement;

  // Initialize rate limit inputs from preferences
  const initRateLimitValue = (
    input: HTMLInputElement,
    prefKey: string,
    defaultValue: string,
  ) => {
    if (input) {
      const value = Zotero.Prefs.get(prefKey, true);
      input.value =
        value !== undefined && value !== null ? String(value) : defaultValue;
    }
  };

  initRateLimitValue(
    rpmInput,
    "extensions.zotero.zotero-mcp-plugin.embedding.rpm",
    "60",
  );
  initRateLimitValue(
    tpmInput,
    "extensions.zotero.zotero-mcp-plugin.embedding.tpm",
    "150000",
  );
  initRateLimitValue(
    costInput,
    "extensions.zotero.zotero-mcp-plugin.embedding.costPer1M",
    "0.02",
  );

  // Save rate limit on change
  const bindRateLimitSave = (
    input: HTMLInputElement,
    prefKey: string,
    isFloat = false,
  ) => {
    input?.addEventListener("change", () => {
      let value: number;
      if (isFloat) {
        value = parseFloat(input.value) || 0;
      } else {
        value = parseInt(input.value, 10) || 0;
      }
      Zotero.Prefs.set(prefKey, isFloat ? String(value) : value, true);
      ztoolkit.log(
        `[PreferenceScript] Saved rate limit pref: ${prefKey} = ${value}`,
      );

      // Update embedding service rate limit config
      updateEmbeddingServiceRateLimits();
    });
  };

  bindRateLimitSave(
    rpmInput,
    "extensions.zotero.zotero-mcp-plugin.embedding.rpm",
  );
  bindRateLimitSave(
    tpmInput,
    "extensions.zotero.zotero-mcp-plugin.embedding.tpm",
  );
  bindRateLimitSave(
    costInput,
    "extensions.zotero.zotero-mcp-plugin.embedding.costPer1M",
    true,
  );

  // Load usage stats on page load
  loadApiUsageStats();

  // Refresh button
  refreshButton?.addEventListener("click", () => {
    loadApiUsageStats();
  });

  // Reset button
  resetButton?.addEventListener("click", () => {
    const confirmMsg =
      getString("pref-api-usage-reset-confirm" as any) ||
      "Are you sure you want to reset all API usage statistics?";
    if (addon.data.prefs!.window.confirm(confirmMsg)) {
      resetApiUsageStats();
    }
  });

  async function loadApiUsageStats() {
    try {
      const { getEmbeddingService } = require("./semantic/embeddingService");
      const embeddingService = getEmbeddingService();

      // Ensure service is initialized to load persisted stats
      await embeddingService.initialize();

      const stats = embeddingService.getUsageStats();

      // Format numbers with thousands separator
      const formatNum = (n: number) => n.toLocaleString();

      // Update UI elements
      if (totalTokensEl)
        totalTokensEl.textContent = formatNum(stats.totalTokens);
      if (totalRequestsEl)
        totalRequestsEl.textContent = formatNum(stats.totalRequests);
      if (totalTextsEl) totalTextsEl.textContent = formatNum(stats.totalTexts);
      if (estimatedCostEl)
        estimatedCostEl.textContent = `$${stats.estimatedCostUsd.toFixed(4)}`;
      if (sessionTokensEl)
        sessionTokensEl.textContent = formatNum(stats.sessionTokens);
      if (sessionRequestsEl)
        sessionRequestsEl.textContent = formatNum(stats.sessionRequests);
      if (currentRpmEl) currentRpmEl.textContent = `${stats.currentRpm}`;
      if (currentTpmEl) currentTpmEl.textContent = formatNum(stats.currentTpm);
      if (rateLimitHitsEl)
        rateLimitHitsEl.textContent = formatNum(stats.rateLimitHits);

      ztoolkit.log(
        `[PreferenceScript] Loaded API usage stats: ${stats.totalTokens} tokens, ${stats.totalRequests} requests`,
      );
    } catch (error) {
      ztoolkit.log(
        `[PreferenceScript] Failed to load API usage stats: ${error}`,
        "warn",
      );
      // Show error state
      if (totalTokensEl) totalTokensEl.textContent = "-";
      if (totalRequestsEl) totalRequestsEl.textContent = "-";
    }
  }

  async function resetApiUsageStats() {
    try {
      const { getEmbeddingService } = require("./semantic/embeddingService");
      const embeddingService = getEmbeddingService();

      // Ensure service is initialized
      await embeddingService.initialize();

      embeddingService.resetUsageStats(true); // Reset cumulative stats

      // Reload display
      await loadApiUsageStats();

      ztoolkit.log("[PreferenceScript] Reset API usage stats");
    } catch (error) {
      ztoolkit.log(
        `[PreferenceScript] Failed to reset API usage stats: ${error}`,
        "warn",
      );
    }
  }
}

/**
 * Update embedding service rate limit configuration from preferences
 */
function updateEmbeddingServiceRateLimits() {
  try {
    const { getEmbeddingService } = require("./semantic/embeddingService");
    const embeddingService = getEmbeddingService();

    const rpm = Zotero.Prefs.get(
      "extensions.zotero.zotero-mcp-plugin.embedding.rpm",
      true,
    );
    const tpm = Zotero.Prefs.get(
      "extensions.zotero.zotero-mcp-plugin.embedding.tpm",
      true,
    );
    const costPer1M = Zotero.Prefs.get(
      "extensions.zotero.zotero-mcp-plugin.embedding.costPer1M",
      true,
    );

    embeddingService.setRateLimitConfig({
      rpm: rpm ? parseInt(String(rpm), 10) : 60,
      tpm: tpm ? parseInt(String(tpm), 10) : 150000,
      costPer1MTokens: costPer1M ? parseFloat(String(costPer1M)) : 0.02,
    });

    ztoolkit.log(`[PreferenceScript] Updated embedding service rate limits`);
  } catch (error) {
    ztoolkit.log(
      `[PreferenceScript] Failed to update rate limits: ${error}`,
      "warn",
    );
  }
}
