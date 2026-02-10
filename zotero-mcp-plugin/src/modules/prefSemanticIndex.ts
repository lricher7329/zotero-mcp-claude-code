/* eslint-disable @typescript-eslint/no-require-imports */
import { getString } from "../utils/locale";

declare let ztoolkit: ZToolkit;
declare let addon: any;
declare let Zotero: any;

/**
 * Bind semantic stats display handlers
 */
export function bindSemanticStatsSettings(doc: Document) {
  const loadingEl = doc?.querySelector(
    "#semantic-stats-loading",
  ) as HTMLElement;
  const contentEl = doc?.querySelector(
    "#semantic-stats-content",
  ) as HTMLElement;
  const refreshButton = doc?.querySelector(
    "#refresh-semantic-stats-button",
  ) as HTMLButtonElement;

  const totalItemsEl = doc?.querySelector(
    "#semantic-stats-total-items",
  ) as HTMLElement;
  const totalVectorsEl = doc?.querySelector(
    "#semantic-stats-total-vectors",
  ) as HTMLElement;
  const zhVectorsEl = doc?.querySelector(
    "#semantic-stats-zh-vectors",
  ) as HTMLElement;
  const enVectorsEl = doc?.querySelector(
    "#semantic-stats-en-vectors",
  ) as HTMLElement;
  const cachedItemsEl = doc?.querySelector(
    "#semantic-stats-cached-items",
  ) as HTMLElement;
  const cacheSizeEl = doc?.querySelector(
    "#semantic-stats-cache-size",
  ) as HTMLElement;
  const dbSizeEl = doc?.querySelector("#semantic-stats-db-size") as HTMLElement;
  const dimensionsEl = doc?.querySelector(
    "#semantic-stats-dimensions",
  ) as HTMLElement;
  const int8StatusEl = doc?.querySelector(
    "#semantic-stats-int8-status",
  ) as HTMLElement;
  const statusEl = doc?.querySelector("#semantic-stats-status") as HTMLElement;

  // Index control elements
  const buildButton = doc?.querySelector(
    "#build-semantic-index-button",
  ) as HTMLButtonElement;
  const rebuildButton = doc?.querySelector(
    "#rebuild-semantic-index-button",
  ) as HTMLButtonElement;
  const clearButton = doc?.querySelector(
    "#clear-semantic-index-button",
  ) as HTMLButtonElement;
  const pauseButton = doc?.querySelector(
    "#pause-semantic-index-button",
  ) as HTMLButtonElement;
  const resumeButton = doc?.querySelector(
    "#resume-semantic-index-button",
  ) as HTMLButtonElement;
  const abortButton = doc?.querySelector(
    "#abort-semantic-index-button",
  ) as HTMLButtonElement;
  const progressContainer = doc?.querySelector(
    "#semantic-index-progress-container",
  ) as HTMLElement;
  const progressText = doc?.querySelector(
    "#semantic-index-progress-text",
  ) as HTMLElement;
  const progressPercent = doc?.querySelector(
    "#semantic-index-progress-percent",
  ) as HTMLElement;
  const progressBar = doc?.querySelector(
    "#semantic-index-progress-bar",
  ) as HTMLElement;
  const currentItemEl = doc?.querySelector(
    "#semantic-index-current-item",
  ) as HTMLElement;
  const etaEl = doc?.querySelector("#semantic-index-eta") as HTMLElement;
  const messageEl = doc?.querySelector(
    "#semantic-index-message",
  ) as HTMLElement;

  let isIndexing = false;
  let progressUpdateInterval: ReturnType<typeof setInterval> | null = null;
  let lastErrorInfo: {
    message: string;
    type: string;
    retryable: boolean;
  } | null = null;
  let messageTimeout: ReturnType<typeof setTimeout> | null = null;

  // Load stats on page load
  loadSemanticStats();

  // Register error callback for semantic service
  registerErrorCallback();

  // Refresh button
  refreshButton?.addEventListener("click", () => {
    loadSemanticStats();
  });

  // Build index button
  buildButton?.addEventListener("click", () => {
    startIndexing(false);
  });

  // Rebuild index button
  rebuildButton?.addEventListener("click", () => {
    const confirmMsg =
      getString("pref-semantic-index-confirm-rebuild" as any) ||
      "This will rebuild the entire index. Are you sure?";
    if (addon.data.prefs!.window.confirm(confirmMsg)) {
      startIndexing(true);
    }
  });

  // Pause button
  pauseButton?.addEventListener("click", () => {
    try {
      ztoolkit.log("[PreferenceScript] Pause button clicked");

      // Stop progress updates FIRST to prevent any race conditions
      // (interval callback might be running async and could reset buttons)
      stopProgressUpdates();

      const { getSemanticSearchService } = require("./semantic");
      const semanticService = getSemanticSearchService();

      // Check current status before pausing
      const beforeProgress = semanticService.getIndexProgress();
      ztoolkit.log(
        `[PreferenceScript] Before pause: status=${beforeProgress.status}`,
      );

      semanticService.pauseIndex();

      // Verify pause took effect
      const afterProgress = semanticService.getIndexProgress();
      ztoolkit.log(
        `[PreferenceScript] After pause: status=${afterProgress.status}`,
      );

      if (afterProgress.status === "paused") {
        updateControlButtons("paused");
        showMessage(
          getString("pref-semantic-index-paused" as any) || "Indexing paused",
          "warning",
        );
      } else {
        ztoolkit.log(
          `[PreferenceScript] Pause did not take effect, status is still: ${afterProgress.status}`,
          "warn",
        );
        // Restart progress updates if pause failed
        startProgressUpdates();
      }
    } catch (error) {
      ztoolkit.log(
        `[PreferenceScript] Failed to pause indexing: ${error}`,
        "warn",
      );
    }
  });

  // Resume button
  resumeButton?.addEventListener("click", async () => {
    try {
      const { getSemanticSearchService } = require("./semantic");
      const semanticService = getSemanticSearchService();

      // Check current status
      const progress = semanticService.getIndexProgress();

      // Clear error info since we're resuming
      lastErrorInfo = null;

      // Hide any error message displayed
      if (messageEl) messageEl.style.display = "none";

      // Reset status display color
      if (statusEl) statusEl.style.color = "";

      // Check if this is a resume after restart or error (no active build process)
      // We detect this by checking if isIndexing is false but status is paused/error
      if (
        !isIndexing &&
        (progress.status === "paused" || progress.status === "error")
      ) {
        // Resume after restart/error - need to start a new build process
        ztoolkit.log(
          `[PreferenceScript] Resuming index after ${progress.status} - starting new build process`,
        );
        isIndexing = true;

        // Reset the paused/error state
        semanticService.resumeIndex();
        updateControlButtons("indexing");
        showMessage(
          getString("pref-semantic-index-started" as any) ||
            "Indexing resumed...",
          "info",
        );

        // Show progress UI
        if (progressContainer) progressContainer.style.display = "block";

        // Start progress updates
        startProgressUpdates();

        // Start a new build (not rebuild) to continue from where we left off
        await semanticService.buildIndex({
          rebuild: false, // Don't rebuild, just continue with unindexed items
          onProgress: (p: any) => {
            updateProgress(p);
            if (p.status === "completed" || p.status === "aborted") {
              stopProgressUpdates();
              updateControlButtons("idle");
              isIndexing = false;
              loadSemanticStats();

              if (p.status === "completed") {
                // Check if there are any failed items
                const failedItems = semanticService.getFailedItems();
                if (failedItems.length > 0) {
                  showMessage(
                    `${getString("pref-semantic-index-completed" as any) || "Indexing completed"} (${failedItems.length} ${getString("pref-semantic-index-failed-items" as any) || "items failed"})`,
                    "warning",
                  );
                } else {
                  showMessage(
                    getString("pref-semantic-index-completed" as any) ||
                      "Indexing completed!",
                    "success",
                  );
                }
              }
            }
            // Note: error state is handled by the error callback, not here
          },
        });
      } else {
        // Normal resume during active session
        semanticService.resumeIndex();
        updateControlButtons("indexing");
        showMessage(
          getString("pref-semantic-index-started" as any) ||
            "Indexing resumed...",
          "info",
        );
        // Restart progress updates (they were stopped when pausing)
        startProgressUpdates();
      }
    } catch (error) {
      ztoolkit.log(
        `[PreferenceScript] Failed to resume indexing: ${error}`,
        "warn",
      );
      isIndexing = false;
      updateControlButtons("idle");
    }
  });

  // Abort button
  abortButton?.addEventListener("click", () => {
    try {
      const { getSemanticSearchService } = require("./semantic");
      const semanticService = getSemanticSearchService();
      semanticService.abortIndex();
      updateControlButtons("idle");
      showMessage(
        getString("pref-semantic-index-aborted" as any) || "Indexing aborted",
        "warning",
      );
      stopProgressUpdates();
      isIndexing = false;
    } catch (error) {
      ztoolkit.log(
        `[PreferenceScript] Failed to abort indexing: ${error}`,
        "warn",
      );
    }
  });

  // Clear index button
  clearButton?.addEventListener("click", async () => {
    const confirmMsg =
      getString("pref-semantic-index-confirm-clear" as any) ||
      "This will clear all index data (content cache will be preserved). Are you sure?";
    if (!addon.data.prefs!.window.confirm(confirmMsg)) {
      return;
    }

    try {
      const { getVectorStore } = require("./semantic/vectorStore");
      const vectorStore = getVectorStore();
      await vectorStore.initialize();
      await vectorStore.clear();

      showMessage(
        getString("pref-semantic-index-cleared" as any) || "Index cleared",
        "success",
      );
      ztoolkit.log("[PreferenceScript] Index cleared successfully");

      // Reload stats to show updated state
      loadSemanticStats();
    } catch (error) {
      showMessage(
        getString("pref-semantic-index-error" as any) + `: ${error}`,
        "error",
      );
      ztoolkit.log(
        `[PreferenceScript] Failed to clear index: ${error}`,
        "error",
      );
    }
  });

  async function startIndexing(rebuild: boolean) {
    if (isIndexing) return;
    isIndexing = true;

    try {
      const { getSemanticSearchService } = require("./semantic");
      const semanticService = getSemanticSearchService();

      // Initialize if needed
      await semanticService.initialize();

      // Show progress UI
      if (progressContainer) progressContainer.style.display = "block";
      updateControlButtons("indexing");
      showMessage(
        getString("pref-semantic-index-started" as any) ||
          "Indexing started...",
        "info",
      );

      // Start progress updates
      startProgressUpdates();

      // Build index with progress callback
      const result = await semanticService.buildIndex({
        rebuild,
        onProgress: (progress: any) => {
          updateProgress(progress);
        },
      });

      // Indexing completed
      isIndexing = false;
      stopProgressUpdates();
      updateControlButtons("idle");

      if (result.status === "completed") {
        if (result.total === 0) {
          showMessage(
            getString("pref-semantic-index-no-items" as any) ||
              "No items need indexing",
            "info",
          );
        } else {
          // Check for failed items
          const failedItems = semanticService.getFailedItems();
          if (failedItems.length > 0) {
            showMessage(
              `${getString("pref-semantic-index-completed" as any) || "Indexing completed"} (${result.processed}/${result.total}, ${failedItems.length} ${getString("pref-semantic-index-failed-items" as any) || "items failed"})`,
              "warning",
            );
          } else {
            showMessage(
              getString("pref-semantic-index-completed" as any) +
                ` (${result.processed}/${result.total})`,
              "success",
            );
          }
        }
      } else if (result.status === "aborted") {
        showMessage(
          getString("pref-semantic-index-aborted" as any) || "Indexing aborted",
          "warning",
        );
      } else if (result.status === "error") {
        // Error is already shown by the error callback, but show additional info if available
        if (result.error && !lastErrorInfo) {
          showMessage(
            getString("pref-semantic-index-error" as any) + `: ${result.error}`,
            "error",
          );
        }
      }

      // Reload stats
      loadSemanticStats();
    } catch (error) {
      isIndexing = false;
      stopProgressUpdates();
      updateControlButtons("idle");
      showMessage(
        getString("pref-semantic-index-error" as any) + `: ${error}`,
        "error",
      );
      ztoolkit.log(
        `[PreferenceScript] Index building failed: ${error}`,
        "error",
      );
    }
  }

  function updateProgress(progress: any) {
    if (progressText) {
      progressText.textContent = `${progress.processed}/${progress.total}`;
    }

    if (progressPercent && progress.total > 0) {
      const percent = Math.round((progress.processed / progress.total) * 100);
      progressPercent.textContent = `(${percent}%)`;
    }

    if (progressBar && progress.total > 0) {
      const percent = Math.round((progress.processed / progress.total) * 100);
      progressBar.style.width = `${percent}%`;
    }

    if (currentItemEl && progress.currentItem) {
      currentItemEl.textContent = progress.currentItem;
    }

    if (etaEl && progress.estimatedRemaining) {
      etaEl.textContent = formatTime(progress.estimatedRemaining);
    }
  }

  function formatTime(ms: number): string {
    if (ms < 1000) return "< 1s";
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }

  function updateControlButtons(status: "idle" | "indexing" | "paused") {
    if (buildButton)
      buildButton.style.display = status === "idle" ? "" : "none";
    if (rebuildButton)
      rebuildButton.style.display = status === "idle" ? "" : "none";
    if (clearButton)
      clearButton.style.display = status === "idle" ? "" : "none";
    if (pauseButton)
      pauseButton.style.display = status === "indexing" ? "" : "none";
    if (resumeButton)
      resumeButton.style.display = status === "paused" ? "" : "none";
    if (abortButton)
      abortButton.style.display =
        status === "indexing" || status === "paused" ? "" : "none";
  }

  function showMessage(
    text: string,
    type: "info" | "success" | "warning" | "error",
  ) {
    if (!messageEl) return;

    // Clear any pending timeout to prevent previous messages from hiding this one
    if (messageTimeout) {
      clearTimeout(messageTimeout);
      messageTimeout = null;
    }

    messageEl.textContent = text;
    messageEl.style.display = "block";

    // Set style based on type
    const colors: Record<string, { bg: string; text: string }> = {
      info: { bg: "#e3f2fd", text: "#1565c0" },
      success: { bg: "#e8f5e9", text: "#2e7d32" },
      warning: { bg: "#fff3e0", text: "#ef6c00" },
      error: { bg: "#ffebee", text: "#c62828" },
    };

    const color = colors[type] || colors.info;
    messageEl.style.backgroundColor = color.bg;
    messageEl.style.color = color.text;

    // Auto-hide after 5 seconds for non-error messages
    // Error messages persist until manually cleared or another message is shown
    if (type !== "error") {
      messageTimeout = setTimeout(() => {
        if (messageEl) messageEl.style.display = "none";
        messageTimeout = null;
      }, 5000);
    }
  }

  function startProgressUpdates() {
    if (progressUpdateInterval) {
      ztoolkit.log(
        `[PreferenceScript] startProgressUpdates: interval already exists, skipping`,
      );
      return;
    }

    ztoolkit.log(
      `[PreferenceScript] startProgressUpdates: starting progress update interval`,
    );

    progressUpdateInterval = setInterval(() => {
      try {
        const { getSemanticSearchService } = require("./semantic");
        const semanticService = getSemanticSearchService();
        const progress = semanticService.getIndexProgress();

        // Update progress UI
        updateProgress(progress);

        // Update status text
        if (statusEl) {
          statusEl.textContent = getStatusText(progress.status);
        }

        // Update control buttons based on status
        if (progressUpdateInterval) {
          if (progress.status === "paused" || progress.status === "error") {
            updateControlButtons("paused");
          } else if (progress.status === "indexing") {
            updateControlButtons("indexing");
          }
        }

        // Log progress periodically (every 5 seconds) for debugging
        if (progress.processed % 5 === 0 && progress.processed > 0) {
          ztoolkit.log(
            `[PreferenceScript] Progress update: ${progress.processed}/${progress.total} (${progress.status})`,
          );
        }
      } catch (error) {
        ztoolkit.log(
          `[PreferenceScript] Progress update error: ${error}`,
          "warn",
        );
      }
    }, 500); // Update every 500ms for smoother progress
  }

  function stopProgressUpdates() {
    if (progressUpdateInterval) {
      ztoolkit.log(
        `[PreferenceScript] stopProgressUpdates: stopping progress update interval`,
      );
      clearInterval(progressUpdateInterval);
      progressUpdateInterval = null;
    }
  }

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

      // Update UI
      if (totalItemsEl)
        totalItemsEl.textContent = String(stats.indexStats.totalItems);
      if (totalVectorsEl)
        totalVectorsEl.textContent = String(stats.indexStats.totalVectors);
      if (zhVectorsEl)
        zhVectorsEl.textContent = String(stats.indexStats.zhVectors);
      if (enVectorsEl)
        enVectorsEl.textContent = String(stats.indexStats.enVectors);
      if (cachedItemsEl)
        cachedItemsEl.textContent = String(
          stats.indexStats.cachedContentItems || 0,
        );
      if (cacheSizeEl)
        cacheSizeEl.textContent = formatSize(
          stats.indexStats.cachedContentSizeBytes || 0,
        );
      if (dbSizeEl)
        dbSizeEl.textContent = stats.indexStats.dbSizeBytes
          ? formatSize(stats.indexStats.dbSizeBytes)
          : "-";
      if (dimensionsEl) {
        if (stats.indexStats.storedDimensions) {
          // Get configured dimensions from prefs to show comparison
          const configuredDims = Zotero.Prefs.get(
            "extensions.zotero.zotero-mcp-plugin.embedding.dimensions",
            true,
          );
          const configuredDimsNum = configuredDims
            ? parseInt(String(configuredDims), 10)
            : null;
          if (
            configuredDimsNum &&
            configuredDimsNum !== stats.indexStats.storedDimensions
          ) {
            dimensionsEl.textContent = `${stats.indexStats.storedDimensions} (${getString("pref-semantic-stats-dimensions-mismatch" as any) || "mismatch"}: ${configuredDims})`;
            dimensionsEl.style.color = "#d32f2f";
          } else {
            dimensionsEl.textContent = String(
              stats.indexStats.storedDimensions,
            );
            dimensionsEl.style.color = "#333";
          }
        } else {
          dimensionsEl.textContent = "-";
        }
      }
      if (int8StatusEl) {
        if (stats.indexStats.int8MigrationStatus) {
          const { migrated, total, percent } =
            stats.indexStats.int8MigrationStatus;
          int8StatusEl.textContent = `${migrated}/${total} (${percent}%)`;
          int8StatusEl.style.color = percent === 100 ? "#2e7d32" : "#ef6c00";
        } else {
          int8StatusEl.textContent = "-";
        }
      }
      if (statusEl)
        statusEl.textContent = getStatusText(stats.indexProgress.status);

      // Update progress display if indexing is in progress or has error
      if (
        stats.indexProgress.status === "indexing" ||
        stats.indexProgress.status === "paused" ||
        stats.indexProgress.status === "error"
      ) {
        if (progressContainer) progressContainer.style.display = "block";
        updateProgress(stats.indexProgress);

        if (stats.indexProgress.status === "error") {
          // Show error state - display error message and allow resume
          updateControlButtons("paused"); // Show resume button for retry
          if (statusEl) {
            // Include error message in status if available
            const errorStatus = getStatusText("error");
            if (stats.indexProgress.error) {
              statusEl.textContent = `${errorStatus}: ${stats.indexProgress.error}`;
            } else {
              statusEl.textContent = errorStatus;
            }
            statusEl.style.color = "#c62828";
          }
          // Also show error message in message area if available
          if (stats.indexProgress.error) {
            const retryHint =
              stats.indexProgress.errorRetryable !== false
                ? ` (${getString("pref-semantic-index-error-retry-hint" as any) || "Click Resume to retry"})`
                : "";
            showMessage(stats.indexProgress.error + retryHint, "error");
          }
        } else {
          updateControlButtons(
            stats.indexProgress.status as "indexing" | "paused",
          );
          if (statusEl) statusEl.style.color = "";
        }

        isIndexing = stats.indexProgress.status === "indexing";
        if (isIndexing && !progressUpdateInterval) {
          startProgressUpdates();
        }
      } else {
        if (progressContainer) progressContainer.style.display = "none";
        updateControlButtons("idle");
        if (statusEl) statusEl.style.color = "";
      }

      // Hide loading, show content
      loadingEl.style.display = "none";
      contentEl.style.display = "block";

      ztoolkit.log(
        `[PreferenceScript] Loaded semantic stats: ${stats.indexStats.totalItems} items, ${stats.indexStats.totalVectors} vectors`,
      );
    } catch (error) {
      ztoolkit.log(
        `[PreferenceScript] Failed to load semantic stats: ${error}`,
        "warn",
      );

      // Show error message
      loadingEl.textContent =
        getString("pref-semantic-stats-not-initialized" as any) ||
        "Semantic search service not initialized";
      loadingEl.style.display = "block";
      contentEl.style.display = "none";
    }
  }

  function getStatusText(status: string): string {
    const statusMap: Record<string, string> = {
      idle: getString("pref-semantic-stats-status-idle" as any) || "Idle",
      indexing:
        getString("pref-semantic-stats-status-indexing" as any) || "Indexing",
      paused: getString("pref-semantic-stats-status-paused" as any) || "Paused",
      completed:
        getString("pref-semantic-stats-status-completed" as any) || "Completed",
      error: getString("pref-semantic-stats-status-error" as any) || "Error",
      aborted: "Aborted",
    };
    return statusMap[status] || status;
  }

  /**
   * Register error callback to receive API errors during indexing
   */
  async function registerErrorCallback() {
    try {
      const { getSemanticSearchService } = require("./semantic");
      const semanticService = getSemanticSearchService();

      // Wait for initialization
      await semanticService.initialize();

      // Register error callback
      semanticService.setOnIndexError((error: any) => {
        ztoolkit.log(
          `[PreferenceScript] Received indexing error: ${error.type} - ${error.message}`,
        );

        // Get localized error message based on error type, including original error details
        const getLocalizedErrorMessage = (
          errorType: string,
          originalMessage: string,
        ): string => {
          const errorTypeMap: Record<string, string> = {
            network:
              getString("pref-semantic-index-error-network" as any) ||
              "Network connection failed, please check your network and click Resume",
            rate_limit:
              getString("pref-semantic-index-error-rate-limit" as any) ||
              "API rate limit exceeded, please try again later",
            auth:
              getString("pref-semantic-index-error-auth" as any) ||
              "API authentication failed, please check your API key",
            invalid_request:
              getString("pref-semantic-index-error-invalid-request" as any) ||
              "Invalid API request, please check configuration",
            server:
              getString("pref-semantic-index-error-server" as any) ||
              "API server error, please try again later",
            config:
              getString("pref-semantic-index-error-config" as any) ||
              "Configuration error, please check API settings",
            unknown:
              getString("pref-semantic-index-error-unknown" as any) ||
              "Unknown error",
          };
          const localizedMsg = errorTypeMap[errorType];
          // For known error types, append original message if it provides additional details
          // For unknown errors or when type is not found, always include original message
          if (localizedMsg) {
            // Include original message for all errors to provide more context
            return originalMessage && originalMessage !== errorType
              ? `${localizedMsg}: ${originalMessage}`
              : localizedMsg;
          }
          return originalMessage || "Unknown error";
        };

        // Store error info for display and potential retry
        lastErrorInfo = {
          message: getLocalizedErrorMessage(
            error.type || "unknown",
            error.message,
          ),
          type: error.type || "unknown",
          retryable: error.retryable !== false,
        };

        // Stop progress updates
        stopProgressUpdates();

        // Update UI to show error state
        updateControlButtons("paused");

        // Show error message with retry hint
        const errorMsg = lastErrorInfo.message;
        const retryHint = lastErrorInfo.retryable
          ? ` (${getString("pref-semantic-index-error-retry-hint" as any) || "Click Resume to retry"})`
          : "";
        showMessage(errorMsg + retryHint, "error");

        // Update status display
        if (statusEl) {
          statusEl.textContent = getStatusText("error");
          statusEl.style.color = "#c62828";
        }

        isIndexing = false;
      });

      ztoolkit.log(
        "[PreferenceScript] Registered error callback for semantic service",
      );
    } catch (error) {
      ztoolkit.log(
        `[PreferenceScript] Failed to register error callback: ${error}`,
        "warn",
      );
    }
  }
}
