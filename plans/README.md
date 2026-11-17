# Plans

Working documents for multi-step efforts that span several releases. Maintainer notes, not published: the docs site is built from `docs/` only.

| File | Effort |
|---|---|
| [AI_STUDY_TOOLS_PLAN.md](AI_STUDY_TOOLS_PLAN.md) | AI study tools: transcription, source pins, summaries and Q&A from part of a source |
| [COMPANION_EXTENSION_PLAN.md](COMPANION_EXTENSION_PLAN.md) | A Chrome extension for incremental reading of web pages, working with the plugin |
| [INCREMENTAL_VIDEO_PLAN.md](INCREMENTAL_VIDEO_PLAN.md) | Plugin player ⇄ RemNote player for YouTube IncRems: rebuilding the plugin player on Embed Website, Review in Editor with PaneHeader controls, extracts from either player |
| [STORAGE_PLAN.md](STORAGE_PLAN.md) | Reducing what the plugin keeps in RemNote's synced storage |

## Implemented

Finished plans, moved to [`implemented/`](implemented/). They are kept for their decisions and the reasons behind them; the user-facing result is in `docs/` and the changelog.

| File | Effort | Shipped |
|---|---|---|
| [SEARCH_ENGINE_PLAN.md](implemented/SEARCH_ENGINE_PLAN.md) | An Anki-style query language run by the AI helper on remnote.db: AND/OR/NOT, scopes, tags, slots, cards, suppression causes, FSRS S/D/R per card's scheduler; Search & Browse with ✨ AI | v1.0.231 |
| [HISTORY_ARCHIVE_PLAN.md](implemented/HISTORY_ARCHIVE_PLAN.md) | A desktop helper that archives the review history of deleted cards and IncRems (and where they lived in the tree), so the Study Dashboard keeps counting it | v1.0.217 |

## Conventions

A plan says at the top what it is for and when it was last updated, keeps its decisions next to the reasons for them, and tracks its phases with checkboxes, so work can resume without re-deriving anything.

When a plan is finished, mark it implemented at the top, with the version it shipped in, and move it to `implemented/` with `git mv`. List it in the Implemented table and update any references to its path in code and docs. What was learned about RemNote along the way goes to [`findings/`](../findings/).
