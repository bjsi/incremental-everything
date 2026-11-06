// Open URL (Use Companion) in the queue hands a web page to the Chrome Companion.
// One sitting gets one review: the queue's Next and the Companion's reading clock
// must not both record it. See companion/clock.js for the Companion's side.
//
// - The click is stamped in session storage for this queue turn. Next carries it
//   into the review it writes (context.companionHandoffAt), and the Companion,
//   reading that review later, swaps the wall-clock time after the click for the
//   reading it measured (context.companionSeconds).
// - If the Companion recorded the sitting first, Next finds that session in the
//   history and adds the queue's own minutes to it instead of a second review.
// - The page is also written to synced storage, so a Companion panel open in
//   Chrome learns it is an Incremental page and counts it from the start.

import { RNPlugin } from '@remnote/plugin-sdk';
import { IncrementalRep } from '../incremental_rem/types';

/** Session: the last hand-off in this client, { remId, at }. */
export const companionHandoffKey = 'companion-handoff';
/** Synced (account-wide, so keyed by KB): pages handed off, { [kbId]: { [docId]: { url, at } } }. */
export const companionTargetsKey = 'companion-targets';
const MAX_TARGETS_PER_KB = 100;

export type CompanionTargets = Record<string, Record<string, { url: string; at: number }>>;

export async function recordCompanionHandoff(plugin: RNPlugin, remId: string, url: string) {
  const at = Date.now();
  await plugin.storage.setSession(companionHandoffKey, { remId, at });
  const kbId = (await plugin.kb.getCurrentKnowledgeBaseData().catch(() => undefined))?._id;
  if (!kbId) return;
  const all = (await plugin.storage.getSynced<CompanionTargets>(companionTargetsKey)) ?? {};
  const pages = Object.entries({ ...all[kbId], [remId]: { url, at } })
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, MAX_TARGETS_PER_KB);
  await plugin.storage.setSynced(companionTargetsKey, { ...all, [kbId]: Object.fromEntries(pages) });
}

/** The hand-off of this queue turn, if Use Companion was clicked during it. */
export async function takeCompanionHandoff(
  plugin: RNPlugin,
  remId: string,
  turnStartedAt: number | null
): Promise<number | undefined> {
  const handoff = await plugin.storage.getSession<{ remId: string; at: number }>(companionHandoffKey);
  if (!handoff || handoff.remId !== remId || (turnStartedAt && handoff.at < turnStartedAt)) return undefined;
  await plugin.storage.setSession(companionHandoffKey, undefined);
  return handoff.at;
}

/** A session the Companion recorded during this queue turn, which Next must not record again. */
export function companionSessionInTurn(
  history: IncrementalRep[] | undefined,
  turnStartedAt: number | null
): IncrementalRep | undefined {
  if (!turnStartedAt) return undefined;
  return [...(history ?? [])]
    .reverse()
    .find((rep) => rep.eventType === 'externalRep' && !!rep.context?.webUrl && rep.date >= turnStartedAt);
}

/**
 * Seconds the queue adds to a Companion session it finds: the time in RemNote
 * before the page was handed off, or, without a hand-off, before the reading began.
 */
export function queueSecondsBefore(session: IncrementalRep, turnStartedAt: number, handoffAt?: number): number {
  const readingBegan = session.date - (session.reviewTimeSeconds ?? 0) * 1000;
  const until = handoffAt ?? readingBegan;
  return Math.max(0, Math.round((Math.min(until, readingBegan) - turnStartedAt) / 1000));
}

/** A queue review's time once the Companion's reading replaces the wall clock after the hand-off. */
export function refinedReviewSeconds(review: IncrementalRep, handoffAt: number, companionSeconds: number): number {
  const startedAt = review.date - (review.reviewTimeSeconds ?? 0) * 1000;
  const before = Math.max(0, Math.round((handoffAt - startedAt) / 1000));
  return before + Math.max(0, Math.round(companionSeconds));
}
