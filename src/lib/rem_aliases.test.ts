/**
 * Aliases with their ids (rem_aliases.ts). Run with `npm test`.
 * "Today" = RemNote after its storage overhaul: the bridge answers {aliasId, text}
 * and an alias is not a Rem. "SDK only" = no raw call, so the SDK's wrapped answer
 * (and findOne on an alias that is still a Rem) is all there is.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { aliasesWithIds, aliasIdForText, aliasTextOf } from './rem_aliases';

const stored = [
  { aliasId: 'SVC', text: ['service power'] },
  { aliasId: 'SEA', text: ['sea margin'] },
];
const today: any = {
  _id: 'MARGIN',
  call: async (name: string, args?: any) => {
    if (name === 'getAliases') return stored;
    if (name === 'getOrCreateAliasWithText')
      return stored.find((a) => a.text[0] === args.aliasText[0]) ?? { aliasId: 'NEW', text: args.aliasText };
  },
  // What the SDK hands back: Rem shells with no id.
  getAliases: async () => stored.map((a) => ({ _id: undefined, text: a.text })),
};
const sdkOnly: any = {
  _id: 'OLD',
  getAliases: async () => [{ _id: 'OLDALIAS', text: ['velho'] }],
  getOrCreateAliasWithText: async () => ({ _id: 'OLDALIAS', text: ['velho'] }),
};
const plugin: any = {
  rem: { findOne: async (id: string) => (id === 'OLDALIAS' ? { _id: id, text: ['velho'] } : undefined) },
};

describe('rem aliases', () => {
  it('lists aliases with the ids the SDK drops', async () => {
    assert.deepEqual(await aliasesWithIds(today), stored);
    assert.deepEqual(await aliasesWithIds(sdkOnly), [{ aliasId: 'OLDALIAS', text: ['velho'] }]);
    assert.deepEqual(await aliasesWithIds(undefined), []);
  });
  it('reads one alias, or nothing when it is gone', async () => {
    assert.deepEqual(await aliasTextOf(plugin, today, 'SEA'), ['sea margin']);
    assert.equal(await aliasTextOf(plugin, today, 'GONE'), undefined);
    assert.deepEqual(await aliasTextOf(plugin, sdkOnly, 'OLDALIAS'), ['velho']);
  });
  it('finds an alias id by its text', async () => {
    assert.equal(await aliasIdForText(today, ['sea margin']), 'SEA');
    assert.equal(await aliasIdForText(sdkOnly, ['velho']), 'OLDALIAS');
  });
});
