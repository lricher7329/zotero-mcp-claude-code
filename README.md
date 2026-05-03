# Zotero MCP for Claude Code

A Zotero plugin that exposes your library to AI assistants via the [Model Context Protocol](https://modelcontextprotocol.org/) (MCP). This fork adds Claude Code compatibility and write operations.

[![GitHub](https://img.shields.io/badge/GitHub-zotero--mcp--claude--code-blue?logo=github)](https://github.com/lricher7329/zotero-mcp-claude-code)
[![Zotero](https://img.shields.io/badge/Zotero-7--9-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Version](https://img.shields.io/badge/Version-1.8.2-brightgreen)]()
[![License](https://img.shields.io/badge/License-MIT-yellow)](./LICENSE)

> **Note:** This fork has been developed and tested with **Claude Code** on **Zotero 7–9 for macOS** (latest macOS). The plugin manifest declares compatibility with Zotero 7, 8, and 9. It uses standard MCP over Streamable HTTP, so it should work with any MCP-compatible client and platform, but other clients and operating systems have not been tested by this fork's author.

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

If you've enabled **Require auth token on local connections** (or **Allow remote access** — which forces auth regardless), copy the token from the prefs UI and add it as a header:

```json
{
  "mcpServers": {
    "zotero-mcp": {
      "type": "http",
      "url": "http://127.0.0.1:23120/mcp",
      "headers": {
        "Authorization": "Bearer zmcp_<your-token>"
      }
    }
  }
}
```

See [Authentication](#authentication) below.

### 3. Verify

```bash
claude mcp list
```

You should see `zotero-mcp` with the available tools listed.

## Supported clients

| Client | Connection | Tested |
|--------|-----------|--------|
| **Claude Code** | Native HTTP MCP (recommended) | Yes |
| **Claude Desktop** | Streamable HTTP via mcp-remote | No |
| **Cursor IDE** | Streamable HTTP via mcp-remote | No |
| **Cherry Studio** | Native Streamable HTTP | No |
| **Gemini CLI** | Native HTTP MCP | No |
| **Cline (VS Code)** | Streamable HTTP via mcp-remote | No |
| **Continue.dev** | Streamable HTTP via mcp-remote | No |
| **Qwen Code** | Native HTTP MCP | No |
| **Chatbox** | Streamable HTTP via mcp-remote | No |
| **Trae AI** | Streamable HTTP via mcp-remote | No |

The plugin preferences include a **Client Configuration Generator** that produces ready-to-use config for each client.

## MCP tools (36 total)

### Read tools (21 — always available)

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
| `get_tags` | List all tags with optional filtering |
| `get_related_items` | Get items linked via Zotero's Related feature |
| `generate_bibliography` | Generate formatted citations using Zotero's citation engine |
| `search_by_identifier` | Find library items by DOI, ISBN, or PMID |
| `get_library_stats` | Library summary: item counts by type, tag/collection/trash counts |
| `get_item_types` | List all valid Zotero item types with localized names |
| `get_creator_types` | List valid creator types, optionally filtered by item type |
| `get_item_type_fields` | List valid fields for a given item type |
| `get_trash_items` | List items in the trash with pagination |
| `get_recently_modified` | Get items modified within N days |
| `semantic_search` | AI-powered semantic search using embedding vectors |
| `find_similar` | Find items similar to a given item |
| `semantic_status` | Check semantic index status |
| `fulltext_database` | Query the full-text content cache (list, search, get, stats) |

### Write tools (15 — when enabled in preferences)

| Tool | Description |
|------|-------------|
| `create_item` | Create a new library item with fields, creators, tags, collections |
| `update_item` | Update fields and creators on an existing item |
| `add_note` | Create a standalone or child note |
| `update_note` | Update an existing note's content and tags |
| `trash_item` | Move an item to the trash |
| `add_tags` | Add tags to an item |
| `remove_tags` | Remove tags from an item |
| `rename_tag` | Rename a tag across all items in the library |
| `delete_tag` | Delete a tag from the entire library |
| `create_collection` | Create a new collection or subcollection |
| `rename_collection` | Rename a collection |
| `delete_collection` | Delete a collection (items optionally deleted) |
| `move_collection` | Move a collection to a new parent or root |
| `add_to_collection` | Add an item to a collection |
| `remove_from_collection` | Remove an item from a collection |
| `move_item_to_collection` | Atomically move an item between collections |
| `add_related_item` | Create a bidirectional Related link between items |
| `remove_related_item` | Remove a Related link between items |
| `import_attachment_url` | Import a file from a URL as an attachment |
| `batch_tag` | Tag multiple items at once (max 100) |
| `batch_add_to_collection` | Add multiple items to a collection (max 100) |
| `batch_remove_from_collection` | Remove multiple items from a collection (max 100) |
| `batch_trash` | Trash multiple items at once (max 100) |
| `restore_from_trash` | Restore a trashed item back to the library |

Write tools are gated by **per-scope opt-in checkboxes** in preferences (see [Write scopes](#write-scopes) below). Tools whose scopes are disabled are hidden from the `tools/list` response — they don't just fail-on-call, they don't exist as far as the client can see.

## Authentication

The plugin auto-generates a per-install bearer token on first start, stored in the `extensions.zotero.zotero-mcp-plugin.mcp.server.authToken` preference and surfaced in **Settings → Zotero MCP for Claude Code → MCP Server → Authentication** with **Copy** and **Regenerate** buttons.

| Pref | Default | Behavior |
|---|---|---|
| `mcp.server.allowRemote` | `false` | When `true`, listener binds `0.0.0.0` and **auth is mandatory** regardless of `requireAuth` |
| `mcp.server.requireAuth` | `false` | When `true`, loopback callers must also present the token |

When auth is required, send the token via either:

```http
Authorization: Bearer zmcp_<48-hex-chars>
```

or

```http
X-Zotero-MCP-Token: zmcp_<48-hex-chars>
```

`X-Zotero-MCP-Token` exists for browser-extension callers that can't set `Authorization`. Both headers force a CORS preflight, defeating drive-by simple-form CSRF.

Loopback default (no auth) keeps existing client configs working out of the box. Public-facing or shared-machine setups should enable `requireAuth`. The `/ping`, `/capabilities`, `/help`, `/mcp/status`, and `GET /mcp` endpoints stay open even when auth is on, so health checks and config generators don't need credentials.

**Regenerating the token** invalidates every existing client config — clients will get 401 until you update them.

### Defense-in-depth checks (always on)

These run regardless of auth state:

- `Origin: null` (sandboxed iframes, `file://`, cross-origin redirects) is rejected
- `POST /mcp` requires `Content-Type: application/json` (defeats `text/plain` CSRF via simple form POST)
- `Host` header must be loopback when `allowRemote=false`
- Duplicate `Host` headers rejected
- `Mcp-Session-Id` validated against `^mcp-[a-f0-9-]{8,80}$` and capped at 256 active sessions with LRU eviction
- Global + per-IP + per-session token-bucket rate limits, with a stricter bucket on write tools
- 10s wall-clock deadline on full request body read
- `Content-Length > 1MB` rejected before reading

## Write scopes

`mcp.write.enabled` (single boolean) was replaced in v1.8.0 by **seven granular scopes**. A tool is only exposed in `tools/list` when **every scope it requires** is enabled.

| Scope pref | Tools |
|---|---|
| `mcp.write.notes` | `add_note`, `update_note` |
| `mcp.write.tags` | `add_tags`, `remove_tags` |
| `mcp.write.collections` | `add_to_collection`, `remove_from_collection`, `create_collection`, `rename_collection`, `move_collection`, `move_item_to_collection` |
| `mcp.write.metadata` | `create_item`, `update_item`, `add_related_item`, `remove_related_item` |
| `mcp.write.delete` ⚠ | `trash_item`, `restore_from_trash`, `delete_collection` |
| `mcp.write.bulk` ⚠ | (combined with another scope on bulk operations — see below) |
| `mcp.write.import` ⚠ | `import_attachment_url` (SSRF risk) |

Scopes marked ⚠ are destructive and default to off. Multi-scope tools require **all** listed scopes:

| Tool | Scopes required |
|---|---|
| `batch_tag` | `bulk` + `tags` |
| `batch_add_to_collection` | `bulk` + `collections` |
| `batch_remove_from_collection` | `bulk` + `collections` |
| `batch_trash` | `bulk` + `delete` |
| `delete_tag` | `delete` + `bulk` (library-wide) |
| `rename_tag` | `tags` + `bulk` (library-wide rewrite) |
| `delete_collection` with `deleteItems: true` | `delete` + `bulk` |

### Migration from `mcp.write.enabled`

On first run after upgrading from v1.7.0 or earlier:

- If the legacy `mcp.write.enabled` was `true`, the safe scopes (`notes`, `tags`, `collections`, `metadata`) migrate **on**; the destructive scopes (`delete`, `bulk`, `import`) stay **off**. Re-enable them deliberately if you need them.
- If `mcp.write.enabled` was unset or `false`, all scopes default to off.

### Reading scope state programmatically

```js
Zotero.Prefs.get("extensions.zotero.zotero-mcp-plugin.mcp.write.metadata", true)
// → true | false | undefined
```

The same pref keys appear in `~/Library/Application Support/Zotero/Profiles/<profile>/prefs.js`.

## Plugin preferences

Configure in **Zotero > Settings > Zotero MCP for Claude Code**:

- **MCP Server** -- Enable/disable, port (default 23120), remote access
- **Authentication** -- Bearer token (Copy / Regenerate), require-auth-on-loopback toggle
- **Write Scopes** -- Per-scope opt-in (notes, tags, collections, metadata, delete, bulk, import)
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

- Zotero 7, 8, or 9
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

| Endpoint | Method | Purpose | Auth required when `requireAuth=true` |
|----------|--------|---------|---|
| `/mcp` | POST | MCP JSON-RPC 2.0 requests | yes |
| `/mcp` | GET | Endpoint info (JSON) | no |
| `/mcp` | DELETE | Session termination (per MCP 2025-03-26 spec) | no |
| `/ping` | GET | Health check (returns `pong`) | no |
| `/mcp/status` | GET | Server status | no |
| `/capabilities` | GET | Server capabilities (also at `/help`, `/mcp/capabilities`) | no |

**Protocol versions supported:** `2024-11-05` and `2025-03-26` (negotiated via `initialize`).

## Fork changes

This fork ([lricher7329/zotero-mcp-claude-code](https://github.com/lricher7329/zotero-mcp-claude-code)) adds the following on top of the upstream [cookjohn/zotero-mcp](https://github.com/cookjohn/zotero-mcp):

- **Claude Code compatibility** -- Proper request body reading, Accept header validation, DELETE method, notification handling, batch requests, dual protocol version support (`2024-11-05` + `2025-03-26`)
- **Write operations** -- ~24 MCP write tools for creating/updating items, notes, tags, collections, relations, and attachments, plus batch operations and trash management — all gated by per-scope opt-ins
- **Library introspection** -- Schema discovery tools (item types, creator types, field lists), library stats, trash listing, recently modified items
- **Security hardening (v1.8.0)** -- Per-install bearer token auth; Origin/Content-Type CSRF protection; per-scope write opt-ins (destructive ops default off); global + per-IP + per-session rate limits; SSRF guard with IPv6-mapped-IPv4 and decimal/octal IPv4 detection; itemKey/collectionKey format validation; session ID hardening with LRU cap; body-read deadline; sanitized error messages
- **MCP/JSON-RPC compliance fixes (v1.8.0)** -- Tool execution failures returned as `result.isError` (LLM can recover) rather than `-32603`; argument validation maps to `-32602`; parse-error `id: null` per spec; `notifications/initialized` correct; empty batch returns `-32600`; dropped false `tools.listChanged` advertisement
- **`get_item_details` mode=complete** -- Now enumerates all item-type fields via `Zotero.ItemFields.getItemTypeFields`, including `extra` (PMID/PMCID/citation key per Zotero convention), `collections` membership, `dateAdded`/`dateModified`/`accessDate`. Critical for downstream identifier extraction.
- **Codebase audit** -- Typed errors, API validation, singleton fixes, batched queries, module refactoring, 37 unit tests

## License

[MIT](./LICENSE)

## Acknowledgements

- [Zotero](https://www.zotero.org/) -- Open-source reference management
- [cookjohn/zotero-mcp](https://github.com/cookjohn/zotero-mcp) -- Original upstream project
- [Model Context Protocol](https://modelcontextprotocol.org/) -- The protocol standard
- [Zotero Plugin Template](https://github.com/windingwind/zotero-plugin-template) -- Plugin scaffolding
