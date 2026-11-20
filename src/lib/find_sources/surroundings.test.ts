/**
 * Where a note sits, as Find Sources / Check Statement / Ask Your Sources send it
 * (noteSurroundings): a descriptor's chain as CONTEXT, the Rems above as OUTLINE PATH.
 * Run with `npm test`. The outline follows a real one (PSCPP › Tug Use › …).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { noteSurroundings } from './surroundings';

interface Fake {
  _id: string;
  text: string;
  type?: number;
  doc?: boolean;
  parent?: Fake;
}
const rem = (f: Fake): any => ({
  _id: f._id,
  text: [f.text],
  type: f.type ?? 0,
  getParentRem: async () => (f.parent ? rem(f.parent) : undefined),
  isDocument: async () => !!f.doc,
});
const textOf = async (r: any) => (r.text as string[]).join('');

const root: Fake = { _id: 'R', text: 'PSCPP', doc: true };
const tugUse: Fake = { _id: 'T', text: 'Tug Use', doc: true, parent: root };
const methods: Fake = { _id: 'M', text: '3) Assisting methods', doc: true, parent: tugUse };
const ice: Fake = { _id: 'I', text: '3.3) Tug assistance in ice', parent: methods };
const tugs: Fake = { _id: 'N', text: 'Rebocadores com tubulão', doc: true, parent: ice };

describe('noteSurroundings', () => {
  it('a descriptor: its concept as CONTEXT, the outline above it, up to its document', async () => {
    const q = rem({ _id: 'Q', text: 'Não pode rebocar em que método?', type: 2, parent: tugs });
    const s = await noteSurroundings(q, textOf, true);
    assert.deepEqual(s.ancestors, ['N', 'I', 'M', 'T', 'R']);
    assert.equal(s.context, 'Rebocadores com tubulão');
    assert.equal(s.outline, '3) Assisting methods › 3.3) Tug assistance in ice');
  });

  it('a nested descriptor chain: the concept, then the descriptors, outermost first', async () => {
    const d1: Fake = { _id: 'D1', text: 'no gelo', type: 2, parent: tugs };
    const q = rem({ _id: 'Q', text: 'por quê?', type: 2, parent: d1 });
    const s = await noteSurroundings(q, textOf, true);
    assert.equal(s.context, 'Rebocadores com tubulão › no gelo');
  });

  it('any other Rem: no CONTEXT, the outline up to its document, never a long note', async () => {
    const long: Fake = { _id: 'L', text: 'x'.repeat(200), parent: ice };
    const q = rem({ _id: 'Q', text: 'Quando se aceita rebocar com cabo longo no gelo?', parent: long });
    const s = await noteSurroundings(q, textOf, true);
    assert.equal(s.context, undefined);
    assert.equal(s.outline, '3) Assisting methods › 3.3) Tug assistance in ice');
  });

  it('Find Sources: no outline', async () => {
    const q = rem({ _id: 'Q', text: 'Não pode rebocar em que método?', type: 2, parent: tugs });
    const s = await noteSurroundings(q, textOf, false);
    assert.equal(s.context, 'Rebocadores com tubulão');
    assert.equal(s.outline, undefined);
  });
});
