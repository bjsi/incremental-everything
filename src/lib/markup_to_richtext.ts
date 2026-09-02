import { ReactRNPlugin, RichTextInterface } from '@remnote/plugin-sdk';

/**
 * Convert literal markup left behind by PDF extraction into real RemNote rich
 * text.
 *
 * Why this exists: RemNote's PDF highlight extraction copies the page's text
 * layer verbatim — it runs no markdown or LaTeX parser at all. Our rebuilt text
 * layers deliberately carry markup in *source* form:
 *
 *   \[ ... \]   display formula      ->  { i: 'x', text, block: true }
 *   \( ... \)   inline formula       ->  { i: 'x', text }
 *   **bold**                         ->  { i: 'm', text, b: true }
 *   *italic*                         ->  { i: 'm', text, l: true }
 *
 * so that this command can turn them into rich text after the fact.
 *
 * Our own rebuilt text layers emit \[..\] and \(..\) rather than $$..$$ / $..$
 * on purpose: RemNote unescapes markdown inside dollar-delimited spans, which
 * silently strips the backslash from \, \; \{ \} \% \\ and corrupts the formula
 * while still rendering it. Dollar delimiters are recognised here anyway, since
 * text extracted from PDFs we did not rebuild routinely carries them:
 *
 *   $$ ... $$  display formula      ->  { i: 'x', text, block: true }
 *   $ ... $    inline formula       ->  { i: 'x', text }
 *
 * Single dollars are matched conservatively (pandoc's rule): the opening $ may
 * not be followed by whitespace, the closing $ may not be preceded by it or
 * followed by a digit, and the span may not cross a line break — so prices like
 * "$5 and $10" are left alone.
 */

type RTNode = any;

const DISPLAY = /\\\[([\s\S]+?)\\\]/;
const INLINE = /\\\(([\s\S]+?)\\\)/;
const DISPLAY_DOLLAR = /(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$/;
const INLINE_DOLLAR = /(?<![\\$])\$(?![\s$])([^\n$]+?)(?<![\s\\])\$(?![\d$])/;
const BOLD = /\*\*([^*]+?)\*\*/;
const ITALIC = /(?<!\*)\*([^*\n]+?)\*(?!\*)/;

// Longest/most specific first: a display formula may contain parentheses that
// would otherwise be mistaken for an inline one.
const RULES: { re: RegExp; make: (body: string, attrs: any) => RTNode }[] = [
  { re: DISPLAY, make: (b) => ({ i: 'x', text: b.trim(), block: true }) },
  { re: DISPLAY_DOLLAR, make: (b) => ({ i: 'x', text: b.trim(), block: true }) },
  { re: INLINE, make: (b) => ({ i: 'x', text: b.trim() }) },
  { re: INLINE_DOLLAR, make: (b) => ({ i: 'x', text: b.trim() }) },
  { re: BOLD, make: (b, a) => ({ i: 'm', ...a, text: b, b: true }) },
  { re: ITALIC, make: (b, a) => ({ i: 'm', ...a, text: b, l: true }) },
];

/** Split one text node's string into rich-text nodes, keeping the node's own
 *  formatting on the surrounding plain runs. */
const convertText = (text: string, attrs: any): RTNode[] => {
  const keep = (s: string): RTNode[] =>
    s ? [Object.keys(attrs).length ? { i: 'm', ...attrs, text: s } : s] : [];

  for (const { re, make } of RULES) {
    const m = re.exec(text);
    if (!m) continue;
    const before = text.slice(0, m.index);
    const after = text.slice(m.index + m[0].length);
    return [
      ...convertText(before, attrs),
      make(m[1], attrs),
      ...convertText(after, attrs),
    ];
  }
  return keep(text);
};

/** Returns new rich text, or null when nothing in the rem needed converting.
 *  Non-text nodes (images, rem references, existing formulas) pass through
 *  untouched — a rem may already hold an image alongside its caption. */
export const convertRichText = (rt: RichTextInterface): RichTextInterface | null => {
  if (!rt || !rt.length) return null;
  const out: RTNode[] = [];
  let changed = false;

  for (const item of rt) {
    const isString = typeof item === 'string';
    const isTextNode = isString || (item as any)?.i === 'm';
    if (!isTextNode) {
      out.push(item);
      continue;
    }
    const node: any = isString ? { text: item } : { ...(item as any) };
    const text: string = node.text || '';
    const attrs: any = { ...node };
    delete attrs.text;
    delete attrs.i;

    const pieces = convertText(text, attrs);
    if (pieces.length !== 1 || typeof pieces[0] !== (isString ? 'string' : 'object')) {
      changed = true;
    }
    out.push(...pieces);
  }
  return changed ? (out as RichTextInterface) : null;
};

export interface ConvertResult {
  scanned: number;
  converted: number;
}

/** Convert one rem and, optionally, everything beneath it. */
export const convertRemTree = async (
  plugin: ReactRNPlugin,
  remId: string,
  includeDescendants: boolean
): Promise<ConvertResult> => {
  const root = await plugin.rem.findOne(remId);
  if (!root) return { scanned: 0, converted: 0 };

  const targets = [root];
  if (includeDescendants) {
    const kids = await root.getDescendants();
    targets.push(...kids);
  }

  let scanned = 0;
  let converted = 0;
  for (const rem of targets) {
    scanned++;
    const next = convertRichText((rem.text || []) as RichTextInterface);
    if (next) {
      await rem.setText(next);
      converted++;
    }
    // A highlight's own extracted text can also live in backText.
    const back = convertRichText((rem.backText || []) as RichTextInterface);
    if (back) {
      await rem.setBackText(back);
      if (!next) converted++;
    }
  }
  return { scanned, converted };
};
