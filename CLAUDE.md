# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Zotero MCP is a Zotero plugin that provides Model Context Protocol (MCP) integration, allowing AI clients (Claude Code, Claude Desktop, Cherry Studio, Cursor IDE) to interact with a user's local Zotero library. The plugin includes an integrated MCP server that uses Streamable HTTP protocol.

**Architecture:** AI Client ↔ Streamable HTTP ↔ Zotero Plugin (integrated MCP server)

**Fork:** This fork adds Claude Code compatibility. Contributed by lricher7329.

## Claude Code Configuration

To use with Claude Code, add this to your MCP configuration (`~/.claude.json` or `.mcp.json`):

```json
{
  "mcpServers": {
    "zotero-mcp": {
      "type": "http",
      "url": "http://127.0.0.1:23120/mcp"
    }
  }
}
```

## Build Commands

All commands run from `zotero-mcp-plugin/` directory:

```bash
npm install          # Install dependencies
npm run build        # Build plugin and run TypeScript type checking
npm run start        # Development mode with auto-reload
npm run lint:check   # Check formatting and linting
npm run lint:fix     # Fix formatting and linting issues
npm run test         # Run tests via zotero-plugin-scaffold
```

## Code Architecture

### Entry Points
- [src/index.ts](zotero-mcp-plugin/src/index.ts) - Plugin bootstrap
- [src/addon.ts](zotero-mcp-plugin/src/addon.ts) - Main Addon class, exposes API methods
- [src/hooks.ts](zotero-mcp-plugin/src/hooks.ts) - Lifecycle hooks (startup, shutdown, prefs events), starts HTTP server

### Core Modules (`src/modules/`)
- [httpServer.ts](zotero-mcp-plugin/src/modules/httpServer.ts) - HTTP server using Mozilla nsIServerSocket, routes requests to MCP server or REST endpoints
- [streamableMCPServer.ts](zotero-mcp-plugin/src/modules/streamableMCPServer.ts) - MCP protocol implementation, handles JSON-RPC 2.0 requests, defines all MCP tools
- [searchEngine.ts](zotero-mcp-plugin/src/modules/searchEngine.ts) - Advanced search with boolean operators, relevance scoring, field queries
- [apiHandlers.ts](zotero-mcp-plugin/src/modules/apiHandlers.ts) - HTTP request handlers for search, items, collections, fulltext

### Content Extraction
- [unifiedContentExtractor.ts](zotero-mcp-plugin/src/modules/unifiedContentExtractor.ts) - Unified content extraction from PDFs, notes, attachments
- [smartAnnotationExtractor.ts](zotero-mcp-plugin/src/modules/smartAnnotationExtractor.ts) - Annotation extraction with relevance scoring
- [pdfService.ts](zotero-mcp-plugin/src/modules/pdfService.ts) / [pdfProcessor.ts](zotero-mcp-plugin/src/modules/pdfProcessor.ts) - PDF text extraction

### Configuration
- [serverPreferences.ts](zotero-mcp-plugin/src/modules/serverPreferences.ts) - Server port and enabled state preferences
- [mcpSettingsService.ts](zotero-mcp-plugin/src/modules/mcpSettingsService.ts) - MCP-specific settings (content modes, token limits)
- [clientConfigGenerator.ts](zotero-mcp-plugin/src/modules/clientConfigGenerator.ts) - Generates AI client configuration JSON

### Utilities
- [utils/prefs.ts](zotero-mcp-plugin/src/utils/prefs.ts) - Preference getters/setters
- [utils/ztoolkit.ts](zotero-mcp-plugin/src/utils/ztoolkit.ts) - ZToolkit factory for Zotero plugin utilities

## MCP Tools Provided

The plugin exposes these tools via MCP protocol:
- `search_library` - Library search with advanced filtering
- `search_annotations` - Search annotations/highlights
- `get_item_details` - Get item metadata
- `get_annotations` - Get annotations for items
- `get_content` - Unified content extraction (PDF, notes, abstract)
- `get_collections` / `search_collections` / `get_collection_details` / `get_collection_items` / `get_subcollections` - Collection operations
- `search_fulltext` - Full-text search with context
- `get_item_abstract` - Get item abstract

## Key Technical Details

- **Target:** Zotero 7+, Firefox 115 (ESR)
- **Protocol:** MCP 2024-11-05 and 2025-03-26 with Streamable HTTP transport
- **Default Port:** 23120
- **Endpoints:** `/mcp` (MCP requests), `/ping` (health check), `/mcp/status`, `/capabilities`
- **HTTP Methods:** GET, POST, DELETE (for session termination)

## Claude Code Compatibility Changes

This fork includes the following changes for Claude Code compatibility:

1. **Request body reading** - Properly reads full POST body based on Content-Length (up to 64KB)
2. **Accept header validation** - Validates client accepts application/json per MCP spec
3. **DELETE method support** - Session termination per MCP spec
4. **Notification handling** - Returns HTTP 202 for JSON-RPC notifications (requests without id)
5. **Batch request support** - Handles JSON arrays of requests
6. **Protocol version support** - Supports both 2024-11-05 and 2025-03-26 versions

## Development Notes

- Uses `zotero-plugin-toolkit` for plugin utilities
- Uses `zotero-plugin-scaffold` for build tooling
- HTTP server uses Mozilla's `nsIServerSocket` component
- Preferences stored under `extensions.zotero.zotero-mcp-plugin.*`
- Logging uses `ztoolkit.log()` with `===MCP===` prefix for easy filtering
- All source code comments and error messages are in English
- Chinese locale files (`addon/locale/zh-CN/`) are for UI translations only
- Chinese stop word lists in NLP/annotation code are functional data and should remain
