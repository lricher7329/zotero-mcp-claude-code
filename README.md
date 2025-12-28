# Zotero MCP - Claude Code Compatible Fork

A fork of [cookjohn/zotero-mcp](https://github.com/cookjohn/zotero-mcp) with full **Claude Code** compatibility.

[![GitHub](https://img.shields.io/badge/Original-cookjohn%2Fzotero--mcp-blue?logo=github)](https://github.com/cookjohn/zotero-mcp)
[![zotero target version](https://img.shields.io/badge/Zotero-7-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-Compatible-orange)](https://claude.ai/code)

---

## What's New in This Fork

This fork adds full compatibility with **Claude Code** (the CLI tool from Anthropic). The original plugin worked with Claude Desktop, Cherry Studio, and Cursor IDE, but had issues connecting to Claude Code due to differences in how Claude Code handles MCP servers.

### Changes Made

| Feature | Description |
|---------|-------------|
| **Request Body Reading** | Fixed to properly read full POST body based on `Content-Length` header (up to 64KB) |
| **Accept Header Validation** | Added validation per MCP spec for `application/json` acceptance |
| **DELETE Method Support** | Added session termination endpoint per MCP specification |
| **Notification Handling** | Returns HTTP 202 Accepted for JSON-RPC notifications (requests without `id`) |
| **Batch Request Support** | Handles JSON arrays of requests per JSON-RPC 2.0 spec |
| **Protocol Version Support** | Supports both MCP versions `2024-11-05` and `2025-03-26` |
| **English Documentation** | Translated Chinese code comments to English |

---

## Quick Start

### 1. Install the Plugin

1. Download the latest `.xpi` file from the [Releases Page](https://github.com/lricher7329/zotero-mcp-claude-code/releases) (or build from source)
2. In Zotero, install via `Tools -> Add-ons`
3. Restart Zotero

### 2. Enable the MCP Server

In Zotero: `Preferences -> Zotero MCP Plugin`
- Enable the server
- Default port: `23120`

### 3. Configure Claude Code

Add this to your Claude Code MCP configuration (`~/.claude.json` or `.mcp.json`):

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

### 4. Verify Connection

```bash
claude mcp list
```

You should see `zotero-mcp` listed with its available tools.

---

## Available MCP Tools

Once connected, Claude Code can use these tools to interact with your Zotero library:

| Tool | Description |
|------|-------------|
| `search_library` | Search your library with advanced filtering (title, creator, year, tags, full-text) |
| `search_annotations` | Search highlights, notes, and PDF annotations |
| `get_item_details` | Get detailed metadata for a specific item |
| `get_annotations` | Get annotations for a specific item |
| `get_content` | Extract unified content (PDF text, notes, abstract) |
| `get_collections` | List all collections |
| `search_collections` | Search collections by name |
| `get_collection_details` | Get details for a specific collection |
| `get_collection_items` | Get items in a collection |
| `get_subcollections` | Get child collections |
| `search_fulltext` | Full-text search with context snippets |
| `get_item_abstract` | Get the abstract of an item |

---

## Architecture

```
Claude Code ↔ HTTP POST ↔ Zotero Plugin (integrated MCP server) ↔ Zotero Library
```

The plugin runs an HTTP server inside Zotero that implements the MCP protocol using Streamable HTTP transport. No separate server process is required.

**Endpoints:**
- `POST /mcp` - MCP JSON-RPC 2.0 requests
- `GET /mcp` - Endpoint information
- `DELETE /mcp` - Session termination
- `GET /ping` - Health check
- `GET /mcp/status` - Server status
- `GET /capabilities` - API documentation

---

## Building from Source

```bash
cd zotero-mcp-plugin
npm install
npm run build
```

The built `.xpi` file will be in `.scaffold/build/`.

For development with auto-reload:
```bash
npm run start
```

---

## Other Supported Clients

This fork maintains backward compatibility with:
- **Claude Desktop** - Use Streamable HTTP configuration
- **Cherry Studio** - Streamable HTTP support
- **Cursor IDE** - Streamable HTTP MCP support

---

## Credits

- **Original Project:** [cookjohn/zotero-mcp](https://github.com/cookjohn/zotero-mcp)
- **Claude Code Compatibility:** [lricher7329](https://github.com/lricher7329)
- **Zotero:** [zotero.org](https://www.zotero.org/)
- **Model Context Protocol:** [modelcontextprotocol.org](https://modelcontextprotocol.org/)

## License

This project is licensed under the [MIT License](./LICENSE).
