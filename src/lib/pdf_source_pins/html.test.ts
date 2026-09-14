/**
 * Tests for HTML article anchoring. Run with `npm test`. Uses jsdom's DOMParser,
 * which parses like the browser's.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import {
  highlightDataFor,
  highlightSpan,
  mathPlaceholder,
  parseArticle,
  resolveXPath,
  textPosition,
  viewerHtml,
  xpathFor,
} from './html';
import { ownersByInterval, planFromOwners } from './overlap';

const { window } = new JSDOM('');
const parser = new window.DOMParser();

// The shape RemNote stores: readability's page div, then the content div.
const HTML =
  '<div class="page" id="readability-page-1"><div>' +
  '<p>Alpha beta <strong>gamma</strong> delta epsilon.</p>' +
  '<ol><li><strong>Rule one</strong><br>First words of the rule body are here.</li></ol>' +
  '</div></div>';

describe('parseArticle', () => {
  it('keeps words inside their text nodes, even without whitespace between nodes', () => {
    const article = parseArticle(HTML, parser);
    const texts = article.words.map((w) => w.text);
    assert.ok(texts.includes('one'));
    assert.ok(texts.includes('First'));
    assert.ok(!texts.includes('oneFirst'));
  });
});

describe('viewerHtml', () => {
  it('sanitizes before parsing, so removed elements affect paths as in the viewer', () => {
    const purify = createDOMPurify(window as any);
    const html = '<div><p>One<script>alert(1)</script>Two</p><p>Three words here</p></div>';
    const article = parseArticle(viewerHtml(html, (s) => String(purify.sanitize(s))), parser);
    // The script is gone and "One"/"Two" merge into a single text node, as in the viewer.
    assert.ok(!article.root.innerHTML.includes('script'));
    assert.equal(article.root.querySelector('p')!.childNodes.length, 1);
    const three = article.nodes.find((n) => n.node.data.startsWith('Three'))!.node;
    assert.equal(xpathFor(three, article.root), '/div[1]/p[2]/text()[1]');
  });

  it('gives a formula the same single-element footprint as KaTeX, so later siblings keep their paths', () => {
    const purify = createDOMPurify(window as any);
    const html = '<div><p>Area <inline_math>a<b</inline_math> is <block_math>x^2</block_math> then words follow here</p></div>';
    const article = parseArticle(viewerHtml(html, (s) => String(purify.sanitize(s)), mathPlaceholder), parser);
    const p = article.root.querySelector('p')!;
    assert.deepEqual(
      [...p.childNodes].map((n) => (n.nodeType === 3 ? '#text' : (n as Element).className)),
      ['#text', 'katex', '#text', 'katex-display', '#text']
    );
    const tail = article.nodes.find((n) => n.node.data.includes('follow'))!.node;
    assert.equal(xpathFor(tail, article.root), '/div[1]/p[1]/text()[3]');
  });

  it('renders math tags before sanitizing', () => {
    const html = '<p>Area <inline_math>x^2</inline_math> and <block_math>y</block_math></p>';
    const out = viewerHtml(html, (s) => s, (tex, display) => `<span class="katex">${display ? 'D' : 'I'}:${tex}</span>`);
    assert.equal(out, '<p>Area <span class="katex">I:x^2</span> and <span class="katex">D:y</span></p>');
  });
});

describe('xpathFor', () => {
  it('writes RemNote-style paths that resolve back to the same node', () => {
    const article = parseArticle(HTML, parser);
    for (const { node } of article.nodes) {
      assert.equal(resolveXPath(article, xpathFor(node, article.root)), node);
    }
    const gamma = article.nodes.find((n) => n.node.data === 'gamma')!.node;
    assert.equal(xpathFor(gamma, article.root), '/div[1]/div[1]/p[1]/strong[1]/text()[1]');
    const body = article.nodes.find((n) => n.node.data.startsWith('First'))!.node;
    assert.equal(xpathFor(body, article.root), '/div[1]/div[1]/ol[1]/li[1]/text()[1]');
  });
});

describe('textPosition', () => {
  it('maps an element boundary to the next text node, or past the end of the element', () => {
    const article = parseArticle(HTML, parser);
    const p = resolveXPath(article, '/div[1]/div[1]/p[1]')!;
    const gamma = article.nodes.find((n) => n.node.data === 'gamma')!;
    assert.equal(textPosition(article, p, 1), gamma.start); // before <strong>
    const epsilonEnd = article.text.indexOf('epsilon.') + 'epsilon.'.length;
    assert.equal(textPosition(article, p, p.childNodes.length), epsilonEnd);
  });
});

describe('highlightDataFor / highlightSpan', () => {
  it('produces Data whose anchor resolves back to the same words', () => {
    const article = parseArticle(HTML, parser);
    const k = article.words.findIndex((w) => w.text === 'beta');
    const words = article.words.slice(k, k + 4); // beta gamma delta epsilon.
    const data = highlightDataFor(article, words);
    assert.equal(data.text, 'beta gamma delta epsilon.');
    assert.equal(data.startXPath, '/div[1]/div[1]/p[1]/text()[1]');
    assert.equal(data.endXPath, '/div[1]/div[1]/p[1]/text()[2]');
    assert.equal(data.textBefore, 'Alpha');
    assert.deepEqual(highlightSpan(article, data), { start: words[0].start, end: words[3].end });
  });

  it('returns null when an anchor no longer resolves', () => {
    const article = parseArticle(HTML, parser);
    assert.equal(
      highlightSpan(article, { startXPath: '/div[9]/p[1]/text()[1]', endXPath: '/div[9]', startOffset: 0, endOffset: 1 }),
      null
    );
  });
});

describe('ownersByInterval', () => {
  it('feeds the shared plan: reuse the covering highlight, create the uncovered stretch', () => {
    const article = parseArticle(HTML, parser);
    const quote = article.words.slice(0, 5); // Alpha beta gamma delta epsilon.
    const k = article.words.findIndex((w) => w.text === 'Rule');
    const body = article.words.slice(k, k + 9);
    const existing = [{ remId: 'H', intervals: [{ start: quote[0].start, end: quote[4].end }] }];

    const inside = planFromOwners(quote, ownersByInterval(quote, existing));
    assert.deepEqual(inside.reuse, ['H']);
    assert.deepEqual(inside.create, []);

    const elsewhere = planFromOwners(body, ownersByInterval(body, existing));
    assert.deepEqual(elsewhere.reuse, []);
    assert.equal(elsewhere.create[0].length, 9);
  });
});
