/**
 * What a page remembers in each knowledge base, against a stand-in for the plugin
 * API: synced storage is shared by all KBs, and a Rem exists in only one of them.
 * Run with `npm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// First: the SDK's bundle reads the browser's `self` as it loads.
import '../duplicate_source/sdk_node_shim.test_support';
import { powerupCode } from '../consts';
import { OPS } from './index';
import { companionEntryKey, companionShardKey, shardOfPage } from './rules';

(globalThis as any).location ??= { search: '' };

const URL_A = 'https://example.org/article';
const PAGE_KEY = 'example.org/article';
const SHARD = companionShardKey(shardOfPage(PAGE_KEY));
const anchor = { exact: 'x', prefix: '', suffix: '', position: 0 };

function account(remsByKb: Record<string, string[]>) {
  const synced: Record<string, any> = {};
  let current = Object.keys(remsByKb)[0];
  const plugin: any = {
    kb: {
      getCurrentKnowledgeBaseData: async () => ({ _id: current, name: current }),
      isPrimaryKnowledgeBase: async () => false,
    },
    storage: {
      getSynced: async (key: string) => synced[key],
      setSynced: async (key: string, value: unknown) => {
        synced[key] = JSON.parse(JSON.stringify(value));
      },
    },
    rem: {
      findOne: async (id: string) =>
        remsByKb[current].includes(id)
          ? { _id: id, hasPowerup: async (code: string) => code === powerupCode }
          : undefined,
    },
  };
  return { plugin, synced, switchTo: (kb: string) => (current = kb) };
}

const pageState = (plugin: any) => OPS.pageState(plugin, { url: URL_A }) as Promise<any>;
const entry = (remId: string) => ({ remId, anchor });
const page = (...remIds: string[]) => ({ extracts: remIds.map(entry), sections: {}, order: {} });

describe('pageState across knowledge bases', () => {
  it('Answers with the KB, and leaves the records of another KB alone', async () => {
    const { plugin, synced, switchTo } = account({ test: ['r1'], main: [] });
    synced[SHARD] = { [companionEntryKey('test', PAGE_KEY)]: page('r1') };

    switchTo('main');
    const inMain = await pageState(plugin);
    assert.equal(inMain.kbId, 'main');
    assert.deepEqual(inMain.extracts, []);
    assert.equal(synced[SHARD][companionEntryKey('test', PAGE_KEY)].extracts.length, 1);

    switchTo('test');
    const inTest = await pageState(plugin);
    assert.equal(inTest.kbId, 'test');
    assert.deepEqual(inTest.extracts.map((extract: any) => extract.remId), ['r1']);
  });

  it('Keeps read points apart', async () => {
    const { plugin, switchTo } = account({ test: [], main: [] });
    await OPS.setReadPoint(plugin, { url: URL_A, anchor, percent: 0.5 });
    assert.ok((await pageState(plugin)).readPoint);
    switchTo('main');
    assert.equal((await pageState(plugin)).readPoint, undefined);
  });

  it('Still forgets an extract whose Rem is gone from its own KB', async () => {
    const { plugin, synced } = account({ test: ['r1'] });
    synced[SHARD] = { [companionEntryKey('test', PAGE_KEY)]: page('r1', 'deleted') };
    const state = await pageState(plugin);
    assert.deepEqual(state.extracts.map((extract: any) => extract.remId), ['r1']);
    assert.equal(synced[SHARD][companionEntryKey('test', PAGE_KEY)].extracts.length, 1);
  });
});

describe('Records from before the per-KB entries', () => {
  it('Each KB takes only its own, and the shared record then goes', async () => {
    const { plugin, synced, switchTo } = account({ test: ['r1'], main: ['r2'], other: [] });
    synced[SHARD] = { [PAGE_KEY]: page('r1', 'r2') };

    switchTo('other');
    assert.deepEqual((await pageState(plugin)).extracts, []);
    assert.equal(synced[SHARD][PAGE_KEY].extracts.length, 2);

    switchTo('test');
    assert.deepEqual((await pageState(plugin)).extracts.map((extract: any) => extract.remId), ['r1']);
    assert.deepEqual(synced[SHARD][PAGE_KEY].extracts.map((extract: any) => extract.remId), ['r2']);

    switchTo('main');
    assert.deepEqual((await pageState(plugin)).extracts.map((extract: any) => extract.remId), ['r2']);
    assert.equal(synced[SHARD][PAGE_KEY], undefined);
    assert.equal(synced[SHARD][companionEntryKey('test', PAGE_KEY)].extracts.length, 1);
  });
});
