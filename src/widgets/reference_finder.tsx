import { renderWidget, usePlugin, useRunAsync, WidgetLocation, RemType, SelectionType } from '@remnote/plugin-sdk';
import { useState, useRef, useEffect, useCallback } from 'react';

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
// ---------------------------------------------------------------------------

const normalize = (s: string) => s.normalize('NFC').trim().toLowerCase();
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
}

function ReferenceFinder() {
  const plugin = usePlugin();
  const ctx = useRunAsync(
    async () => await plugin.widget.getWidgetContext<WidgetLocation.FloatingWidget>(),
    []
  );
  const floatingWidgetId = ctx?.floatingWidgetId;

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState(0);
  const [conceptsOnly, setConceptsOnly] = useState(false);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const reqIdRef = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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

  // Build a short "root / … / parent" breadcrumb so the user can tell which
  // document a rem lives in (mirrors RemNote's reference-search breadcrumb).
  const buildBreadcrumb = useCallback(
    async (rem: any): Promise<string> => {
      const names: string[] = [];
      try {
        let cur = await rem.getParentRem();
        let depth = 0;
        while (cur && depth < 8) {
          const t = (await plugin.richText.toString(cur.text ?? [])).trim();
          if (t) names.push(t.length > 24 ? t.slice(0, 24) + '…' : t);
          cur = await cur.getParentRem();
          depth++;
        }
      } catch { /* ignore */ }
      if (names.length === 0) return '';
      const topDown = names.reverse(); // root … parent
      if (topDown.length <= 2) return topDown.join(' / ');
      return `${topDown[0]} / … / ${topDown[topDown.length - 1]}`;
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
            if (!seen.has(r._id)) seen.set(r._id, r);
          }
        }
        if (reqId !== reqIdRef.current) return; // a newer search superseded this

        // Phase 1 — resolve name/type/ranking, filter to rems containing all
        // tokens, and score. (backText + breadcrumb are resolved later, only
        // for the rems we'll actually show, to keep per-keystroke cost low.)
        type Scored = { r: any; id: string; name: string; normName: string; type: number; times: number; score: number };
        const scored: Scored[] = [];
        for (const r of seen.values()) {
          const name = await plugin.richText.toString(r.text ?? []);
          const foldName = fold(name);
          // Accent-insensitive: every typed token must appear in the folded name.
          if (!foldedTokens.every((t) => foldName.includes(t))) continue;
          const type = await r.getType().catch(() => 0);
          if (conceptsOnly && type !== RemType.CONCEPT) continue;
          const times = await r.timesSelectedInSearch().catch(() => 0);

          // Lower score = better. Exact match → start-with → contains; then
          // concepts before other types; then by selection count and brevity.
          // Compared on folded text so accents don't change the ranking.
          let score = 3;
          if (foldName === qf) score = 0;
          else if (foldName.startsWith(qf)) score = 1;
          else if (foldName.includes(qf)) score = 2;
          scored.push({ r, id: r._id, name, normName: normalize(name), type, times, score });
        }

        scored.sort((a, b) => {
          if (a.score !== b.score) return a.score - b.score;
          const ac = a.type === RemType.CONCEPT ? 0 : 1;
          const bc = b.type === RemType.CONCEPT ? 0 : 1;
          if (ac !== bc) return ac - bc;
          if (a.times !== b.times) return b.times - a.times;
          return a.name.length - b.name.length;
        });

        // Phase 2 — enrich the top results with backText + a shortened
        // breadcrumb so the user can disambiguate (which document is this in?).
        const top = scored.slice(0, 25);
        const candidates: Candidate[] = [];
        for (const s of top) {
          let backText = '';
          try {
            if (s.r.backText?.length) backText = (await plugin.richText.toString(s.r.backText)).trim();
          } catch { /* ignore */ }
          const breadcrumb = await buildBreadcrumb(s.r);
          candidates.push({
            id: s.id, name: s.name, normName: s.normName, type: s.type,
            times: s.times, score: s.score, backText, breadcrumb,
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
    async (cand: Candidate | undefined) => {
      if (!cand) return;
      console.log('[reference-finder] pick →', cand.id, JSON.stringify(cand.name));

      // Insert WHILE the widget is still open: RemNote keeps the underlying
      // editor as the "active editor" even though DOM focus is in this iframe.
      // insertRichText silently no-ops if there is no active editor, so we
      // first check getSelection() to decide between insert and clipboard.
      let inserted = false;
      try {
        const sel = await plugin.editor.getSelection();
        console.log('[reference-finder] active editor selection:', sel);
        if (sel) {
          // If text is selected, replace it with the reference (mimics RemNote's
          // [[ ]] behaviour where the selected text becomes the link).
          if (
            sel.type === SelectionType.Text &&
            (sel as any).range &&
            (sel as any).range.start !== (sel as any).range.end
          ) {
            await plugin.editor.delete();
            console.log('[reference-finder] deleted selected text before inserting');
          }
          await plugin.editor.insertRichText([{ i: 'q', _id: cand.id }]);
          inserted = true;
          console.log('[reference-finder] insertRichText OK');
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

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, Math.max(results.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(results[selected]);
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
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <div style={{ fontWeight: 700, fontSize: '13px' }}>Find &amp; Insert Reference</div>
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
        placeholder="Type a rem name (e.g. Navegação Interior)…"
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
      <div style={{ marginTop: '8px', maxHeight: '320px', overflowY: 'auto' }}>
        {query.trim().length < 2 ? (
          <div style={{ fontSize: '12px', color: 'var(--rn-clr-content-tertiary)', padding: '6px 2px' }}>
            Type at least 2 characters. Tip: this searches each word separately and floats exact-name matches up, so it finds rems the normal search can't.
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
              onClick={() => pick(r)}
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
                    {r.name || '(empty)'}
                  </span>
                  {r.score === 0 && (
                    <span style={{ flexShrink: 0, fontSize: '9px', color: '#16a34a', fontWeight: 700 }}>EXACT</span>
                  )}
                </div>
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
        ↑/↓ to navigate · Enter to insert · Esc to close
      </div>
    </div>
  );
}

renderWidget(ReferenceFinder);
