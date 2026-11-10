/**
 * The IncRem cache's warm start (cache.ts + persistence.ts) against a fake
 * plugin. Run with `npm test`.
 */
import '../sdk_test_env';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadIncrementalRemCache } from './cache';
import { markIncRemDirty, flushIncRemDirtySet } from './persistence';
import { allIncrementalRemKey } from '../consts';
import { IncrementalRem } from './types';

type FakeRem = {
  _id: string;
  updatedAt: number;
  priority: number;
  history: { date: number; scheduled: number; nextRepMs?: number }[];
};

const DAY = 86400000;

function makeWorld(count: number) {
  const rems = new Map<string, FakeRem>();
  for (let i = 0; i < count; i++) {
    const id = `rem${i}`;
    rems.set(id, {
      _id: id,
      updatedAt: 1000,
      priority: i % 100,
      history: [{ date: 500, scheduled: 400, nextRepMs: 2_000_000_000_000 + i * DAY }],
    });
  }
  const local = new Map<string, unknown>();
  const session = new Map<string, unknown>();
  const stats = { slotReads: 0, inFlight: 0, maxInFlight: 0 };

  const call = async <T>(value: T): Promise<T> => {
    stats.inFlight++;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    await new Promise((r) => setImmediate(r));
    stats.inFlight--;
    return value;
  };
  const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

  const pluginRem = (r: FakeRem) => ({
    _id: r._id,
    updatedAt: r.updatedAt,
    parent: null,
    hasPowerup: () => call(true),
    getPowerupPropertyAsRichText: (_code: string, slot: string) => {
      stats.slotReads++;
      // Priority as rich text; the two Daily Document slots are empty, so the
      // next-rep date falls back to the history's nextRepMs stamp.
      return call(slot === 'priority' ? [String(rems.get(r._id)!.priority)] : []);
    },
    getPowerupProperty: (_code: string, _slot: string) => {
      stats.slotReads++;
      return call(JSON.stringify(rems.get(r._id)!.history));
    },
  });

  const plugin: any = {
    kb: { getCurrentKnowledgeBaseData: () => call({ _id: 'kb1' }) },
    powerup: {
      getPowerupByCode: () =>
        call({ taggedRem: () => call([...rems.values()].map(pluginRem)) }),
    },
    rem: { findOne: (id: string) => call(rems.has(id) ? pluginRem(rems.get(id)!) : undefined) },
    richText: { toString: (rt: string[]) => call(rt.join('')) },
    storage: {
      getLocal: (k: string) => call(clone(local.get(k))),
      setLocal: (k: string, v: unknown) => call(void local.set(k, clone(v))),
      getSession: (k: string) => call(clone(session.get(k))),
      setSession: (k: string, v: unknown) => call(void session.set(k, clone(v))),
    },
  };
  return { rems, plugin, stats, session };
}

/** The deferred persist runs on a 30 s timer: run it now. */
async function loadAndPersist(plugin: any, opts?: { forceCold?: boolean }) {
  const realSetTimeout = global.setTimeout;
  const deferred: (() => void)[] = [];
  (global as any).setTimeout = (fn: () => void, ms: number) =>
    ms >= 30_000 ? (deferred.push(fn), 0) : realSetTimeout(fn, ms);
  try {
    const loaded = await loadIncrementalRemCache(plugin, opts);
    deferred.forEach((fn) => fn());
    // Let the persist chain (several awaited calls) finish.
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    return loaded;
  } finally {
    (global as any).setTimeout = realSetTimeout;
  }
}

const byId = (list: IncrementalRem[]) => new Map(list.map((r) => [r.remId, r]));

describe('IncRem cache warm start', () => {
  it('cold load reads everything with bounded concurrency, then warm load reuses the copy', async () => {
    const w = makeWorld(600);
    const cold = await loadAndPersist(w.plugin);
    assert.equal(cold.length, 600);
    const coldReads = w.stats.slotReads;
    assert.ok(coldReads >= 600 * 4, `cold reads ${coldReads}`);
    assert.ok(w.stats.maxInFlight <= 30, `max in flight ${w.stats.maxInFlight}`);

    w.stats.slotReads = 0;
    const warm = await loadAndPersist(w.plugin);
    assert.equal(warm.length, 600);
    // Only the self-check sample (100 IncRems × 4 slot reads) touches the slots.
    assert.ok(w.stats.slotReads <= 100 * 4, `warm reads ${w.stats.slotReads}`);
    assert.deepEqual(byId(warm).get('rem7'), byId(cold).get('rem7'));
    assert.equal((w.session.get(allIncrementalRemKey) as IncrementalRem[]).length, 600);
  });

  it('picks up a review (updatedAt), a hand edit (dirty set), a new and a removed IncRem', async () => {
    const w = makeWorld(300);
    await loadAndPersist(w.plugin);

    // A review elsewhere: history grows and updatedAt moves past syncedAt.
    const reviewed = w.rems.get('rem3')!;
    reviewed.history.push({ date: Date.now(), scheduled: Date.now(), nextRepMs: 2_100_000_000_000 });
    reviewed.updatedAt = Date.now();
    // A hand edit of the Priority row: updatedAt does NOT move; the listener marks it.
    w.rems.get('rem5')!.priority = 99;
    markIncRemDirty(w.plugin, 'rem5');
    await flushIncRemDirtySet(w.plugin);
    // Made incremental since the copy, and un-made.
    w.rems.set('newRem', { _id: 'newRem', updatedAt: 1000, priority: 42, history: [{ date: 1, scheduled: 1, nextRepMs: 5 }] });
    w.rems.delete('rem9');

    const warm = byId(await loadAndPersist(w.plugin));
    assert.equal(warm.size, 300);
    assert.equal(warm.get('rem3')!.history!.length, 2);
    assert.equal(warm.get('rem3')!.nextRepDate, 2_100_000_000_000);
    assert.equal(warm.get('rem5')!.priority, 99);
    assert.equal(warm.get('newRem')!.priority, 42);
    assert.equal(warm.has('rem9'), false);

    // The dirty set was cleared by the persist: a third load re-reads nothing extra.
    w.stats.slotReads = 0;
    const third = byId(await loadAndPersist(w.plugin));
    assert.equal(third.get('rem5')!.priority, 99);
    assert.ok(w.stats.slotReads <= 100 * 4, `third reads ${w.stats.slotReads}`);
  });

  it('falls back to a cold load when the copy disagrees in bulk', async () => {
    const w = makeWorld(200);
    await loadAndPersist(w.plugin);
    // Every priority changed without any trace (e.g. a restored backup).
    for (const r of w.rems.values()) r.priority = (r.priority + 1) % 100;
    const reloaded = byId(await loadAndPersist(w.plugin));
    assert.equal(reloaded.get('rem10')!.priority, 11);
    assert.equal(reloaded.get('rem150')!.priority, 51);
  });

  it('forceCold ignores the copy', async () => {
    const w = makeWorld(150);
    await loadAndPersist(w.plugin);
    w.rems.get('rem20')!.priority = 77; // no trace, outside any sample guarantee
    const cold = byId(await loadAndPersist(w.plugin, { forceCold: true }));
    assert.equal(cold.get('rem20')!.priority, 77);
  });
});
