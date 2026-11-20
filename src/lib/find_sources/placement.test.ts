import assert from 'node:assert/strict';
import { insertPinsAt, placeInline, RichElement, sentenceEnd } from './placement';

const pin = (id: string) => ({ i: 'q', _id: id, pin: true });

// sentenceEnd: whole sentences only, past closing punctuation, lenient on spacing/case.
{
  const rt: RichElement[] = ['Métodos probabilísticos economizam. A largura depende do navio.'];
  assert.equal(sentenceEnd(rt, 'Métodos probabilísticos economizam'), 'Métodos probabilísticos economizam.'.length);
  assert.equal(sentenceEnd(rt, 'a largura depende do navio'), rt[0].length);
  // Not a whole sentence: starts mid-sentence.
  assert.equal(sentenceEnd(rt, 'probabilísticos economizam'), null);
  // Not there.
  assert.equal(sentenceEnd(rt, 'profundidade do canal'), null);
}

// Across a formatted run, and refusing a match through a reference.
{
  const rt: RichElement[] = ['O navio de ', { i: 'm', b: true, text: 'projeto' }, ' define a largura. Outro ponto.'];
  assert.equal(sentenceEnd(rt, 'O navio de projeto define a largura.'), 'O navio de projeto define a largura.'.length);
  const withRef: RichElement[] = ['O ', { i: 'q', _id: 'X' }, ' define a largura. Outro.'];
  assert.equal(sentenceEnd(withRef, 'O navio define a largura'), null);
}

// insertPinsAt splits a string, keeps formatting when splitting a run, and appends at an element end.
{
  const rt: RichElement[] = ['Uma. Duas.'];
  assert.deepEqual(insertPinsAt(rt, 4, ['A']), ['Uma.', ' ', pin('A'), ' Duas.']);
  const bold: RichElement[] = [{ i: 'm', b: true, text: 'Uma. Duas.' }];
  assert.deepEqual(insertPinsAt(bold, 4, ['A']), [
    { i: 'm', b: true, text: 'Uma.' },
    ' ',
    pin('A'),
    { i: 'm', b: true, text: ' Duas.' },
  ]);
  assert.deepEqual(insertPinsAt(['Fim.'], 4, ['A']), ['Fim.', ' ', pin('A')]);
}

// placeInline: two passages on two sentences → inline; one passage → nothing placed.
{
  const rt: RichElement[] = ['Métodos probabilísticos economizam. A largura depende do navio.'];
  const two = placeInline(rt, [
    { covers: 'Métodos probabilísticos economizam.', pins: ['A'] },
    { covers: 'A largura depende do navio.', pins: ['B'] },
  ]);
  assert.deepEqual(two.placed, [0, 1]);
  assert.deepEqual(two.text, ['Métodos probabilísticos economizam.', ' ', pin('A'), ' A largura depende do navio.', ' ', pin('B')]);

  const one = placeInline(rt, [{ covers: 'Métodos probabilísticos economizam.', pins: ['A'] }, { covers: '', pins: ['B'] }]);
  assert.deepEqual(one.placed, []);
  assert.deepEqual(one.text, rt);

  // Both on the same sentence: not a mix, so nothing inline.
  const same = placeInline(rt, [
    { covers: 'Métodos probabilísticos economizam.', pins: ['A'] },
    { covers: 'Métodos probabilísticos economizam', pins: ['B'] },
  ]);
  assert.deepEqual(same.placed, []);

  // A covers that cannot be placed is left for the end; the others still go inline.
  const three = placeInline(['Um ponto. Dois pontos. Três pontos.'], [
    { covers: 'Um ponto.', pins: ['A'] },
    { covers: 'Três pontos.', pins: ['B'] },
    { covers: 'pontos', pins: ['C'] },
  ]);
  assert.deepEqual(three.placed, [0, 1]);
}

console.log('find_sources placement: ok');
