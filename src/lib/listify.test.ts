/**
 * Inline list detection and the inlinize layout cycle. Run with `npm test`.
 */
// listify pulls in the plugin SDK, whose bundle expects a browser `self`.
(globalThis as any).self ??= globalThis;

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cycleInlineListLayout, detectInlineList, inlinizeListInText } from './listify';
import { rtPlainStr } from './bulletize';

const plain = (rt: any[] | null) => (rt ? rtPlainStr(rt as any) : null);

const TRUE_FALSE =
  'Marque V ou F - Lei nº 9.432/1997: ( ) A Lei se aplica a embarcações de pesca. ' +
  '( ) No afretamento a casco nu, o afretador designa o comandante. ( ) Nas embarcações do REB, todos são brasileiros.';

describe('fill-in blank markers', () => {
  it('detects "( )" as list markers and keeps them in the items', () => {
    assert.equal(detectInlineList(TRUE_FALSE)?.kind, 'blank');
    assert.equal(
      plain(inlinizeListInText([TRUE_FALSE])),
      'Marque V ou F - Lei nº 9.432/1997:\n' +
        '• ( ) A Lei se aplica a embarcações de pesca.\n' +
        '• ( ) No afretamento a casco nu, o afretador designa o comandante.\n' +
        '• ( ) Nas embarcações do REB, todos são brasileiros.'
    );
  });

  it('accepts padded and underscored blanks, not a single one', () => {
    assert.equal(detectInlineList('Q: (  ) Um item. (__) Outro item.')?.markerOffsets.length, 2);
    assert.equal(detectInlineList('Uma frase ( ) com um parêntese vazio.'), null);
  });
});

describe('cycleInlineListLayout', () => {
  it('goes bullets -> spaced -> bullets with a caput', () => {
    const bullets = 'Caput:\n• 1 Um\n• 2 Dois';
    const spaced = plain(cycleInlineListLayout([bullets]));
    assert.equal(spaced, 'Caput:\n\n1 Um\n\n2 Dois');
    assert.equal(plain(cycleInlineListLayout([spaced!])), bullets);
  });

  it('round-trips a list with no caput', () => {
    const bullets = '• ( ) Um item.\n• ( ) Outro item.';
    const spaced = plain(cycleInlineListLayout([bullets]));
    assert.equal(spaced, '( ) Um item.\n\n( ) Outro item.');
    assert.equal(plain(cycleInlineListLayout([spaced!])), bullets);
  });

  it('keeps formatting on the item text', () => {
    const bold = { i: 'm', text: 'Dois', b: true };
    assert.deepEqual(cycleInlineListLayout(['Caput\n• Um\n• ', bold] as any), [
      'Caput\n',
      '\n',
      'Um\n',
      '\n',
      bold,
    ]);
  });

  it('leaves non-inlinized text to list detection', () => {
    assert.equal(cycleInlineListLayout([TRUE_FALSE]), null);
    assert.equal(cycleInlineListLayout(['Parágrafo um.\n\nParágrafo dois.']), null);
    assert.equal(cycleInlineListLayout(['Caput\n• só um item']), null);
  });
});
