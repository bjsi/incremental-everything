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

describe('rangeToRichText', () => {
  const richTextOf = (html, url) => {
    const doc = load(`<div id="d">${html}</div>`, url);
    const range = doc.createRange();
    range.selectNodeContents(doc.querySelector('#d'));
    return A.rangeToRichText(range);
  };

  it('keeps formats and absolute links, on one line', () => {
    assert.deepEqual(richTextOf('<p>Plain <b>bold</b> and <i>slanted</i></p><p>a <a href="/x">link</a></p>'), [
      'Plain ',
      { i: 'm', text: 'bold', b: true },
      ' and ',
      { i: 'm', text: 'slanted', l: true },
      ' a ',
      { i: 'm', text: 'link', iUrl: 'https://example.org/x' },
    ]);
  });

  it('leaves page text that looks like commands as text', () => {
    assert.deepEqual(richTextOf('a → b :: c \\[30\\] *d* ![x](y)'), ['a → b :: c \\[30\\] *d* ![x](y)']);
  });

  it('keeps a citation as a superscript link', () => {
    assert.deepEqual(richTextOf('as<sup><a href="#c">[30]</a></sup>'), [
      'as',
      { i: 'm', text: '[30]', sup: true, iUrl: 'https://example.org/a/b#c' },
    ]);
  });

  it('makes an image an image, with its size, inside a link or not', () => {
    assert.deepEqual(richTextOf('<a href="/wiki/File:X.jpg"><img src="/thumb/X.jpg" alt="X" width="10" height="20"></a> Figure'), [
      { i: 'i', url: 'https://example.org/thumb/X.jpg', width: 10, height: 20, title: 'X' },
      ' Figure',
    ]);
  });

  it('leaves out images that have no web address', () => {
    assert.deepEqual(richTextOf('Before <img src="data:image/png;base64,AAAA"> after'), ['Before after']);
  });

  const wikiMath = (tex, kind = 'inline') =>
    `<span class="mwe-math-element mwe-math-element-${kind}"><span class="mwe-math-mathml-a11y" style="display:none"><math alttext="{\\displaystyle ${tex}}"><semantics><mrow><mi>k</mi><mo>→</mo></mrow><annotation encoding="application/x-tex">{\\displaystyle ${tex}}</annotation></semantics></math></span><img src="https://wikimedia.org/render/svg/abc" class="mwe-math-fallback-image-${kind}" alt="{\\displaystyle ${tex}}"></span>`;

  it('turns a Wikipedia formula into LaTeX, once, with no image', () => {
    assert.deepEqual(richTextOf(`where ${wikiMath('C')} is`), ['where ', { i: 'x', text: 'C' }, ' is']);
  });

  it('marks a displayed formula as a block', () => {
    assert.deepEqual(richTextOf(wikiMath('\\Delta \\varphi', 'block')), [{ i: 'x', text: '\\Delta \\varphi', block: true }]);
    assert.deepEqual(
      richTextOf(`<img src="https://w.org/a" class="mwe-math-fallback-image-display" alt="{\\displaystyle x}">`),
      [{ i: 'x', text: 'x', block: true }]
    );
  });

  it('reads KaTeX', () => {
    const html = '<span class="katex"><span class="katex-mathml"><math><semantics><annotation encoding="application/x-tex">a^2</annotation></semantics></math></span><span class="katex-html">a2</span></span>';
    assert.deepEqual(richTextOf(html), [{ i: 'x', text: 'a^2' }]);
  });

  it('reads MathJax 2, leaving out what it draws', () => {
    const html = '<span class="MathJax">drawn</span><script type="math/tex; mode=display">b_1</script>';
    assert.deepEqual(richTextOf(html), [{ i: 'x', text: 'b_1', block: true }]);
  });

  it('leaves MathML with no LaTeX in it as text', () => {
    assert.deepEqual(richTextOf('<math><mi>k</mi></math>'), ['k']);
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
      console.log('rich text sample:', JSON.stringify(A.rangeToRichText(range)).slice(0, 170));
    });
  });
}
