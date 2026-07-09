import { renderWidget, usePlugin, useRunAsync, WidgetLocation, RemType, SelectionType } from '@remnote/plugin-sdk';
import { useState, useRef, useEffect, useCallback } from 'react';
import { safeRemTextToString } from '../lib/pdfUtils';

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

interface Candidate {
  id: string;
  name: string;
  normName: string;
  type: number;
  times: number;
  score: number; // lower is better
  backText: string;
  breadcrumb: string;
  // Set when the rem matched via one of its aliases rather than its primary
  // name. `aliasText` is what we display and insert; `aliasId` stamps the
  // reference so it renders the alias text and links back to this rem.
  aliasId?: string;
  aliasText?: string;
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
  const inputRef = useRef<HTMLInputElement>(null);
  const reqIdRef = useRef(0);
  // The rem the picker was triggered from, captured by the command before focus
  // moved into this widget. Excluded from results (a rem can't reference itself).
  const sourceRemIdRef = useRef<string>('');

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

        console.log('[reference-finder] flip:', {
          anchorLeft, width, viewportWidth, chosenLeft: Math.round(left), flippedH: left !== anchorLeft,
          caretBottom, viewportHeight, spaceBelow, spaceAbove, flipUp, vertical,
        });
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
  // (mirrors RemNote's reference-search breadcrumb). Shows the root plus the 3
  // closest ancestors, collapsing any middle gap with "…".
  const buildBreadcrumb = useCallback(
    async (rem: any): Promise<string> => {
      const names: string[] = [];
      try {
        let cur = await rem.getParentRem();
        let depth = 0;
        // Walk all the way to the root (cap guards against cycles/very deep trees).
        while (cur && depth < 20) {
          const raw = (await safeRemTextToString(plugin, cur.text)).trim();
          const t = raw === 'Untitled' ? '' : raw; // treat empty ancestors as skippable
          if (t) names.push(t.length > 24 ? t.slice(0, 24) + '…' : t);
          cur = await cur.getParentRem();
          depth++;
        }
      } catch { /* ignore */ }
      if (names.length === 0) return '';
      const topDown = names.reverse(); // root … parent (closest to the rem)
      // Up to 4 levels fit without a gap (root + 3 closest covers everything).
      if (topDown.length <= 4) return topDown.join(' / ');
      const root = topDown[0];
      const closest3 = topDown.slice(-3); // great-grandparent, grandparent, parent
      return `${root} / … / ${closest3.join(' / ')}`;
    },
    [plugin]
  );

  const runSearch = useCallback(
    async (raw: string) => {
      const reqId = ++reqIdRef.current;
      const q = normalize(raw);
      const qf = fold(raw);
      if (q.length < 2) {
        setResults([]);
        return;
      }
      setSearching(true);
      try {
        const tokens = q.split(/\s+/).filter((t) => t.length >= 2);
        // Folded tokens drive matching so accents/special chars are ignored.
        const foldedTokens = qf.split(/\s+/).filter((t) => t.length >= 2);
        // Search the full query plus each token (longest first, capped to 4) so
        // a buried exact-name rem is retrieved via its most distinctive token.
        const queries = Array.from(
          new Set<string>([raw.trim(), ...[...tokens].sort((a, b) => b.length - a.length).slice(0, 4)])
        );

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
          score: number; aliasId?: string; aliasText?: string;
          matchFold: string; // folded text the match was made on (alias or name)
        };
        const scored: Scored[] = [];
        for (const r of seen.values()) {
          // safeRemTextToString never throws on malformed `.text` (some rems in
          // a large KB carry rich text the SDK's validator rejects, which used
          // to reject the whole search promise) and repairs it via normalize.
          const nameRaw = await safeRemTextToString(plugin, r.text);
          const name = nameRaw === 'Untitled' ? '' : nameRaw;
          const foldName = fold(name);
          const type = await r.getType().catch(() => 0);
          if (conceptsOnly && type !== RemType.CONCEPT) continue;

          // Accent-insensitive: every typed token must appear in the folded name…
          let aliasId: string | undefined;
          let aliasText: string | undefined;
          let matchFold = foldName;
          if (!foldedTokens.every((t) => foldName.includes(t))) {
            // …or in one of the rem's aliases. RemNote indexes aliases into the
            // owning rem, so an alias-text search returns THIS rem (with a
            // non-matching primary name); consult its aliases to confirm and
            // capture which alias to reference. Only the non-matching results
            // pay this extra lookup, so per-keystroke cost stays low.
            let matched: { id: string; text: string; fold: string } | undefined;
            try {
              for (const a of await r.getAliases()) {
                const atRaw = (await safeRemTextToString(plugin, a.text)).trim();
                const at = atRaw === 'Untitled' ? '' : atRaw;
                const fa = fold(at);
                if (at && foldedTokens.every((t) => fa.includes(t))) {
                  matched = { id: a._id, text: at, fold: fa };
                  break;
                }
              }
            } catch { /* ignore */ }
            if (!matched) continue;
            aliasId = matched.id;
            aliasText = matched.text;
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
          scored.push({ r, id: r._id, name, normName: normalize(name), type, times, score, aliasId, aliasText, matchFold });
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
              const bt = (await safeRemTextToString(plugin, s.r.backText)).trim();
              backText = bt === 'Untitled' ? '' : bt; // don't show the empty-sentinel
            }
          } catch { /* ignore */ }
          const breadcrumb = await buildBreadcrumb(s.r);
          candidates.push({
            id: s.id, name: s.name, normName: s.normName, type: s.type,
            times: s.times, score: s.score, backText, breadcrumb,
            aliasId: s.aliasId, aliasText: s.aliasText,
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
    async (cand: Candidate | undefined, asPin = false) => {
      if (!cand) return;
      console.log('[reference-finder] pick →', cand.id, JSON.stringify(cand.name), asPin ? '(as pin)' : '');

      // Insert WHILE the widget is still open: RemNote keeps the underlying
      // editor as the "active editor" even though DOM focus is in this iframe.
      // insertRichText silently no-ops if there is no active editor, so we
      // first check getSelection() to decide between insert and clipboard.
      let inserted = false;
      try {
        const sel = await plugin.editor.getSelection();
        console.log('[reference-finder] active editor selection:', sel);
        if (sel) {
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
            const ts = await plugin.editor.getSelectedText();
            clozeId = findClozeId(ts?.richText);
            if (!clozeId && sel.type === SelectionType.Text && (sel as any).remId) {
              const rem = await plugin.rem.findOne((sel as any).remId);
              const offset = (sel as any).range?.start ?? 0;
              clozeId = clozeIdAtOffset(rem?.text, offset);
            }
          } catch { /* best-effort cloze detection */ }
          console.log('[reference-finder] cloze id at insertion point:', clozeId);

          // If text is selected, replace it with the reference (mimics RemNote's
          // [[ ]] behaviour where the selected text becomes the link).
          if (hasTextRange) {
            await plugin.editor.delete();
            console.log('[reference-finder] deleted selected text before inserting');
          }
          // A pinned reference (`pin: true`) renders as just the link chip
          // WITHOUT the referenced text — the same result as RemNote's manual
          // "Edit or Add Alias → clear text" trick, but in one keystroke.
          const ref: any = { i: 'q', _id: cand.id };
          // Matched via an alias → reference the owning rem but render the alias
          // text (RemNote's own alias-reference shape: _id + aliasId).
          if (cand.aliasId) ref.aliasId = cand.aliasId;
          if (asPin) ref.pin = true;
          if (clozeId) ref[CLOZE_KEY] = clozeId;
          await plugin.editor.insertRichText([ref]);
          inserted = true;
          console.log('[reference-finder] insertRichText OK', cand.aliasId ? '(alias)' : '', asPin ? '(pin)' : '', clozeId ? '(inside cloze)' : '');
        } else {
          console.warn('[reference-finder] no active editor selection — will use clipboard fallback');
        }
      } catch (e) {
        console.error('[reference-finder] insertRichText threw:', e);
      }

      if (!inserted) {
        // Fallback: stash a reference on the clipboard so the user can paste it.
        try {
          const rem = await plugin.rem.findOne(cand.id);
          await rem?.copyReferenceToClipboard();
          await plugin.app.toast('No editor caret found — reference copied to clipboard. Paste it (⌘/Ctrl+V).');
          console.log('[reference-finder] copied reference to clipboard as fallback');
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
      console.log('[reference-finder] open in new pane →', cand.id, JSON.stringify(cand.name));
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
      // Shift+Enter opens the rem in a new pane; Ctrl/Cmd+Enter inserts a PIN
      // (reference without its text); plain Enter inserts a normal reference.
      if (e.shiftKey) open(results[selected]);
      else pick(results[selected], e.ctrlKey || e.metaKey);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };

  const typeLabel = (t: number) => RemType[t] ?? '?';

  return (
    <div
      style={{
        fontFamily: 'system-ui, -apple-system, sans-serif',
        color: 'var(--rn-clr-content-primary)',
        backgroundColor: 'var(--rn-clr-background-primary)',
        border: '1px solid var(--rn-clr-border)',
        borderRadius: '8px',
        boxShadow: '0 8px 30px rgba(0,0,0,0.25)',
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
            Type at least 2 characters. Searches each word separately and floats exact-name matches up, so it finds rems the normal search can't — including matches by a rem's alias (shown with an ALIAS tag; the inserted reference renders the alias text). Enter inserts a reference; Ctrl/Cmd+Enter inserts a pin (no text); Shift+Enter / Shift+click opens the rem in a new pane.
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
              title="Click: insert reference · Ctrl/Cmd+click: insert pin (no text) · Shift+click: open in new pane"
              onClick={(e) => (e.shiftKey ? open(r) : pick(r, e.ctrlKey || e.metaKey))}
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
                  backgroundColor: r.type === RemType.CONCEPT ? '#16a34a' : 'var(--rn-clr-background-tertiary)',
                  color: r.type === RemType.CONCEPT ? 'white' : 'var(--rn-clr-content-secondary)',
                  whiteSpace: 'nowrap',
                }}
              >
                {typeLabel(r.type)}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
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
      <div style={{ marginTop: '6px', fontSize: '10px', color: 'var(--rn-clr-content-tertiary)' }}>
        ↑/↓ navigate · Enter insert reference · Ctrl/Cmd+Enter insert pin (no text) · Shift+Enter open in new pane · Esc close
      </div>
    </div>
  );
}

renderWidget(ReferenceFinder);
