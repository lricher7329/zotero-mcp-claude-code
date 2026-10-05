# Zotero MCP for Claude Code — Roadmap

> Living plan and current development state. Updated as milestones progress.
> Workflow: project-workflow skill (`~/.claude/skills/coding/skills/project-workflow/SKILL.md`).
> Status legend: `[ ]` planned · `[~]` in progress · `[x]` complete.

## Current State

- **Tier:** C — Direct (solo tooling; remote CI is the tag-triggered release workflow only)
- **Local check:** `cd zotero-mcp-plugin && npm run lint:check && npm run build`
  (`npm test` needs a Zotero binary path configured for zotero-plugin-scaffold — see M2)
- **Released:** v1.8.7 (2026-10-05), verified live on Zotero 10.0.5 / Firefox 140 ESR
- **Active milestone:** none — between milestones
- **Branch:** `main`
- **Next step:** start M2 — bump `zotero-plugin-scaffold` 0.8.0 → 0.9.2 and get `npm test` running locally
- **Updated:** 2026-10-05

## Milestones

### M1 — Zotero 10 compatibility  `[x] complete`
Branch: `main` · Merged: 2026-10-05 · Release: v1.8.7
- [x] Phase 1.1 — Raise `strict_max_version` to `10.*` (manifest, `prepare-release.js`, `update.json`, `update-beta.json`)
- [x] Phase 1.2 — Replace removed `OS.File.stat` with `IOUtils.stat` in `itemFormatter.ts`
- [x] Phase 1.3 — Update compatibility docs (README, CLAUDE.md files, AUTO_UPDATE_GUIDE)
- [x] Phase 1.4 — Release v1.8.7; verify port 23120, `initialize`, `search_library`, `get_item_details` on Zotero 10.0.5

### M2 — Tooling refresh  `[ ] planned`
- [ ] Phase 2.1 — Bump `zotero-plugin-scaffold` 0.8.0 → 0.9.2; re-check `zotero-plugin-toolkit` / `zotero-types` for Zotero 10 / Firefox 140 support
- [ ] Phase 2.2 — Make `npm test` runnable locally (configure Zotero binary path for scaffold; currently fails with "No Zotero Found")
- [ ] Phase 2.3 — Fold `npm test` into the local check above once it runs
- [ ] Phase 2.4 — Bring root-level docs (README, AUTO_UPDATE_GUIDE) under Prettier, or exclude them deliberately

### M3 — Write operations via Zotero web API  `[ ] planned`
- [ ] Phase 3.1 — Scope: which write tools benefit from the web API vs. the local plugin API (from `IDEAS.md`)

## Detail Documents

- [README.md](README.md) — install, client setup, tools, auth, write scopes
- [AUTO_UPDATE_GUIDE.md](AUTO_UPDATE_GUIDE.md) — Zotero auto-update manifest and release assets
- [zotero-mcp-plugin/CLAUDE.md](zotero-mcp-plugin/CLAUDE.md) — release process and version-file checklist
- [IDEAS.md](IDEAS.md) — unscoped ideas backlog

## Changelog

- 2026-10-05 — ROADMAP created; M1 (Zotero 10 compatibility) complete, v1.8.7 released
