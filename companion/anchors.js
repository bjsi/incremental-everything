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

  function escapeMarkdown(text) {
    return text.replace(/([\\`*_[\]])/g, '\\$1');
  }

  /**
   * `![alt](url =WIDTHxHEIGHT)`, read by splitMarkdownImages in the plugin. A clone
   * has no layout, so the size and the image actually shown come from the page's own
   * copy. RemNote needs the size to show an image properly in the queue.
   */
  function imageToken(clone) {
    const source = clone.getAttribute('src');
    const live = [...clone.ownerDocument.images].find((img) => img.getAttribute('src') === source) ?? clone;
    const url = live.currentSrc || live.src || clone.src;
    if (!/^https?:/.test(url || '')) return '';
    const safe = url.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\s/g, '%20');
    const width = live.width || Number(clone.getAttribute('width')) || 0;
    const height = live.height || Number(clone.getAttribute('height')) || 0;
    const size = width && height ? ` =${Math.round(width)}x${Math.round(height)}` : '';
    return `![${escapeMarkdown(clone.alt || '')}](${safe}${size})`;
  }

  function nodeToMarkdown(node) {
    if (node.nodeType === 3) return escapeMarkdown(node.nodeValue.replace(/\s+/g, ' '));
    if (node.nodeType !== 1 && node.nodeType !== 11) return '';
    const tag = (node.tagName || '').toLowerCase();
    if (node.nodeType === 1 && node.matches(SKIP)) return '';
    if (tag === 'br') return ' ';
    if (tag === 'img') return imageToken(node);
    const inner = [...node.childNodes].map(nodeToMarkdown).join('');
    if (!inner.trim()) return inner;
    const wrap = (mark) => {
      const body = inner.trim();
      return `${inner.startsWith(' ') ? ' ' : ''}${mark}${body}${mark}${inner.endsWith(' ') ? ' ' : ''}`;
    };
    if (tag === 'b' || tag === 'strong') return wrap('**');
    if (tag === 'i' || tag === 'em') return wrap('*');
    if (tag === 'code') return `\`${node.textContent}\``;
    // A linked image, as on wikis, is the image: a link cannot hold one in RemNote.
    if (tag === 'a' && /^https?:/.test(node.href || '')) {
      return inner.includes('![') && !inner.includes('!\\[') ? inner : `[${inner.trim()}](${node.href})`;
    }
    if (/^(p|div|li|h[1-6]|blockquote|tr|section|article)$/.test(tag)) return ` ${inner} `;
    return inner;
  }

  /** The selection as one line of Markdown, keeping bold, italic, links and images. */
  function rangeToMarkdown(range) {
    return nodeToMarkdown(range.cloneContents()).replace(/ +/g, ' ').trim();
  }

  const api = { buildIndex, describeRange, anchorAt, resolveAnchor, toRange, readOutline, sectionOf, rangeToMarkdown };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.IEAnchors = api;
})(globalThis);
