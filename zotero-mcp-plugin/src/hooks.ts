import { BasicExampleFactory } from "./modules/examples";
import { httpServer } from "./modules/httpServer"; // 使用单例导出
import { serverPreferences } from "./modules/serverPreferences";
import { getString, initLocale } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { createZToolkit } from "./utils/ztoolkit";
import { MCPSettingsService } from "./modules/mcpSettingsService";
import { registerSemanticIndexColumn, unregisterSemanticIndexColumn, refreshSemanticColumn } from "./modules/semanticIndexColumn";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  // Initialize MCP settings with defaults
  try {
    MCPSettingsService.initializeDefaults();
    ztoolkit.log(`===MCP=== [hooks.ts] MCP settings initialized successfully`);
  } catch (error) {
    ztoolkit.log(`===MCP=== [hooks.ts] Error initializing MCP settings: ${error}`, 'error');
  }

  // Check if this is first installation and show config prompt
  checkFirstInstallation();

  // 启动HTTP服务器前增加详细诊断
  try {
    ztoolkit.log(`===MCP=== [hooks.ts] [DIAGNOSTIC] Starting server initialization...`);
    
    // 记录初始化环境信息
    ztoolkit.log(`===MCP=== [hooks.ts] [DIAGNOSTIC] Zotero version: ${Zotero.version || 'unknown'}`);
    try {
      ztoolkit.log(`===MCP=== [hooks.ts] [DIAGNOSTIC] Platform: ${(globalThis as any).navigator?.platform || 'unknown'}`);
      ztoolkit.log(`===MCP=== [hooks.ts] [DIAGNOSTIC] User agent: ${(globalThis as any).navigator?.userAgent || 'unknown'}`);
    } catch (e) {
      ztoolkit.log(`===MCP=== [hooks.ts] [DIAGNOSTIC] Platform info unavailable`);
    }
    
    ztoolkit.log(`===MCP=== [hooks.ts] Attempting to get server preferences...`);
    const port = serverPreferences.getPort();
    const enabled = serverPreferences.isServerEnabled();

    ztoolkit.log(
      `===MCP=== [hooks.ts] Port retrieved: ${port} (type: ${typeof port})`,
    );
    ztoolkit.log(`===MCP=== [hooks.ts] Server enabled: ${enabled} (type: ${typeof enabled})`);
    
    // 额外检查：直接查询底层偏好设置
    try {
      const directEnabled = Zotero.Prefs.get("extensions.zotero.zotero-mcp-plugin.mcp.server.enabled", true);
      const directPort = Zotero.Prefs.get("extensions.zotero.zotero-mcp-plugin.mcp.server.port", true);
      ztoolkit.log(`===MCP=== [hooks.ts] [DIAGNOSTIC] Direct pref check - enabled: ${directEnabled}, port: ${directPort}`);
      
      if (enabled !== directEnabled) {
        ztoolkit.log(`===MCP=== [hooks.ts] [DIAGNOSTIC] WARNING: Enabled state mismatch! serverPreferences: ${enabled}, direct: ${directEnabled}`);
      }
    } catch (error) {
      ztoolkit.log(`===MCP=== [hooks.ts] [DIAGNOSTIC] Error in direct preference check: ${error}`, 'error');
    }
    
    // 检查是否有任何外部因素重置了设置
    if (enabled === false) {
      ztoolkit.log(`===MCP=== [hooks.ts] [DIAGNOSTIC] Server is disabled - investigating reason...`);
      
      // 尝试检测是否是首次启动后被重置
      const hasBeenEnabled = Zotero.Prefs.get("extensions.zotero.zotero-mcp-plugin.debug.hasBeenEnabled", false);
      if (!hasBeenEnabled) {
        ztoolkit.log(`===MCP=== [hooks.ts] [DIAGNOSTIC] First time setup - server was never enabled before`);
      } else {
        ztoolkit.log(`===MCP=== [hooks.ts] [DIAGNOSTIC] WARNING: Server was previously enabled but is now disabled!`);
      }
      
      ztoolkit.log(`===MCP=== [hooks.ts] Server is disabled, skipping startup 插件无法启动`);
      return;
    }
    
    // 记录服务器曾经被启用过
    Zotero.Prefs.set("extensions.zotero.zotero-mcp-plugin.debug.hasBeenEnabled", true, true);

    if (!port || isNaN(port)) {
      throw new Error(`Invalid port value: ${port}`);
    }

    ztoolkit.log(
      `===MCP=== [hooks.ts] Starting HTTP server on port ${port}...`,
    );
    httpServer.start(port); // No await, let it run in background
    addon.data.httpServer = httpServer; // 保存引用以便后续使用
    ztoolkit.log(
      `===MCP=== [hooks.ts] HTTP server start initiated on port ${port}`,
    );
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    ztoolkit.log(
      `===MCP=== [hooks.ts] Failed to start HTTP server: ${err.message}`,
      "error",
    );
    Zotero.debug(
      `===MCP=== [hooks.ts] Server start error details: ${err.stack}`,
    );
  }

  // 监听偏好设置变化
  serverPreferences.addObserver(async (name) => {
    ztoolkit.log(`[MCP Plugin] Preference changed: ${name}`);

    if (name === "extensions.zotero.zotero-mcp-plugin.mcp.server.port" || name === "extensions.zotero.zotero-mcp-plugin.mcp.server.enabled") {
      try {
        // 先停止服务器
        if (httpServer.isServerRunning()) {
          ztoolkit.log("[MCP Plugin] Stopping HTTP server for restart...");
          httpServer.stop();
          ztoolkit.log("[MCP Plugin] HTTP server stopped");
        }

        // 如果启用了服务器，重新启动
        if (serverPreferences.isServerEnabled()) {
          const port = serverPreferences.getPort();
          ztoolkit.log(
            `[MCP Plugin] Restarting HTTP server on port ${port}...`,
          );
          httpServer.start(port);
          ztoolkit.log(
            `[MCP Plugin] HTTP server restarted successfully on port ${port}`,
          );
        } else {
          ztoolkit.log("[MCP Plugin] HTTP server disabled by user preference");
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        ztoolkit.log(
          `[MCP Plugin] Error handling preference change: ${err.message}`,
          "error",
        );
      }
    }
  });

  BasicExampleFactory.registerPrefs();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  // Mark initialized as true to confirm plugin loading status
  // outside of the plugin (e.g. scaffold testing process)
  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  // Create ztoolkit for every window
  addon.data.ztoolkit = createZToolkit();

  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  // Also load addon.ftl and preferences.ftl
  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-addon.ftl`,
  );
  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-preferences.ftl`,
  );

  // Register context menu for semantic indexing
  registerSemanticIndexMenu(win);

  // Register semantic index status column
  registerSemanticIndexColumn();
}

async function onMainWindowUnload(win: Window): Promise<void> {
  ztoolkit.unregisterAll();
}

function onShutdown(): void {
  ztoolkit.log("[MCP Plugin] Shutting down...");

  // 注销语义索引状态列
  try {
    unregisterSemanticIndexColumn();
    ztoolkit.log("[MCP Plugin] Semantic index column unregistered during shutdown");
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    ztoolkit.log(
      `[MCP Plugin] Error unregistering semantic index column: ${err.message}`,
      "error",
    );
  }

  // 停止HTTP服务器
  try {
    if (httpServer.isServerRunning()) {
      httpServer.stop();
      ztoolkit.log("[MCP Plugin] HTTP server stopped during shutdown");
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    ztoolkit.log(
      `[MCP Plugin] Error stopping server during shutdown: ${err.message}`,
      "error",
    );
  }

  // 停止语义搜索服务
  try {
    const { getSemanticSearchService } = require("./modules/semantic");
    const semanticService = getSemanticSearchService();
    // Abort any ongoing indexing
    semanticService.abortIndex();
    // Destroy the service
    semanticService.destroy();
    ztoolkit.log("[MCP Plugin] Semantic search service stopped during shutdown");
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    ztoolkit.log(
      `[MCP Plugin] Error stopping semantic service during shutdown: ${err.message}`,
      "error",
    );
  }

  // 停止嵌入服务
  try {
    const { getEmbeddingService } = require("./modules/semantic/embeddingService");
    const embeddingService = getEmbeddingService();
    embeddingService.destroy();
    ztoolkit.log("[MCP Plugin] Embedding service stopped during shutdown");
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    ztoolkit.log(
      `[MCP Plugin] Error stopping embedding service during shutdown: ${err.message}`,
      "error",
    );
  }

  // 关闭向量存储数据库
  try {
    const { getVectorStore } = require("./modules/semantic/vectorStore");
    const vectorStore = getVectorStore();
    vectorStore.close();
    ztoolkit.log("[MCP Plugin] Vector store closed during shutdown");
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    ztoolkit.log(
      `[MCP Plugin] Error closing vector store during shutdown: ${err.message}`,
      "error",
    );
  }

  serverPreferences.unregister();
  ztoolkit.unregisterAll();
  // Remove addon object
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

/**
 * This function is just an example of dispatcher for Notify events.
 * Any operations should be placed in a function to keep this funcion clear.
 */
async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  // You can add your code to the corresponding notify type
  ztoolkit.log("notify", event, type, ids, extraData);
}

/**
 * This function is just an example of dispatcher for Preference UI events.
 * Any operations should be placed in a function to keep this funcion clear.
 * @param type event type
 * @param data event data
 */
async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  ztoolkit.log(`===MCP=== [hooks.ts] [DIAGNOSTIC] Preferences event: ${type}`);
  
  switch (type) {
    case "load":
      ztoolkit.log(`===MCP=== [hooks.ts] [DIAGNOSTIC] Loading preference scripts...`);
      
      // 诊断设置面板加载环境
      try {
        if (data.window) {
          ztoolkit.log(`===MCP=== [hooks.ts] [DIAGNOSTIC] Preference window available`);
          
          // 检查当前偏好设置状态
          const currentEnabled = Zotero.Prefs.get("extensions.zotero.zotero-mcp-plugin.mcp.server.enabled", true);
          const currentPort = Zotero.Prefs.get("extensions.zotero.zotero-mcp-plugin.mcp.server.port", true);
          ztoolkit.log(`===MCP=== [hooks.ts] [DIAGNOSTIC] Current prefs at panel load - enabled: ${currentEnabled}, port: ${currentPort}`);
          
          // 检查preference元素是否存在
          setTimeout(() => {
            try {
              const doc = data.window.document;
              const enabledElement = doc?.querySelector('#zotero-prefpane-zotero-mcp-plugin-mcp-server-enabled');
              const portElement = doc?.querySelector('#zotero-prefpane-zotero-mcp-plugin-mcp-server-port');
              
              ztoolkit.log(`===MCP=== [hooks.ts] [DIAGNOSTIC] Preference elements - enabled: ${!!enabledElement}, port: ${!!portElement}`);
              
              if (enabledElement) {
                const hasChecked = enabledElement.hasAttribute('checked');
                ztoolkit.log(`===MCP=== [hooks.ts] [DIAGNOSTIC] Enabled checkbox state: ${hasChecked}`);
              }
              
            } catch (error) {
              ztoolkit.log(`===MCP=== [hooks.ts] [DIAGNOSTIC] Error checking preference elements: ${error}`, 'error');
            }
          }, 500);
          
        } else {
          ztoolkit.log(`===MCP=== [hooks.ts] [DIAGNOSTIC] WARNING: No preference window in data`, 'error');
        }
      } catch (error) {
        ztoolkit.log(`===MCP=== [hooks.ts] [DIAGNOSTIC] Error in preference load diagnostic: ${error}`, 'error');
      }
      
      registerPrefsScripts(data.window);
      break;
    default:
      return;
  }
}

// Add your hooks here. For element click, etc.
// Keep in mind hooks only do dispatch. Don't add code that does real jobs in hooks.
// Otherwise the code would be hard to read and maintain.

/**
 * Check if this is the first installation and prompt user to configure
 */
function checkFirstInstallation() {
  try {
    const hasShownPrompt = Zotero.Prefs.get("mcp.firstInstallPromptShown", false);
    if (!hasShownPrompt) {
      // Mark as shown immediately to prevent multiple prompts
      Zotero.Prefs.set("mcp.firstInstallPromptShown", true);
      
      // Show prompt after a short delay to ensure UI is ready
      setTimeout(() => {
        showFirstInstallPrompt();
      }, 3000);
    }
  } catch (error) {
    ztoolkit.log(`[MCP Plugin] Error checking first installation: ${error}`, "error");
  }
}

/**
 * Show first installation configuration prompt
 */
function showFirstInstallPrompt() {
  try {
    // Use bilingual text for first install prompt
    const title = "欢迎使用 Zotero MCP 插件 / Welcome to Zotero MCP Plugin";
    const promptText = "感谢安装 Zotero MCP 插件！为了开始使用，您需要为您的 AI 客户端生成配置文件。是否现在打开设置页面来生成配置？\n\nThank you for installing the Zotero MCP Plugin! To get started, you need to generate configuration files for your AI clients. Would you like to open the settings page now to generate configurations?";
    const openPrefsText = "打开设置 / Open Settings";
    const laterText = "稍后配置 / Configure Later";
    
    // Use a simple window confirm instead of Services.prompt for compatibility
    const message = `${title}\n\n${promptText}\n\n${openPrefsText} (OK) / ${laterText} (Cancel)`;
    
    const mainWindow = Zotero.getMainWindow();
    if (!mainWindow) {
      ztoolkit.log("[MCP Plugin] No main window available", "error");
      return;
    }
    
    const result = mainWindow.confirm(message);
    
    if (result) {
      // User chose to open preferences
      setTimeout(() => {
        openPreferencesWindow();
      }, 100);
    }
  } catch (error) {
    ztoolkit.log(`[MCP Plugin] Error showing first install prompt: ${error}`, "error");
  }
}

/**
 * Open the preferences window
 */
function openPreferencesWindow() {
  try {
    const windowName = `${addon.data.config.addonRef}-preferences`;
    const existingWindow = Zotero.getMainWindow().ZoteroPane.openPreferences(null, windowName);
    
    if (existingWindow) {
      existingWindow.focus();
    }
  } catch (error) {
    ztoolkit.log(`[MCP Plugin] Error opening preferences: ${error}`, "error");
    
    // Fallback: try to open standard preferences
    try {
      Zotero.getMainWindow().openPreferences();
    } catch (fallbackError) {
      ztoolkit.log(`[MCP Plugin] Fallback preferences open failed: ${fallbackError}`, "error");
    }
  }
}

/**
 * Register semantic index context menu
 */
function registerSemanticIndexMenu(win: _ZoteroTypes.MainWindow) {
  try {
    const doc = win.document;

    // Find the item context menu
    const itemMenu = doc.getElementById("zotero-itemmenu");
    if (!itemMenu) {
      ztoolkit.log("[MCP Plugin] Item menu not found, skipping context menu registration");
      return;
    }

    // Create menu separator
    const separator = doc.createXULElement("menuseparator");
    separator.id = "zotero-mcp-semantic-separator";

    // Create parent menu
    const parentMenu = doc.createXULElement("menu");
    parentMenu.id = "zotero-mcp-semantic-menu";
    parentMenu.setAttribute("label", getString("menu-semantic-index" as any) || "Update Semantic Index");

    // Create popup for submenu
    const popup = doc.createXULElement("menupopup");
    popup.id = "zotero-mcp-semantic-popup";

    // Create "Index Selected Items" menu item
    const indexSelectedItem = doc.createXULElement("menuitem");
    indexSelectedItem.id = "zotero-mcp-index-selected";
    indexSelectedItem.setAttribute("label", getString("menu-semantic-index-selected" as any) || "Index Selected Items");
    indexSelectedItem.addEventListener("command", () => {
      handleIndexSelected(win);
    });

    // Create "Index All Items" menu item
    const indexAllItem = doc.createXULElement("menuitem");
    indexAllItem.id = "zotero-mcp-index-all";
    indexAllItem.setAttribute("label", getString("menu-semantic-index-all" as any) || "Index All Items");
    indexAllItem.addEventListener("command", () => {
      handleIndexAll(win);
    });

    // Create "Clear Selected Items Index" menu item
    const clearSelectedItem = doc.createXULElement("menuitem");
    clearSelectedItem.id = "zotero-mcp-clear-selected";
    clearSelectedItem.setAttribute("label", getString("menu-semantic-clear-selected" as any) || "Clear Selected Items Index");
    clearSelectedItem.addEventListener("command", () => {
      handleClearSelectedIndex(win);
    });

    // Assemble menu
    popup.appendChild(indexSelectedItem);
    popup.appendChild(indexAllItem);
    popup.appendChild(clearSelectedItem);
    parentMenu.appendChild(popup);

    // Add to item menu
    itemMenu.appendChild(separator);
    itemMenu.appendChild(parentMenu);

    ztoolkit.log("[MCP Plugin] Semantic index context menu registered");
  } catch (error) {
    ztoolkit.log(`[MCP Plugin] Error registering context menu: ${error}`, "error");
  }

  // Also register collection context menu
  registerCollectionSemanticIndexMenu(win);
}

/**
 * Register semantic index context menu for collections
 */
function registerCollectionSemanticIndexMenu(win: _ZoteroTypes.MainWindow) {
  try {
    const doc = win.document;

    // Find the collection context menu
    const collectionMenu = doc.getElementById("zotero-collectionmenu");
    if (!collectionMenu) {
      ztoolkit.log("[MCP Plugin] Collection menu not found, skipping collection context menu registration");
      return;
    }

    // Create menu separator
    const separator = doc.createXULElement("menuseparator");
    separator.id = "zotero-mcp-collection-semantic-separator";

    // Create parent menu
    const parentMenu = doc.createXULElement("menu");
    parentMenu.id = "zotero-mcp-collection-semantic-menu";
    parentMenu.setAttribute("label", getString("menu-collection-semantic-index" as any) || "Semantic Index");

    // Create popup for submenu
    const popup = doc.createXULElement("menupopup");
    popup.id = "zotero-mcp-collection-semantic-popup";

    // Create "Build Index" menu item (incremental, only unindexed items)
    const buildIndexItem = doc.createXULElement("menuitem");
    buildIndexItem.id = "zotero-mcp-collection-build-index";
    buildIndexItem.setAttribute("label", getString("menu-collection-build-index" as any) || "Build Index");
    buildIndexItem.addEventListener("command", () => {
      handleIndexCollection(win, false);
    });

    // Create "Rebuild Index" menu item (rebuild all items in collection)
    const rebuildIndexItem = doc.createXULElement("menuitem");
    rebuildIndexItem.id = "zotero-mcp-collection-rebuild-index";
    rebuildIndexItem.setAttribute("label", getString("menu-collection-rebuild-index" as any) || "Rebuild Index");
    rebuildIndexItem.addEventListener("command", () => {
      handleIndexCollection(win, true);
    });

    // Create "Clear Index" menu item
    const clearIndexItem = doc.createXULElement("menuitem");
    clearIndexItem.id = "zotero-mcp-collection-clear-index";
    clearIndexItem.setAttribute("label", getString("menu-collection-clear-index" as any) || "Clear Index");
    clearIndexItem.addEventListener("command", () => {
      handleClearCollectionIndex(win);
    });

    // Assemble menu
    popup.appendChild(buildIndexItem);
    popup.appendChild(rebuildIndexItem);
    popup.appendChild(clearIndexItem);
    parentMenu.appendChild(popup);

    // Add to collection menu
    collectionMenu.appendChild(separator);
    collectionMenu.appendChild(parentMenu);

    ztoolkit.log("[MCP Plugin] Collection semantic index context menu registered");
  } catch (error) {
    ztoolkit.log(`[MCP Plugin] Error registering collection context menu: ${error}`, "error");
  }
}

/**
 * Handle indexing a collection
 * @param rebuild If true, rebuild index for all items (even if already indexed)
 */
async function handleIndexCollection(win: _ZoteroTypes.MainWindow, rebuild: boolean = false) {
  try {
    const ZoteroPane = win.ZoteroPane;
    if (!ZoteroPane) {
      ztoolkit.log("[MCP Plugin] ZoteroPane not available", "error");
      return;
    }

    // Get selected collection
    const collection = ZoteroPane.getSelectedCollection?.();
    if (!collection) {
      ztoolkit.log("[MCP Plugin] No collection selected");
      showNotification(win, getString("menu-semantic-index-no-collection" as any) || "Please select a collection");
      return;
    }

    ztoolkit.log(`[MCP Plugin] ${rebuild ? 'Rebuilding' : 'Building'} index for collection: ${collection.name}`);

    // Get all items in the collection (including nested subcollections)
    const itemIDs = collection.getChildItems(true);
    if (!itemIDs || itemIDs.length === 0) {
      ztoolkit.log("[MCP Plugin] Collection has no items");
      showNotification(win, getString("menu-semantic-index-no-items" as any) || "Collection has no items");
      return;
    }

    // Convert IDs to item objects and filter for regular items
    const items = Zotero.Items.get(itemIDs);
    const itemKeys = items
      .filter((item: any) => item.isRegularItem?.())
      .map((item: any) => item.key);

    if (itemKeys.length === 0) {
      ztoolkit.log("[MCP Plugin] No regular items in collection");
      showNotification(win, getString("menu-semantic-index-no-items" as any) || "No indexable items in collection");
      return;
    }

    ztoolkit.log(`[MCP Plugin] ${rebuild ? 'Rebuilding' : 'Building'} index for ${itemKeys.length} items from collection "${collection.name}"`);

    // Import and use semantic search service
    const { getSemanticSearchService } = await import("./modules/semantic");
    const semanticService = getSemanticSearchService();
    await semanticService.initialize();

    // Show starting notification
    const startMessage = `${getString("menu-semantic-index-started" as any) || "Semantic indexing started"}: ${collection.name} (${itemKeys.length})`;
    showNotification(win, startMessage);

    // Build index for collection items
    semanticService.buildIndex({
      itemKeys,
      rebuild,
      onProgress: (progress) => {
        ztoolkit.log(`[MCP Plugin] Index progress: ${progress.processed}/${progress.total}`);
      }
    }).then((result) => {
      ztoolkit.log(`[MCP Plugin] Collection indexing completed: ${result.processed}/${result.total} items`);
      // Refresh semantic column to show updated status
      refreshSemanticColumn();
      // Show success notification
      const completedMsg = `${getString("menu-semantic-index-completed" as any) || "Indexing completed"}: ${collection.name} (${result.processed}/${result.total})`;
      showNotification(win, completedMsg);
    }).catch((error) => {
      ztoolkit.log(`[MCP Plugin] Collection indexing failed: ${error}`, "error");
      // Refresh column anyway to show current status
      refreshSemanticColumn();
      // Show error notification
      const errorMsg = `${getString("menu-semantic-index-error" as any) || "Indexing failed"}: ${error.message || error}`;
      showNotification(win, errorMsg);
    });

  } catch (error) {
    ztoolkit.log(`[MCP Plugin] Error handling collection index: ${error}`, "error");
    showNotification(win, getString("menu-semantic-index-error" as any) || "Semantic indexing failed");
  }
}

/**
 * Handle clearing index for a collection
 */
async function handleClearCollectionIndex(win: _ZoteroTypes.MainWindow) {
  try {
    const ZoteroPane = win.ZoteroPane;
    if (!ZoteroPane) {
      ztoolkit.log("[MCP Plugin] ZoteroPane not available", "error");
      return;
    }

    // Get selected collection
    const collection = ZoteroPane.getSelectedCollection?.();
    if (!collection) {
      ztoolkit.log("[MCP Plugin] No collection selected");
      showNotification(win, getString("menu-semantic-index-no-collection" as any) || "Please select a collection");
      return;
    }

    // Confirm before clearing
    const confirmMsg = getString("menu-collection-clear-confirm" as any) ||
      `Are you sure you want to clear the semantic index for "${collection.name}"?`;
    if (!win.confirm(confirmMsg)) {
      return;
    }

    ztoolkit.log(`[MCP Plugin] Clearing index for collection: ${collection.name}`);

    // Get all items in the collection
    const itemIDs = collection.getChildItems(true);
    if (!itemIDs || itemIDs.length === 0) {
      ztoolkit.log("[MCP Plugin] Collection has no items");
      showNotification(win, getString("menu-semantic-index-no-items" as any) || "Collection has no items");
      return;
    }

    // Convert IDs to item objects and get keys
    const items = Zotero.Items.get(itemIDs);
    const itemKeys = items
      .filter((item: any) => item.isRegularItem?.())
      .map((item: any) => item.key);

    if (itemKeys.length === 0) {
      ztoolkit.log("[MCP Plugin] No regular items in collection");
      return;
    }

    // Delete vectors for these items
    const { getVectorStore } = await import("./modules/semantic/vectorStore");
    const vectorStore = getVectorStore();
    await vectorStore.initialize();

    let clearedCount = 0;
    for (const itemKey of itemKeys) {
      try {
        await vectorStore.deleteItemVectors(itemKey);
        clearedCount++;
      } catch (e) {
        // Ignore errors for items that weren't indexed
      }
    }

    ztoolkit.log(`[MCP Plugin] Cleared index for ${clearedCount} items in collection "${collection.name}"`);

    // Refresh semantic column
    refreshSemanticColumn();

    // Show notification
    const message = `${getString("menu-collection-index-cleared" as any) || "Index cleared"}: ${collection.name} (${clearedCount})`;
    showNotification(win, message);

  } catch (error) {
    ztoolkit.log(`[MCP Plugin] Error clearing collection index: ${error}`, "error");
    showNotification(win, getString("menu-semantic-index-error" as any) || "Failed to clear index");
  }
}

/**
 * Handle clearing index for selected items
 */
async function handleClearSelectedIndex(win: _ZoteroTypes.MainWindow) {
  try {
    const ZoteroPane = win.ZoteroPane;
    if (!ZoteroPane) {
      ztoolkit.log("[MCP Plugin] ZoteroPane not available", "error");
      return;
    }

    const selectedItems = ZoteroPane.getSelectedItems();
    if (!selectedItems || selectedItems.length === 0) {
      ztoolkit.log("[MCP Plugin] No items selected");
      return;
    }

    // Get item keys
    const itemKeys = selectedItems
      .filter((item: any) => item.isRegularItem?.())
      .map((item: any) => item.key);

    if (itemKeys.length === 0) {
      ztoolkit.log("[MCP Plugin] No regular items selected");
      return;
    }

    // Confirm before clearing
    const confirmMsg = getString("menu-semantic-clear-selected-confirm" as any) ||
      `Are you sure you want to clear the semantic index for ${itemKeys.length} selected item(s)?`;
    if (!win.confirm(confirmMsg)) {
      return;
    }

    ztoolkit.log(`[MCP Plugin] Clearing index for ${itemKeys.length} selected items...`);

    // Delete vectors for these items
    const { getVectorStore } = await import("./modules/semantic/vectorStore");
    const vectorStore = getVectorStore();
    await vectorStore.initialize();

    let clearedCount = 0;
    for (const itemKey of itemKeys) {
      try {
        await vectorStore.deleteItemVectors(itemKey);
        clearedCount++;
      } catch (e) {
        // Ignore errors for items that weren't indexed
      }
    }

    ztoolkit.log(`[MCP Plugin] Cleared index for ${clearedCount} items`);

    // Refresh semantic column
    refreshSemanticColumn();

    // Show notification
    const message = `${getString("menu-semantic-clear-selected-done" as any) || "Index cleared for"} ${clearedCount} ${getString("menu-semantic-items" as any) || "items"}`;
    showNotification(win, message);

  } catch (error) {
    ztoolkit.log(`[MCP Plugin] Error clearing selected items index: ${error}`, "error");
    showNotification(win, getString("menu-semantic-index-error" as any) || "Failed to clear index");
  }
}

/**
 * Handle indexing selected items
 */
async function handleIndexSelected(win: _ZoteroTypes.MainWindow) {
  try {
    const ZoteroPane = win.ZoteroPane;
    if (!ZoteroPane) {
      ztoolkit.log("[MCP Plugin] ZoteroPane not available", "error");
      return;
    }

    const selectedItems = ZoteroPane.getSelectedItems();
    if (!selectedItems || selectedItems.length === 0) {
      ztoolkit.log("[MCP Plugin] No items selected");
      return;
    }

    // Get item keys
    const itemKeys = selectedItems
      .filter((item: any) => item.isRegularItem?.())
      .map((item: any) => item.key);

    if (itemKeys.length === 0) {
      ztoolkit.log("[MCP Plugin] No regular items selected");
      return;
    }

    ztoolkit.log(`[MCP Plugin] Indexing ${itemKeys.length} selected items...`);

    // Import and use semantic search service
    const { getSemanticSearchService } = await import("./modules/semantic");
    const semanticService = getSemanticSearchService();
    await semanticService.initialize();

    // Show starting notification
    showNotification(win, `${getString("menu-semantic-index-started" as any) || "Semantic indexing started"}: ${itemKeys.length} ${getString("menu-semantic-items" as any) || "items"}`);

    // Build index for selected items
    semanticService.buildIndex({
      itemKeys,
      rebuild: false,
      onProgress: (progress) => {
        ztoolkit.log(`[MCP Plugin] Index progress: ${progress.processed}/${progress.total}`);
      }
    }).then((result) => {
      ztoolkit.log(`[MCP Plugin] Indexing completed: ${result.processed}/${result.total} items`);
      // Refresh semantic column to show updated status
      refreshSemanticColumn();
      // Show success notification
      const completedMsg = `${getString("menu-semantic-index-completed" as any) || "Indexing completed"}: ${result.processed}/${result.total} ${getString("menu-semantic-items" as any) || "items"}`;
      showNotification(win, completedMsg);
    }).catch((error) => {
      ztoolkit.log(`[MCP Plugin] Indexing failed: ${error}`, "error");
      // Refresh column anyway to show current status
      refreshSemanticColumn();
      // Show error notification
      const errorMsg = `${getString("menu-semantic-index-error" as any) || "Indexing failed"}: ${error.message || error}`;
      showNotification(win, errorMsg);
    });

  } catch (error) {
    ztoolkit.log(`[MCP Plugin] Error handling index selected: ${error}`, "error");
    showNotification(win, getString("menu-semantic-index-error" as any) || "Semantic indexing failed");
  }
}

/**
 * Handle indexing all items
 */
async function handleIndexAll(win: _ZoteroTypes.MainWindow) {
  try {
    ztoolkit.log("[MCP Plugin] Indexing all items...");

    // Import and use semantic search service
    const { getSemanticSearchService } = await import("./modules/semantic");
    const semanticService = getSemanticSearchService();
    await semanticService.initialize();

    // Show starting notification
    showNotification(win, getString("menu-semantic-index-started" as any) || "Semantic indexing started");

    // Build index for all items
    semanticService.buildIndex({
      rebuild: false,
      onProgress: (progress) => {
        ztoolkit.log(`[MCP Plugin] Index progress: ${progress.processed}/${progress.total}`);
      }
    }).then((result) => {
      ztoolkit.log(`[MCP Plugin] Indexing completed: ${result.processed}/${result.total} items`);
      // Refresh semantic column to show updated status
      refreshSemanticColumn();
      // Show success notification
      const completedMsg = `${getString("menu-semantic-index-completed" as any) || "Indexing completed"}: ${result.processed}/${result.total} ${getString("menu-semantic-items" as any) || "items"}`;
      showNotification(win, completedMsg);
    }).catch((error) => {
      ztoolkit.log(`[MCP Plugin] Indexing failed: ${error}`, "error");
      // Refresh column anyway to show current status
      refreshSemanticColumn();
      // Show error notification
      const errorMsg = `${getString("menu-semantic-index-error" as any) || "Indexing failed"}: ${error.message || error}`;
      showNotification(win, errorMsg);
    });

  } catch (error) {
    ztoolkit.log(`[MCP Plugin] Error handling index all: ${error}`, "error");
    showNotification(win, getString("menu-semantic-index-error" as any) || "Semantic indexing failed");
  }
}

/**
 * Show a simple notification
 */
function showNotification(win: _ZoteroTypes.MainWindow, message: string) {
  try {
    // Use Zotero's progress window for notification
    const progressWin = new Zotero.ProgressWindow({ closeOnClick: true });
    progressWin.changeHeadline("Zotero MCP");
    progressWin.addDescription(message);
    progressWin.show();
    progressWin.startCloseTimer(3000);
  } catch (error) {
    ztoolkit.log(`[MCP Plugin] Error showing notification: ${error}`, "warn");
  }
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
};
