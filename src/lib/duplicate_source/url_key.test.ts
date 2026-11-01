/**
 * URL comparison keys. Run with `npm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalUrlKey } from './url_key';

const same = (...urls: string[]) => {
  const keys = new Set(urls.map(canonicalUrlKey));
  assert.equal(keys.size, 1, `${urls.join(' , ')} gave ${[...keys].join(' , ')}`);
  assert.notEqual([...keys][0], null);
};
const different = (a: string, b: string) => assert.notEqual(canonicalUrlKey(a), canonicalUrlKey(b));

describe('canonicalUrlKey', () => {
  it('ignores the scheme, www, host case and a trailing slash', () => {
    same(
      'https://supermemo.guru/wiki/Minimum_definition',
      'http://supermemo.guru/wiki/Minimum_definition',
      'https://www.supermemo.guru/wiki/Minimum_definition',
      'https://SuperMemo.Guru/wiki/Minimum_definition/',
    );
  });
  it('ignores section fragments but keeps hash routes', () => {
    same(
      'https://help.supermemo.org/wiki/Incremental_learning',
      'https://help.supermemo.org/wiki/Incremental_learning#General_outline',
    );
    different('https://app.example.com/#/inbox', 'https://app.example.com/#/outbox');
    different('https://app.example.com/#!/post/1', 'https://app.example.com/#!/post/2');
  });
  it('ignores tracking parameters and parameter order, and keeps the others', () => {
    same('https://example.com/a?id=1&page=2', 'https://example.com/a?page=2&id=1&utm_source=x&fbclid=y');
    different('https://example.com/a?id=1', 'https://example.com/a?id=2');
  });
  it('keeps path case and treats encoded and plain paths alike', () => {
    different('https://gwern.net/spaced-repetition', 'https://gwern.net/Spaced-repetition');
    same('https://pt.wikipedia.org/wiki/Cronômetro_marítimo', 'https://pt.wikipedia.org/wiki/Cron%C3%B4metro_mar%C3%ADtimo');
  });
  it('reduces YouTube addresses to the video', () => {
    same(
      'https://www.youtube.com/watch?v=07EZFW96fDk',
      'https://youtu.be/07EZFW96fDk?si=abc',
      'https://m.youtube.com/watch?v=07EZFW96fDk&t=90s',
      'https://www.youtube.com/embed/07EZFW96fDk',
    );
    different('https://www.youtube.com/watch?v=aaa', 'https://www.youtube.com/watch?v=bbb');
    assert.equal(canonicalUrlKey('https://www.youtube.com/@channel'), 'youtube.com/@channel');
  });
  it('keeps subdomains and ports apart', () => {
    different('https://en.wikipedia.org/wiki/X', 'https://pt.wikipedia.org/wiki/X');
    different('http://localhost:3000/a', 'http://localhost:4000/a');
  });
  it('compares other schemes as written', () => {
    assert.equal(canonicalUrlKey('x-devonthink-item://ABC'), 'x-devonthink-item://ABC');
  });
  it('gives no key to what names no page', () => {
    for (const value of ['', '   ', '#fn:1', '/docs/a', undefined, null, 42]) {
      assert.equal(canonicalUrlKey(value), null);
    }
  });
});
