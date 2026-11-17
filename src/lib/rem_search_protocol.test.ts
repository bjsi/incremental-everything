/** The AI helper's search answer and query syntax (rem_search_protocol.ts). Run with `npm test`. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAiResponse, parseRemIdsResponse, parseSearchResponse, parseSuppressionResponse, usesQuerySyntax } from './rem_search_protocol';

describe('parseSearchResponse', () => {
  it('reads hits, keeping the alias a Rem matched through', () => {
    assert.deepEqual(
      parseSearchResponse({
        ok: true,
        ms: 5,
        total: 2,
        results: [{ remId: 'go7LdXuu9hpAZH12G' }, { remId: 'rzGXXDY2z0yi0Iefg', aliasId: 'qWCrdfRe3iCpnoLZg' }, { nope: 1 }],
      }),
      {
        status: 'ok',
        hits: [{ remId: 'go7LdXuu9hpAZH12G' }, { remId: 'rzGXXDY2z0yi0Iefg', aliasId: 'qWCrdfRe3iCpnoLZg' }],
        total: 2,
        ms: 5,
      }
    );
  });
  it('passes a query error on, and treats anything else as no helper', () => {
    assert.deepEqual(
      parseSearchResponse({ ok: true, queryError: { kind: 'unclosed-group', message: 'This "(" is never closed.', at: 4 } }),
      { status: 'query-error', error: { kind: 'unclosed-group', message: 'This "(" is never closed.', at: 4 } }
    );
    assert.deepEqual(parseSearchResponse({ ok: false, error: 'boom' }), { status: 'unavailable' });
    assert.deepEqual(parseSearchResponse({ ok: true }), { status: 'unavailable' });
    assert.deepEqual(parseSearchResponse(null), { status: 'unavailable' });
  });
});

describe('usesQuerySyntax', () => {
  it('spots operators, quotes, brackets and keys', () => {
    for (const q of ['bow -tug', 'bow or bowsprit', 'bow and wave', '"bow flare"', 'bow (wave)', 'in:PSCPP squat', 'w:bow', 'alias:x',
      'tag:anki squat', 'is:concept', '-is:incremental bow', 'prop:priority<20', 'incremental.priority<=5', 'ankicard.book:pna*', '*.book:x', 'added:7', 'has:alias',
      'is:due', 'card:cloze squat', 'ml:growing', 'rated:7:forgot', 'introduced:30', 'prop:lapses>3', 'suppressed:table',
      'prop:r<0.8', 'prop:s>21', 'scheduler:Vocabulary', 'is:fsrs']) {
      assert.equal(usesQuerySyntax(q), true, q);
    }
  });
  it('leaves plain words alone', () => {
    for (const q of ['bow weather wave', 'under-keel clearance', 'navegação interior', 'fig. 6.4', 'order', 'android', 'fig. 6.4: squat', 'e.g. squat', '3:30']) {
      assert.equal(usesQuerySyntax(q), false, q);
    }
  });
});

describe('parseRemIdsResponse', () => {
  it('reads the ids, and gives null for anything that is not an answer', () => {
    assert.deepEqual(parseRemIdsResponse({ ok: true, remIds: ['go7LdXuu9hpAZH12G', '', 3] }), ['go7LdXuu9hpAZH12G']);
    assert.deepEqual(parseRemIdsResponse({ ok: true, remIds: [] }), []);
    assert.equal(parseRemIdsResponse({ ok: true, queryError: { kind: 'index-building' } }), null);
    assert.equal(parseRemIdsResponse({ ok: false, error: 'boom' }), null);
    assert.equal(parseRemIdsResponse(null), null);
  });
});

describe('parseSuppressionResponse', () => {
  it('reads causes and table Rems, dropping unknown causes', () => {
    const out = parseSuppressionResponse({ ok: true, causes: { C1: 'paused', C2: 'cloze', C3: 'bogus' }, inTable: ['R1'] });
    assert.deepEqual(out && [...out.causes], [['C1', 'paused'], ['C2', 'cloze']]);
    assert.deepEqual(out && [...out.inTable], ['R1']);
    assert.equal(parseSuppressionResponse({ ok: true, queryError: { kind: 'index-building' } }), null);
    assert.equal(parseSuppressionResponse({ ok: false }), null);
  });
});

describe('parseAiResponse', () => {
  it('reads the query, its mode and whether it parses', () => {
    assert.deepEqual(parseAiResponse({ ok: true, query: ' is:due ', mode: 'cards', valid: true }), { query: 'is:due', mode: 'cards', valid: true });
    assert.deepEqual(parseAiResponse({ ok: true, query: '(bow', mode: 'x', valid: false, error: 'never closed' }), { query: '(bow', mode: null, valid: false, error: 'never closed' });
    assert.equal(parseAiResponse({ ok: false, error: 'claude CLI not found' }), null);
  });
});
