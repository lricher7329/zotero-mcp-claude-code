/**
 * Test setup: mock Zotero globals that aren't available outside the plugin.
 */

// Mock ztoolkit
(globalThis as any).ztoolkit = {
  log: () => {},
};
