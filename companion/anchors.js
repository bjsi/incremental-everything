// Finding text on a page again, and reading the page's outline. Pure DOM, so it
// also runs under jsdom in anchors.test.js.
(function (root) {
  const SKIP = 'script,style,noscript,template,textarea,select,svg,[data-ie-companion]';
  const NOT_CONTENT =
    'nav,aside,footer,[role=navigation],[role=complementary],.toc,#toc,.sidebar,#sidebar,.comments,#comments';
  const CONTEXT = 40;

  /** The page's text with whitespace runs collapsed, mapped back to text nodes per character. */
  function buildIndex(doc) {
    const walker = doc.createTreeWalker(doc.body, 4 /* SHOW_TEXT */);
    const chars = [];
    const nodes = [];
    const mapNode = [];
    const mapOffset = [];
    let pendingSpace = false;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest(SKIP)) continue;
      const value = node.nodeValue;
      const nodeIndex = nodes.push(node) - 1;
      for (let offset = 0; offset < value.length; offset++) {
        if (/\s/.test(value[offset])) {
          if (chars.length && !pendingSpace) {
            pendingSpace = true;
            chars.push(' ');
            mapNode.push(nodeIndex);
            mapOffset.push(offset);
          }
        } else {
          pendingSpace = false;
          chars.push(value[offset]);
          mapNode.push(nodeIndex);
          mapOffset.push(offset);
        }
      }
    }
    return { text: chars.join(''), nodes, mapNode, mapOffset };
  }

  /** Character position of a range's boundaries. comparePoint is monotonic, so this is a binary search. */
  function rangeToPositions(index, range) {
    const search = (accept) => {
      let low = 0;
      let high = index.text.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        const result = range.comparePoint(index.nodes[index.mapNode[middle]], index.mapOffset[middle]);
        if (accept(result)) high = middle;
        else low = middle + 1;
      }
      return low;
    };
    let start = search((r) => r >= 0);
    let end = search((r) => r > 0);
    while (end > start && index.text[end - 1] === ' ') end--;
    while (start < end && index.text[start] === ' ') start++;
    return { start, end };
  }

  function anchorAt(index, start, end) {
    return {
      exact: index.text.slice(start, end),
      prefix: index.text.slice(Math.max(0, start - CONTEXT), start),
      suffix: index.text.slice(end, end + CONTEXT),
      position: start,
    };
  }

  function describeRange(index, range) {
    const { start, end } = rangeToPositions(index, range);
    return end > start ? anchorAt(index, start, end) : null;
  }

  function matchingTail(a, b) {
    let n = 0;
    while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
    return n;
  }

  function matchingHead(a, b) {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
  }

  function allIndexesOf(text, needle) {
    const found = [];
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) found.push(at);
    return found;
  }

  /**
   * Finds an anchor in a page, possibly changed since. Returns { start, end, how }:
   * `exact` when the surrounding words agree or the text is unique, `ambiguous`
   * when it repeats with no context to choose by, `edges` when only its beginning
   * and end still match. Null when the text is gone.
   */
  function resolveAnchor(index, anchor) {
    const { text } = index;
    const hits = allIndexesOf(text, anchor.exact);
    if (hits.length) {
      let best = null;
      for (const start of hits) {
        const before = text.slice(Math.max(0, start - anchor.prefix.length), start);
        const end = start + anchor.exact.length;
        const after = text.slice(end, end + anchor.suffix.length);
        const score = matchingTail(before, anchor.prefix) + matchingHead(after, anchor.suffix);
        const distance = Math.abs(start - anchor.position);
        if (!best || score > best.score || (score === best.score && distance < best.distance)) {
          best = { start, end, score, distance };
        }
      }
      const how = hits.length === 1 || best.score > 0 ? 'exact' : 'ambiguous';
      return { start: best.start, end: best.end, how };
    }

    // The middle was edited: accept the same beginning and end at a similar length.
    const edge = Math.min(32, Math.floor(anchor.exact.length / 3));
    if (edge < 12) return null;
    const head = anchor.exact.slice(0, edge);
    const tail = anchor.exact.slice(-edge);
    let best = null;
    for (const start of allIndexesOf(text, head)) {
      const tailAt = text.indexOf(tail, start + edge);
      if (tailAt === -1) continue;
      const end = tailAt + edge;
      const drift = Math.abs(end - start - anchor.exact.length);
      if (drift <= anchor.exact.length * 0.5 && (!best || drift < best.drift)) best = { start, end, drift };
    }
    return best && { start: best.start, end: best.end, how: 'edges' };
  }

  function toRange(doc, index, start, end) {
    const range = doc.createRange();
    range.setStart(index.nodes[index.mapNode[start]], index.mapOffset[start]);
    range.setEnd(index.nodes[index.mapNode[end - 1]], index.mapOffset[end - 1] + 1);
    return range;
  }

  function headingText(element) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll('.mw-editsection,[aria-hidden=true],script,style').forEach((n) => n.remove());
    return clone.textContent.replace(/\s+/g, ' ').trim();
  }

  /**
   * The page's sections in order, each with its path of ancestor titles. The first
   * h1 is left out when it opens the page, since that is the document's own title.
   */
  function readOutline(doc) {
    let elements = [...doc.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(
      (el) => !el.closest(NOT_CONTENT) && !el.hidden && el.id !== 'mw-toc-heading' && headingText(el)
    );
    if (elements[0]?.tagName === 'H1' && elements.filter((el) => el.tagName === 'H1').length === 1) {
      elements = elements.slice(1);
    }
    const stack = [];
    return elements.map((element) => {
      const level = Number(element.tagName[1]);
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      const text = headingText(element);
      const path = [...stack.map((s) => s.text), text];
      stack.push({ level, text });
      return { element, level, text, path, depth: path.length, id: element.id || element.querySelector('[id]')?.id || '' };
    });
  }

  /** The section a range falls in: the last heading before it. */
  function sectionOf(outline, range) {
    let found = null;
    for (const section of outline) {
      const relation = range.comparePoint(section.element, 0);
      if (relation < 0 || section.element.contains(range.startContainer)) found = section;
      else break;
    }
    return found;
  }

  /** A formula's LaTeX, without the wrapper Wikipedia puts around it. */
  function cleanLatex(tex) {
    const text = (tex || '').trim();
    const wrapped = text.match(/^\{\\(?:displaystyle|textstyle)\s*([\s\S]*)\}$/);
    return (wrapped ? wrapped[1] : text).trim();
  }

  /**
   * If this element is a formula, its LaTeX and whether it is shown on its own line.
   * Covers MathML with a TeX annotation (Wikipedia, KaTeX) and MathJax 2's script
   * tags. MathML with no TeX in it has no LaTeX to give, and stays as its text.
   */
  function formulaOf(element) {
    if (element.matches('script[type^="math/tex"]')) {
      return { text: cleanLatex(element.textContent), block: element.type.includes('mode=display') };
    }
    if (!element.matches('.mwe-math-element,.katex,.katex-display,math,img[class*="mwe-math-fallback-image"]')) return null;
    const annotation = element.querySelector('annotation[encoding="application/x-tex"]');
    const math = element.matches('math') ? element : element.querySelector('math');
    const image = element.matches('img') ? element : element.querySelector('img[class*="mwe-math-fallback-image"]');
    const text = cleanLatex(annotation?.textContent || math?.getAttribute('alttext') || image?.getAttribute('alt'));
    if (!text) return null;
    const block =
      element.matches('.mwe-math-element-block,.katex-display') ||
      math?.getAttribute('display') === 'block' ||
      !!image?.className.includes('fallback-image-display');
    return { text, block };
  }

  /** A clone has no layout, so the size and the image shown come from the page's own copy. */
  function imageElement(clone) {
    const source = clone.getAttribute('src');
    const live = [...clone.ownerDocument.images].find((img) => img.getAttribute('src') === source) ?? clone;
    const url = live.currentSrc || live.src || clone.src;
    if (!/^https?:/.test(url || '')) return null;
    // RemNote needs the size to show an image properly in the queue.
    const width = Math.round(live.width || Number(clone.getAttribute('width')) || 0);
    const height = Math.round(live.height || Number(clone.getAttribute('height')) || 0);
    return {
      i: 'i',
      url,
      ...(width && height ? { width, height } : {}),
      ...(clone.alt ? { title: clone.alt } : {}),
    };
  }

  const INLINE_FORMAT = { b: 'b', strong: 'b', i: 'l', em: 'l', u: 'u', sup: 'sup', sub: 'sub', code: 'q', s: 'str', del: 'str' };
  const BLOCK_TAG = /^(p|div|li|h[1-6]|blockquote|tr|td|th|dd|dt|section|article|br)$/;

  function collectRichText(node, format, out) {
    if (node.nodeType === 3) {
      const text = node.nodeValue.replace(/\s+/g, ' ');
      if (text) out.push({ text, format });
      return;
    }
    if (node.nodeType !== 1 && node.nodeType !== 11) return;
    if (node.nodeType === 1) {
      const formula = formulaOf(node);
      if (formula) {
        out.push({ i: 'x', text: formula.text, ...(formula.block ? { block: true } : {}) });
        return;
      }
      // MathJax 2 draws a formula next to the script that holds its LaTeX.
      if (node.matches('.MathJax,.MathJax_Preview,.MathJax_Display') && node.parentNode?.querySelector('script[type^="math/tex"]')) return;
      if (node.matches(SKIP)) return;
    }
    const tag = (node.tagName || '').toLowerCase();
    if (tag === 'img') {
      const image = imageElement(node);
      if (image) out.push(image);
      return;
    }
    let inner = format;
    if (INLINE_FORMAT[tag]) inner = { ...format, [INLINE_FORMAT[tag]]: true };
    if (tag === 'a' && /^https?:/.test(node.href || '')) inner = { ...format, iUrl: node.href };
    const isBlock = BLOCK_TAG.test(tag);
    if (isBlock) out.push({ text: ' ', format: {} });
    for (const child of node.childNodes) collectRichText(child, inner, out);
    if (isBlock) out.push({ text: ' ', format: {} });
  }

  /**
   * The selection as RemNote rich text, built here rather than through RemNote's
   * Markdown parser. That parser reads page text as commands: `→` and `::` start a
   * flashcard, and `\[30\]` becomes block LaTeX.
   */
  function rangeToRichText(range) {
    const pieces = [];
    collectRichText(range.cloneContents(), {}, pieces);

    const merged = [];
    for (const piece of pieces) {
      const last = merged[merged.length - 1];
      const sameFormat = last && 'format' in last && 'format' in piece && JSON.stringify(last.format) === JSON.stringify(piece.format);
      if (sameFormat) last.text += piece.text;
      else if ('format' in piece) merged.push({ text: piece.text, format: piece.format });
      else merged.push(piece);
    }

    // Spaces where blocks and inline text meet: collapse them, and trim both ends.
    merged.forEach((piece, index) => {
      if (!('format' in piece)) return;
      const previous = merged[index - 1];
      piece.text = piece.text.replace(/ +/g, ' ');
      if (index === 0 || (previous && 'format' in previous && previous.text.endsWith(' '))) piece.text = piece.text.replace(/^ /, '');
      if (index === merged.length - 1) piece.text = piece.text.replace(/ $/, '');
    });

    return merged
      .filter((piece) => !('format' in piece) || piece.text)
      .map((piece) => {
        if (!('format' in piece)) return piece;
        return Object.keys(piece.format).length ? { i: 'm', text: piece.text, ...piece.format } : piece.text;
      });
  }

  const api = { buildIndex, describeRange, anchorAt, resolveAnchor, toRange, readOutline, sectionOf, rangeToRichText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.IEAnchors = api;
})(globalThis);
