import { AppEvents, RNPlugin } from '@remnote/plugin-sdk';
import { setCardPriority, updateCardPriorityCache } from './card_priority';
import { defaultCardPriorityId, enableFlashcardPrioritisationId } from './consts';
import { findClosestAncestorWithAnyPriority } from './priority_inheritance';
import { getIESetting } from './settings';

/**
 * Card priority for other plugins (e.g. an importer creating flashcards).
 * User and developer documentation: docs/Priority-Bridge-for-Other-Plugins.md.
 *
 * THE CHANNEL
 *
 * Plugin storage is private: the host stores every key as
 * `plugin|<manifest id>|<key>`, so no plugin can read another's values. The
 * change EVENT is not: `setSession` / `setSynced` emit
 * `storage.session.changed` / `storage.synced.changed` under the bare key, to
 * every widget listening on that key, whichever plugin wrote it (app.asar,
 * plugin "storage" and "events" handlers, RemNote 1.28). So a plugin writes a
 * request into its own session storage and we receive it as an event; we answer
 * the same way. Session storage is in-memory and never synced, so nothing
 * accumulates and no other device replays it.
 *
 * Events reach only running listeners: nothing is queued while this plugin is
 * off. A client keeps its own pending list and resends on `ready`, which we
 * announce at startup.
 *
 * PROTOCOL v1 (keys below; every payload carries a requestId, answers echo it)
 *   ping             {requestId}                          → pong {requestId, version}
 *   priority-query   {requestId, parentIds: (id|null)[]}  → priority-answer
 *                    {requestId, enabled, results: {[parentId|'']: {priority, source, ancestorName?}}}
 *                    — the priority a NEW child of each parent would inherit
 *                    ('incremental' / 'card' from an ancestor, else 'default').
 *   set-priority     {requestId, items: [{remId, priority}]} → set-priority-ack
 *                    {requestId, done: remId[], failed: remId[]}
 *                    — written as a manual priority (history event 'import').
 */
export const PRIORITY_BRIDGE_VERSION = 1;
export const PRIORITY_BRIDGE_KEYS = {
  ready: 'ie-bridge.v1.ready',
  ping: 'ie-bridge.v1.ping',
  pong: 'ie-bridge.v1.pong',
  query: 'ie-bridge.v1.priority-query',
  answer: 'ie-bridge.v1.priority-answer',
  set: 'ie-bridge.v1.set-priority',
  ack: 'ie-bridge.v1.set-priority-ack',
} as const;

type Payload = Record<string, any> | undefined;

/** The listener receives the value itself, or wrapped as {value} (see mastery_drill_native.ts). */
const unwrap = (raw: any): Payload => (raw && typeof raw === 'object' && 'value' in raw && !('requestId' in raw) ? raw.value : raw);

/** Requests already handled in this realm: the event can arrive more than once. */
const handled = new Set<string>();
const firstTime = (kind: string, requestId: unknown) => {
  if (typeof requestId !== 'string' || !requestId) return false;
  const key = `${kind}:${requestId}`;
  if (handled.has(key)) return false;
  handled.add(key);
  if (handled.size > 500) handled.delete(handled.values().next().value as string);
  return true;
};

const reply = (plugin: RNPlugin, key: string, value: Record<string, any>) =>
  plugin.storage.setSession(key, { ...value, at: Date.now() });

async function inheritedFor(plugin: RNPlugin, parentId: string | null) {
  const parent = parentId ? await plugin.rem.findOne(parentId) : undefined;
  if (parent) {
    // Starting the walk AT the parent: what a new child of it would inherit.
    const found = await findClosestAncestorWithAnyPriority(plugin, parent, 'Card', parent._id);
    if (found) {
      return {
        priority: found.priority,
        source: found.sourceType === 'IncRem' ? 'incremental' : 'card',
        ancestorName: found.ancestorName,
      };
    }
  }
  return { priority: await getIESetting(plugin, defaultCardPriorityId), source: 'default' };
}

export function registerExternalPriorityBridge(plugin: RNPlugin) {
  plugin.event.addListener(AppEvents.StorageSessionChange, PRIORITY_BRIDGE_KEYS.ping, async (raw: any) => {
    const msg = unwrap(raw);
    if (!firstTime('ping', msg?.requestId)) return;
    await reply(plugin, PRIORITY_BRIDGE_KEYS.pong, { requestId: msg!.requestId, version: PRIORITY_BRIDGE_VERSION });
  });

  plugin.event.addListener(AppEvents.StorageSessionChange, PRIORITY_BRIDGE_KEYS.query, async (raw: any) => {
    const msg = unwrap(raw);
    if (!firstTime('query', msg?.requestId)) return;
    const parentIds: (string | null)[] = Array.isArray(msg!.parentIds) ? msg!.parentIds : [];
    const results: Record<string, unknown> = {};
    for (const id of new Set(parentIds)) {
      try {
        results[id ?? ''] = await inheritedFor(plugin, id);
      } catch (e) {
        console.error('[PriorityBridge] query failed for', id, e);
      }
    }
    await reply(plugin, PRIORITY_BRIDGE_KEYS.answer, {
      requestId: msg!.requestId,
      // With flashcard prioritisation off, inherited/default values are not
      // materialised as tags; a manual one still is.
      enabled: await getIESetting(plugin, enableFlashcardPrioritisationId),
      results,
    });
  });

  plugin.event.addListener(AppEvents.StorageSessionChange, PRIORITY_BRIDGE_KEYS.set, async (raw: any) => {
    const msg = unwrap(raw);
    if (!firstTime('set', msg?.requestId)) return;
    const done: string[] = [];
    const failed: string[] = [];
    for (const item of Array.isArray(msg!.items) ? msg!.items : []) {
      const priority = Math.round(Number(item?.priority));
      try {
        const rem = typeof item?.remId === 'string' ? await plugin.rem.findOne(item.remId) : undefined;
        if (!rem || !Number.isFinite(priority) || priority < 0 || priority > 100) throw new Error('invalid item');
        await setCardPriority(plugin, rem, priority, 'manual', false, { event: 'import' });
        await updateCardPriorityCache(plugin, rem._id);
        done.push(rem._id);
      } catch (e) {
        console.error('[PriorityBridge] set-priority failed for', item, e);
        failed.push(item?.remId);
      }
    }
    await reply(plugin, PRIORITY_BRIDGE_KEYS.ack, { requestId: msg!.requestId, done, failed });
  });

  // Clients resend whatever they still hold once they hear this.
  void reply(plugin, PRIORITY_BRIDGE_KEYS.ready, { requestId: `ready-${Date.now()}`, version: PRIORITY_BRIDGE_VERSION });
}
