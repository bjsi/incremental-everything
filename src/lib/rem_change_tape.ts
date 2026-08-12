// lib/rem_change_tape.ts
//
// A rolling tape of the remIds GlobalRemChanged has fired for, so the debug
// widget can see raw events it cannot observe from inside a popup.
//
// WHAT IT IS FOR
//
// The card-priority cache could be persisted across sessions instead of rebuilt
// from ~135,000 slot reads every launch, if there were a reliable signal for
// "this rem's priority changed while we were away". `rem.updatedAt` is free in
// the taggedRem() payload but does NOT move when a user hand-edits the Priority
// property row — measured, see lib/updated_at_probe.ts — because that edit
// changes a CHILD rem.
//
// The fallback is a dirty-set fed by the GlobalRemChanged listener. For that to
// work, the event must let us name the TAGGED rem, not just the property child.
// This tape answers that empirically: hand-edit a priority, then read back which
// remIds actually fired and what each one is.
//
// WHY A TAPE AND NOT A LOG
//
// Making the edit requires closing the debug popup, so nothing observed from
// inside the widget survives to be read. And console output cannot be correlated
// with the enrichment (is this rem tagged? does it have cards? who is its
// parent?) that makes the answer legible.
//
// COST
//
// Recording is an array push into a module-level ring buffer — no IPC, nothing
// awaited, safe on a path that fires thousands of times. The buffer is flushed
// to session storage on a time throttle, so the write rate is bounded at one per
// FLUSH_INTERVAL_MS regardless of event volume, and only while events are
// actually arriving.

import { RNPlugin } from '@remnote/plugin-sdk';

export const REM_CHANGE_TAPE_KEY = 'debug-rem-change-tape';

/** Entries kept. Old ones fall off the front. */
const MAX_ENTRIES = 150;
/** At most one session write per this interval, however many events arrive. */
const FLUSH_INTERVAL_MS = 1500;

export interface RemChangeEntry {
  remId: string;
  at: number;
}

let tape: RemChangeEntry[] = [];
let lastFlush = 0;
let flushPending = false;

/**
 * Records one event. Synchronous and non-throwing by construction: this runs on
 * the GlobalRemChanged hot path, where an await or a throw would be felt.
 */
export function recordRemChangeEvent(plugin: RNPlugin, remId: string): void {
  tape.push({ remId, at: Date.now() });
  if (tape.length > MAX_ENTRIES) tape = tape.slice(-MAX_ENTRIES);
  scheduleFlush(plugin);
}

/**
 * Throttled flush WITH a trailing edge.
 *
 * The leading-edge-only version of this dropped the tail: it flushed when a new
 * event arrived and the interval had expired, so the last event of a burst — the
 * one a hand edit produces, and the one the probe is actually about — sat in the
 * buffer until some unrelated event happened to come along. A probe that
 * silently loses its final event reports "1 event" for two and sends you off
 * concluding the wrong thing.
 */
function scheduleFlush(plugin: RNPlugin): void {
  if (flushPending) return;

  const wait = Math.max(0, FLUSH_INTERVAL_MS - (Date.now() - lastFlush));
  flushPending = true;
  setTimeout(() => {
    lastFlush = Date.now();
    flushPending = false;
    // Fire and forget. A failed flush costs a stale tape in a debug panel, which
    // is not worth propagating an error into the event handler for.
    plugin.storage.setSession(REM_CHANGE_TAPE_KEY, [...tape]).catch(() => { });
  }, wait);
}

export async function readRemChangeTape(plugin: RNPlugin): Promise<RemChangeEntry[]> {
  return (await plugin.storage.getSession<RemChangeEntry[]>(REM_CHANGE_TAPE_KEY)) ?? [];
}

export async function clearRemChangeTape(plugin: RNPlugin): Promise<void> {
  tape = [];
  lastFlush = 0;
  await plugin.storage.setSession(REM_CHANGE_TAPE_KEY, []);
}

export interface EnrichedRemChange extends RemChangeEntry {
  exists: boolean;
  text: string;
  /** Carries the CardPriority powerup — i.e. is itself a cache entry. */
  isTagged: boolean;
  /** A powerup property rem (the child a visible slot's value lives in). */
  isPowerupProperty: boolean;
  parentId: string | null;
  parentIsTagged: boolean;
  parentText: string;
  /** What a dirty-set would actually mark from this event. */
  wouldMark: string | null;
  /** Why it would mark that. */
  via: 'self' | 'parent' | 'none';
}

/**
 * Turns raw remIds into the answer the design question needs: for each event,
 * which tagged rem (if any) would a dirty-set derive from it, and by what route.
 *
 * The `via` field is the payload. If hand edits show up as `self`, the dirty-set
 * is trivial — record data.remId. If they show up as `parent`, it needs the
 * child→parent hop, which is free (`parent` is a plain field on the rem object,
 * not a call). If they show up as `none`, the event does not name the tagged rem
 * at all and the dirty-set cannot be built from this signal.
 */
export async function enrichRemChangeTape(
  plugin: RNPlugin,
  entries: RemChangeEntry[]
): Promise<EnrichedRemChange[]> {
  const { CARD_PRIORITY_CODE } = await import('./card_priority/types');
  const { safeRemTextToString } = await import('./pdfUtils');

  return await Promise.all(
    entries.map(async (entry) => {
      const base: EnrichedRemChange = {
        ...entry,
        exists: false,
        text: '',
        isTagged: false,
        isPowerupProperty: false,
        parentId: null,
        parentIsTagged: false,
        parentText: '',
        wouldMark: null,
        via: 'none',
      };

      try {
        const rem = await plugin.rem.findOne(entry.remId);
        if (!rem) return base;

        base.exists = true;
        base.text = (await safeRemTextToString(plugin, rem.text)).slice(0, 60);
        base.isTagged = await rem.hasPowerup(CARD_PRIORITY_CODE);
        base.isPowerupProperty = await rem.isPowerupProperty();
        base.parentId = rem.parent ?? null;

        if (base.isTagged) {
          base.wouldMark = rem._id;
          base.via = 'self';
        } else if (base.parentId) {
          const parent = await plugin.rem.findOne(base.parentId);
          if (parent) {
            base.parentText = (await safeRemTextToString(plugin, parent.text)).slice(0, 60);
            base.parentIsTagged = await parent.hasPowerup(CARD_PRIORITY_CODE);
            if (base.parentIsTagged) {
              base.wouldMark = parent._id;
              base.via = 'parent';
            }
          }
        }
      } catch {
        // Leave the defaults; a single unreadable rem should not sink the report.
      }

      return base;
    })
  );
}
