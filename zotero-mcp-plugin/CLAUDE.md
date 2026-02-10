# Zotero MCP Plugin

## Project Overview

A Zotero plugin that provides MCP (Model Context Protocol) server functionality, enabling AI assistants to interact with Zotero's library data.

## Tech Stack

- TypeScript
- Zotero Plugin API (Firefox/Gecko-based)
- zotero-plugin-scaffold for building
- SQLite for semantic search index

## Key Directories

- `src/` - TypeScript source code
- `addon/` - Plugin assets (manifest, locales, preferences UI)
- `.scaffold/build/` - Build output
- `update.json` - Zotero auto-update manifest

## Build Commands

```bash
npm run build      # Production build
npm run start      # Development with hot reload
npm run lint:check # Check formatting and linting
npm run lint:fix   # Fix formatting and linting issues
```

## Release Process

A GitHub Actions workflow at `/.github/workflows/release.yml` automates releases. Pushing a version tag triggers it.

### Steps

1. Bump version in three files:
   - `package.json` — `"version": "X.Y.Z"`
   - `src/modules/httpServer.ts` — `version: "X.Y.Z"` in serverInfo
   - `update.json` — add new entry with version and update_link
2. Update lockfile: `npm install --package-lock-only`
3. Verify build: `npm run build`
4. Commit, tag, and push:
   ```bash
   git add package.json package-lock.json src/modules/httpServer.ts update.json
   git commit -m "chore: bump version to X.Y.Z"
   git tag vX.Y.Z
   git push origin main --tags
   ```
5. GitHub Actions builds the XPI and creates the release with `zotero-mcp-for-claude-code.xpi` and `update.json` as assets.

### Version files summary

| File | Field | Purpose |
|------|-------|---------|
| `package.json` | `version` | npm/build version, used by scaffold |
| `src/modules/httpServer.ts` | `serverInfo.version` | Reported in `/capabilities` endpoint |
| `update.json` | `updates[]` entry | Zotero auto-update manifest (append, don't replace) |

## Important Patterns

### Preferences

- Prefix: `extensions.zotero.zotero-mcp-plugin`
- Defined in `addon/content/preferences.xhtml`
- Accessed via `Zotero.Prefs.get/set`

### Localization

- English: `addon/locale/en-US/preferences.ftl`
- Chinese: `addon/locale/zh-CN/preferences.ftl`

## Code Style

- Use ztoolkit.log for logging
- Follow existing patterns in codebase
- Use English for all comments and code documentation
- Chinese locale files in `addon/locale/zh-CN/` are for UI translations only
- Chinese stop word lists in NLP code are functional data and should remain
