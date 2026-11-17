/**
 * Read aloud: a rem tree → spoken script. Run with `npm test`.
 * The fake tree follows a real note ("Definições Básicas", PIANC 121): Portuguese
 * text with italic English terms, an image, and the Incremental powerup's
 * property rems (Next Rep Date, Priority) as children.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildReadAloudScript, buildRemScript, guessLang, renderLine } from './read_aloud_script';

type El = any;
interface Fake {
  _id: string;
  text: El[];
  backText?: El[];
  children?: Fake[];
  property?: boolean;
  table?: boolean;
  parent?: Fake;
}

const m = (text: string, f: Record<string, unknown> = {}) => ({ i: 'm', text, ...f });

function fakeRem(f: Fake): any {
  return {
    _id: f._id,
    text: f.text,
    backText: f.backText,
    type: 0,
    isPowerupProperty: async () => !!f.property,
    isPowerupSlot: async () => false,
    isPowerup: async () => false,
    isTable: async () => !!f.table,
    isCode: async () => false,
    getPortalDirectlyIncludedRem: async () => [],
    getChildrenRem: async () => (f.children ?? []).map(fakeRem),
    getParentRem: async () => (f.parent ? fakeRem(f.parent) : undefined),
  };
}

const refTargets: Record<string, El[]> = {
  ALIAS: ['canal de navegação'],
  TARGET: ['Canal Principal'],
  MARGIN: ['Service power margin'],
};
/**
 * Aliases as RemNote now stores them: on the target, not as rems. `findOne` cannot
 * reach them; only the raw `getAliases` bridge call, as `{aliasId, text}`.
 */
const storedAliases: Record<string, { aliasId: string; text: El[] }[]> = {
  MARGIN: [
    { aliasId: 'OTHER', text: ['service power'] },
    { aliasId: 'SEA', text: ['sea margin'] },
  ],
};
const plugin: any = {
  rem: {
    findOne: async (id: string) =>
      refTargets[id]
        ? {
            _id: id,
            text: refTargets[id],
            call: async (name: string) => (name === 'getAliases' ? (storedAliases[id] ?? []) : undefined),
          }
        : undefined,
  },
  richText: {
    toString: async (rt: El[]) =>
      rt.map((e) => (typeof e === 'string' ? e : (e.text ?? ''))).join(''),
  },
};

const doc: Fake = {
  _id: 'DOC',
  text: [m('Definições Básicas', { b: true })],
  children: [
    {
      _id: 'A',
      text: ['Canal de Acesso (Approach Channel):'],
      children: [
        {
          _id: 'A1',
          text: [
            m('Canal externo (', { b: true }),
            m('outer channel)', { b: true, l: true }),
            m(':', { b: true }),
            ' localizado em águas abertas, como ',
            m('heave', { l: true }),
            ', ',
            m('pitch', { l: true }),
            ' e ',
            m('roll', { l: true }),
            '.',
          ],
        },
        {
          _id: 'A2',
          text: ['A força é ', { i: 'x', text: 'F = m a' }, ', de 120 kN [ver p. 12].'],
        },
      ],
    },
    {
      _id: 'B',
      text: [
        'Veja o ',
        { i: 'q', _id: 'TARGET', aliasId: 'ALIAS' },
        ' e a fonte ',
        { i: 'q', _id: 'H', pin: true },
        '.',
      ],
      children: [{ _id: 'IMG', text: [{ i: 'i', url: 'https://x/img.png' }] }],
    },
    {
      _id: 'AUD',
      text: ['🔊 Áudio (Kore) ', { i: 'a', url: 'https://x/a.mp3' }],
      children: [{ _id: 'SUM', text: ['resumo antigo'] }],
    },
    { _id: 'C', text: ['O que é o fairway?'], backText: ['A via navegável mais ampla'] },
    { _id: 'T', text: ['tabela'], table: true },
    { _id: 'P1', text: ['Next Rep Date ', 'November 1st, 2026'], property: true },
    { _id: 'P2', text: ['Priority 18'], property: true },
  ],
};

describe('buildReadAloudScript', () => {
  it('reads the tree in order with the reading rules', async () => {
    const out = await buildReadAloudScript(plugin, fakeRem(doc));
    assert.equal(out.lang, 'pt');
    assert.equal(out.title, 'Definições Básicas');
    assert.deepEqual(out.script.split('\n'), [
      '[pt] Definições Básicas.',
      '[pt] Canal de Acesso (Approach Channel):',
      '[pt] Canal externo (<en>outer channel</en>): localizado em águas abertas, como <en>heave</en>, <en>pitch</en> e <en>roll</en>.',
      '[pt] A força é (fórmula omitida), de 120 quilonewtons (ver página 12).',
      '[pt] Veja o canal de navegação e a fonte.',
      '[pt] O que é o fairway? A via navegável mais ampla.',
      '[pt] Tabela omitida.',
    ]);
    assert.deepEqual(out.source.split('\n'), [
      '- Definições Básicas',
      '  - Canal de Acesso (Approach Channel):',
      '    - Canal externo (*outer channel)*: localizado em águas abertas, como *heave*, *pitch* e *roll*.',
      '    - A força é \\(F = m a\\), de 120 kN [ver p. 12].',
      '  - Veja o canal de navegação e a fonte .',
      '  - O que é o fairway? ⇒ A via navegável mais ampla',
      '  - (table omitted)',
    ]);
    assert.equal(out.stats.skipped.properties, 2);
    assert.equal(out.stats.skipped.images, 1);
    assert.equal(out.stats.skipped.pins, 1);
    assert.equal(out.stats.skipped.formulas, 1);
    assert.equal(out.stats.skipped.audio, 1);
  });
});

describe('language marks', () => {
  it('guesses the language of a line', () => {
    assert.equal(guessLang('O canal normalmente termina em uma área de manobra'), 'pt');
    assert.equal(guessLang('The channel ends in a turning basin'), 'en');
  });
  it('never marks acronyms', () => {
    assert.equal(
      renderLine(
        [
          { text: 'A âncora ', italic: false },
          { text: 'HHP', italic: true },
        ],
        'pt'
      ),
      'A âncora HHP.'
    );
  });
  it('marks Portuguese italic terms in an English line', () => {
    assert.equal(
      renderLine(
        [
          { text: 'Fonseca calls it ', italic: false },
          { text: 'poder de unhar', italic: true },
        ],
        'en'
      ),
      'Fonseca calls it <pt>poder de unhar</pt>.'
    );
  });
});

describe('buildRemScript (pronunciation)', () => {
  it('reads front and back only: cloze whole, reference by alias, pin skipped', async () => {
    const out = await buildRemScript(
      plugin,
      fakeRem({
        _id: 'CARD',
        text: [
          'O ',
          m('canal de acesso', { cId: 'c1' }),
          ' liga o porto ao mar, ver ',
          {
            i: 'q',
            _id: 'TARGET',
            aliasId: 'ALIAS',
          },
          { i: 'q', _id: 'H', pin: true },
        ],
        backText: ['Chamado em inglês de ', m('approach channel', { l: true })],
        children: [{ _id: 'KID', text: ['não lido'] }],
      })
    );
    assert.deepEqual(out.script.split('\n'), [
      '[pt] O canal de acesso liga o porto ao mar, ver canal de navegação.',
      '[pt] Chamado em inglês de <en>approach channel</en>.',
    ]);
    assert.equal(out.stats.skipped.pins, 1);
  });
  it('reads an alias stored on its target (post-overhaul), and the target when the alias is gone', async () => {
    const out = await buildRemScript(
      plugin,
      fakeRem({
        _id: 'FLARE',
        text: [
          'Ships with an excessive bow flare are exposed to much higher sea loads. ',
          { i: 'q', _id: 'MARGIN', aliasId: 'SEA' },
          ' becomes useless, unlike the ',
          { i: 'q', _id: 'MARGIN', aliasId: 'GONE' },
          '.',
        ],
      })
    );
    assert.equal(
      out.script,
      'Ships with an excessive bow flare are exposed to much higher sea loads. sea margin becomes useless, unlike the Service power margin.'
    );
  });
  it('takes an undecided side from the other side, then from the parents', async () => {
    const parent: Fake = { _id: 'P', text: ['Termos do canal de navegação do porto'] };
    const one = await buildRemScript(plugin, fakeRem({ _id: 'W', text: ['fairway'], parent }));
    assert.equal(one.script, '[pt] fairway.');
    const italic = await buildRemScript(
      plugin,
      fakeRem({ _id: 'W3', text: [m('fairway', { l: true })], backText: ['hidrovia'], parent })
    );
    assert.deepEqual(italic.script.split('\n'), ['fairway.', '[pt] hidrovia.']);
    const two = await buildRemScript(
      plugin,
      fakeRem({ _id: 'W2', text: ['heave'], backText: ['The vertical motion of the ship'], parent })
    );
    assert.deepEqual(two.script.split('\n'), ['heave.', 'The vertical motion of the ship.']);
  });
});
