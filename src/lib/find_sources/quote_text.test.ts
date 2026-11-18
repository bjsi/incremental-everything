import assert from 'node:assert/strict';
import { attribution, emphasisSegments, segmentsToRichText } from './quote_text';

// Bold phrases and a key word inside one of them; text is never changed.
{
  const text = 'The maximum wave-induced vertical ship motion is the largest probabilistic factor.';
  const segs = emphasisSegments(text, ['wave-induced vertical ship motion', 'the largest probabilistic factor'], 'largest');
  assert.equal(segs.map((s) => s.text).join(''), text);
  assert.deepEqual(
    segs.filter((s) => s.bold).map((s) => [s.text, s.italic]),
    [
      ['wave-induced vertical ship motion', false],
      ['the ', false],
      ['largest', true],
      [' probabilistic factor', false],
    ]
  );
}

// A phrase that is not in the text is ignored; case differences are tolerated.
{
  const segs = emphasisSegments('A direct addition would lead to over-design.', ['Direct Addition', 'missing words']);
  assert.deepEqual(segs.map((s) => [s.text, s.bold]), [
    ['A ', false],
    ['direct addition', true],
    [' would lead to over-design.', false],
  ]);
}

// Rich text: plain strings and formatted runs.
assert.deepEqual(segmentsToRichText(emphasisSegments('ab cd', ['cd'], 'd')), [
  'ab ',
  { i: 'm', text: 'c', b: true },
  { i: 'm', text: 'd', b: true, l: true },
]);

// Attribution in the skills' format.
assert.equal(attribution({ cite: 'PIANC 121', page: 30, edital: 'sim' }), '(PIANC 121, PDF p. 30)');
assert.equal(
  attribution({ cite: 'BPG', sectionNumber: '5.2.1', page: 95, edital: 'obra-fora' }),
  '(BPG, §5.2.1, PDF p. 95; fora do edital)'
);

console.log('find_sources quote_text: ok');
