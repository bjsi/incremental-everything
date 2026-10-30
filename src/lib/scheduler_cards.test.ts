/**
 * Tests for the other-scheduler cards list. Run with `npm test`.
 */
import './sdk_test_env';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeFSRSCalibrationBreakdown } from './fsrs_calibration';
import { computeCardAnalyticsBreakdown } from './card_analytics';
import { parseWeightsString } from './fsrs';
import { PER_KEY_UTF16_LIMIT, utf16Bytes } from './history_shards';
import {
  SCHEDULER_SHARD_UTF16_BUDGET,
  SchedulerCardsExport,
  buildSchedulerStorage,
  clearSchedulerCards,
  findCardScheduler,
  getOtherSchedulerCardIds,
  planFsrsSettings,
  saveSchedulerCards,
  schedulerManifestKey,
  schedulerShardKey,
} from './scheduler_cards';

const KB = 'kb1';
const ids = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(16, '0')}`);

const listOf = (questions: number, vocabulary: number, generatedAt = 1000): SchedulerCardsExport => ({
  kind: 'incremental-remnote-scheduler-cards',
  version: 1,
  kbId: KB,
  generatedAt,
  schedulers: [
    { id: 'q', name: 'Questions', type: 'sm2', cards: ids('q', questions) },
    { id: 'v', name: 'Vocabulary', type: 'fsrs', cards: ids('v', vocabulary) },
  ],
});

/** A storage stand-in that, like RemNote, can silently reject a write over the ceiling. */
function fakePlugin(options: { rejectKey?: string; cards?: any[] } = {}) {
  const store = new Map<string, any>();
  const plugin: any = {
    store,
    storage: {
      getSynced: async (key: string) => store.get(key),
      setSynced: async (key: string, value: any) => {
        if (key === options.rejectKey || utf16Bytes(value) >= PER_KEY_UTF16_LIMIT) return;
        store.set(key, value);
      },
    },
    kb: { getCurrentKnowledgeBaseData: async () => ({ _id: KB }) },
    card: { getAll: async () => options.cards ?? [] },
  };
  return plugin;
}

describe('buildSchedulerStorage', () => {
  it('fits a real-sized list in one key, well under the ceiling', () => {
    const { manifest, shards } = buildSchedulerStorage(listOf(5416, 1600));
    assert.equal(shards.length, 1);
    assert.equal(manifest.cardCount, 7016);
    assert.ok(utf16Bytes(shards[0]) < PER_KEY_UTF16_LIMIT / 2);
  });

  it('spreads a larger list over keys that each stay inside the budget', () => {
    const { manifest, shards } = buildSchedulerStorage(listOf(30000, 15000));
    assert.equal(manifest.shardCount, shards.length);
    assert.ok(shards.length > 1);
    for (const shard of shards) assert.ok(utf16Bytes(shard) <= SCHEDULER_SHARD_UTF16_BUDGET);
    const stored = shards.flatMap((shard) => shard.chunks.flatMap((chunk) => chunk.ids.split(' ')));
    assert.equal(stored.length, 45000);
    assert.equal(new Set(stored).size, 45000);
  });

  it('keeps each id with its own scheduler across a shard boundary', () => {
    const { manifest, shards } = buildSchedulerStorage(listOf(20000, 20000));
    for (const shard of shards) {
      for (const { s, ids: joined } of shard.chunks) {
        const expected = manifest.schedulers[s].id;
        assert.ok(joined.split(' ').every((id) => id.startsWith(expected)));
      }
    }
  });
});

describe('planFsrsSettings', () => {
  const weights = (count: number) => Array.from({ length: count }, (_, i) => i + 0.5);
  const fsrs = (over = {}) => ({ id: 'g', type: 'fsrs', weights: weights(21), targetRetention: 0.9, ...over });

  it('fills both settings from an FSRS-6 scheduler, with no warning', () => {
    const plan = planFsrsSettings(fsrs({ targetRetention: 0.875 }));
    assert.equal(parseWeightsString(plan.weights)?.length, 21);
    assert.equal(plan.retentionPercent, 87.5);
    assert.deepEqual(plan.warnings, []);
  });

  it('warns about a scheduler that is not FSRS, and changes nothing', () => {
    const plan = planFsrsSettings({ id: 'g', type: 'sm2', weights: null, targetRetention: null });
    assert.equal(plan.weights, null);
    assert.equal(plan.retentionPercent, null);
    assert.match(plan.warnings[0], /Anki SM-2, not FSRS-6/);
  });

  it('uses the default weights and retention when the scheduler stores none', () => {
    const plan = planFsrsSettings(fsrs({ weights: null, targetRetention: null }));
    assert.equal(plan.weights, '');
    assert.equal(plan.retentionPercent, 90);
    assert.deepEqual(plan.warnings, []);
  });

  it('warns about FSRS-5 weights but still uses them, since the plugin can replay them', () => {
    const plan = planFsrsSettings(fsrs({ weights: weights(19) }));
    assert.equal(parseWeightsString(plan.weights)?.length, 19);
    assert.match(plan.warnings[0], /FSRS-5/);
  });

  it('keeps the weights when their count is one the plugin cannot use', () => {
    const plan = planFsrsSettings(fsrs({ weights: weights(17) }));
    assert.equal(plan.weights, null);
    assert.equal(plan.retentionPercent, 90);
    assert.match(plan.warnings[0], /17 FSRS weights/);
  });

  it('keeps the retention when it is outside the setting\'s range', () => {
    const plan = planFsrsSettings(fsrs({ targetRetention: 0.6 }));
    assert.equal(plan.retentionPercent, null);
    assert.match(plan.warnings[0], /outside/);
  });
});

describe('saving and looking up', () => {
  it('finds the scheduler of a listed card, and nothing for the rest', async () => {
    const plugin = fakePlugin();
    await saveSchedulerCards(plugin, KB, listOf(3, 2));
    assert.equal((await findCardScheduler(plugin, KB, ids('q', 3)[1]))?.name, 'Questions');
    assert.equal((await findCardScheduler(plugin, KB, ids('v', 2)[0]))?.type, 'fsrs');
    assert.equal(await findCardScheduler(plugin, KB, 'someOtherCard'), null);
    assert.equal((await getOtherSchedulerCardIds(plugin))?.size, 5);
  });

  it('removes shards a smaller list no longer needs', async () => {
    const plugin = fakePlugin();
    await saveSchedulerCards(plugin, KB, listOf(40000, 0, 1));
    assert.ok(plugin.store.get(schedulerShardKey(KB, 1)));
    await saveSchedulerCards(plugin, KB, listOf(2, 0, 2));
    assert.equal(plugin.store.get(schedulerShardKey(KB, 1)), null);
    assert.equal((await getOtherSchedulerCardIds(plugin))?.size, 2);
  });

  it('reports a write that RemNote rejected silently', async () => {
    const plugin = fakePlugin({ rejectKey: schedulerShardKey(KB, 0) });
    await assert.rejects(saveSchedulerCards(plugin, KB, listOf(3, 0)), /did not keep/);
    assert.equal(plugin.store.get(schedulerManifestKey(KB)), undefined);
  });

  it('treats shards from another import as no list at all', async () => {
    const plugin = fakePlugin();
    await saveSchedulerCards(plugin, KB, listOf(3, 0, 3));
    plugin.store.set(schedulerShardKey(KB, 0), { generatedAt: 999, chunks: [{ s: 0, ids: 'stale' }] });
    plugin.store.set(schedulerManifestKey(KB), { ...plugin.store.get(schedulerManifestKey(KB)), generatedAt: 4 });
    assert.equal(await getOtherSchedulerCardIds(plugin), null);
  });

  it('clears the manifest and every shard', async () => {
    const plugin = fakePlugin();
    await saveSchedulerCards(plugin, KB, listOf(3, 0, 5));
    await clearSchedulerCards(plugin, KB);
    assert.equal(plugin.store.get(schedulerManifestKey(KB)), null);
    assert.equal(plugin.store.get(schedulerShardKey(KB, 0)), null);
    assert.equal(await getOtherSchedulerCardIds(plugin), null);
  });
});

describe('excluding cards from analytics', () => {
  const NOW = Date.now();
  const card = (id: string) => ({
    _id: id,
    remId: `rem-${id}`,
    type: 'forward',
    nextRepetitionTime: NOW + 86400000,
    repetitionHistory: [
      { date: NOW - 40 * 86400000, score: 1 },
      { date: NOW - 10 * 86400000, score: 1 },
    ],
  });
  const cards = [card('keep'), card('drop')];
  const period = { id: 'all', startMs: 0, endMs: NOW + 1000, customStart: '', customEnd: '' };
  const infos: any[] = cards.map((c) => ({ remId: c.remId, cardId: c._id, priority: 10, cardCount: 1 }));

  it('leaves listed cards out of Card Analytics and counts them', async () => {
    const plugin = fakePlugin({ cards });
    const all = await computeCardAnalyticsBreakdown(plugin, infos, null, 180000, false, period);
    const some = await computeCardAnalyticsBreakdown(
      plugin, infos, null, 180000, false, period, undefined, undefined, null, new Set(['drop']),
    );
    assert.equal(all.totalCards, 2);
    assert.equal(all.excludedOtherSchedulerCards, 0);
    assert.equal(some.totalCards, 1);
    assert.equal(some.overall.totReps, all.overall.totReps / 2);
    assert.equal(some.excludedOtherSchedulerCards, 1);
  });

  it('leaves listed cards out of FSRS Calibration and counts them', async () => {
    const plugin = fakePlugin({ cards });
    const all = await computeFSRSCalibrationBreakdown(plugin, null, false, period);
    const some = await computeFSRSCalibrationBreakdown(plugin, null, false, period, undefined, new Set(['drop']));
    assert.equal(all.totalCards, 2);
    assert.equal(some.totalCards, 1);
    assert.equal(some.excludedOtherSchedulerCards, 1);
  });
});
