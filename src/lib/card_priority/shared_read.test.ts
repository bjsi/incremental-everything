/**
 * The shared, versioned read of the card-priority cache. Run with `npm test`.
 */
import '../sdk_test_env';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readCardPriorityByRem, resetCardPrioritySharedRead } from './shared_read';
import { writeCardPriorityCache } from './persistence';
import { allCardPriorityInfoKey } from '../consts';

function fakePlugin() {
  const session = new Map<string, unknown>();
  const stats = { fullReads: 0 };
  const plugin: any = {
    storage: {
      getSession: async (k: string) => {
        if (k === allCardPriorityInfoKey) stats.fullReads++;
        await new Promise((r) => setImmediate(r));
        return session.get(k);
      },
      setSession: async (k: string, v: unknown) => void session.set(k, v),
      getSynced: async () => undefined,
      getLocal: async () => undefined,
    },
  };
  return { plugin, stats };
}

const info = (remId: string, priority: number) => ({ remId, priority, source: 'manual', cardCount: 1 }) as any;

describe('shared card-priority read', () => {
  beforeEach(() => resetCardPrioritySharedRead());

  it('serves hundreds of concurrent lookups from one read', async () => {
    const { plugin, stats } = fakePlugin();
    await writeCardPriorityCache(plugin, [info('a', 10), info('b', 20)]);
    const results = await Promise.all(Array.from({ length: 300 }, () => readCardPriorityByRem(plugin)));
    assert.equal(stats.fullReads, 1);
    assert.equal(results[299].get('b')!.priority, 20);
  });

  it('reuses the copy until the cache is written again', async () => {
    const { plugin, stats } = fakePlugin();
    await writeCardPriorityCache(plugin, [info('a', 10)]);
    await readCardPriorityByRem(plugin);
    await readCardPriorityByRem(plugin);
    assert.equal(stats.fullReads, 1);

    await writeCardPriorityCache(plugin, [info('a', 55)]);
    assert.equal((await readCardPriorityByRem(plugin)).get('a')!.priority, 55);
    assert.equal(stats.fullReads, 2);
  });
});
