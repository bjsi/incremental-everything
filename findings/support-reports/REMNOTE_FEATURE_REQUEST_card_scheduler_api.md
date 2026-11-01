# Feature request: let plugins read which scheduler a card uses

**From:** Hugo Marins, *Incremental RemNote* plugin (`incremental-everything`)
**Checked against:** RemNote desktop 1.29.1-beta (macOS), `@remnote/plugin-sdk` 0.0.46
**Date:** 2026-10-30

---

## The request

Please add a read-only way for plugins to get the Spaced Repetition Scheduler that applies to a Rem or card, including its type and settings.

## Why plugins need it

Any plugin that shows or analyses memory data has to replay a card's history with the right scheduler. RemNote lets users assign different schedulers to different documents, but a plugin can't find out which one applies, so it has to treat every card as if it used a single set of FSRS weights. On every other card, its figures are silently wrong.

Measured on one real knowledge base with 41,691 practised cards:

| Scheduler | Practised cards | Plugin's result with the Global scheduler's weights |
|---|---|---|
| Global Default (FSRS) | 37,494 | Matches RemNote within 0.001% |
| Vocabulary (FSRS, different weights) | 600 | Median stability 2.36 times RemNote's; 3.4% of cards within 5% |
| Questions (Anki SM-2) | 3,597 | No meaningful figure, because SM-2 has no stability |

The match on Global cards shows the plugin's calculations are right. Those are the same calculations that go wrong on the other cards, simply because the scheduler is unknown.

It also affects bulk analysis: a plugin can't tell which cards to leave out of its retention and calibration statistics.

## What plugins can see today

- **Rem objects:** `mapRemToPluginInterface` returns only `_id`, `owner`, `createdAt`, `parent`, `type`, `u`, `children`, `text` and `backText`, so the Rem's `src` field never arrives.
- **Card objects:** the card mapper has no scheduler field.
- **`plugin.scheduler`:** it only offers `registerCustomScheduler`, with no way to read a scheduler.
- **Knowledge base data:** the Global Default Scheduler's id and settings aren't available either.

## Why this should be a small change

RemNote already has the answer on the host side. `rem.getSpacedRepetitionScheduler()` resolves the nearest ancestor with a scheduler through the in-memory graph (`get_spaced_repetition_scheduler_source_rem`), caches it, and falls back to the Global Default. The queue already calls this for each card it shows, so this mainly means exposing it through the plugin bridge.

## Suggested API

Names are only suggestions:

```ts
interface SchedulerInfo {
  _id: string;
  name: string;
  type: 'fsrs' | 'sm2' | 'plugin' | string;
  isGlobalDefault: boolean;
  // FSRS only; null weights mean RemNote's defaults
  weights?: number[] | null;
  targetRetention?: number;
  learningSteps?: string;
  relearningSteps?: string;
  maximumInterval?: number;
}

// One Rem. The same rule RemNote uses, including the Global Default fallback.
rem.getSpacedRepetitionScheduler(): Promise<SchedulerInfo>;

// Every scheduler in the knowledge base.
plugin.scheduler.getAll(): Promise<SchedulerInfo[]>;

// Many Rems at once, returning remId -> scheduler id.
plugin.scheduler.getIdsForRems(remIds: RemId[]): Promise<Record<RemId, string>>;
```

**The batch call matters most for analytics.** Without it, a plugin needs one call per Rem, which is impractical across tens of thousands of cards. Adding a `schedulerId` field to the card objects from `plugin.card.getAll()` would work just as well.

If only part of this is possible, the most useful minimum is the scheduler id for each card, plus a read of the schedulers' type and settings.

## Current workaround and its limits

We ship a Python script that reads `src` and the `spaced_repetition_scheduler` table from the local `remnote.db`, and the user imports the result into the plugin. It works, but:

- It needs a computer with the desktop app and Python, so most users won't use it.
- The list goes stale: new cards under another scheduler count as Global until the user runs it again.
- It depends on an internal database layout that can change without notice.

An API call would remove the need for all of this.
