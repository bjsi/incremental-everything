/**
 * Read aloud, part 1: a rem tree → the spoken script that scripts/media_bridge/tts.py
 * reads (lines; `[pt]` = Portuguese line; `<en>…</en>`/`<pt>…</pt>` = foreign term).
 * Pure apart from the RemNote reads, so it can be tested with fake rems
 * (read_aloud_script.test.ts). Rules: see lib/read_aloud.ts.
 */
import type { PluginRem, RichTextInterface, RNPlugin } from '@remnote/plugin-sdk';
import { aliasTextOf } from './rem_aliases';
import { descriptorChain } from './descriptor_chain';

/** RemType.PORTAL. A type-only import keeps this module loadable outside RemNote (tests). */
const REM_TYPE_PORTAL = 6;

/** A safety net for huge trees; the popup says when it was hit. */
const MAX_REMS = 3000;
/** How deep a reference's own references are followed. */
const MAX_REF_DEPTH = 2;

export type Lang = 'pt' | 'en';

export interface ReadAloudStats {
  rems: number;
  lines: number;
  skipped: Record<string, number>;
  truncated: boolean;
}

// --- language ---------------------------------------------------------------------

const PT_WORDS = new Set(
  (
    'de da do das dos que não nao uma um em para com os as é ao aos no na nos nas se por mais como ' +
    'ser são sao está esta pelo pela pelos pelas e o a à entre sobre também tambem quando onde seu sua ' +
    'muito deve pode foi são navio canal'
  ).split(' ')
);
const EN_WORDS = new Set(
  (
    'the of and to is in that it for with as on are be by this an which from or at was were has have ' +
    'not can should must when where its their than then into ship channel'
  ).split(' ')
);
const PT_LETTERS = /[ãõçáéíóúâêôàü]/i;

const wordsOf = (text: string) => text.toLowerCase().match(/[\p{L}]+/gu) ?? [];

/** 'pt', 'en', or null when the text gives no clue. */
export function guessLang(text: string): Lang | null {
  const words = wordsOf(text);
  let pt = 0;
  let en = 0;
  for (const w of words) {
    if (PT_WORDS.has(w)) pt++;
    if (EN_WORDS.has(w)) en++;
    if (PT_LETTERS.test(w)) pt += 0.5;
  }
  if (pt === en) return null;
  return pt > en ? 'pt' : 'en';
}

/** Is an italic span in the other language than its line? Names and acronyms are never marked. */
function isForeignTerm(text: string, lineLang: Lang): boolean {
  const words = wordsOf(text);
  if (words.length === 0) return false;
  if (/^[\p{Lu}\d\s.-]+$/u.test(text.trim())) return false; // OSS, HHP, UR-A
  const guess = guessLang(text);
  if (lineLang === 'pt') {
    if (guess === 'en') return true;
    // A Portuguese line's italic words with no Portuguese letter or word: an English term.
    return guess === null && !PT_LETTERS.test(text);
  }
  return guess === 'pt' || PT_LETTERS.test(text);
}

// --- rich text → spoken text --------------------------------------------------------

export interface Span {
  text: string;
  italic: boolean;
  /** A formula's LaTeX (text is then the FORMULA placeholder). */
  latex?: string;
}

const FORMULA = '\u0001F\u0001';

const count = (stats: ReadAloudStats, what: string) => {
  stats.skipped[what] = (stats.skipped[what] ?? 0) + 1;
};

/**
 * The text a reference shows: its alias when it names one, else its target's text, else
 * the text kept for a deleted target.
 *
 * An alias is no longer a rem since RemNote's storage overhaul (lib/rem_aliases.ts).
 */
async function referenceText(plugin: RNPlugin, el: any): Promise<RichTextInterface | undefined> {
  const target = await plugin.rem.findOne(el._id);
  if (el.aliasId) {
    const alias = await aliasTextOf(plugin, target, el.aliasId);
    if (alias) return alias;
  }
  return target?.text ?? (el.textOfDeletedRem as RichTextInterface | undefined);
}

async function spansOf(
  plugin: RNPlugin,
  rt: RichTextInterface | undefined,
  stats: ReadAloudStats,
  depth = 0
): Promise<Span[]> {
  const out: Span[] = [];
  for (const element of rt ?? []) {
    if (typeof element === 'string') {
      out.push({ text: element, italic: false });
      continue;
    }
    const el = element as any;
    switch (el.i) {
      case 'm':
        if (el.code) {
          count(stats, 'code');
          break;
        }
        out.push({ text: String(el.text ?? ''), italic: !!el.l });
        break;
      case 'q': {
        if (el.pin) {
          count(stats, 'pins');
          break;
        }
        const targetText = await referenceText(plugin, el);
        if (!targetText?.length) break;
        if (depth >= MAX_REF_DEPTH) {
          out.push({ text: await plugin.richText.toString(targetText), italic: false });
        } else {
          out.push(...(await spansOf(plugin, targetText, stats, depth + 1)));
        }
        break;
      }
      case 'x':
        count(stats, 'formulas');
        out.push({ text: FORMULA, italic: false, latex: String(el.text ?? '') });
        break;
      case 'n':
        out.push({ text: String(el.text ?? ''), italic: false });
        break;
      case 'i':
        count(stats, 'images');
        break;
      case 'a':
        count(stats, 'audio');
        break;
      case 'r':
        count(stats, 'drawings');
        break;
      case 'p':
        count(stats, 'embeds');
        break;
      default:
        break; // card delimiters, icons, global names
    }
  }
  return out;
}

/**
 * A notice that an audio was made by AI ("Audio gerado por IA, apenas para introduzir a
 * matéria." over the audios of imported courses): about the audio, not the subject.
 * Matched only as a whole sentence that ends its line and starts the Rem or follows a
 * separator ("Title — Audio gerado por IA…"), so a note that talks about AI audio
 * mid-sentence is still read. In Read aloud, a Rem whose notice sits right above an
 * audio (a child audio Rem) is left out whole, title included (collect).
 */
const AI_NOTICE_RE = new RegExp(
  '(^|\\s*[—–:|-]\\s*)' +
    '(?:' +
    '[áa]udio\\s+(?:gerad[oa]|criad[oa]|produzid[oa]|narrad[oa]|sintetizad[oa])\\s+(?:por|com)\\s+' +
    '(?:(?:uma\\s+)?IA|intelig[êe]ncia\\s+artificial)' +
    '|' +
    '(?:AI|IA)[- ](?:generated|created|produced|narrated)\\s+audio' +
    '|' +
    'audio\\s+(?:generated|created|produced|narrated|synthesi[sz]ed)\\s+(?:by|with)\\s+' +
    '(?:an\\s+)?(?:AI|artificial\\s+intelligence)' +
    ')' +
    '\\b[^.!?\\n]*[.!?]*[ \\t]*(?=\\n|$)',
  'giu'
);

/** Spans with the AI-audio notices cut out (see AI_NOTICE_RE), counted in `stats`. */
export function withoutAiNotices(spans: Span[], stats: ReadAloudStats): Span[] {
  const plain = plainOf(spans);
  const cuts = [...plain.matchAll(AI_NOTICE_RE)].map(
    (m) => [m.index!, m.index! + m[0].length] as const
  );
  if (!cuts.length) return spans;
  stats.skipped.aiNotices = (stats.skipped.aiNotices ?? 0) + cuts.length;
  const out: Span[] = [];
  let pos = 0;
  for (const span of spans) {
    const start = pos;
    pos += span.text.length;
    let text = '';
    let at = start;
    for (const [a, b] of cuts) {
      if (b <= at || a >= pos) continue;
      text += span.text.slice(at - start, Math.max(a, at) - start);
      at = Math.min(b, pos);
    }
    text += span.text.slice(at - start);
    // A formula is kept whole or dropped whole (its placeholder is never cut in two).
    if (span.latex !== undefined && text !== span.text) continue;
    if (text) out.push({ ...span, text });
  }
  return out;
}

const UNITS: Record<string, Record<Lang, string>> = {
  kN: { pt: 'quilonewtons', en: 'kilonewtons' },
  MN: { pt: 'meganewtons', en: 'meganewtons' },
  kgf: { pt: 'quilogramas-força', en: 'kilograms-force' },
  tf: { pt: 'toneladas-força', en: 'tonnes-force' },
  kW: { pt: 'quilowatts', en: 'kilowatts' },
  MW: { pt: 'megawatts', en: 'megawatts' },
  kn: { pt: 'nós', en: 'knots' },
  kt: { pt: 'nós', en: 'knots' },
  kts: { pt: 'nós', en: 'knots' },
};
const UNIT_RE = new RegExp(`(\\d)\\s*(${Object.keys(UNITS).join('|')})\\b`, 'g');

/** Plain text a TTS engine would read badly or aloud: cleaned for speech. */
function speakable(text: string, lang: Lang): string {
  return text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\[…\]|\[\.\.\.\]/g, '…')
    .replace(/\[\[|\]\]/g, '')
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .replace(/\*\*|__/g, '')
    .replace(/\$/g, '')
    .replace(/[<>]/g, ' ')
    .replace(/[→←⇒⇐⇔↔➔]/g, ', ')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\bPDF p\.\s*/g, lang === 'pt' ? 'página ' : 'page ')
    .replace(/\bpp?\. ?(\d)/g, (_m, d) => `${lang === 'pt' ? 'página' : 'page'} ${d}`)
    .replace(UNIT_RE, (_m, d, unit) => `${d} ${UNITS[unit][lang]}`);
}

/** Spans → one script line in `lang`, italic foreign terms marked. */
export function renderLine(spans: Span[], lang: Lang): string {
  const other: Lang = lang === 'pt' ? 'en' : 'pt';
  let line = '';
  for (const span of spans) {
    const text = speakable(span.text, lang);
    if (span.italic && isForeignTerm(text, lang)) {
      // Keep the punctuation around the term outside the mark.
      const m = text.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/su);
      if (m && m[2]) {
        line += `${m[1]}<${other}>${m[2]}</${other}>${m[3]}`;
        continue;
      }
    }
    line += text;
  }
  line = line
    .replaceAll(FORMULA, lang === 'pt' ? ' (fórmula omitida) ' : ' (formula omitted) ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?)])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/^[#>\-–—•\s]+/, '')
    .trim();
  if (line && !/[.!?:;…]$/.test(line)) line += '.';
  return line;
}

const plainOf = (spans: Span[]) => spans.map((s) => s.text).join('');

/**
 * A rendered line as a script line. A line that is nothing but one marked foreign term
 * (an italic *fairway* card in a Portuguese note) becomes a line in that term's
 * language, so engines that drop inline marks still pronounce it right.
 */
function scriptLine(text: string, lang: Lang): string {
  const whole = text.match(/^<(pt|en)>(.*)<\/\1>([.!?…:;]*)$/s);
  if (whole) {
    lang = whole[1] as Lang;
    text = whole[2] + whole[3];
  }
  return lang === 'pt' ? `[pt] ${text}` : text;
}

// --- the tree -----------------------------------------------------------------------

interface RawLine {
  front: Span[];
  back: Span[];
  depth: number;
  placeholder?: 'table';
}

const hasAudio = (rem: PluginRem) =>
  [...(rem.text ?? []), ...(rem.backText ?? [])].some(
    (el) => typeof el === 'object' && el !== null && (el as any).i === 'a'
  );

async function collect(
  plugin: RNPlugin,
  rem: PluginRem,
  out: RawLine[],
  stats: ReadAloudStats,
  seen: Set<string>,
  depth = 0
): Promise<void> {
  if (seen.has(rem._id)) return;
  if (stats.rems >= MAX_REMS) {
    stats.truncated = true;
    return;
  }
  seen.add(rem._id);
  const [isProperty, isSlot, isPowerup, isTable, isCode] = await Promise.all([
    rem.isPowerupProperty().catch(() => false),
    rem.isPowerupSlot().catch(() => false),
    rem.isPowerup().catch(() => false),
    rem.isTable().catch(() => false),
    rem.isCode().catch(() => false),
  ]);
  if (isProperty || isSlot || isPowerup) {
    count(stats, 'properties');
    return;
  }
  if (hasAudio(rem)) {
    count(stats, 'audio');
    return; // an audio rem and its children (a previous summary) are never read
  }
  stats.rems++;
  if (isTable) {
    count(stats, 'tables');
    out.push({ front: [], back: [], depth, placeholder: 'table' });
    return;
  }
  if ((rem.type as number) === REM_TYPE_PORTAL) {
    // The bridge hands these back as raw rem data, without the methods collect()
    // calls ("isPowerupProperty is not a function"): re-fetch them by id, in order.
    const raw = await rem.getPortalDirectlyIncludedRem().catch(() => [] as PluginRem[]);
    const ids = (raw ?? []).map((r) => r?._id).filter(Boolean);
    const byId = new Map(
      ids.length
        ? (((await plugin.rem.findMany(ids).catch(() => [])) ?? []) as PluginRem[]).map((r) => [r._id, r])
        : []
    );
    for (const id of ids) {
      const child = byId.get(id);
      if (child) await collect(plugin, child, out, stats, seen, depth);
    }
    return;
  }
  const children = await rem.getChildrenRem();
  if (isCode) count(stats, 'code');
  else {
    const notices = stats.skipped.aiNotices ?? 0;
    const front = withoutAiNotices(await spansOf(plugin, rem.text, stats), stats);
    const back = withoutAiNotices(await spansOf(plugin, rem.backText, stats), stats);
    // "Title — Audio gerado por IA…" right above its audio: the title is the audio's
    // caption, and the audio is not read, so the whole line goes.
    const audioCaption = (stats.skipped.aiNotices ?? 0) > notices && children.some(hasAudio);
    if (!audioCaption && (plainOf(front).trim() || plainOf(back).trim()))
      out.push({ front, back, depth });
  }
  for (const child of children) await collect(plugin, child, out, stats, seen, depth + 1);
}

/** Spans as written text for an LLM: italic as *x*, formulas as \(LaTeX\). */
function writtenOf(spans: Span[]): string {
  return spans
    .map((s) =>
      s.latex !== undefined
        ? `\\(${s.latex}\\)`
        : s.italic && s.text.trim()
          ? `*${s.text}*`
          : s.text
    )
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The tree as an indented outline, for the LLM modes (Adapted, Summary): the same rems
 * and skips as the script, but formulas kept as LaTeX, italics as *x*, and a
 * flashcard's back after " ⇒ ".
 */
function outlineOf(raw: RawLine[]): string {
  return raw
    .map((l) => {
      const text =
        l.placeholder === 'table'
          ? '(table omitted)'
          : [writtenOf(l.front), writtenOf(l.back)].filter(Boolean).join(' ⇒ ');
      return `${'  '.repeat(l.depth)}- ${text}`;
    })
    .join('\n');
}

/** The focused rem's tree as a spoken script, in the script format tts.py reads. */
export async function buildReadAloudScript(
  plugin: RNPlugin,
  rem: PluginRem
): Promise<{
  script: string;
  source: string;
  lang: Lang;
  title: string;
  stats: ReadAloudStats;
}> {
  const stats: ReadAloudStats = { rems: 0, lines: 0, skipped: {}, truncated: false };
  const raw: RawLine[] = [];
  // A descriptor is read under its concept (lib/descriptor_chain): the fronts of its
  // chain first, outermost first, then the Rem and its tree one level deeper.
  const chain = await descriptorChain(rem).catch(() => [] as PluginRem[]);
  for (const link of chain) {
    const front = withoutAiNotices(await spansOf(plugin, link.text, stats), stats);
    if (plainOf(front).trim()) raw.push({ front, back: [], depth: raw.length });
  }
  const top = raw.length;
  await collect(plugin, rem, raw, stats, new Set(), top);

  const guesses = raw.map((l) => guessLang(plainOf([...l.front, ...l.back])));
  const pt = guesses.filter((g) => g === 'pt').length;
  const en = guesses.filter((g) => g === 'en').length;
  const lang: Lang = pt >= en && pt > 0 ? 'pt' : 'en';

  const lines: string[] = [];
  raw.forEach((l, i) => {
    const lineLang = guesses[i] ?? lang;
    let text: string;
    if (l.placeholder === 'table') text = lineLang === 'pt' ? 'Tabela omitida.' : 'Table omitted.';
    else {
      const front = renderLine(l.front, lineLang);
      const back = renderLine(l.back, lineLang);
      text = front && back ? `${front.replace(/[.]$/, ':')} ${back}` : front || back;
    }
    if (!text) return;
    lines.push(scriptLine(text, lineLang));
  });
  stats.lines = lines.length;
  // The title is the Rem's own, not its concept's.
  const title = raw[top] ? renderLine(raw[top].front, guesses[top] ?? lang).replace(/[.:]$/, '') : '';
  return { script: lines.join('\n'), source: outlineOf(raw), lang, title, stats };
}

/** The language of a Rem's parents (up to three), English when they give no clue. */
async function parentsLang(plugin: RNPlugin, rem: PluginRem): Promise<Lang> {
  let parent = await rem.getParentRem();
  const texts: string[] = [];
  for (let i = 0; parent && i < 3; i++) {
    texts.push(await plugin.richText.toString(parent.text ?? []));
    parent = await parent.getParentRem();
  }
  return guessLang(texts.join(' ')) ?? 'en';
}

/**
 * One Rem, for a pronunciation: its front and back (no descendants) as one or two
 * script lines, each in its own language. A descriptor is read in context: first the
 * fronts of its chain (concept, then the descriptors above it, descriptorChain),
 * then its own front and back. A single word gives no language clue, so an undecided
 * side takes the other side's language, then the language of the Rem's parents (up to
 * three), then English; an undecided chain line looks only at its own parents.
 */
export async function buildRemScript(
  plugin: RNPlugin,
  rem: PluginRem
): Promise<{ script: string; lang: Lang; title: string; stats: ReadAloudStats }> {
  const stats: ReadAloudStats = { rems: 1, lines: 0, skipped: {}, truncated: false };
  const chain = await descriptorChain(rem);
  const front = withoutAiNotices(await spansOf(plugin, rem.text, stats), stats);
  const back = withoutAiNotices(await spansOf(plugin, rem.backText, stats), stats);
  let context: Lang | null = null;
  const contextLang = async (): Promise<Lang> => (context ??= await parentsLang(plugin, rem));
  const chainLines: string[] = [];
  for (const link of chain) {
    const spans = withoutAiNotices(await spansOf(plugin, link.text, stats), stats);
    if (!plainOf(spans).trim()) continue;
    stats.rems++;
    // Only what is above the link: the descriptors below it may be in another language.
    const lang = guessLang(plainOf(spans)) ?? (await parentsLang(plugin, link));
    const text = renderLine(spans, lang);
    if (text) chainLines.push(scriptLine(text, lang));
  }
  const frontGuess = guessLang(plainOf(front));
  const backGuess = guessLang(plainOf(back));
  const sides: { spans: Span[]; lang: Lang }[] = [];
  if (plainOf(front).trim()) {
    sides.push({ spans: front, lang: frontGuess ?? backGuess ?? (await contextLang()) });
  }
  if (plainOf(back).trim()) {
    sides.push({ spans: back, lang: backGuess ?? frontGuess ?? (await contextLang()) });
  }
  const lines = [
    ...chainLines,
    ...sides
      .map(({ spans, lang }) => {
        const text = renderLine(spans, lang);
        return text ? scriptLine(text, lang) : '';
      })
      .filter(Boolean),
  ];
  stats.lines = lines.length;
  const lang = sides[0]?.lang ?? 'en';
  const title = sides.length ? renderLine(sides[0].spans, sides[0].lang).replace(/[.:]$/, '') : '';
  return { script: lines.join('\n'), lang, title, stats };
}
