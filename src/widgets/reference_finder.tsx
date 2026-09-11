import { renderWidget, usePlugin, useRunAsync, WidgetLocation, RemType, SelectionType, RICH_TEXT_FORMATTING, BuiltInPowerupCodes, MoveUnit } from '@remnote/plugin-sdk';
import { useState, useRef, useEffect, useCallback } from 'react';
import { resolveRemTextForBreadcrumb, buildAncestorBreadcrumb } from '../lib/richTextRemRefs';
import { sanitizeRichTextForSetText } from '../lib/richTextSanitize';
import { remHasImage } from '../lib/image_scan';

// Report each step of the alias-id resolution as a toast. Off by default: the
// picker's console lives in its own widget iframe, so toasts are the only
// diagnosis that reaches the user without re-scoping DevTools — but they are
// noise in daily use. Flip to true when re-testing alias insertion (e.g. after
// RemNote answers on how a plugin should obtain an alias's id).
const ALIAS_REPAIR_DEBUG = false;

// The rem id of an alias returned by `rem.getAliases()`. Historically that is
// `_id`; the fallbacks are here because a candidate matched by alias text has
// been coming back without one, which is exactly what leaves the inserted
// reference showing the rem's primary name instead of the alias.
const aliasRemId = (a: any): string =>
  a?._id ?? a?.id ?? a?.remId ?? a?.rem?._id ?? a?._rem?._id ?? '';

// ---------------------------------------------------------------------------
// Find & Insert Reference
//
// RemNote's built-in reference search seeds candidates per token with a cap.
// When every token in a rem's name is high-frequency (e.g. "Navegação Interior",
// "mar territorial"), the exact-name concept never makes the candidate cut, so
// you literally cannot find it by typing its name — even though it exists and
// is referenced many times. (See the debug widget's "Search / Linkage
// Diagnostics" for the full investigation.)
//
// This picker sidesteps that: it searches EACH typed token separately (the
// distinctive token reliably returns the rem), unions the results, keeps only
// rems whose name contains all tokens, and floats exact-name matches to the
// top. Then it inserts a reference at the cursor via editor.insertRichText.
//
// Aliases: RemNote's built-in `[[` search also matches a rem by its aliases
// (the Aliases built-in powerup). We do too — when a result's primary name
// doesn't contain every typed token, we consult `rem.getAliases()` and match
// against each alias. A match is surfaced with the alias text, and picking it
// inserts a reference whose `aliasId` points at the matched alias, so the
// reference renders the alias text (exactly like RemNote's own behaviour).
// ---------------------------------------------------------------------------

const normalize = (s: string) => s.normalize('NFC').trim().toLowerCase();

// RemNote marks cloze membership with a `cId` key on each rich-text element
// (including rem-reference elements). To keep an inserted reference INSIDE a
// cloze instead of breaking it, we stamp the surrounding cloze's id onto it.
const CLOZE_KEY = 'cId';

// First cloze id found among a span of rich text (used for selected text).
function findClozeId(rt: any): string | undefined {
  if (!Array.isArray(rt)) return undefined;
  for (const el of rt) {
    if (el && typeof el === 'object' && typeof (el as any)[CLOZE_KEY] === 'string') {
      return (el as any)[CLOZE_KEY];
    }
  }
  return undefined;
}

// Editor caret-offset width of one element. Text contributes its length;
// RemNote counts a rem reference as width 2; other inline nodes as 1.
function elementWidth(el: any): number {
  if (typeof el === 'string') return el.length;
  if (el?.i === 'm' || el?.i === 'x') return (el.text ?? '').length;
  if (el?.i === 'q') return 2;
  return 1;
}

// Cloze id at a collapsed caret offset. A caret sitting on a boundary counts as
// inside the cloze if either adjacent element is clozed.
function clozeIdAtOffset(rt: any, offset: number): string | undefined {
  if (!Array.isArray(rt)) return undefined;
  let pos = 0;
  let prevCId: string | undefined;
  for (const el of rt) {
    const w = elementWidth(el);
    const cId = el && typeof el === 'object' ? (el as any)[CLOZE_KEY] : undefined;
    if (offset === pos) return cId ?? prevCId;
    if (offset > pos && offset < pos + w) return cId;
    pos += w;
    prevCId = cId;
  }
  return prevCId; // caret at the very end of the text
}
// Accent/diacritic-insensitive fold so "navegacao interior" matches
// "Navegação Interior". Decompose, drop combining marks, lowercase.
const fold = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

// Treat "Figure", "Fig" and "Fig." (any capitalisation) as the same word, so
// typing "fig 4.3" matches a rem named "Figure 4.3" and vice-versa. Collapse a
// standalone "fig"/"fig." token to the canonical "figure" (and swallow a
// trailing dot) everywhere matching/scoring reads folded text. `\bfig\b` won't
// touch the "fig" inside "figure" — there's no word boundary between "g" and
// "u" — so already-canonical text is left alone.
const canonFig = (s: string) => s.replace(/\bfig\b\.?/g, 'figure');

// The opposite spelling. Only used to seed the backend search: RemNote reaches a
// rem written "Fig. 6.4" through the phrase "fig 6.4" and never through
// "figure 6.4" (see the phrase-seed comment in runSearch), so both spellings of
// the whole query have to be asked for.
const shortFig = (s: string) => s.replace(/\bfigure\b/g, 'fig');

interface Candidate {
  id: string;
  name: string;
  normName: string;
  type: number;
  times: number;
  score: number; // lower is better
  backText: string;
  breadcrumb: string;
  // True when the rem is a PDF highlight. Its RemType is DEFAULT_TYPE like any
  // plain rem, so the badge would say nothing about what it actually is —
  // resolved in Phase 2 (bounded to the rows we show) and shown as its own badge.
  isPdfHighlight?: boolean;
  // True when the rem carries an image in its own text or back text — the same
  // predicate the HasImage powerup is applied by ("Tag Rems With Images"), read
  // straight off the rich text instead of through the tag: it costs nothing (no
  // extra lookup, unlike the PDF-highlight probe above) and it is right even for
  // rems that have never been scanned, or whose image was added or removed since
  // they were.
  hasImage?: boolean;
  // Set when the rem matched via one of its aliases rather than its primary
  // name. `aliasText` is what we display and insert; `aliasId` stamps the
  // reference so it renders the alias text and links back to this rem.
  aliasId?: string;
  aliasText?: string;
  // Debug only: set when the alias object came back without a usable rem id.
  aliasKeys?: string;
  // The matched alias's own rich text. Aliases are no longer rems, so their id
  // can only be recovered by handing this back to getOrCreateAliasWithText().
  aliasRichText?: any;
}

function ReferenceFinder() {
  const plugin = usePlugin();
  const ctx = useRunAsync(
    async () => await plugin.widget.getWidgetContext<WidgetLocation.FloatingWidget>(),
    []
  );
  const floatingWidgetId = ctx?.floatingWidgetId;
  const widgetInstanceId = (ctx as any)?.widgetInstanceId as string | undefined;

  // The picker starts hidden while we measure the viewport and (if needed) flip
  // to the left of the caret, so the user never sees it jump. Revealed once
  // positioning settles — or immediately if measurement can't run.
  const [positioned, setPositioned] = useState(false);
  const positionedRef = useRef(false);
  // Max height for the results list, capped to the space available on whichever
  // side (below/above the caret) we open on, so a long list scrolls instead of
  // spilling off-screen. Set during positioning; 320 is the default cap.
  const [listMaxHeight, setListMaxHeight] = useState(320);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState(0);
  const [conceptsOnly, setConceptsOnly] = useState(false);
  const [searching, setSearching] = useState(false);
  // True when the picker was opened over selected text. Gates the "pin at end"
  // hint in the footer so the key list stays short in the ordinary case.
  const [openedFromSelection, setOpenedFromSelection] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const reqIdRef = useRef(0);
  // The rem the picker was triggered from, captured by the command before focus
  // moved into this widget. Excluded from results (a rem can't reference itself).
  const sourceRemIdRef = useRef<string>('');

  // Round outer edge / kill the filled square behind our corners. renderWidget
  // mounts us inside the iframe on a container that carries RemNote's default
  // (square, themed) background — our rounded panel then reveals that fill at the
  // corners ("squared outside, rounded inside"; a light square even in dark mode
  // is the un-themed canvas showing through). Make the document AND every
  // wrapper element transparent, excluding our own panel (marked data-rf-panel)
  // and its descendants so they keep their backgrounds.
  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = `
      html, body {
        background: transparent !important;
        margin: 0 !important;
        padding: 0 !important;
        color-scheme: light dark;
      }
      body *:not([data-rf-panel]):not([data-rf-panel] *) {
        background-color: transparent !important;
      }
    `;
    document.head.appendChild(style);
    return () => { style.remove(); };
  }, []);

  // Focus once we're actually visible — a visibility:hidden input can't take
  // focus, so focusing before the position settles would be a no-op. Select any
  // seeded query text so it can be overwritten immediately.
  useEffect(() => {
    if (!positioned) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (el.value) el.select();
  }, [positioned]);

  useEffect(() => {
    (async () => {
      const src = await plugin.storage.getSession<string>('reference-finder-source-rem');
      sourceRemIdRef.current = typeof src === 'string' ? src : '';
    })();
  }, [plugin]);

  // Seed the box with selected text handed off by the command (if any), then
  // select it so the user can immediately overwrite or refine it.
  useEffect(() => {
    (async () => {
      const init = await plugin.storage.getSession<string>('reference-finder-initial-query');
      await plugin.storage.setSession('reference-finder-initial-query', '');
      if (typeof init === 'string' && init.trim()) {
        // A seeded query means the command found selected text, which is exactly
        // when "pin at end" is worth offering — it's the mode that leaves that
        // selection alone.
        setOpenedFromSelection(true);
        setQuery(init.trim());
        requestAnimationFrame(() => inputRef.current?.select());
      }
    })();
  }, [plugin]);

  // Let Enter / arrow keys reach this widget instead of the editor.
  useEffect(() => {
    if (!floatingWidgetId) return;
    plugin.window
      .stealKeys(floatingWidgetId, ['Enter', 'ArrowUp', 'ArrowDown', 'Escape'])
      .catch(() => {/* best-effort; arrows/Enter still work inside the input */});
  }, [floatingWidgetId, plugin]);

  // Keep the picker on-screen. The command opens us with our LEFT edge at the
  // caret and our top just below it; near the right or bottom edge of the window
  // that pushes our panel off-screen and RemNote doesn't clamp it. Neither the
  // command sandbox nor this widget iframe can read the host window size from the
  // DOM (innerWidth is the iframe's own size and cross-origin reads throw). The
  // one host-coordinate signal we DO get is plugin.widget.getDimensions, so we
  // measure geometrically:
  //   1. read where we were placed (left edge = the caret).
  //   2. briefly anchor our RIGHT + BOTTOM edges to the viewport and read back —
  //      rect.right / rect.bottom are then the true viewport width / height.
  //   3. flip LEFT of the caret if we'd overflow the right edge; flip ABOVE the
  //      caret if the fully-expanded panel wouldn't fit below (mirrors RemNote's
  //      selection search, which opens upward once the anchor passes mid-screen).
  // All of this runs while the panel is hidden, so there's no visible jump.
  useEffect(() => {
    if (!floatingWidgetId || !widgetInstanceId || positionedRef.current) return;
    let cancelled = false;
    const reveal = () => {
      if (cancelled || positionedRef.current) return;
      positionedRef.current = true;
      setPositioned(true);
    };
    (async () => {
      const MARGIN = 8;
      const GAP = 6; // matches the caret offset the command opens us with
      // Non-list chrome (header + input + footer + paddings/gaps). Subtracted
      // from the space on the chosen side to size the scrollable results list.
      const CHROME = 130;
      const LIST_CAP = 320; // never grow the list beyond this even with room
      // getDimensions is typed for a number but getWidgetContext hands back a
      // string id; coerce, and fall back to the raw value if it isn't numeric.
      const numId = Number(widgetInstanceId);
      const instId: any = Number.isFinite(numId) ? numId : widgetInstanceId;
      // The caret rect handed over by the command (host coordinates) — lets us
      // flip above precisely. Falls back to values derived from our placement.
      let caret: { top: number; bottom: number; left: number; right: number } | null = null;
      try { caret = (await plugin.storage.getSession('reference-finder-caret')) ?? null; } catch { /* ignore */ }
      // Original placement; captured up front so we can restore it if a later
      // step throws mid-measurement.
      let orig: { top: number; left: number } | undefined;
      try {
        const placed = await plugin.widget.getDimensions(instId);
        if (cancelled) return;
        const anchorLeft = placed.left;
        const width = placed.width || 680;
        // The command opened us at top = caret.bottom + GAP.
        const caretBottom = caret?.bottom ?? (placed.top - GAP);
        const caretTop = caret?.top ?? (caretBottom - 24);
        orig = { top: Math.round(placed.top), left: Math.round(anchorLeft) };

        // Measure the viewport by pinning our right+bottom edges to it, then
        // reading back: rect.right / rect.bottom equal the true viewport size.
        await plugin.window.setFloatingWidgetPosition(floatingWidgetId, { right: 0, bottom: 0 });
        await new Promise((r) => setTimeout(r, 16)); // let the host relayout
        const pinned = await plugin.widget.getDimensions(instId);
        if (cancelled) return;
        const viewportWidth = pinned.right;
        const viewportHeight = pinned.bottom;

        // Horizontal: flip to the left of the caret if we'd overflow the right.
        let left = anchorLeft;
        if (viewportWidth > 0 && anchorLeft + width > viewportWidth - MARGIN) {
          left = Math.max(MARGIN, Math.min(anchorLeft - width, viewportWidth - width - MARGIN));
        }

        // Vertical: open below the caret, but flip above once the caret passes
        // the vertical midpoint (more room above than below) — mirrors RemNote's
        // selection search, which opens upward even just below mid-screen. When
        // flipping we anchor our BOTTOM just above the caret so the list grows up.
        const spaceBelow = viewportHeight - caretBottom;
        const spaceAbove = caretTop;
        const flipUp = viewportHeight > 0 && spaceAbove > spaceBelow;
        const vertical = flipUp
          ? { bottom: Math.max(MARGIN, Math.round(viewportHeight - caretTop + GAP)) }
          : { top: Math.round(caretBottom) + GAP };

        // Cap the results list to the room available on the chosen side so a long
        // list scrolls instead of running off-screen.
        if (viewportHeight > 0) {
          const sideSpace = flipUp ? spaceAbove : spaceBelow;
          const listMax = Math.max(120, Math.min(LIST_CAP, Math.round(sideSpace - CHROME - MARGIN - GAP)));
          if (!cancelled) setListMaxHeight(listMax);
        }

        await plugin.window.setFloatingWidgetPosition(floatingWidgetId, { left: Math.round(left), ...vertical });
      } catch (e) {
        // Something failed after we may have pinned to the right edge — restore
        // the original placement so we never reveal stuck off to the side.
        console.warn('[reference-finder] viewport measurement failed:', e);
        if (!cancelled && orig) {
          try { await plugin.window.setFloatingWidgetPosition(floatingWidgetId, orig); }
          catch { /* best-effort */ }
        }
      } finally {
        reveal();
      }
    })();
    return () => { cancelled = true; };
  }, [floatingWidgetId, widgetInstanceId, plugin]);

  // Safety net: never leave the picker invisible if measurement stalls.
  useEffect(() => {
    const t = setTimeout(() => {
      if (!positionedRef.current) { positionedRef.current = true; setPositioned(true); }
    }, 1000);
    return () => clearTimeout(t);
  }, []);

  // Build a breadcrumb so the user can tell which document a rem lives in
  // (mirrors RemNote's reference-search breadcrumb). Shared with the Suppressed
  // Cards picker — see lib/richTextRemRefs.
  const buildBreadcrumb = useCallback(
    async (rem: any): Promise<string> => buildAncestorBreadcrumb(plugin, rem),
    [plugin]
  );

  const runSearch = useCallback(
    async (raw: string) => {
      const reqId = ++reqIdRef.current;
      const q = normalize(raw);
      const qf = canonFig(fold(raw));
      if (q.length < 2) {
        setResults([]);
        return;
      }
      setSearching(true);
      try {
        const tokens = q.split(/\s+/).filter((t) => t.length >= 2);
        // Folded tokens drive matching so accents/special chars are ignored.
        const foldedTokens = qf.split(/\s+/).filter((t) => t.length >= 2);
        // Seed the backend search with the alternate figure spelling too, so
        // RemNote's index returns "Figure 4.3" when the user typed "fig" (and
        // vice-versa) rather than relying only on the distinctive numeric token.
        const searchTokens = Array.from(
          new Set(
            tokens.flatMap((t) =>
              /^fig\.?$/.test(t) ? [t, 'figure'] : t === 'figure' ? [t, 'fig'] : [t]
            )
          )
        );
        // Seed with the WHOLE query as a phrase, in both figure spellings, before
        // any single token. This is the seed that matters, because of how
        // RemNote's search actually retrieves candidates (SQLite FTS5):
        //   • it splits the query on every non-letter/digit character, so
        //     "Fig. 6.4" becomes the tokens [fig, ., 6, ., 4];
        //   • it then keeps only the tokens longer than two characters and ORs
        //     them as prefix matches — here just `"fig"*`, since "6" and "4" are
        //     dropped. That pool ("every rem containing a word starting with
        //     fig") is truncated to the top-ranked thousand, and this picker then
        //     keeps the best 50 by cost. In a knowledge base full of figures the
        //     one you want does not survive that cut, however well it would have
        //     scored once retrieved.
        //   • the ONE branch that isolates a rem instead of truncating a huge
        //     pool is an exact adjacent-phrase match on the whole query
        //     (`"figure 6.4"*`, capped at 100 rows) — and it only runs when the
        //     phrase is at least 3 characters and 2 tokens.
        // FTS prefix-matches only the LAST word of a phrase, so the phrase
        // "fig 6.4" does not match a rem named "Figure 6.4" and vice-versa. Both
        // spellings therefore have to be asked for; canonFig alone was only ever
        // applied to matching and scoring, never to what we asked the index for,
        // which is why "Fig. 6.4" could not find "Figure 6.4: …".
        const phrases = Array.from(new Set<string>([q, canonFig(q), shortFig(q)]));
        // …then each token (longest first) so a buried exact-name rem is still
        // reachable via its most distinctive token. Capped so a query stays a
        // bounded number of backend searches per keystroke.
        const queries = Array.from(
          new Set<string>([...phrases, ...[...searchTokens].sort((a, b) => b.length - a.length)])
        ).slice(0, 5);

        const seen = new Map<string, any>();
        for (const qq of queries) {
          const res = await plugin.search.search([qq], undefined, {
            filterOnlyConcepts: conceptsOnly,
            numResults: 50,
          });
          for (const r of res) {
            if (r._id === sourceRemIdRef.current) continue; // never suggest the rem itself
            if (!seen.has(r._id)) seen.set(r._id, r);
          }
        }
        if (reqId !== reqIdRef.current) return; // a newer search superseded this

        // Phase 1 — resolve name/type/ranking, filter to rems containing all
        // tokens, and score. (backText + breadcrumb are resolved later, only
        // for the rems we'll actually show, to keep per-keystroke cost low.)
        type Scored = {
          r: any; id: string; name: string; normName: string; type: number; times: number;
          score: number; aliasId?: string; aliasText?: string; aliasKeys?: string; aliasRichText?: any;
          matchFold: string; // folded text the match was made on (alias or name)
        };
        const scored: Scored[] = [];
        for (const r of seen.values()) {
          // resolveRemTextForBreadcrumb never throws on malformed `.text` (it
          // reads nodes directly, so a rem whose rich text the SDK's validator
          // rejects can't reject the whole search promise). It also collapses a
          // pin reference to a compact 📌 instead of expanding the (often long)
          // referenced rem's text — so pin text doesn't pollute the match/name.
          const nameRaw = await resolveRemTextForBreadcrumb(plugin, r.text);
          const name = nameRaw === 'Untitled' ? '' : nameRaw;
          const foldName = canonFig(fold(name));
          const type = await r.getType().catch(() => 0);
          if (conceptsOnly && type !== RemType.CONCEPT) continue;

          // Accent-insensitive: every typed token must appear in the folded name…
          let aliasId: string | undefined;
          let aliasText: string | undefined;
          let aliasKeys: string | undefined; // debug: shape of the alias object when it has no id
          let aliasRichText: any; // the alias's own rich text — resolves its id at pick time
          let matchFold = foldName;
          if (!foldedTokens.every((t) => foldName.includes(t))) {
            // …or in one of the rem's aliases. RemNote indexes aliases into the
            // owning rem, so an alias-text search returns THIS rem (with a
            // non-matching primary name); consult its aliases to confirm and
            // capture which alias to reference. Only the non-matching results
            // pay this extra lookup, so per-keystroke cost stays low.
            let matched: { id: string; text: string; fold: string; rt: any } | undefined;
            try {
              for (const a of await r.getAliases()) {
                const atRaw = (await resolveRemTextForBreadcrumb(plugin, a.text)).trim();
                const at = atRaw === 'Untitled' ? '' : atRaw;
                const fa = canonFig(fold(at));
                if (at && foldedTokens.every((t) => fa.includes(t))) {
                  matched = { id: aliasRemId(a), text: at, fold: fa, rt: a.text };
                  if (!matched.id) aliasKeys = Object.keys(a ?? {}).join(',').slice(0, 120);
                  break;
                }
              }
            } catch { /* ignore */ }
            if (!matched) continue;
            aliasId = matched.id || undefined;
            aliasText = matched.text;
            aliasRichText = matched.rt;
            matchFold = matched.fold;
          }
          const times = await r.timesSelectedInSearch().catch(() => 0);

          // Lower score = better. Exact match → start-with → contains; then
          // concepts before other types; then by selection count and brevity.
          // Scored on the matched folded text (alias or name) so an exact alias
          // ranks like an exact name, and accents don't change the ranking.
          let score = 3;
          if (matchFold === qf) score = 0;
          else if (matchFold.startsWith(qf)) score = 1;
          else if (matchFold.includes(qf)) score = 2;
          scored.push({ r, id: r._id, name, normName: normalize(name), type, times, score, aliasId, aliasText, aliasKeys, aliasRichText, matchFold });
        }

        scored.sort((a, b) => {
          if (a.score !== b.score) return a.score - b.score;
          const ac = a.type === RemType.CONCEPT ? 0 : 1;
          const bc = b.type === RemType.CONCEPT ? 0 : 1;
          if (ac !== bc) return ac - bc;
          if (a.times !== b.times) return b.times - a.times;
          return a.matchFold.length - b.matchFold.length;
        });

        // Phase 2 — enrich the top results with backText + a shortened
        // breadcrumb so the user can disambiguate (which document is this in?).
        const top = scored.slice(0, 25);
        const candidates: Candidate[] = [];
        for (const s of top) {
          let backText = '';
          try {
            if (s.r.backText?.length) {
              const bt = (await resolveRemTextForBreadcrumb(plugin, s.r.backText)).trim();
              backText = bt === 'Untitled' ? '' : bt; // don't show the empty-sentinel
            }
          } catch { /* ignore */ }
          const breadcrumb = await buildBreadcrumb(s.r);
          // Built-in powerup membership isn't enumerable, so probe it directly.
          const isPdfHighlight = await s.r
            .hasPowerup(BuiltInPowerupCodes.PDFHighlight)
            .catch(() => false);
          candidates.push({
            id: s.id, name: s.name, normName: s.normName, type: s.type,
            times: s.times, score: s.score, backText, breadcrumb, isPdfHighlight,
            hasImage: remHasImage(s.r),
            aliasId: s.aliasId, aliasText: s.aliasText, aliasKeys: s.aliasKeys,
            aliasRichText: s.aliasRichText,
          });
        }

        if (reqId !== reqIdRef.current) return;
        setResults(candidates);
        setSelected(0);
      } finally {
        if (reqId === reqIdRef.current) setSearching(false);
      }
    },
    [plugin, conceptsOnly, buildBreadcrumb]
  );

  // Debounce searches as the user types.
  useEffect(() => {
    const t = setTimeout(() => runSearch(query), 200);
    return () => clearTimeout(t);
  }, [query, runSearch]);

  const close = useCallback(async () => {
    if (floatingWidgetId) await plugin.window.closeFloatingWidget(floatingWidgetId);
  }, [floatingWidgetId, plugin]);

  const pick = useCallback(
    async (picked: Candidate | undefined, mode: 'ref' | 'pin' | 'textPin' | 'pinEnd' = 'ref') => {
      if (!picked) return;
      let cand: Candidate = picked;

      // Insert WHILE the widget is still open: RemNote keeps the underlying
      // editor as the "active editor" even though DOM focus is in this iframe.
      // insertRichText silently no-ops if there is no active editor, so we
      // first check getSelection() to decide between insert and clipboard.
      let inserted = false;
      let sawSelection = false;
      let insertErr: any = null;
      let targetRemId: string | undefined;
      // Set when 'pinEnd' could not trust the caret after moving it (see below);
      // the pin is then appended by rewriting the rem's text instead.
      let caretLeftTheRem = false;
      try {
        const sel = await plugin.editor.getSelection();
        if (sel) {
          sawSelection = true;
          targetRemId = (sel as any).remId;
          // An alias reference needs the alias's id, and `getAliases()` no
          // longer supplies one — the objects it returns are rem shells whose
          // `_id` is empty, because a built-in powerup's data is not stored as
          // rems any more. `getOrCreateAliasWithText` is the surviving route:
          // "if an equivalent alias already exists, that alias will be
          // returned". Feeding it the alias's OWN rich text (not a re-typed
          // string) is what keeps it a lookup rather than a create.
          if (!cand.aliasId && cand.aliasText && cand.aliasRichText) {
            try {
              const owner = await plugin.rem.findOne(cand.id);
              const alias: any = await owner?.getOrCreateAliasWithText(cand.aliasRichText);
              if (typeof alias?._id === 'string' && alias._id) {
                cand = { ...cand, aliasId: alias._id };
              } else if (ALIAS_REPAIR_DEBUG) {
                await plugin.app.toast(
                  `alias id lookup: getOrCreateAliasWithText returned ${alias ? 'an object with no _id' : 'nothing'}`
                );
              }
            } catch (e) {
              console.warn('[reference-finder] alias id lookup failed:', e);
              if (ALIAS_REPAIR_DEBUG) await plugin.app.toast(`alias id lookup threw: ${(e as any)?.message ?? e}`);
            }
          }
          // Cloze-awareness: if the insertion point sits inside a cloze, stamp
          // that cloze's id onto the reference so it stays INSIDE the cloze
          // instead of breaking it. Prefer the selected span's cId; fall back
          // to the element at the caret offset.
          let clozeId: string | undefined;
          const hasTextRange =
            sel.type === SelectionType.Text &&
            (sel as any).range &&
            (sel as any).range.start !== (sel as any).range.end;
          try {
            // 'pinEnd' appends past the end of the text, so it must NOT inherit a
            // cloze id — that would drag the pin inside a cloze that happens to
            // sit at the end of the rem.
            const ts = mode === 'pinEnd' ? undefined : await plugin.editor.getSelectedText();
            clozeId = findClozeId(ts?.richText);
            if (mode !== 'pinEnd' && !clozeId && sel.type === SelectionType.Text && (sel as any).remId) {
              const rem = await plugin.rem.findOne((sel as any).remId);
              const offset = (sel as any).range?.start ?? 0;
              clozeId = clozeIdAtOffset(rem?.text, offset);
            }
          } catch { /* best-effort cloze detection */ }

          // If text is selected, replace it with the reference (mimics RemNote's
          // [[ ]] behaviour where the selected text becomes the link) — except in
          // 'pinEnd', whose whole point is to KEEP the selected text and hang the
          // pin off the end of the rem. There, collapse to the end of the selection
          // and walk the caret to the end of the line: that keeps us inside the
          // field the selection was in, so a back-side selection appends to the
          // back rather than the front.
          if (mode === 'pinEnd') {
            await plugin.editor.collapseSelection('end');
            await plugin.editor.moveCaret(1, MoveUnit.LINE);
            // Guard: MoveUnit.LINE is "to the end of the line" for us, but if it
            // ever behaves as "one line down" the caret would now sit in the NEXT
            // rem — and the pin would be appended to a rem the user never picked.
            // Confirm we're still in the same rem; if not, append through setText
            // below instead of inserting at a caret we no longer trust.
            try {
              const afterMove = await plugin.editor.getSelection();
              if (!afterMove || (afterMove as any).remId !== targetRemId) {
                caretLeftTheRem = true;
              }
            } catch {
              caretLeftTheRem = true;
            }
          } else if (hasTextRange) {
            await plugin.editor.delete();
          }
          // Build the rich text to insert:
          //  • 'ref'     — a normal reference (renders the referenced text).
          //  • 'pin'     — a pinned reference: just the link chip, WITHOUT the
          //                text (RemNote's "Edit or Add Alias → clear text" trick).
          //  • 'textPin' — the rem's text spelled out, then a pin chip after it
          //                (mirrors RemNote's paste option "Text with Pin").
          const makeRef = (pin: boolean): any => {
            const r: any = { i: 'q', _id: cand.id };
            // Matched via an alias → reference the owning rem but render the alias
            // text (RemNote's own alias-reference shape: _id + aliasId).
            if (cand.aliasId) r.aliasId = cand.aliasId;
            if (pin) r.pin = true;
            if (clozeId) r[CLOZE_KEY] = clozeId;
            return r;
          };
          let toInsert: any[];
          if (mode === 'textPin') {
            // "Text with Pin" (mirrors RemNote's paste option): splice in the
            // SOURCE rem's own rich text — keeping formatting, images, etc. —
            // then a pin chip. Two twists that match the plugin's Opt+Z cloze
            // workflow:
            //  • the source's cloze spans are NOT re-clozed (that would make
            //    "clozes out of clozes"); instead they're MARKED like Opt+Z —
            //    yellow highlight (h:3) + reference font colour (tc:1) — so they
            //    still read as clozes without being functional ones.
            //  • if the source is a front/back card, the back is brought along
            //    too, joined with a practice-direction arrow instead of RemNote's
            //    card delimiter.
            const HL = RICH_TEXT_FORMATTING.HIGHLIGHT;
            const TC = RICH_TEXT_FORMATTING.TEXT_COLOR;
            const stripHints = (n: any) => {
              delete n[RICH_TEXT_FORMATTING.CLOZE_HINT];
              delete n[RICH_TEXT_FORMATTING.CARD_HINT_FRONT];
              delete n[RICH_TEXT_FORMATTING.CARD_HINT_BACK];
              delete n[RICH_TEXT_FORMATTING.MULTILINE_CARD_HINT];
              delete n[RICH_TEXT_FORMATTING.HIDDEN_CLOZE];
              delete n[RICH_TEXT_FORMATTING.REVEALED_CLOZE];
            };
            let srcRem: any;
            try { srcRem = await plugin.rem.findOne(cand.aliasId || cand.id); } catch { /* ignore */ }
            const frontRt: any[] = Array.isArray(srcRem?.text) ? srcRem.text : [];
            const backRt: any[] = Array.isArray(srcRem?.backText) ? srcRem.backText : [];
            // Arrow reflects the card's practice direction, like the Opt+Z command.
            let arrowChar = '⇔';
            try {
              if (backRt.length && srcRem) {
                const dir = await srcRem.getPracticeDirection();
                arrowChar = dir === 'forward' ? '⇒' : dir === 'backward' ? '⇐' : '⇔';
              }
            } catch { /* keep default */ }
            // Convert a section's rich text: cloze spans → marked (not clozed);
            // card-delimiter nodes ('s') → the arrow; everything else preserved.
            const processSection = (rt: any[]): any[] => {
              const out: any[] = [];
              for (const item of rt) {
                const isStr = typeof item === 'string';
                if (!isStr && (item as any)?.i === 's') {
                  out.push({ i: 'm', text: ' ' + arrowChar + ' ' });
                  continue;
                }
                const node: any = isStr ? { i: 'm', text: item } : { ...(item as any) };
                const hadCloze = CLOZE_KEY in node;
                delete node[CLOZE_KEY];
                stripHints(node);
                if (hadCloze) { node[HL] = 3; node[TC] = 1; out.push(node); }
                else out.push(isStr ? (item as string) : node);
              }
              return out;
            };
            const sourceParts: any[] = [...processSection(frontRt)];
            if (backRt.length) {
              // Only add a separator arrow if the front didn't already carry a
              // card delimiter (which processSection just turned into one).
              const hasDelim = frontRt.some((it: any) => it && typeof it !== 'string' && it.i === 's');
              if (!hasDelim) sourceParts.push({ i: 'm', text: ' ' + arrowChar + ' ' });
              sourceParts.push(...processSection(backRt));
            }
            if (!sourceParts.length) {
              const displayText = (cand.aliasText || cand.name || '').trim();
              if (displayText) sourceParts.push(displayText);
            }
            // Normalize the source nodes so insertRichText's cross-sandbox
            // validator accepts them — most importantly images, whose out-of-range
            // `percent` (e.g. 68.08) otherwise makes the whole insert throw. Same
            // sanitization setText needs. The pin is appended AFTER, so its cloze
            // id isn't touched by the sanitizer.
            const sanitizedSource = sanitizeRichTextForSetText(sourceParts as any);
            toInsert = [...(sanitizedSource as any[]), ' ', makeRef(true)];
          } else if (mode === 'pinEnd') {
            // A space keeps the chip off the last word.
            toInsert = [' ', makeRef(true)];
          } else {
            toInsert = [makeRef(mode === 'pin')];
          }
          try {
            if (mode === 'pinEnd' && caretLeftTheRem) {
              // Caret-free path: append the pin to the rem's own text. Deterministic
              // (no dependence on where the caret ended up) and it keeps the selected
              // text untouched, which is the whole point of this mode.
              const targetRem = targetRemId ? await plugin.rem.findOne(targetRemId) : undefined;
              if (!targetRem) throw new Error('pin at end: lost the rem the picker was opened from');
              const existing: any[] = Array.isArray(targetRem.text) ? (targetRem.text as any[]) : [];
              await targetRem.setText([...existing, ...toInsert] as any);
            } else {
              await plugin.editor.insertRichText(toInsert);
            }
            inserted = true;
          } catch (insErr) {
            // insertRichText can reject some node types inline (images/audio/latex
            // etc.). For text+pin, don't lose everything — retry with only text and
            // rem-reference nodes so the user still gets the text and the pin.
            console.error('[reference-finder] insertRichText threw on full payload:', insErr);
            if (mode === 'textPin') {
              const INSERTABLE = new Set(['m', 'q']);
              const filtered = toInsert.filter((n) => typeof n === 'string' || INSERTABLE.has(n?.i));
              const dropped = toInsert.length - filtered.length;
              console.warn(`[reference-finder] text+pin retry without ${dropped} non-insertable node(s)`, filtered);
              await plugin.editor.insertRichText(filtered);
              inserted = true;
              if (dropped > 0) {
                await plugin.app.toast(`Inserted text + pin — but ${dropped} embedded element(s) (e.g. image) can't be inserted inline; open the rem to view them.`);
              }
            } else {
              throw insErr;
            }
          }
          // --- aliasId repair pass -------------------------------------
          // The reference we hand to insertRichText carries `aliasId` so it
          // renders the matched alias ("momento de inércia") instead of the
          // rem's primary name ("mass moment of inertia"). RemNote's editor
          // drops that field on insert — the saved rich text comes back with
          // `_id` only — so the reference renders the primary name. Re-read
          // the target rem, stamp `aliasId` back onto the node we just
          // inserted and write it with setText, which goes through a
          // different validator.
          //
          // ALIAS_REPAIR_DEBUG surfaces each outcome as a toast as well as a
          // console line: this widget runs in its own iframe, so its console
          // output is invisible unless DevTools' context is switched to that
          // frame — a toast is the only report that always reaches the user.
          if (inserted && cand.aliasId) {
            const say = async (msg: string, data?: any) => {
              console.log('[reference-finder] alias repair:', msg, data ?? '');
              if (ALIAS_REPAIR_DEBUG) await plugin.app.toast(`alias repair: ${msg}`);
            };
            try {
              if (!targetRemId) {
                await say('skipped — no remId on the editor selection');
              } else {
                // Search from the end: earlier references to the same rem are
                // pre-existing, the one we just inserted is the last. Retry once
                // in case the rem hasn't picked up the edit yet.
                const lastRefIdx = (rt: any[]) => {
                  for (let i = rt.length - 1; i >= 0; i--) {
                    const n = rt[i];
                    if (n && typeof n !== 'string' && n.i === 'q' && n._id === cand.id) return i;
                  }
                  return -1;
                };
                let rem = await plugin.rem.findOne(targetRemId);
                let rt: any[] = Array.isArray(rem?.text) ? (rem!.text as any[]) : [];
                let idx = lastRefIdx(rt);
                if (idx === -1) {
                  await new Promise((r) => setTimeout(r, 150));
                  rem = await plugin.rem.findOne(targetRemId);
                  rt = Array.isArray(rem?.text) ? (rem!.text as any[]) : [];
                  idx = lastRefIdx(rt);
                }
                if (idx === -1) {
                  await say('inserted reference not found in the target rem', { targetRemId, refId: cand.id });
                } else if (rt[idx].aliasId === cand.aliasId) {
                  await say('insertRichText kept aliasId — nothing to repair');
                } else {
                  const patched = rt.map((n, i) => (i === idx ? { ...(n as any), aliasId: cand.aliasId } : n));
                  await rem!.setText(patched as any);
                  const after = await plugin.rem.findOne(targetRemId);
                  const afterRt: any[] = Array.isArray(after?.text) ? (after!.text as any[]) : [];
                  const stored = afterRt.find(
                    (n: any) => n && typeof n !== 'string' && n.i === 'q' && n._id === cand.id && n.aliasId
                  );
                  await say(
                    stored
                      ? 'setText stored aliasId ✓ (if the alias text still is not rendered, RemNote is ignoring the id)'
                      : 'setText ALSO dropped aliasId ✗ — RemNote rejects the field on every plugin write path',
                    { targetRemId, refId: cand.id, aliasId: cand.aliasId, storedNode: stored }
                  );
                }
              }
            } catch (e) {
              console.warn('[reference-finder] alias repair failed:', e);
              if (ALIAS_REPAIR_DEBUG) await plugin.app.toast(`alias repair failed: ${(e as any)?.message ?? e}`);
            }
          } else if (inserted && ALIAS_REPAIR_DEBUG && cand.aliasText) {
            // Matched by alias text but no alias rem id came back from
            // getAliases() — report the object's shape so we can see what the
            // id now lives under.
            await plugin.app.toast(
              `alias repair: no aliasId for "${cand.aliasText}" — alias object keys: ${cand.aliasKeys || '(none)'}`
            );
          } else if (inserted && ALIAS_REPAIR_DEBUG) {
            // Distinguishes "the picked candidate had no alias" from "this code
            // isn't running at all" — silence would look the same either way.
            await plugin.app.toast('alias repair: picked candidate carries no aliasId');
          }
        } else {
          console.warn('[reference-finder] no active editor selection — will use clipboard fallback');
        }
      } catch (e) {
        insertErr = e;
        console.error('[reference-finder] pick insertion failed:', e);
      }

      if (!inserted) {
        // Fallback: stash a reference on the clipboard so the user can paste it.
        try {
          const rem = await plugin.rem.findOne(cand.id);
          await rem?.copyReferenceToClipboard();
          const reason = !sawSelection
            ? 'No editor caret found'
            : `Couldn't insert (${insertErr?.message ?? insertErr ?? 'unknown error'})`;
          await plugin.app.toast(`${reason} — reference copied to clipboard. Paste it (⌘/Ctrl+V).`);
        } catch (e2) {
          await plugin.app.toast('Could not insert or copy the reference. Check the console.');
          console.error('[reference-finder] clipboard fallback failed:', e2);
        }
      }

      await close();
    },
    [plugin, close]
  );

  // Open a rem in a NEW pane (split to the right). This is the main way to
  // reach the "flawed" rems that the normal search can't surface — pick them
  // here and jump to them without leaving the current pane. Builds a mosaic
  // tree because window.openRem only targets the current pane.
  const open = useCallback(
    async (cand: Candidate | undefined) => {
      if (!cand) return;
      try {
        const tree = await plugin.window.getCurrentWindowTree();
        const toRemIdTree = (node: any): any =>
          node && typeof node === 'object' && 'direction' in node
            ? {
                direction: node.direction,
                first: toRemIdTree(node.first),
                second: toRemIdTree(node.second),
                splitPercentage: node.splitPercentage,
              }
            : node.remId; // PaneRem leaf → remId
        const newTree = {
          direction: 'row' as const,
          first: toRemIdTree(tree),
          second: cand.id,
          splitPercentage: 55,
        };
        await plugin.window.setRemWindowTree(newTree);
      } catch (e) {
        // Fallback: open in the current pane.
        console.warn('[reference-finder] split-pane open failed, opening in current pane:', e);
        try {
          const rem = await plugin.rem.findOne(cand.id);
          if (rem) await plugin.window.openRem(rem);
        } catch (e2) {
          await plugin.app.toast('Could not open the rem. Check the console.');
          console.error('[reference-finder] open failed:', e2);
        }
      }
      await close();
    },
    [plugin, close]
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, Math.max(results.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // Ctrl/Cmd+Shift+Enter appends a PIN at the END of the rem, leaving any
      // selected text in place — tested first, since it also carries Shift;
      // Shift+Enter opens the rem in a new pane; Ctrl/Cmd+Enter inserts a PIN
      // (reference without its text); Opt/Alt+Enter inserts the text followed by
      // a pin ("Text with Pin"); plain Enter inserts a normal reference.
      if ((e.ctrlKey || e.metaKey) && e.shiftKey) pick(results[selected], 'pinEnd');
      else if (e.shiftKey) open(results[selected]);
      else if (e.altKey) pick(results[selected], 'textPin');
      else pick(results[selected], e.ctrlKey || e.metaKey ? 'pin' : 'ref');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };

  const typeLabel = (t: number) => RemType[t] ?? '?';

  return (
    <div
      data-rf-panel
      style={{
        fontFamily: 'system-ui, -apple-system, sans-serif',
        color: 'var(--rn-clr-content-primary)',
        backgroundColor: 'var(--rn-clr-background-primary)',
        // Conspicuous border: a solid 2px frame in RemNote's opaque border color
        // (with a concrete grey fallback so it stays visible even if the variable
        // is missing — an undefined var with no fallback drops the whole
        // declaration), plus a soft drop shadow to lift the panel off the page.
        // (No box-shadow "ring": on a light background it doubled the corner edge
        // and read as a faint halo just outside the rounded border.)
        border: '2px solid var(--rn-clr-border-opaque, #9ca3af)',
        borderRadius: '10px',
        boxShadow: '0 10px 32px rgba(0,0,0,0.28)',
        padding: '12px',
        boxSizing: 'border-box',
        // Hidden (but fully laid out, so getDimensions still measures our real
        // width) until the viewport-flip logic settles our position.
        visibility: positioned ? 'visible' : 'hidden',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <div style={{ fontWeight: 700, fontSize: '13px' }}>Find Rem — Reference or Open</div>
        <label style={{ fontSize: '11px', color: 'var(--rn-clr-content-secondary)', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
          <input type="checkbox" checked={conceptsOnly} onChange={(e) => setConceptsOnly(e.target.checked)} />
          Concepts only
        </label>
      </div>
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Type a rem name"
        style={{
          width: '100%',
          padding: '8px 10px',
          fontSize: '13px',
          boxSizing: 'border-box',
          borderRadius: '6px',
          border: '1px solid var(--rn-clr-border)',
          backgroundColor: 'var(--rn-clr-background-secondary)',
          color: 'var(--rn-clr-content-primary)',
        }}
      />
      <div style={{ marginTop: '8px', maxHeight: `${listMaxHeight}px`, overflowY: 'auto' }}>
        {query.trim().length < 2 ? (
          <div style={{ fontSize: '12px', color: 'var(--rn-clr-content-tertiary)', padding: '6px 2px' }}>
            Type at least 2 characters. Searches each word separately and floats exact-name matches up, so it finds rems the normal search can't — including matches by a rem's alias (shown with an ALIAS tag; the inserted reference renders the alias text). Enter inserts a reference; Ctrl/Cmd+Enter inserts a pin (no text); Opt/Alt+Enter inserts the text then a pin; Shift+Enter / Shift+click opens the rem in a new pane.
          </div>
        ) : results.length === 0 ? (
          <div style={{ fontSize: '12px', color: 'var(--rn-clr-content-tertiary)', padding: '6px 2px' }}>
            {searching ? 'Searching…' : 'No matches.'}
          </div>
        ) : (
          results.map((r, i) => (
            <div
              key={r.id}
              onMouseEnter={() => setSelected(i)}
              title="Click: insert reference · Ctrl/Cmd+click: insert pin (no text) · Opt/Alt+click: text then pin · Shift+click: open in new pane"
              onClick={(e) =>
                (e.ctrlKey || e.metaKey) && e.shiftKey
                  ? pick(r, 'pinEnd')
                  : e.shiftKey
                  ? open(r)
                  : e.altKey
                  ? pick(r, 'textPin')
                  : pick(r, e.ctrlKey || e.metaKey ? 'pin' : 'ref')
              }
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '8px',
                padding: '6px 8px',
                borderRadius: '6px',
                cursor: 'pointer',
                backgroundColor: i === selected ? 'var(--rn-clr-background-tertiary)' : 'transparent',
              }}
            >
              <span
                style={{
                  flexShrink: 0,
                  marginTop: '2px',
                  fontSize: '9px',
                  fontWeight: 700,
                  padding: '1px 5px',
                  borderRadius: '4px',
                  backgroundColor: r.isPdfHighlight
                    ? '#d97706'
                    : r.type === RemType.CONCEPT
                    ? '#16a34a'
                    : 'var(--rn-clr-background-tertiary)',
                  color:
                    r.isPdfHighlight || r.type === RemType.CONCEPT
                      ? 'white'
                      : 'var(--rn-clr-content-secondary)',
                  whiteSpace: 'nowrap',
                }}
              >
                {r.isPdfHighlight ? 'PDF HIGHLIGHT' : typeLabel(r.type)}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {/* Images carry no searchable text, so nothing else in the row
                      hints that a result is a figure. Sits to the LEFT of the
                      name rather than in the badge gutter, which would go ragged
                      if only some rows widened it. */}
                  {r.hasImage && (
                    <span
                      title="Contains an image"
                      aria-label="Contains an image"
                      style={{ flexShrink: 0, fontSize: '11px', lineHeight: 1 }}
                    >
                      🖼️
                    </span>
                  )}
                  <span style={{ fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                    {(r.aliasText || r.name) || '(empty)'}
                  </span>
                  {r.aliasText && (
                    <span style={{ flexShrink: 0, fontSize: '9px', color: '#2563eb', fontWeight: 700 }}>ALIAS</span>
                  )}
                  {r.score === 0 && (
                    <span style={{ flexShrink: 0, fontSize: '9px', color: '#16a34a', fontWeight: 700 }}>EXACT</span>
                  )}
                </div>
                {r.aliasText && (
                  <div
                    style={{
                      fontSize: '11px',
                      color: 'var(--rn-clr-content-secondary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    ↳ {r.name || '(empty)'}
                  </div>
                )}
                {r.backText && (
                  <div
                    style={{
                      fontSize: '11px',
                      color: 'var(--rn-clr-content-secondary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {r.backText}
                  </div>
                )}
                {r.breadcrumb && (
                  <div
                    style={{
                      fontSize: '10px',
                      color: 'var(--rn-clr-content-tertiary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {r.breadcrumb}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>
      <div
        style={{
          marginTop: '8px',
          paddingTop: '6px',
          borderTop: '1px solid var(--rn-clr-border)',
          fontSize: '10px',
          color: 'var(--rn-clr-content-tertiary)',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          columnGap: '12px',
          rowGap: '3px',
        }}
      >
        {[
          { keys: '↑/↓', label: 'navigate' },
          { keys: 'Enter', label: 'reference' },
          { keys: 'Ctrl/Cmd+Enter', label: 'pin (no text)' },
          { keys: 'Opt/Alt+Enter', label: 'text + pin' },
          { keys: 'Shift+Enter', label: 'open in new pane' },
          { keys: 'Esc', label: 'close' },
        ].map((s) => (
          <span key={s.keys} style={{ whiteSpace: 'nowrap' }}>
            <strong style={{ color: 'var(--rn-clr-content-secondary)', fontWeight: 600 }}>{s.keys}</strong>{' '}
            {s.label}
          </span>
        ))}
        {/* Only offered when the picker was opened over selected text: this is the
            mode that keeps that text and hangs the pin off the end of the rem.
            Clickable as well as typed — the click lands in this iframe, so the
            editor's selection survives it. */}
        {openedFromSelection && (
          <span
            role="button"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()} /* keep editor focus/selection */
            onClick={() => pick(results[selected], 'pinEnd')}
            title="Insert a pin at the end of the Rem, keeping the selected text"
            style={{
              whiteSpace: 'nowrap',
              cursor: 'pointer',
              padding: '1px 6px',
              borderRadius: '4px',
              backgroundColor: 'var(--rn-clr-background-tertiary)',
              color: 'var(--rn-clr-content-secondary)',
            }}
          >
            📌{' '}
            <strong style={{ color: 'var(--rn-clr-content-secondary)', fontWeight: 600 }}>
              Ctrl/Cmd+Shift+Enter
            </strong>{' '}
            pin at end (keep text)
          </span>
        )}
      </div>
    </div>
  );
}

renderWidget(ReferenceFinder);
