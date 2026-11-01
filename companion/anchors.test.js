// Run from the repo root: node --test companion/anchors.test.js
// REAL_PAGE=<saved html> also runs the checks against a real page.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const A = require('./anchors.js');

const load = (html, url = 'https://example.org/a/b') => new JSDOM(html, { url }).window.document;

function selectText(doc, element, from = 0, to) {
  const node = element.firstChild;
  const range = doc.createRange();
  range.setStart(node, from);
  range.setEnd(node, to ?? node.length);
  return range;
}

describe('anchors', () => {
  const html = `<body><script>var hidden = "phrase";</script>
    <p id="a">The same   phrase
      here, first time.</p><p id="b">Some words and the same phrase here, second time.</p></body>`;

  it('round-trips a selection, ignoring whitespace runs', () => {
    const doc = load(html);
    const index = A.buildIndex(doc);
    const anchor = A.describeRange(index, selectText(doc, doc.querySelector('#a')));
    assert.equal(anchor.exact, 'The same phrase here, first time.');
    const found = A.resolveAnchor(index, anchor);
    assert.equal(found.how, 'exact');
    assert.equal(found.start, anchor.position);
    assert.equal(A.toRange(doc, index, found.start, found.end).toString().replace(/\s+/g, ' '), anchor.exact);
  });

  it('skips scripts when indexing', () => {
    assert.ok(!A.buildIndex(load(html)).text.includes('hidden'));
  });

  it('tells repeated text apart by its surroundings', () => {
    const doc = load(html);
    const index = A.buildIndex(doc);
    const second = doc.querySelector('#b');
    const start = second.textContent.indexOf('same phrase');
    const anchor = A.describeRange(index, selectText(doc, second, start, start + 'same phrase'.length));
    const moved = { ...anchor, position: 0 };
    assert.equal(A.resolveAnchor(index, moved).start, anchor.position);
  });

  it('survives text added before it', () => {
    const doc = load(html);
    const anchor = A.describeRange(A.buildIndex(doc), selectText(doc, doc.querySelector('#b')));
    doc.body.insertAdjacentHTML('afterbegin', '<p>A new paragraph appeared up here.</p>');
    const index = A.buildIndex(doc);
    const found = A.resolveAnchor(index, anchor);
    assert.equal(found.how, 'exact');
    assert.equal(index.text.slice(found.start, found.end), anchor.exact);
  });

  it('accepts an edited middle, and gives up when the text is gone', () => {
    const doc = load('<p id="p">Beginning of a rather long sentence, with a middle part, and then its proper ending here.</p>');
    const anchor = A.describeRange(A.buildIndex(doc), selectText(doc, doc.querySelector('#p')));
    doc.querySelector('#p').textContent = anchor.exact.replace('a middle part', 'an edited piece');
    assert.equal(A.resolveAnchor(A.buildIndex(doc), anchor).how, 'edges');
    doc.querySelector('#p').textContent = 'Something else altogether.';
    assert.equal(A.resolveAnchor(A.buildIndex(doc), anchor), null);
  });

  it('gives a range ending in the next paragraph the right text', () => {
    const doc = load('<div><p id="a">First paragraph.</p><p id="b">Second paragraph.</p></div>');
    const range = doc.createRange();
    range.setStart(doc.querySelector('#a').firstChild, 6);
    range.setEnd(doc.querySelector('#b').firstChild, 6);
    assert.equal(A.describeRange(A.buildIndex(doc), range).exact, 'paragraph.Second');
  });
});

describe('outline', () => {
  const html = `<body><h1>Title</h1><nav><h2>Menu</h2></nav><div id="toc"><h2 id="mw-toc-heading">Contents</h2></div>
    <p id="intro">Intro.</p>
    <h2 id="one">One <span class="mw-editsection">[edit]</span></h2><p id="p1">In one.</p>
    <h3 id="sub">One A</h3><p id="p2">In one A.</p>
    <h2 id="two">Two</h2><h4>Two deep</h4><p id="p3">In two deep.</p></body>`;

  it('reads nested sections, leaving out the title and navigation', () => {
    const outline = A.readOutline(load(html));
    assert.deepEqual(outline.map((s) => s.path), [['One'], ['One', 'One A'], ['Two'], ['Two', 'Two deep']]);
    assert.equal(outline[1].id, 'sub');
  });

  it('places a selection in the section above it', () => {
    const doc = load(html);
    const outline = A.readOutline(doc);
    const of = (id) => A.sectionOf(outline, selectText(doc, doc.querySelector(`#${id}`)))?.path;
    assert.equal(of('intro'), undefined);
    assert.deepEqual(of('p1'), ['One']);
    assert.deepEqual(of('p2'), ['One', 'One A']);
    assert.deepEqual(of('p3'), ['Two', 'Two deep']);
  });
});

describe('rangeToMarkdown', () => {
  it('keeps bold, italic, absolute links and images, on one line', () => {
    const doc = load('<div id="d"><p>Plain <b>bold</b> and <i>slanted</i></p><p>a <a href="/x">link</a> <img src="i.png" alt="pic"> star*</p></div>');
    const range = doc.createRange();
    range.selectNodeContents(doc.querySelector('#d'));
    assert.equal(
      A.rangeToMarkdown(range),
      'Plain **bold** and *slanted* a [link](https://example.org/x) ![pic](https://example.org/a/i.png) star\\*'
    );
  });

  const markdownOf = (html, url) => {
    const doc = load(`<div id="d">${html}</div>`, url);
    const range = doc.createRange();
    range.selectNodeContents(doc.querySelector('#d'));
    return A.rangeToMarkdown(range);
  };

  it('adds the size when the page gives it', () => {
    assert.equal(markdownOf('<img src="i.png" width="800" height="600">'), '![](https://example.org/a/i.png =800x600)');
  });

  it('makes a linked image just the image, as on wikis', () => {
    assert.equal(
      markdownOf('<a href="/wiki/File:X.jpg"><img src="/thumb/X.jpg" alt="X" width="10" height="20"></a> Figure'),
      '![X](https://example.org/thumb/X.jpg =10x20) Figure'
    );
  });

  it('keeps a text link that merely mentions an image', () => {
    assert.equal(markdownOf('<a href="/x">!\\[not an image</a>').startsWith('[!'), true);
  });

  it('leaves out images that have no web address', () => {
    assert.equal(markdownOf('Before <img src="data:image/png;base64,AAAA"> after'), 'Before after');
  });

  it('escapes parentheses and spaces in the address', () => {
    assert.equal(markdownOf('<img src="/a (1).png">'), '![](https://example.org/a%20%281%29.png)');
  });
});

if (process.env.REAL_PAGE) {
  describe('real page', () => {
    const doc = load(fs.readFileSync(process.env.REAL_PAGE, 'utf8'), 'https://supermemo.guru/wiki/Pleasure_of_learning');
    const paragraphs = [...doc.querySelectorAll('p')].filter((p) => p.textContent.trim().length > 60);

    it('reads the outline', () => {
      const outline = A.readOutline(doc);
      console.log(`${outline.length} sections; first: ${outline[0].text}; deepest: ${outline.reduce((a, b) => (b.depth > a.depth ? b : a)).path.join(' > ')}`);
      assert.ok(outline.length > 20);
      assert.equal(outline[0].text, 'The main problem in education');
      assert.ok(!outline.some((s) => s.text === 'Contents' || s.text === 'Tools'));
      assert.ok(outline.some((s) => s.path.join('>') === 'Knowledge valuation network>Knowledge valuation in the brain>Orbitofrontal cortex'));
    });

    it('round-trips every paragraph', () => {
      const index = A.buildIndex(doc);
      let exact = 0;
      for (const p of paragraphs) {
        const range = doc.createRange();
        range.selectNodeContents(p);
        const anchor = A.describeRange(index, range);
        const found = A.resolveAnchor(index, anchor);
        assert.equal(found.start, anchor.position);
        if (found.how === 'exact') exact++;
      }
      console.log(`${exact} of ${paragraphs.length} paragraphs found again exactly`);
      assert.equal(exact, paragraphs.length);
    });

    it('finds them again after the page gains text up top', () => {
      const anchors = paragraphs.map((p) => {
        const range = doc.createRange();
        range.selectNodeContents(p);
        return A.describeRange(A.buildIndex(doc), range);
      }).slice(0, 25);
      doc.body.insertAdjacentHTML('afterbegin', '<div>Cookie banner text that appeared later on the page.</div>');
      const index = A.buildIndex(doc);
      for (const anchor of anchors) assert.equal(index.text.slice(...Object.values(A.resolveAnchor(index, anchor)).slice(0, 2)), anchor.exact);
    });

    it('places a real paragraph in the right section', () => {
      const outline = A.readOutline(doc);
      const paragraph = paragraphs.find((p) => p.textContent.startsWith('The main problem with regards to education'));
      const range = doc.createRange();
      range.selectNodeContents(paragraph);
      assert.deepEqual(A.sectionOf(outline, range).path, ['The main problem in education']);
      console.log('markdown sample:', A.rangeToMarkdown(range).slice(0, 170));
    });
  });
}
