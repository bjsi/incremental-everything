import assert from 'node:assert/strict';
import { groupOf, isLeadIn, joinList, OutlineNode, pinTarget, statementsInOutline } from './outline';

const leaf = (id: string, text: string): OutlineNode => ({ id, text, children: [] });
const node = (id: string, text: string, children: OutlineNode[], heading = false): OutlineNode => ({
  id,
  text,
  children,
  heading,
});

// The user's samples (Nov 18, 2026).
const s5ibb = node('s5ibb', 'A Figura mostra que a profundidade segura necessária de um canal é determinada por:', [
  leaf('a', "fatores do nível d'água,"),
  leaf('b', 'fatores do navio e'),
  leaf('c', 'fatores do fundo.'),
]);
const d8Bs = node('d8Bs', 'Folga Abaixo da Quilha Bruta (Gross UKC); composta por 6 fatores:', [
  leaf('e1', 'margem para incertezas do calado estático'),
  leaf('e2', 'alteração na densidade da água'),
  leaf('e3', 'squat e trim dinâmico'),
  leaf('e4', 'adernamento dinâmico'),
  leaf('e5', 'margem para resposta a ondas'),
  leaf('e6', 'FAQ Líquida (Net UKC).'),
]);

// Lead-ins.
assert.equal(isLeadIn('…é determinada por:'), true);
assert.equal(isLeadIn('O navegante só terá evidência da largura a partir de'), true);
assert.equal(isLeadIn('Talvez o parâmetro mais importante do navio seja sua velocidade Vs.'), false);

// Joined the way the author punctuated it.
assert.equal(
  groupOf(s5ibb)!.text,
  "A Figura mostra que a profundidade segura necessária de um canal é determinada por: fatores do nível d'água, fatores do navio e fatores do fundo."
);
assert.equal(
  groupOf(d8Bs)!.text,
  'Folga Abaixo da Quilha Bruta (Gross UKC); composta por 6 fatores: margem para incertezas do calado estático; alteração na densidade da água; squat e trim dinâmico; adernamento dinâmico; margem para resposta a ondas; FAQ Líquida (Net UKC).'
);
assert.deepEqual(groupOf(d8Bs)!.members.map((m) => m.remId), ['e1', 'e2', 'e3', 'e4', 'e5', 'e6']);

// Not a list: a heading's children are full sentences; a long child breaks the list.
assert.equal(groupOf(node('h', 'Fatores Relacionados ao Navio', [leaf('x', 'Calado estático do navio')])), null);
assert.equal(
  groupOf(node('p', 'Os tipos são:', [leaf('x', 'uma frase muito longa '.repeat(12))])),
  null
);

// The tree: heading skipped, its sentence children on their own, a nested group as one.
const tQeV = node(
  'tQeV',
  'Fatores Relacionados ao Navio',
  [
    leaf('dqk', 'Calado estático do navio'),
    d8Bs,
    leaf('Nmz', 'Separadamente, uma margem de manobrabilidade (Manoeuvrability Margin - MM) é verificada para garantir uma folga mínima sob a quilha.'),
  ],
  true
);
const statements = statementsInOutline([tQeV], 6);
assert.deepEqual(statements.map((s) => s.headId), ['d8Bs', 'Nmz']);

// A nested list folds into its item.
const nested = node('n', 'Os parâmetros são:', [
  node('n1', 'do navio:', [leaf('n1a', 'calado (T)'), leaf('n1b', 'velocidade (Vs).')]),
  leaf('n2', 'do canal: profundidade (h).'),
]);
assert.equal(groupOf(nested)!.text, 'Os parâmetros são: do navio: calado (T); velocidade (Vs); do canal: profundidade (h).');

// Pin targets: the one item the passage supports, else the lead-in.
const g = groupOf(d8Bs)!;
assert.equal(pinTarget(g, 'squat e trim dinâmico'), 'e3');
assert.equal(pinTarget(g, 'margem para resposta a ondas'), 'e5');
assert.equal(pinTarget(g, 'adernamento dinâmico; margem para resposta a ondas'), 'd8Bs');
assert.equal(pinTarget(g, ''), 'd8Bs');
// "margem" alone sits in two items: not certain, so the lead-in.
assert.equal(pinTarget(g, 'margem'), 'd8Bs');

assert.equal(joinList('Tipos:', ['a', 'b']), 'Tipos: a; b.');

// A caption over a media Rem (an audio player, an image) is not a statement.
assert.deepEqual(
  statementsInOutline([node('cap', 'Audio gerado por IA, apenas para introduzir a matéria.', [leaf('audio', '')])], 6),
  []
);
console.log('find_sources outline: ok');
