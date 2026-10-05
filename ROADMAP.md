# Zotero MCP for Claude Code — Roadmap

> Living plan and current development state. Updated as milestones progress.
> Workflow: project-workflow skill (`~/.claude/skills/coding/skills/project-workflow/SKILL.md`).
> Status legend: `[ ]` planned · `[~]` in progress · `[x]` complete.

## Current State

- **Tier:** C — Direct (solo tooling; remote CI is the tag-triggered release workflow only)
- **Local check:** `cd zotero-mcp-plugin && npm run check` (Prettier + ESLint, build + `tsc`, Mocha unit tests in Node)
  (`npm test` is scaffold's in-Zotero runner; it launches a second Zotero and is not part of the gate)
- **Released:** v1.8.7 (2026-10-05), verified live on Zotero 10.0.5 / Firefox 140 ESR
- **Active milestone:** none — between milestones
- **Branch:** `main`
- **Next step:** decide whether to release M2 as v1.8.8 (annotation-order fix is user-visible); then M3 scoping
- **Updated:** 2026-10-05

## Milestones

### M1 — Zotero 10 compatibility  `[x] complete`
Branch: `main` · Merged: 2026-10-05 · Release: v1.8.7
- [x] Phase 1.1 — Raise `strict_max_version` to `10.*` (manifest, `prepare-release.js`, `update.json`, `update-beta.json`)
- [x] Phase 1.2 — Replace removed `OS.File.stat` with `IOUtils.stat` in `itemFormatter.ts`
- [x] Phase 1.3 — Update compatibility docs (README, CLAUDE.md files, AUTO_UPDATE_GUIDE)
- [x] Phase 1.4 — Release v1.8.7; verify port 23120, `initialize`, `search_library`, `get_item_details` on Zotero 10.0.5

### M2 — Tooling refresh  `[x] complete`
Branch: `main` (worked in `claude/plugin-version-check-6fff38` worktree) · Merged: 2026-10-05
- [x] Phase 2.1 — `zotero-plugin-scaffold` 0.8.0 → 0.9.2, `zotero-types` beta → 4.1.3, `zotero-plugin-toolkit` beta → 6.0.0 (`ZoteroToolkit` now imported from `zotero-plugin-toolkit/ztoolkit`; 6.0 drops Prompt manager / plugin + debug bridges / toolkit global — none were used); stricter types surfaced a real bug — `annotationSortIndex` is a zero-padded string, was sorted as a number (NaN / string concatenation) — fixed with regression tests
- [x] Phase 2.2 — Local tests: `npm run test:unit` (Mocha + tsx in Node, mocked Zotero globals) is the runnable suite; scaffold's `npm test` stays out of the gate
- [x] Phase 2.3 — `npm run check` = lint + build/type check + unit tests; release workflow now runs unit tests and uses Node 24 (scaffold 0.9 requires Node ≥ 22.8)
- [x] Phase 2.4 — Root-level docs deliberately left outside the Prettier gate (formatting them is ~200 lines of table-alignment churn); plugin lint scope is `zotero-mcp-plugin/` only
- [x] Phase 2.5 — Smoke-tested on Zotero 10.0.5: `initialize`, `tools/list` (50), `get_annotations` order matches DB `sortIndex`
- [x] Phase 2.6 — Disable closes port 23120 and re-enable restores it (shutdown path OK). The orphaned server seen 2026-10-05 13:35 came from reinstalling over the same version with the old build; not retested — revisit only if it recurs

### M3 — Write operations via Zotero web API  `[ ] planned`
- [ ] Phase 3.1 — Scope: which write tools benefit from the web API vs. the local plugin API (from `IDEAS.md`)

## Detail Documents

- [README.md](README.md) — install, client setup, tools, auth, write scopes
- [AUTO_UPDATE_GUIDE.md](AUTO_UPDATE_GUIDE.md) — Zotero auto-update manifest and release assets
- [zotero-mcp-plugin/CLAUDE.md](zotero-mcp-plugin/CLAUDE.md) — release process and version-file checklist
- [IDEAS.md](IDEAS.md) — unscoped ideas backlog

## Changelog

- 2026-10-05 — ROADMAP created; M1 (Zotero 10 compatibility) complete, v1.8.7 released
- 2026-10-05 — M2 started; phases 2.1–2.4 done, Zotero 10 smoke test pending
- 2026-10-05 — M2 complete (toolkit 6.0.0, scaffold 0.9.2, `npm run check`, annotation-order fix); landed on `main`
