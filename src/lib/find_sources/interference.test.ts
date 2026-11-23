import assert from 'node:assert/strict';
import {
  bestNoteMatch,
  cardPreview,
  discriminationCards,
  itemLine,
  noteMatchScore,
  noteTokens,
  parseInterferenceItems,
  sentenceAround,
} from './interference_items';

const ARTE_NAVAL =
  'À voz de “PREPARAR PARA LARGAR O FERRO”, dada a cerca de 1.000 jds do ponto de fundeio, o Sr. Mestre inicia ' +
  'os procedimentos para deixar o ferro pronto para largar. A partir desse momento, as distâncias passam a ser ' +
  'reportadas a cada 100 jds para a estação “proa”, pela estação “manobra”. \n\nÀ voz de “ATENÇÃO PARA LARGAR O ' +
  'FERRO”, dada a cerca de 100 jds do ponto de fundeio, o Sr. Mestre determina que o freio do cabrestante seja aberto.';

// The whole sentence around an excerpt: past "1.000" and "Sr.", stopping at the real full stop.
assert.equal(
  sentenceAround(ARTE_NAVAL, 'dada a cerca de 1.000 jds do ponto de fundeio'),
  'À voz de “PREPARAR PARA LARGAR O FERRO”, dada a cerca de 1.000 jds do ponto de fundeio, o Sr. Mestre inicia ' +
    'os procedimentos para deixar o ferro pronto para largar.'
);
assert.equal(
  sentenceAround(ARTE_NAVAL, 'as distâncias passam a ser reportadas a cada 100 jds'),
  'A partir desse momento, as distâncias passam a ser reportadas a cada 100 jds para a estação “proa”, pela estação “manobra”.'
);
// A blank line ends a sentence too; an excerpt not in the text comes back as it is.
assert.ok(sentenceAround(ARTE_NAVAL, 'ATENÇÃO PARA LARGAR O FERRO').startsWith('À voz de “ATENÇÃO'));
assert.equal(sentenceAround(ARTE_NAVAL, 'nada disso'), 'nada disso');
// A list number at a line start is not a sentence end; the list's lead-in line is left out.
assert.equal(
  sentenceAround('Aproximação:\n1. A 1.000 jardas do ponto de fundeio, reduzir para 5 a 7 nós. 2. Parar.', 'reduzir para 5 a 7 nós'),
  '1. A 1.000 jardas do ponto de fundeio, reduzir para 5 a 7 nós.'
);

// A heading line, ";" and ":" and numbered steps bound the pinned stretch.
assert.equal(
  sentenceAround(
    'Manobra da proa: À ordem do Comando de deixar o ferro pronto a largar, este deve ser arriado. Após isso, deve-se passar o freio.',
    'este deve ser arriado'
  ),
  'À ordem do Comando de deixar o ferro pronto a largar, este deve ser arriado.'
);
assert.equal(
  sentenceAround(
    '(8) dá-se ordem para que todo o pessoal fique safo da amarra;\n(9) aperta-se bem o freio mecânico; (10) dá a voz de Ferro Pronto; (11) o Comandante dá a ordem de Larga o Ferro; (12) abre-se o freio, girando o seu volante;',
    'o Comandante dá a ordem de Larga o Ferro'
  ),
  '(11) o Comandante dá a ordem de Larga o Ferro;'
);
assert.equal(
  sentenceAround('12.42.3. Manobra da proa\nÀ voz de “LARGAR O FERRO”, o homem bate com a marreta na patola.', 'o homem bate com a marreta'),
  'À voz de “LARGAR O FERRO”, o homem bate com a marreta na patola.'
);

// Tokens: accents off, numbers whole, short and common words out.
assert.deepEqual([...noteTokens('dada a cerca de 1.000 jds do ponto')].sort(), ['1000', 'cerca', 'dada', 'jds', 'ponto']);

// The user's own Rem that states the excerpt: the sibling card, not the next step's.
{
  const excerpt = 'À voz de “PREPARAR PARA LARGAR O FERRO”, dada a cerca de 1.000 jds do ponto de fundeio';
  const preparar = {
    id: 'cM4y',
    text:
      'À voz de “Preparar para largar o ferro”, dada a cerca de 1.000 jds do ponto de fundeio, o Sr. Mestre inicia os ' +
      'procedimentos para deixar o ferro pronto para largar. A partir desse momento, as distâncias passam a ser ' +
      'reportadas a cada 100 jds para a estação “proa”, pela estação “manobra”.',
  };
  const largar = { id: 'e7Yk', text: 'À voz de “Largar o ferro! ”, o homem bate com a marreta na Patola, no sentido de abri-la.' };
  assert.equal(bestNoteMatch([largar, preparar], excerpt)?.id, 'cM4y');
  assert.equal(bestNoteMatch([largar], excerpt), undefined);
  // A card that rewrote the number ("3 x LS") still matches on the rest of its words.
  assert.ok(
    noteMatchScore(
      'o navio deve se aproximar do fundeadouro em velocidade reduzida e parar as máquinas a cerca de 3 x LS da posição escolhida.',
      'parar as máquinas a cerca de três comprimentos (do navio) da posição escolhida'
    ) >= 0.4
  );
}

// Items: quotes checked against the passage, kinds validated, duplicates dropped; sides structured.
{
  const contexts = [ARTE_NAVAL];
  const items = parseInterferenceItems(
    [
      {
        kind: 'similar',
        frame: 'Distância ao ponto de fundeio',
        here: { subject: '“Atenção para largar o ferro”', value: '~100 jds' },
        there: { subject: '“Preparar para largar o ferro”', value: '~1.000 jds' },
        quote: { passage: 1, excerpts: ['dada a cerca de 1.000 jds do ponto de fundeio'], emphasis: ['1.000 jds'], key: '1.000' },
      },
      { kind: 'similar', frame: 'x', here: 'a', there: 'b', quote: { passage: 1, excerpts: ['dada a cerca de 1.000 jds do ponto de fundeio'] } },
      { kind: 'invented', frame: 'x', here: 'a', there: 'b', quote: { passage: 1, excerpts: ['as distâncias passam'] } },
      { kind: 'diverges', frame: 'x', here: 'a', there: 'b', quote: { passage: 1, excerpts: ['typed by the model'] } },
      { kind: 'converges', frame: 'x', here: 'a', there: 'b', quote: { passage: 2, excerpts: ['as distâncias passam'] } },
      // an older reply: "axis" and plain-string sides still read
      { kind: 'similar', axis: 'Valor de 100 jds', here: 'Atenção, ~100 jds', there: 'reporte a cada 100 jds', quote: { passage: 1, excerpts: ['as distâncias passam a ser reportadas a cada 100 jds'] } },
    ],
    contexts
  );
  assert.equal(items.length, 2);
  assert.equal(items[0].quote.key, '1.000');
  assert.equal(
    itemLine(items[0]),
    '**Distância ao ponto de fundeio**: “Atenção para largar o ferro”, ~100 jds × “Preparar para largar o ferro”, ~1.000 jds'
  );
  assert.equal(items[1].frame, 'Valor de 100 jds');
  assert.deepEqual(items[1].there, { subject: 'reporte a cada 100 jds', value: '' });
  assert.equal(
    itemLine({ kind: 'converges', frame: 'Distância', here: { subject: 'a', value: '1' }, there: { subject: 'b', value: '2' } }),
    '**Distância**: b, 2'
  );
}

// Discrimination cards: one ladder per frame, the note's value last and shown; another book named.
{
  const frame = 'Distância ao ponto de fundeio';
  const here = { subject: 'Atenção para largar o ferro', value: '~100 jds' };
  const arte = { id: 'arte-naval-2', cite: 'Arte Naval' };
  const plans = discriminationCards(
    [
      { key: 'a', info: { kind: 'similar', frame, here, there: { subject: 'Preparar para largar o ferro', value: '~1.000 jds' } }, book: arte },
      { key: 'b', info: { kind: 'similar', frame: 'Distância ao ponto de fundeio ', here, there: { subject: 'máquinas paradas', value: '~300 jardas' } }, book: { id: 'miguens-1', cite: 'Miguens' } },
      { key: 'c', info: { kind: 'similar', frame: 'Valor de 100 jds', here, there: { subject: 'reporte', value: '' } }, book: arte },
      { key: 'd', info: { kind: 'converges', frame, here, there: { subject: 'x', value: 'y' } }, book: arte },
      { key: 'e', info: { kind: 'diverges', frame: 'Parar as máquinas', here: { subject: 'parar', value: '~3 comprimentos' }, there: { subject: 'parar', value: '~300 jardas' } }, book: { id: 'miguens-1', cite: 'Miguens' } },
    ],
    arte,
    'pt'
  );
  assert.equal(plans.length, 2);
  assert.deepEqual(plans[0].keys, ['a', 'b']);
  assert.equal(
    cardPreview(plans[0]),
    'Distância ao ponto de fundeio — Preparar para largar o ferro: {{~1.000 jds}} · máquinas paradas (Miguens): {{~300 jardas}} · Atenção para largar o ferro: ~100 jds'
  );
  assert.equal(cardPreview(plans[1]), 'Parar as máquinas — Miguens: {{~300 jardas}} · Arte Naval: ~3 comprimentos');
  // A subject already in parentheses takes the book inside them.
  assert.equal(
    cardPreview(
      discriminationCards(
        [{ key: 'm', info: { kind: 'similar', frame: 'F', here, there: { subject: 'máquinas paradas (Fragatas)', value: '~300 jardas' } }, book: { id: 'miguens-1', cite: 'Miguens I' } }],
        arte,
        'pt'
      )[0]
    ),
    'F — máquinas paradas (Fragatas; Miguens I): {{~300 jardas}} · Atenção para largar o ferro: ~100 jds'
  );
  // Without the note's book, a divergence's own side is "esta nota".
  assert.ok(cardPreview(discriminationCards([{ key: 'e', info: { kind: 'diverges', frame: 'F', here: { subject: 's', value: '1' }, there: { subject: 's', value: '2' } }, book: { cite: 'Miguens' } }], undefined, 'pt')[0]).endsWith('esta nota: 1'));
}

console.log('interference tests passed');
