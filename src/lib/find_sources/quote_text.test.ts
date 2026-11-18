import assert from 'node:assert/strict';
import { attribution, boldToRichText, checkedQuote, emphasisSegments, mergedQuote, segmentsToRichText } from './quote_text';

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

// Claude's **bold** as rich text (Ask Your Sources).
assert.deepEqual(boldToRichText('mede **45°**, não **35°**.'), [
  'mede ',
  { i: 'm', text: '45°', b: true },
  ', não ',
  { i: 'm', text: '35°', b: true },
  '.',
]);

// Excerpts chosen by Claude: kept only when really in the passage, in passage order.
{
  const context =
    'Unfortunately, the optimum maximum angle for the flukes varies from about 30° for sand to about 50° for mud, so the makers of ship\'s anchors usually compromise between these two values by making the maximum angle of tilt between 35° and 37°. Too little tilt and the anchor drags.';
  const q = checkedQuote(
    {
      index: 1,
      excerpts: ['Too little tilt and the anchor drags.', 'the optimum maximum angle for the flukes varies from about 30° for sand to about 50° for mud', 'an invented sentence'],
      emphasis: ['30° for sand', '50° for mud', 'not there'],
      key: '50°',
    },
    context
  )!;
  assert.deepEqual(q.excerpts, [
    'the optimum maximum angle for the flukes varies from about 30° for sand to about 50° for mud',
    'Too little tilt and the anchor drags.',
  ]);
  assert.deepEqual(q.emphasis, ['30° for sand', '50° for mud']);
  assert.equal(q.key, '50°');
  // Spacing and quotes from the PDF don't matter; an excerpt that is not there at all is dropped.
  assert.ok(checkedQuote({ index: 0, excerpts: ['ship’s  anchors usually compromise'], emphasis: [], key: '' }, context));
  assert.equal(checkedQuote({ index: 0, excerpts: ['nothing like it'], emphasis: [], key: '' }, context), null);
  // Two sections' quotes of one passage, merged for the review.
  const m = mergedQuote(
    [
      { index: 1, excerpts: ['Too little tilt and the anchor drags.'], emphasis: ['drags'], key: '' },
      { index: 1, excerpts: ['between 35° and 37°'], emphasis: ['35° and 37°'], key: '' },
    ],
    context
  )!;
  assert.deepEqual(m.excerpts, ['between 35° and 37°', 'Too little tilt and the anchor drags.']);
}

console.log('find_sources quote_text: ok');
