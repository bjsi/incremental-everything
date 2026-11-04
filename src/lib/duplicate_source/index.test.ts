/**
 * The duplicate check and the index scan, against a stand-in for the plugin API.
 * Run with `npm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// First: the SDK's bundle reads the browser's `self` as it loads.
import './sdk_node_shim.test_support';
import { BuiltInPowerupCodes } from '@remnote/plugin-sdk';
import {
  confirmNoDuplicateSource,
  loadTrackedSites,
  refreshSourceUrlIndexIfDue,
  registerRemPagesIfTracked,
  websiteOfRem,
} from './index';
import {
  dismissedPowerupCode,
  duplicateSourceDecisionKey,
  powerupCode,
  sourceUrlIndexKey,
  sourceUrlIndexScannedAtKey,
} from '../consts';
import { DuplicateChoice } from './rules';

const LINK = BuiltInPowerupCodes.Link;
const PAGE = 'https://example.com/article';

interface FakeRem {
  _id: string;
  text: string[];
  powerups: string[];
  url?: string;
  sources: string[];
}

function world(rems: Array<Partial<FakeRem> & { _id: string }>, answer?: DuplicateChoice) {
  const store: Record<string, FakeRem> = {};
  const synced: Record<string, any> = {};
  const session: Record<string, any> = {};
  const calls: string[] = [];
  let popup: any;

  const wrap = (rem: FakeRem): any => ({
    ...rem,
    parent: (rem as any).parent,
    hasPowerup: async (code: string) => rem.powerups.includes(code),
    getPowerupProperty: async () => rem.url,
    getSources: async () => rem.sources.map((id) => wrap(store[id])),
  });
  for (const rem of rems) {
    store[rem._id] = { text: [rem._id], powerups: [], sources: [], ...rem };
  }

  const plugin: any = {
    rem: { findOne: async (id: string) => (store[id] ? wrap(store[id]) : undefined) },
    richText: { toString: async (text: string[]) => text.join('') },
    storage: {
      getSynced: async (key: string) => synced[key],
      setSynced: async (key: string, value: any) => void (synced[key] = value),
      getSession: async (key: string) => session[key],
      setSession: async (key: string, value: any) => void (session[key] = value),
    },
    widget: {
      openPopup: async (_: string, data: any) => {
        calls.push('openPopup');
        popup = data;
        if (answer) session[duplicateSourceDecisionKey] = { requestId: data.requestId, choice: answer };
      },
      closePopup: async () => void calls.push('closePopup'),
    },
    window: { openRem: async (rem: any) => void calls.push(`openRem:${rem._id}`) },
    powerup: {
      getPowerupByCode: async (code: string) => ({
        taggedRem: async () => Object.values(store).filter((r) => r.powerups.includes(code)).map(wrap),
      }),
    },
  };
  return { plugin, synced, calls, get: (id: string) => wrap(store[id]), store, popup: () => popup };
}

const link = (id: string, url: string) => ({ _id: id, powerups: [LINK], url });
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('confirmNoDuplicateSource', () => {
  it('asks nothing for a Rem with no web page, and records nothing', async () => {
    const w = world([{ _id: 'plain' }]);
    const rem = w.get('plain');
    assert.deepEqual(await confirmNoDuplicateSource(w.plugin, [rem]), [rem]);
    assert.deepEqual(w.calls, []);
    assert.equal(w.synced[sourceUrlIndexKey], undefined);
  });

  it('asks nothing for the first Rem of a page, and records it', async () => {
    const w = world([link('l', PAGE), { _id: 'doc', sources: ['l'] }]);
    const rem = w.get('doc');
    assert.deepEqual(await confirmNoDuplicateSource(w.plugin, [rem]), [rem]);
    await settle();
    assert.deepEqual(w.calls, []);
    assert.deepEqual(w.synced[sourceUrlIndexKey], { 'example.com/article': ['doc'] });
  });

  it('passes through a Rem that is already Incremental', async () => {
    const w = world([link('l', PAGE), { _id: 'old', sources: ['l'], powerups: [powerupCode] }]);
    w.synced[sourceUrlIndexKey] = { 'example.com/article': ['other'] };
    const rem = w.get('old');
    assert.deepEqual(await confirmNoDuplicateSource(w.plugin, [rem]), [rem]);
    assert.deepEqual(w.calls, []);
  });

  for (const [status, powerup] of [
    ['incremental', powerupCode],
    ['dismissed', dismissedPowerupCode],
  ] as const) {
    it(`warns about a ${status} Rem with the same page, in another URL form`, async () => {
      const w = world(
        [
          link('l1', PAGE),
          link('l2', 'http://www.example.com/article#part'),
          { _id: 'old', sources: ['l2'], powerups: [powerup] },
          { _id: 'new', sources: ['l1'] },
        ],
        { kind: 'cancel' }
      );
      w.synced[sourceUrlIndexKey] = { 'example.com/article': ['old'] };
      assert.deepEqual(await confirmNoDuplicateSource(w.plugin, [w.get('new')]), []);
      assert.deepEqual(w.calls, ['openPopup', 'closePopup']);
      const [group] = w.popup().groups;
      assert.equal(group.url, PAGE);
      assert.deepEqual(group.matches, [
        { remId: 'old', name: 'old', status, url: 'http://www.example.com/article#part' },
      ]);
    });
  }

  it('Make anyway continues and records the new Rem', async () => {
    const w = world(
      [link('l', PAGE), { _id: 'old', sources: ['l'], powerups: [dismissedPowerupCode] }, { _id: 'new', sources: ['l'] }],
      { kind: 'proceed' }
    );
    w.synced[sourceUrlIndexKey] = { 'example.com/article': ['old'] };
    const rem = w.get('new');
    assert.deepEqual(await confirmNoDuplicateSource(w.plugin, [rem]), [rem]);
    await settle();
    assert.deepEqual(w.synced[sourceUrlIndexKey], { 'example.com/article': ['old', 'new'] });
  });

  it('Open goes to the existing Rem and stops', async () => {
    const w = world(
      [link('l', PAGE), { _id: 'old', sources: ['l'], powerups: [powerupCode] }, { _id: 'new', sources: ['l'] }],
      { kind: 'open', remId: 'old' }
    );
    w.synced[sourceUrlIndexKey] = { 'example.com/article': ['old'] };
    assert.deepEqual(await confirmNoDuplicateSource(w.plugin, [w.get('new')]), []);
    assert.deepEqual(w.calls, ['openPopup', 'closePopup', 'openRem:old']);
  });

  it('Skip keeps only the selected Rems without a duplicate', async () => {
    const w = world(
      [
        link('l', PAGE),
        { _id: 'old', sources: ['l'], powerups: [powerupCode] },
        { _id: 'dup', sources: ['l'] },
        { _id: 'fine' },
      ],
      { kind: 'skip' }
    );
    w.synced[sourceUrlIndexKey] = { 'example.com/article': ['old'] };
    const dup = w.get('dup');
    const fine = w.get('fine');
    assert.deepEqual(await confirmNoDuplicateSource(w.plugin, [dup, fine]), [fine]);
    assert.equal(w.popup().total, 2);
  });

  it('prunes stale entries without bothering the user', async () => {
    const w = world([
      link('l', PAGE),
      { _id: 'plainNow', sources: ['l'] }, // lost both powerups
      { _id: 'otherPage', powerups: [powerupCode] }, // lost this source
      { _id: 'new', sources: ['l'] },
    ]);
    w.synced[sourceUrlIndexKey] = { 'example.com/article': ['deleted', 'plainNow', 'otherPage'] };
    const rem = w.get('new');
    assert.deepEqual(await confirmNoDuplicateSource(w.plugin, [rem]), [rem]);
    await settle();
    assert.deepEqual(w.calls, []);
    assert.deepEqual(w.synced[sourceUrlIndexKey], { 'example.com/article': ['new'] });
  });

  it('a failure never blocks making the Rem Incremental', async () => {
    const w = world([{ _id: 'doc' }]);
    const rem = { ...w.get('doc'), getSources: async () => { throw new Error('bridge'); } };
    assert.deepEqual(await confirmNoDuplicateSource(w.plugin, [rem]), [rem]);
  });
});

describe('refreshSourceUrlIndexIfDue', () => {
  it('indexes Incremental and Dismissed Rems, and only those', async () => {
    const w = world([
      link('l1', PAGE),
      link('l2', 'https://example.com/other'),
      { _id: 'inc', sources: ['l1'], powerups: [powerupCode] },
      { _id: 'dis', sources: ['l2'], powerups: [dismissedPowerupCode] },
      { _id: 'plain', sources: ['l1'] },
      { _id: 'noSource', powerups: [powerupCode] },
    ]);
    await refreshSourceUrlIndexIfDue(w.plugin);
    assert.deepEqual(w.synced[sourceUrlIndexKey], {
      'example.com/article': ['inc'],
      'example.com/other': ['dis'],
    });
    assert.ok(w.synced[sourceUrlIndexScannedAtKey]);
  });

  it('does not rescan within a week', async () => {
    const w = world([link('l', PAGE), { _id: 'inc', sources: ['l'], powerups: [powerupCode] }]);
    w.synced[sourceUrlIndexScannedAtKey] = Date.now() - 6 * 86_400_000;
    await refreshSourceUrlIndexIfDue(w.plugin);
    assert.equal(w.synced[sourceUrlIndexKey], undefined);
  });

  it('rescans after a week and drops what no longer holds', async () => {
    const w = world([
      link('l', PAGE),
      { _id: 'inc', sources: ['l'], powerups: [powerupCode] },
      { _id: 'lost', sources: ['l'] },
    ]);
    w.synced[sourceUrlIndexScannedAtKey] = Date.now() - 8 * 86_400_000;
    w.synced[sourceUrlIndexKey] = { 'example.com/article': ['lost'], 'example.com/gone': ['deleted'] };
    await refreshSourceUrlIndexIfDue(w.plugin);
    assert.deepEqual(w.synced[sourceUrlIndexKey], { 'example.com/article': ['inc'] });
  });
});

describe('registerRemPagesIfTracked', () => {
  it('records a Dismissed Rem that gained a source, and ignores an untracked one', async () => {
    const w = world([
      link('l', PAGE),
      { _id: 'dis', sources: ['l'], powerups: [dismissedPowerupCode] },
      { _id: 'plain', sources: ['l'] },
    ]);
    await registerRemPagesIfTracked(w.plugin, w.get('plain'));
    assert.equal(w.synced[sourceUrlIndexKey], undefined);
    await registerRemPagesIfTracked(w.plugin, w.get('dis'));
    assert.deepEqual(w.synced[sourceUrlIndexKey], { 'example.com/article': ['dis'] });
  });
});

describe('loadTrackedSites', () => {
  it('groups Incremental and Dismissed Rems by website, and leaves stale entries out', async () => {
    const w = world([
      link('en', 'https://en.wikipedia.org/wiki/A'),
      link('pt', 'https://pt.wikipedia.org/wiki/B'),
      { _id: 'inc', sources: ['en'], powerups: [powerupCode] },
      { _id: 'dis', sources: ['pt'], powerups: [dismissedPowerupCode] },
      { _id: 'lost', sources: ['pt'] },
    ]);
    w.synced[sourceUrlIndexKey] = {
      'en.wikipedia.org/wiki/A': ['inc'],
      'pt.wikipedia.org/wiki/B': ['dis', 'lost', 'deleted'],
    };
    const { sites, scanned } = await loadTrackedSites(w.plugin);
    assert.equal(scanned, false);
    assert.equal(sites.length, 1);
    assert.equal(sites[0].domain, 'wikipedia.org');
    assert.deepEqual(sites[0].rems.map((rem) => [rem.remId, rem.status]).sort(), [
      ['dis', 'dismissed'],
      ['inc', 'incremental'],
    ]);
  });
});

describe('websiteOfRem', () => {
  it('finds the website on the Rem or its nearest ancestor with a web source', async () => {
    const w = world([
      link('l', 'https://www.supermemo.guru/wiki/X'),
      { _id: 'doc', sources: ['l'] },
      { _id: 'extract', parent: 'doc' } as any,
      { _id: 'plain' },
    ]);
    assert.equal(await websiteOfRem(w.plugin, w.get('extract')), 'supermemo.guru');
    assert.equal(await websiteOfRem(w.plugin, w.get('plain')), undefined);
    assert.equal(await websiteOfRem(w.plugin, undefined), undefined);
  });
});
