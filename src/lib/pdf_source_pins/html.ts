/**
 * Saved web articles (RemNote's Reader view of a page).
 *
 * RemNote stores the article as readability HTML — the Link powerup's FileURL,
 * `%LOCAL_FILE%<name>.html` — and its viewer injects that HTML into a <div>. An
 * HTML highlight's Data addresses the selection with XPaths relative to that
 * <div> (`/div[1]/div[1]/ol[1]/li[3]/strong[1]/text()[1]`) plus character
 * offsets inside the start and end text nodes. Preparing and parsing the same
 * HTML the same way reproduces those paths (verified against real highlights),
 * so all of this works on an inert parsed copy, never on RemNote's live viewer.
 */
import type { HtmlHighlightData } from '../pdf_highlight_create';
import type { TextSpan } from './overlap';

const SHOW_TEXT = 4; // NodeFilter.SHOW_TEXT
const FIRST_ORDERED_NODE_TYPE = 9; // XPathResult.FIRST_ORDERED_NODE_TYPE
const FOLLOWING = 4; // Node.DOCUMENT_POSITION_FOLLOWING
const CONTEXT_CHARS = 200;

export interface ArticleWord extends TextSpan {
  i: number;
  text: string;
  /** Index into `Article.nodes` of the text node holding the word. */
  node: number;
}

export interface Article {
  doc: Document;
  root: Element;
  /** Every text node's data, concatenated in document order. */
  text: string;
  nodes: { node: Text; start: number }[];
  words: ArticleWord[];
}

/**
 * The article HTML exactly as RemNote's viewer mounts it: `<inline_math>` and
 * `<block_math>` rendered by KaTeX, then DOMPurify's default sanitize. Both
 * steps change the DOM — a dropped element merges the text around it, a math
 * tag becomes a KaTeX span — so XPaths only line up with RemNote's after them.
 */
export function viewerHtml(
  html: string,
  sanitize: (html: string) => string,
  renderMath?: (tex: string, display: boolean) => string
): string {
  const withMath = renderMath
    ? html
        .replace(/<inline_math>([\s\S]*?)<\/inline_math>/g, (_, tex) => renderMath(tex, false))
        .replace(/<block_math>([\s\S]*?)<\/block_math>/g, (_, tex) => renderMath(tex, true))
    : html;
  return sanitize(withMath);
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Stand-in for KaTeX's `renderToString`. KaTeX always emits exactly one
 * top-level element — `span.katex`, `span.katex-display` (display mode) or
 * `span.katex-error` — so this reproduces the formula's footprint among its
 * siblings, and every XPath outside a formula lines up, without bundling KaTeX
 * (~270 KB). Only anchors that start or end inside a formula stop resolving.
 */
export const mathPlaceholder = (tex: string, display: boolean) =>
  display
    ? `<span class="katex-display"><span class="katex">${escapeHtml(tex)}</span></span>`
    : `<span class="katex">${escapeHtml(tex)}</span>`;

/**
 * Parse prepared article HTML the way the viewer mounts it: as the innerHTML of
 * a <div>. A DOMParser document is inert — no scripts run, no images load.
 */
export function parseArticle(html: string, parser: DOMParser): Article {
  const doc = parser.parseFromString('<!doctype html><html><body></body></html>', 'text/html');
  const root = doc.createElement('div');
  root.innerHTML = html;
  doc.body.appendChild(root);

  const nodes: Article['nodes'] = [];
  let text = '';
  const walker = doc.createTreeWalker(root, SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n as Text, start: text.length });
    text += (n as Text).data;
  }

  // Words never cross text nodes, so "understand" in <strong> and "Trying" after
  // the <br> stay two words even though no whitespace separates them.
  const words: ArticleWord[] = [];
  nodes.forEach(({ node, start }, k) => {
    const re = /\S+/g;
    for (let m = re.exec(node.data); m; m = re.exec(node.data)) {
      words.push({ i: words.length, text: m[0], start: start + m.index, end: start + m.index + m[0].length, node: k });
    }
  });
  return { doc, root, text, nodes, words };
}

/** RemNote's XPath for a node: `name[n]` per step, n counting same-named preceding siblings. */
export function xpathFor(node: Node, root: Node): string {
  let path = '';
  for (let n: Node | null = node; n !== root; n = n.parentNode) {
    if (!n) throw new Error('Node is not inside the article');
    const name = n.nodeName === '#text' ? 'text()' : n.nodeName.toLowerCase();
    let index = 0;
    for (let s: Node | null = n; s; s = s.previousSibling) if (s.nodeName === n.nodeName) index++;
    path = `${name}[${index}]/${path}`;
  }
  return `/${path}`.replace(/\/$/, '');
}

export function resolveXPath(article: Article, xpath: string | undefined): Node | null {
  if (!xpath) return null;
  try {
    return article.doc.evaluate(`.${xpath}`, article.root, null, FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
  } catch {
    return null;
  }
}

/** Character position in `article.text` of a DOM boundary point (node + offset). */
export function textPosition(article: Article, node: Node, offset: number): number | null {
  const own = article.nodes.find((n) => n.node === node);
  if (own) return own.start + Math.min(offset, own.node.data.length);

  // An element boundary: the position just before its child at `offset`, i.e.
  // the start of the first text node at or after that child.
  const child = node.childNodes[offset];
  if (child) {
    const next = article.nodes.find((n) => child === n.node || child.contains(n.node) || child.compareDocumentPosition(n.node) & FOLLOWING);
    if (next) return next.start;
  }
  // Offset past the last child: the end of the element's last text node.
  const within = article.nodes.filter((n) => node.contains(n.node));
  const last = within[within.length - 1];
  return last ? last.start + last.node.data.length : null;
}

/** The character span an existing HTML highlight covers, or null if its anchor no longer resolves. */
export function highlightSpan(article: Article, data: Partial<HtmlHighlightData> | null): TextSpan | null {
  const startNode = resolveXPath(article, data?.startXPath);
  const endNode = resolveXPath(article, data?.endXPath);
  if (!startNode || !endNode) return null;
  const start = textPosition(article, startNode, data?.startOffset ?? 0);
  const end = textPosition(article, endNode, data?.endOffset ?? 0);
  return start !== null && end !== null && end > start ? { start, end } : null;
}

/** RemNote's HTML highlight Data for a run of consecutive article words. */
export function highlightDataFor(article: Article, words: ArticleWord[]): HtmlHighlightData {
  const first = words[0];
  const last = words[words.length - 1];
  const startNode = article.nodes[first.node];
  const endNode = article.nodes[last.node];
  return {
    startXPath: xpathFor(startNode.node, article.root),
    endXPath: xpathFor(endNode.node, article.root),
    startOffset: first.start - startNode.start,
    endOffset: last.end - endNode.start,
    text: words.map((w) => w.text).join(' '),
    textBefore: article.text.slice(Math.max(0, first.start - CONTEXT_CHARS), first.start).trim(),
    textAfter: article.text.slice(last.end, last.end + CONTEXT_CHARS).trim(),
  };
}
