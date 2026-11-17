// lib/card_priority/shared_read.ts
//
// A shared, versioned read of the card-priority cache for code that only needs
// to look a Rem up in it.
//
// The cache is one session key holding every Rem with cards (~47,000 entries on
// a large library). Each getSession of it is copied out of a postMessage, about
// 0.3 s of main-thread work in the reading frame. The GlobalRemChanged drift
// check used to read it once per changed Rem: when a tool edits hundreds of
// card Rems through the MCP, that was hundreds of reads, and the stall
// diagnostics measured over a minute of frozen widgets (Nov 10, 2026).
//
// Here every caller in a frame shares one copy: concurrent callers wait on the
// same read, and later callers reuse the copy while the cache's version stamp
// (written by writeCardPriorityCache, the only writer) is unchanged. Checking
// the stamp is a tiny read. The copy is dropped after a minute without use.

import { RNPlugin, RemId } from '@remnote/plugin-sdk';
import { allCardPriorityInfoKey, cardPriorityCacheVersionKey } from '../consts';
import { CardPriorityInfo } from './types';

const IDLE_RELEASE_MS = 60_000;

type Snapshot = { version: unknown; byRem: Map<RemId, CardPriorityInfo> };

let snapshot: Snapshot | null = null;
let inflight: Promise<Map<RemId, CardPriorityInfo>> | null = null;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRelease() {
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => {
    releaseTimer = null;
    snapshot = null;
  }, IDLE_RELEASE_MS);
  // Node (tests) only: don't keep the process alive for the release.
  (releaseTimer as unknown as { unref?: () => void }).unref?.();
}

/**
 * The card-priority cache by Rem id. Read-only: the entries are shared with
 * other callers, so never mutate them. May trail a write by the few
 * milliseconds between the cache write and its version stamp.
 */
export function readCardPriorityByRem(plugin: RNPlugin): Promise<Map<RemId, CardPriorityInfo>> {
  scheduleRelease();
  if (inflight) return inflight;
  inflight = (async () => {
    const version = await plugin.storage.getSession<string>(cardPriorityCacheVersionKey);
    if (snapshot && version != null && snapshot.version === version) return snapshot.byRem;
    const list = (await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey)) || [];
    const byRem = new Map<RemId, CardPriorityInfo>();
    for (const info of list) byRem.set(info.remId, info);
    // A write landing between the two reads leaves a newer list under the older
    // stamp; the next call sees the new stamp and reads again.
    snapshot = { version, byRem };
    return byRem;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Test hook: forget the shared copy. */
export function resetCardPrioritySharedRead() {
  snapshot = null;
  inflight = null;
}
