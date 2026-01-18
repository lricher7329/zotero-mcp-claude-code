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

## Available Skills
- `release` - Automate version bump and GitHub release process

## Build Commands
```bash
npm run build      # Production build
npm run start      # Development with hot reload
```

## Important Patterns

### Preferences
- Prefix: `extensions.zotero.zotero-mcp-plugin`
- Defined in `addon/content/preferences.xhtml`
- Accessed via `Zotero.Prefs.get/set`

### Localization
- English: `addon/locale/en-US/preferences.ftl`
- Chinese: `addon/locale/zh-CN/preferences.ftl`

### Release Workflow
See `.claude/skills/release.md` for automated release process.

## Code Style
- Use ztoolkit.log for logging
- Follow existing patterns in codebase
- Chinese comments are acceptable
