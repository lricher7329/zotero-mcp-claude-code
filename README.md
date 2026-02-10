# Zotero MCP for Claude Code

A Zotero plugin that exposes your library to AI assistants via the [Model Context Protocol](https://modelcontextprotocol.org/) (MCP). This fork adds Claude Code compatibility and write operations.

[![GitHub](https://img.shields.io/badge/GitHub-zotero--mcp--claude--code-blue?logo=github)](https://github.com/lricher7329/zotero-mcp-claude-code)
[![Zotero](https://img.shields.io/badge/Zotero-7-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Version](https://img.shields.io/badge/Version-1.4.0-brightgreen)]()
[![License](https://img.shields.io/badge/License-MIT-yellow)](./LICENSE)

---

## What it does

The plugin runs an MCP server inside Zotero that AI clients connect to over HTTP. No separate server process needed.

```
AI Client  <--Streamable HTTP-->  Zotero Plugin (integrated MCP server)
```

Your AI assistant can then search your library, read PDFs, extract annotations, create items, manage collections, and more.

## Quick start

### 1. Install the plugin

Download the latest `.xpi` from the [Releases page](https://github.com/lricher7329/zotero-mcp-claude-code/releases) and install it in Zotero via **Tools > Add-ons**.

### 2. Connect Claude Code

```bash
claude mcp add zotero-mcp http://127.0.0.1:23120/mcp -t http
```

Or add to your MCP config (`~/.claude.json` or `.mcp.json`):

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

### 3. Verify

```bash
claude mcp list
```

You should see `zotero-mcp` with the available tools listed.

## Supported clients

| Client | Connection |
|--------|-----------|
| **Claude Code** | Native HTTP MCP (recommended) |
| **Claude Desktop** | Streamable HTTP via mcp-remote |
| **Cursor IDE** | Streamable HTTP via mcp-remote |
| **Cherry Studio** | Native Streamable HTTP |
| **Gemini CLI** | Native HTTP MCP |
| **Cline (VS Code)** | Streamable HTTP via mcp-remote |
| **Continue.dev** | Streamable HTTP via mcp-remote |
| **Qwen Code** | Native HTTP MCP |
| **Chatbox** | Streamable HTTP via mcp-remote |
| **Trae AI** | Streamable HTTP via mcp-remote |

The plugin preferences include a **Client Configuration Generator** that produces ready-to-use config for each client.

## MCP tools

### Read tools (always available)

| Tool | Description |
|------|-------------|
| `search_library` | Search with advanced filtering (title, creator, year, tags, item type, boolean operators, relevance scoring, pagination) |
| `search_annotations` | Search annotations/highlights by query, color, or tags |
| `get_item_details` | Get full metadata for an item |
| `get_item_abstract` | Get an item's abstract |
| `get_annotations` | Get annotations for specific items |
| `get_content` | Extract content from PDFs, notes, and attachments |
| `get_collections` | List all collections |
| `search_collections` | Search collections by name |
| `get_collection_details` | Get collection metadata |
| `get_collection_items` | List items in a collection |
| `get_subcollections` | List child collections |
| `search_fulltext` | Full-text search across attachments with context snippets |
| `semantic_search` | AI-powered semantic search using embedding vectors |
| `find_similar` | Find items similar to a given item |
| `semantic_status` | Check semantic index status |
| `fulltext_database` | Query the full-text content cache (list, search, get, stats) |

### Write tools (when enabled in preferences)

| Tool | Description |
|------|-------------|
| `create_item` | Create a new library item (journal article, book, etc.) with fields, creators, tags, collections |
| `update_item` | Update fields and creators on an existing item |
| `add_note` | Create a standalone or child note |
| `add_tags` | Add tags to an item |
| `remove_tags` | Remove tags from an item |
| `create_collection` | Create a new collection or subcollection |
| `add_to_collection` | Add an item to a collection |
| `remove_from_collection` | Remove an item from a collection |
| `batch_tag` | Tag multiple items at once (max 100) |
| `batch_add_to_collection` | Add multiple items to a collection at once (max 100) |

Write tools are gated behind the **"Allow write operations"** checkbox in Zotero preferences (**Settings > Zotero MCP for Claude Code > MCP Server**). They only appear in the tool list when enabled.

## Plugin preferences

Configure in **Zotero > Settings > Zotero MCP for Claude Code**:

- **MCP Server** -- Enable/disable, port (default 23120), remote access, write operations
- **Client Configuration Generator** -- Generate config JSON for any supported AI client
- **MCP Content Settings** -- Content processing mode (minimal/preview/standard/complete/custom), max tokens
- **Semantic Search** -- Embedding provider (OpenAI, Ollama, etc.), model, dimensions, API key
- **Semantic Index** -- Build/rebuild/clear index, auto-update, progress monitoring

## Semantic search

The plugin supports AI-powered semantic search using embedding vectors:

1. Configure an embedding provider in preferences (OpenAI, Ollama, or any OpenAI-compatible API)
2. Build the index (indexes item titles, abstracts, and full text)
3. Use `semantic_search` for natural language queries or `find_similar` to find related items

The vector index is stored locally in SQLite with Int8 quantization for efficient storage.

## Development

### Prerequisites

- Zotero 7+
- Node.js 18+

### Setup

```bash
cd zotero-mcp-plugin
npm install
npm run build    # Production build
npm run start    # Dev mode with auto-reload
```

### Testing

```bash
npm run test:unit    # 37 unit tests (mathUtils, textChunker)
npm run lint:check   # Prettier + ESLint
```

### Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/mcp` | POST | MCP JSON-RPC requests |
| `/mcp` | GET | SSE event stream |
| `/mcp` | DELETE | Session termination |
| `/ping` | GET | Health check |
| `/mcp/status` | GET | Server status |
| `/capabilities` | GET | Server capabilities |

## Fork changes

This fork ([lricher7329/zotero-mcp-claude-code](https://github.com/lricher7329/zotero-mcp-claude-code)) adds the following on top of the upstream [cookjohn/zotero-mcp](https://github.com/cookjohn/zotero-mcp):

- **Claude Code compatibility** -- Proper request body reading, Accept header validation, DELETE method, notification handling, batch requests, multi-version protocol support
- **Write operations** -- 10 MCP write tools for creating items, notes, tags, and collections
- **Security hardening** -- ReDoS protection, request size limits, SQL injection fixes, rate limiting, strong session IDs
- **Codebase audit** -- Typed errors, API validation, singleton fixes, batched queries, module refactoring, 37 unit tests

## License

[MIT](./LICENSE)

## Acknowledgements

- [Zotero](https://www.zotero.org/) -- Open-source reference management
- [cookjohn/zotero-mcp](https://github.com/cookjohn/zotero-mcp) -- Original upstream project
- [Model Context Protocol](https://modelcontextprotocol.org/) -- The protocol standard
- [Zotero Plugin Template](https://github.com/windingwind/zotero-plugin-template) -- Plugin scaffolding
