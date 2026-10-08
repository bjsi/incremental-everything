/**
 * Which Rem a queue command acts on inside a Card Cluster. Run with `npm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getQueueVisibleCard } from './queue_visible_card';

type FakeRem = { _id: string; parent?: string; cluster?: boolean };

function fakePlugin(opts: {
  current?: { _id: string; remId: string };
  visibleCardId?: string;
  cards?: Record<string, string>;
  rems?: FakeRem[];
}) {
  const rems = new Map((opts.rems || []).map((r) => [r._id, r]));
  return {
    queue: { getCurrentCard: async () => opts.current },
    storage: { getSession: async () => opts.visibleCardId },
    card: {
      findOne: async (id: string) =>
        opts.cards?.[id] ? { _id: id, remId: opts.cards[id] } : undefined,
    },
    rem: {
      findOne: async (id: string) => {
        const rem = rems.get(id);
        if (!rem) return undefined;
        return {
          ...rem,
          hasPowerup: async (code: string) => code === 'cc' && !!rem.cluster,
          getTagRems: async () => [],
        };
      },
    },
  } as any;
}

const clusterRems: FakeRem[] = [
  { _id: 'parent', cluster: true },
  { _id: 'remA', parent: 'parent' },
  { _id: 'remB', parent: 'parent' },
];

describe('getQueueVisibleCard', () => {
  it('no current card: nothing, whatever the broadcast says', async () => {
    const plugin = fakePlugin({ visibleCardId: 'cB', cards: { cB: 'remB' }, rems: clusterRems });
    assert.equal(await getQueueVisibleCard(plugin), undefined);
  });

  it('no broadcast: the current card', async () => {
    const plugin = fakePlugin({ current: { _id: 'cA', remId: 'remA' } });
    assert.deepEqual(await getQueueVisibleCard(plugin), { remId: 'remA', cardId: 'cA' });
  });

  it('a cluster sibling on screen wins over the anchor', async () => {
    const plugin = fakePlugin({
      current: { _id: 'cA', remId: 'remA' },
      visibleCardId: 'cB',
      cards: { cB: 'remB' },
      rems: clusterRems,
    });
    assert.deepEqual(await getQueueVisibleCard(plugin), { remId: 'remB', cardId: 'cB' });
  });

  it('the anchor may be the cluster Rem itself', async () => {
    const plugin = fakePlugin({
      current: { _id: 'cP', remId: 'parent' },
      visibleCardId: 'cB2',
      cards: { cB2: 'remB' },
      rems: clusterRems,
    });
    assert.deepEqual(await getQueueVisibleCard(plugin), { remId: 'remB', cardId: 'cB2' });
  });

  it('another card of the same Rem is accepted without a cluster', async () => {
    const plugin = fakePlugin({
      current: { _id: 'cA', remId: 'remA' },
      visibleCardId: 'cA2',
      cards: { cA2: 'remA' },
    });
    assert.deepEqual(await getQueueVisibleCard(plugin), { remId: 'remA', cardId: 'cA2' });
  });

  it('a stale broadcast from plain siblings falls back to the current card', async () => {
    const plugin = fakePlugin({
      current: { _id: 'cX', remId: 'remX' },
      visibleCardId: 'cY',
      cards: { cY: 'remY' },
      rems: [
        { _id: 'doc' },
        { _id: 'remX', parent: 'doc' },
        { _id: 'remY', parent: 'doc' },
      ],
    });
    assert.deepEqual(await getQueueVisibleCard(plugin), { remId: 'remX', cardId: 'cX' });
  });

  it('a stale broadcast from an unrelated cluster falls back too', async () => {
    const plugin = fakePlugin({
      current: { _id: 'cZ', remId: 'remZ' },
      visibleCardId: 'cB3',
      cards: { cB3: 'remB' },
      rems: [...clusterRems, { _id: 'remZ', parent: 'elsewhere' }],
    });
    assert.deepEqual(await getQueueVisibleCard(plugin), { remId: 'remZ', cardId: 'cZ' });
  });
});
