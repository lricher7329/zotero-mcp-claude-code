# Zotero MCP for Claude Code — Roadmap

> Living plan and current development state. Updated as milestones progress.
> Workflow: project-workflow skill (`~/.claude/skills/coding/skills/project-workflow/SKILL.md`).
> Status legend: `[ ]` planned · `[~]` in progress · `[x]` complete.

## Current State

- **Tier:** C — Direct (solo tooling; remote CI is the tag-triggered release workflow only)
- **Local check:** `cd zotero-mcp-plugin && npm run check` (Prettier + ESLint, build + `tsc`, Mocha unit tests in Node)
  (`npm test` is scaffold's in-Zotero runner; it launches a second Zotero and is not part of the gate)
- **Released:** v1.8.10 (2026-10-08) — per-session rate limits on loopback, reconnect reserve, global burst 120 → 240. Before that, v1.8.9 (2026-10-05) — M3 Zotero 10 native features; includes M2 (v1.8.8 tag was never published: GitHub Actions outage). v1.8.7 added Zotero 10 support
- **Active milestone:** none — between milestones
- **Branch:** `main`
- **Next step:** none queued. Candidates: improve `get_content` sentence selection on PDFs (picks emails/table refs); M4 stays deferred
- **Updated:** 2026-10-08

## Milestones

### M1 — Zotero 10 compatibility  `[x] complete`
Branch: `main` · Merged: 2026-10-05 · Release: v1.8.7
- [x] Phase 1.1 — Raise `strict_max_version` to `10.*` (manifest, `prepare-release.js`, `update.json`, `update-beta.json`)
- [x] Phase 1.2 — Replace removed `OS.File.stat` with `IOUtils.stat` in `itemFormatter.ts`
- [x] Phase 1.3 — Update compatibility docs (README, CLAUDE.md files, AUTO_UPDATE_GUIDE)
- [x] Phase 1.4 — Release v1.8.7; verify port 23120, `initialize`, `search_library`, `get_item_details` on Zotero 10.0.5

### M2 — Tooling refresh  `[x] complete`
Branch: `main` (worked in `claude/plugin-version-check-6fff38` worktree) · Merged: 2026-10-05 · Release: v1.8.8
- [x] Phase 2.1 — `zotero-plugin-scaffold` 0.8.0 → 0.9.2, `zotero-types` beta → 4.1.3, `zotero-plugin-toolkit` beta → 6.0.0 (`ZoteroToolkit` now imported from `zotero-plugin-toolkit/ztoolkit`; 6.0 drops Prompt manager / plugin + debug bridges / toolkit global — none were used); stricter types surfaced a real bug — `annotationSortIndex` is a zero-padded string, was sorted as a number (NaN / string concatenation) — fixed with regression tests
- [x] Phase 2.2 — Local tests: `npm run test:unit` (Mocha + tsx in Node, mocked Zotero globals) is the runnable suite; scaffold's `npm test` stays out of the gate
- [x] Phase 2.3 — `npm run check` = lint + build/type check + unit tests; release workflow now runs unit tests and uses Node 24 (scaffold 0.9 requires Node ≥ 22.8)
- [x] Phase 2.4 — Root-level docs deliberately left outside the Prettier gate (formatting them is ~200 lines of table-alignment churn); plugin lint scope is `zotero-mcp-plugin/` only
- [x] Phase 2.5 — Smoke-tested on Zotero 10.0.5: `initialize`, `tools/list` (50), `get_annotations` order matches DB `sortIndex`
- [x] Phase 2.6 — Disable closes port 23120 and re-enable restores it (shutdown path OK). The orphaned server seen 2026-10-05 13:35 came from reinstalling over the same version with the old build; not retested — revisit only if it recurs

### M3 — Zotero 10 native features  `[x] complete`
Branch: `main` (worked in `claude/plugin-version-check-6fff38` worktree) · Merged: 2026-10-05 · Release: v1.8.9. All features detect Zotero 10 at runtime; Zotero 7–9 keep current behaviour.
- [x] Phase 3.1 — Full text on Zotero 10: `Zotero.Fulltext.getItemContent` was removed, so PDF text silently fell back to a 30 s extraction that timed out (`get_content`, `search_fulltext`). Now reads Zotero's `.zotero-ft-cache` via `getItemCacheFile` (Zotero 7–10); library-wide `search_fulltext` narrows candidates with Zotero's search index instead of scanning 1,000 items (live: 9.5 s, was > 60 s). Real text then exposed a cubic-time sentence scorer (`intelligentContentProcessor` TF-IDF/TextRank): `get_content` on a 200 KB paper took 130 s; rewritten to tokenize once and precompute row sums — 0.6 s in Node, ~98% same output, perf regression test added. Live on Zotero 10.0.5: `get_content` 1.1 s (all 202,771 chars), `search_fulltext` per-item and library-wide 0.0–0.1 s
- [x] Phase 3.2 — Undoable MCP writes: label saves with Zotero's own `undo-action-*` messages (`undoSupport.ts`) so edits, tags, collection moves, related items, restore, and replace-trash can be undone with Cmd/Ctrl+Z; batches are one undo step. Creates and permanent deletes stay non-undoable (Zotero limitation). Live: `add_tags` via MCP, then Cmd+Z in Zotero removed the tag
- [x] Phase 3.3 — Richer `search_library`: structured `conditions` tree → Zotero 10 condition groups (`groupStart`/`groupEnd` + per-group `joinMode`, optional group `resultLevel`), top-level `resultLevel`, `isEmpty`/`isNotEmpty` (`searchConditions.ts`). Wrapped in one group so it never changes how other filters combine; Zotero 7–9 accept a flat all-joined list and reject the rest with "requires Zotero 10"; bad input → MCP invalid-params. Live on Zotero 10.0.5 (all < 0.2 s): `isEmpty` abstract (1,422), `numAnnotations > 0`, same-annotation group (yellow + text → 1, wrong colour → 0), any-group, `resultLevel` annotation/attachment, invalid operator → -32602. Child results now carry `itemType`, annotation text/colour/page, and parent item key/title (were "No Title") — verified live
- [x] Phase 3.4 — Released v1.8.9 (3.1–3.3 plus everything from the unpublished v1.8.8)

### M4 — Write operations via Zotero web API  `[ ] deferred`
- Deferred 2026-10-05: only pays off for writes while Zotero is closed, unsynced group libraries, or remote machines — none needed now. Zotero 10's local API writes (port 23119) don't cover those cases either (Zotero must run; loopback only)

## Detail Documents

- [README.md](README.md) — install, client setup, tools, auth, write scopes
- [AUTO_UPDATE_GUIDE.md](AUTO_UPDATE_GUIDE.md) — Zotero auto-update manifest and release assets
- [zotero-mcp-plugin/CLAUDE.md](zotero-mcp-plugin/CLAUDE.md) — release process and version-file checklist
- [IDEAS.md](IDEAS.md) — unscoped ideas backlog

## Changelog

- 2026-10-05 — ROADMAP created; M1 (Zotero 10 compatibility) complete, v1.8.7 released
- 2026-10-05 — M2 started; phases 2.1–2.4 done, Zotero 10 smoke test pending
- 2026-10-05 — M2 complete (toolkit 6.0.0, scaffold 0.9.2, `npm run check`, annotation-order fix); landed on `main`; released as v1.8.8
- 2026-10-05 — M3 redefined as Zotero 10 native features (fulltext fix, undoable writes, richer search); web-API writes moved to M4 (deferred)
- 2026-10-05 — M3 complete (fulltext on Zotero 10, sentence-scoring speed-up, undoable writes, structured search); released as v1.8.9. v1.8.8 left tagged but unreleased
- 2026-10-05 — Claude Desktop verified end to end with v1.8.9 via `mcp-remote` (stdio bridge; Custom Connectors can't reach localhost); README row → Tested: Yes, setup section added
