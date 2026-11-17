/**
 * Search & Browse — an Anki-Browser-like table over the Search Engine, in a floating
 * panel that collapses to a small bar at the window's bottom right while you work in
 * the editor (opening a Rem collapses it; Esc too), and comes back with its search,
 * rows and scroll intact (the `sb` command, or the bar). Collapsing moves the panel so
 * only its top-left corner shows; RemNote clips the rest at the window's edge, and
 * moving a floating widget doesn't remount it.
 * (plans/implemented/SEARCH_ENGINE_PLAN.md, phase 4). Every row and column comes from the AI
 * helper in one call per page (scripts/rem_browse.py); this view renders them, sorts
 * by asking again, and runs the bulk actions in lib/search_browse.ts.
 *
 * Keyboard (house rule: keys on the container, never on buttons): in the box, Enter
 * searches, ↑/↓ walk the last searches (as in Anki's Browser) and Tab enters the
 * table; in the table ↑/↓ move, Space selects, Enter opens the Rem, Shift+Enter opens
 * it in a new pane, / or Shift+Tab returns to the box; Esc closes.
 */
import { usePlugin, useRunAsync, useSessionStorageState, WidgetLocation } from '@remnote/plugin-sdk';
import React from 'react';
import {
  BrowseMode,
  BrowseRow,
  BrowseSort,
  browseViaHelper,
  translateQueryViaHelper,
} from '../lib/rem_search_client';
import {
  SavedSearch,
  SEARCH_QUEUE_LIMIT,
  deleteSavedSearch,
  loadSavedSearches,
  practiceDocument,
  reEnableCardsForRems,
  refreshSearchQueue,
  saveSearch,
  setCardPriorityForRems,
} from '../lib/search_browse';
import { openRemInNewPane } from '../lib/remHelpers';
import { copyTextFromGesture } from '../lib/clipboard';
import {
  searchBrowseAckKey,
  searchBrowseFloatIdKey,
  searchBrowseRequestKey,
  searchHistoryKey,
} from '../lib/consts';

/** The collapsed bar: the part of the panel left on screen at the bottom right. */
const BAR_W = 270;
const BAR_H = 44;
/** Keys taken from the editor while the panel is expanded, and given back collapsed. */
const STOLEN_KEYS = ['Enter', 'ArrowUp', 'ArrowDown', 'Escape', 'Tab'];

const PAGE = 100;
/** Searches remembered for ↑/↓ in the box. */
const HISTORY_MAX = 50;
const RING = '2px solid var(--rn-clr-border-accent, #3B82F6)';
const FRAME = 'var(--rn-clr-border-accent, #3B82F6)';
/** A selected row: a light tint of the accent over the panel, so its text keeps the
 *  normal colours (the saturated accent made dark text unreadable). */
const SELECTED_BG = 'color-mix(in srgb, var(--rn-clr-border-accent, #3B82F6) 16%, var(--rn-clr-background-primary, #fff))';

const CAUSE_LABEL: Record<string, string> = {
  paused: 'paused deck',
  ancestor: 'ancestor off',
  rem: 'off on Rem',
  table: 'table',
  direction: 'direction off',
  cloze: 'cloze off',
  removed: 'text removed',
  other: 'other',
  missing: 'Rem gone',
};

function days(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  if (n === 0) return 'today';
  return n > 0 ? `in ${n} d` : `${-n} d ago`;
}

function num(n: number | null | undefined): string {
  return n === null || n === undefined ? '' : String(Math.round(n * 10) / 10);
}

interface Column {
  key: string;
  label: string;
  sort?: BrowseSort;
  width?: string;
  modes?: BrowseMode[];
  render: (r: BrowseRow) => React.ReactNode;
  title?: string;
}

const COLUMNS: Column[] = [
  {
    key: 'text',
    label: 'Rem',
    sort: 'text',
    render: (r) => (
      <div style={{ minWidth: 0 }}>
        <div
          style={{ overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}
          title={r.back ? `${r.text} → ${r.back}` : r.text}
        >
          {r.text || <em style={{ opacity: 0.6 }}>(no text)</em>}
          {r.back ? <span style={{ color: 'var(--rn-clr-content-secondary)' }}> → {r.back}</span> : null}
        </div>
        <div
          style={{ fontSize: '11px', color: 'var(--rn-clr-content-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={r.path.join(' / ')}
        >
          {r.path.length > 3 ? [r.path[0], '…', ...r.path.slice(-2)].join(' / ') : r.path.join(' / ')}
        </div>
      </div>
    ),
  },
  {
    key: 'kind',
    label: 'Card',
    width: '70px',
    modes: ['cards'],
    render: (r) => r.kind ?? '',
  },
  {
    key: 'type',
    label: 'Kind',
    width: '96px',
    render: (r) =>
      [r.isDocument ? 'doc' : '', r.type, r.incremental ? 'IncRem' : '', r.dismissed ? 'dismissed' : '']
        .filter(Boolean)
        .join(' · '),
  },
  { key: 'tags', label: 'Tags', width: '140px', render: (r) => r.tags.join(', ') },
  { key: 'priority', label: 'Card pri.', sort: 'priority', width: '70px', render: (r) => num(r.priority), title: 'Card priority' },
  {
    key: 'inc',
    label: 'IncRem',
    sort: 'incpriority',
    width: '96px',
    render: (r) => [num(r.incPriority), days(r.incDue)].filter(Boolean).join(' · '),
    title: 'IncRem priority · next date',
  },
  { key: 'due', label: 'Due', sort: 'due', width: '80px', render: (r) => days(r.due), title: 'Next review (rem mode: its earliest card)' },
  { key: 'ivl', label: 'Ivl', sort: 'ivl', width: '50px', render: (r) => (r.ivl === null ? '' : `${r.ivl} d`), title: 'Interval' },
  { key: 'reps', label: 'Reps', sort: 'reps', width: '50px', render: (r) => num(r.reps) },
  { key: 'lapses', label: 'Lapses', sort: 'lapses', width: '56px', render: (r) => num(r.lapses) },
  { key: 'ml', label: 'Mastery', width: '86px', modes: ['cards'], render: (r) => r.ml ?? '' },
  {
    key: 's',
    label: 'S',
    sort: 's',
    width: '58px',
    render: (r) => (r.stability === null || r.stability === undefined ? '' : `${r.stability < 10 ? r.stability.toFixed(1) : Math.round(r.stability)} d`),
    title: 'FSRS stability, with the card\u2019s own scheduler (rem mode: its card with the lowest R)',
  },
  {
    key: 'd',
    label: 'D',
    sort: 'd',
    width: '42px',
    render: (r) => (r.difficulty === null || r.difficulty === undefined ? '' : r.difficulty.toFixed(1)),
    title: 'FSRS difficulty (1–10)',
  },
  {
    key: 'r',
    label: 'R',
    sort: 'r',
    width: '48px',
    render: (r) => (r.retrievability === null || r.retrievability === undefined ? '' : `${Math.round(r.retrievability * 100)}%`),
    title: 'FSRS retrievability now: the chance of recalling it today',
  },
  {
    key: 'scheduler',
    label: 'Scheduler',
    width: '96px',
    render: (r) => r.scheduler ?? '',
    title: 'The card\u2019s scheduler (the Global Default, or one assigned to a document above it)',
  },
  {
    key: 'suppressed',
    label: 'Hidden',
    width: '110px',
    render: (r) => r.suppressed.map((c) => CAUSE_LABEL[c] ?? c).join(', '),
    title: 'Why RemNote won’t show its cards',
  },
];

const rowKey = (r: BrowseRow) => r.cardId ?? r.remId;

export function SearchBrowse() {
  const plugin = usePlugin();
  const ctx = useRunAsync(async () => await plugin.widget.getWidgetContext<WidgetLocation.FloatingWidget>(), []);
  const floatId = ctx?.floatingWidgetId as string | undefined;
  const instanceId = (ctx as any)?.widgetInstanceId;
  const [collapsed, setCollapsed] = React.useState(false);
  const [measuring, setMeasuring] = React.useState(true);
  /** Visible panel height: the frame's, trimmed to RemNote's window. */
  const [panelH, setPanelH] = React.useState<number | null>(null);
  const frameRef = React.useRef<{ w: number; h: number } | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const reqRef = React.useRef(0);

  const [query, setQuery] = React.useState('');
  const [mode, setMode] = React.useState<BrowseMode>('rems');
  const [sort, setSort] = React.useState<BrowseSort>('relevance');
  const [desc, setDesc] = React.useState(false);
  const [rows, setRows] = React.useState<BrowseRow[]>([]);
  const [total, setTotal] = React.useState(0);
  const [ran, setRan] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [message, setMessage] = React.useState<{ text: string; tone: 'info' | 'error' } | null>(null);
  const [focus, setFocus] = React.useState(-1); // -1 = the search box
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [saved, setSaved] = React.useState<SavedSearch[]>([]);
  const [activeSaved, setActiveSaved] = React.useState<string>('');
  const [priority, setPriority] = React.useState('');
  const [busy, setBusy] = React.useState<string | null>(null);
  // Search history, newest first, kept per device. `histPos` -1 is what is being
  // typed (kept in `draftRef` while walking the history).
  const [history, setHistory] = React.useState<string[]>([]);
  const [histPos, setHistPos] = React.useState(-1);
  const draftRef = React.useRef('');

  React.useEffect(() => {
    loadSavedSearches(plugin).then(setSaved);
    plugin.storage
      .getLocal<string[]>(searchHistoryKey)
      .then((h) => setHistory(Array.isArray(h) ? h.filter((x) => typeof x === 'string') : []))
      .catch(() => {});
  }, [plugin]);

  const focusBox = React.useCallback(() => {
    let tries = 0;
    const grab = () => {
      inputRef.current?.focus();
      if (document.activeElement !== inputRef.current && ++tries < 8) setTimeout(grab, 50);
    };
    grab();
  }, []);

  /**
   * Centre the panel in RemNote's window. The window's size can't be read from the
   * iframe, so it is measured as Find Rem does: anchor our right and bottom edges to
   * the window, read our rect back (its right/bottom are the window's width/height),
   * then place. Re-measured on every expand, so a resized window is followed.
   */
  const expand = React.useCallback(async () => {
    if (!floatId) return;
    setMeasuring(true);
    try {
      await plugin.window.setFloatingWidgetPosition(floatId, { right: 0, bottom: 0 });
      await new Promise((r) => setTimeout(r, 30));
      const id = Number(instanceId);
      const rect = await plugin.widget.getDimensions((Number.isFinite(id) ? id : instanceId) as number);
      const W = rect.right;
      const H = rect.bottom;
      const w = rect.width || window.innerWidth;
      const h = rect.height || window.innerHeight;
      frameRef.current = { w, h };
      const visible = Math.max(320, Math.min(h, H - 24));
      setPanelH(visible);
      await plugin.window.setFloatingWidgetPosition(floatId, {
        top: Math.max(12, Math.round((H - visible) / 2)),
        left: Math.max(0, Math.round((W - w) / 2)),
      });
    } catch (e) {
      console.warn('[search-browse] measuring the window failed; placing at the top left', e);
      await plugin.window.setFloatingWidgetPosition(floatId, { top: 40, left: 40 }).catch(() => {});
    }
    await plugin.window.stealKeys(floatId, STOLEN_KEYS).catch(() => {});
    setCollapsed(false);
    setMeasuring(false);
    focusBox();
  }, [plugin, floatId, instanceId, focusBox]);

  /** Down to the bar: only the panel's top-left corner stays on screen, at the window's
   *  bottom right. Keys go back to the editor. */
  const collapse = React.useCallback(async () => {
    if (!floatId) return;
    const frame = frameRef.current ?? { w: window.innerWidth, h: window.innerHeight };
    setCollapsed(true);
    (document.activeElement as HTMLElement | null)?.blur?.(); // typing goes back to the editor
    await plugin.window.releaseKeys(floatId, STOLEN_KEYS).catch(() => {});
    await plugin.window.setFloatingWidgetPosition(floatId, {
      right: -(frame.w - BAR_W - 12),
      bottom: -(frame.h - BAR_H - 12),
    });
  }, [plugin, floatId]);

  const close = React.useCallback(async () => {
    if (!floatId) return;
    await plugin.storage.setSession(searchBrowseFloatIdKey, undefined);
    await plugin.window.closeFloatingWidget(floatId);
  }, [plugin, floatId]);

  // A floating widget is mounted on a container with RemNote's square, themed
  // background, which would show around the rounded panel and around the collapsed
  // bar. Everything but our panel goes transparent (as in Find Rem).
  React.useEffect(() => {
    const style = document.createElement('style');
    style.textContent = `
      html, body { background: transparent !important; margin: 0 !important; padding: 0 !important; color-scheme: light dark; }
      body *:not([data-sb-panel]):not([data-sb-panel] *) { background-color: transparent !important; }
    `;
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  // Open expanded.
  React.useEffect(() => {
    if (floatId) expand();
  }, [floatId]); // eslint-disable-line react-hooks/exhaustive-deps

  // The `sb` command asks an open browser to expand instead of opening another one.
  const [request] = useSessionStorageState<{ action: string; at: number } | undefined>(searchBrowseRequestKey, undefined);
  const handledRef = React.useRef<number>(0);
  React.useEffect(() => {
    if (!request || request.at === handledRef.current || !floatId) return;
    handledRef.current = request.at;
    plugin.storage.setSession(searchBrowseAckKey, request.at);
    if (request.action === 'expand') expand();
  }, [request, floatId, expand, plugin]);

  const run = React.useCallback(
    async (opts?: { append?: boolean; q?: string; m?: BrowseMode; s?: BrowseSort; d?: boolean }) => {
      const q = (opts?.q ?? query).trim();
      if (!q) return;
      const m = opts?.m ?? mode;
      const s = opts?.s ?? sort;
      const d = opts?.d ?? desc;
      const offset = opts?.append ? rows.length : 0;
      const req = ++reqRef.current;
      setLoading(true);
      const res = await browseViaHelper(plugin, { query: q, mode: m, sort: s, desc: d, offset, limit: PAGE });
      if (req !== reqRef.current) return;
      setLoading(false);
      if (!opts?.append) {
        const next = [q, ...history.filter((h) => h !== q)].slice(0, HISTORY_MAX);
        setHistory(next);
        setHistPos(-1);
        plugin.storage.setLocal(searchHistoryKey, next).catch(() => {});
      }
      if (res.status === 'ok') {
        setRows(opts?.append ? [...rows, ...res.rows] : res.rows);
        setTotal(res.total);
        setRan(q);
        setMessage(null);
        if (!opts?.append) setSelected(new Set());
      } else if (res.status === 'query-error') {
        setMessage({ text: res.error.message, tone: res.error.kind === 'index-building' ? 'info' : 'error' });
      } else if (res.status === 'unpaired') {
        setMessage({ text: 'The AI helper is running but not paired: paste its token in the plugin settings (AI Helper Pairing Token).', tone: 'error' });
      } else {
        setMessage({ text: 'Search & Browse needs the AI helper running on this computer (see the Search Engine page of the manual).', tone: 'error' });
      }
    },
    [plugin, query, mode, sort, desc, rows, history]
  );

  /**
   * ✨ AI: the box's text, in plain language and any language, turned into a query by
   * Claude through the AI helper (scripts/rem_search_ai.py). The request goes into the
   * history first, so ↑ brings it back; the query replaces it, stays editable, and runs.
   */
  const [aiBusy, setAiBusy] = React.useState(false);
  const askAi = async () => {
    const request = query.trim();
    if (!request || aiBusy) return;
    setAiBusy(true);
    setMessage({ text: `✨ Asking Claude to write the search for “${request}”…`, tone: 'info' });
    const next = [request, ...history.filter((h) => h !== request)].slice(0, HISTORY_MAX);
    setHistory(next);
    plugin.storage.setLocal(searchHistoryKey, next).catch(() => {});
    const res = await translateQueryViaHelper(plugin, request);
    setAiBusy(false);
    if (res.status === 'ok') {
      setQuery(res.query);
      const m = res.mode ?? mode;
      setMode(m);
      if (res.valid) {
        await run({ q: res.query, m });
        setMessage({ text: `✨ “${request}” → ${res.query}  (edit it freely; ↑ brings your words back)`, tone: 'info' });
      } else {
        setMessage({ text: `✨ Claude's search doesn't work as written: ${res.error ?? ''} Edit it, or rephrase and ask again.`, tone: 'error' });
      }
    } else if (res.status === 'failed') {
      setMessage({ text: `✨ ${res.message}`, tone: 'error' });
    } else if (res.status === 'unpaired') {
      setMessage({ text: 'The AI helper is running but not paired: paste its token in the plugin settings (AI Helper Pairing Token).', tone: 'error' });
    } else {
      setMessage({ text: '✨ AI needs the AI helper running on this computer, with Claude Code signed in.', tone: 'error' });
    }
    focusBox();
  };

  /** ↑ (older) / ↓ (newer) through the search history, as Anki's Browser does. */
  const walkHistory = (step: 1 | -1) => {
    if (!history.length) return;
    const pos = Math.max(-1, Math.min(history.length - 1, histPos + step));
    if (pos === histPos) return;
    if (histPos === -1) draftRef.current = query;
    setHistPos(pos);
    setQuery(pos === -1 ? draftRef.current : history[pos]);
  };

  const changeSort = (s: BrowseSort) => {
    const d = s === sort ? !desc : false;
    setSort(s);
    setDesc(d);
    run({ s, d });
  };

  const changeMode = (m: BrowseMode) => {
    setMode(m);
    if (ran) run({ m });
  };

  const selectedRows = React.useMemo(() => rows.filter((r) => selected.has(rowKey(r))), [rows, selected]);
  const targetRemIds = React.useMemo(() => {
    const pool = selectedRows.length ? selectedRows : focus >= 0 && rows[focus] ? [rows[focus]] : [];
    return Array.from(new Set(pool.map((r) => r.remId)));
  }, [selectedRows, rows, focus]);

  const allBoxRef = React.useRef<HTMLInputElement>(null);
  const someSelected = rows.some((r) => selected.has(rowKey(r)));
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(rowKey(r)));
  React.useEffect(() => {
    if (allBoxRef.current) allBoxRef.current.indeterminate = someSelected && !allSelected;
  }, [someSelected, allSelected]);
  /** The header box: every loaded row, or none. */
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map(rowKey)));

  const toggle = (r: BrowseRow) => {
    const next = new Set(selected);
    const k = rowKey(r);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setSelected(next);
  };

  /** Open the Rem, then collapse: opening first, as the panel's calls must finish
   *  while it is in front (the popup version closed first and the open never ran). */
  const openRow = async (r: BrowseRow | undefined, newPane: boolean) => {
    if (!r) return;
    if (newPane) await openRemInNewPane(plugin, r.remId);
    else {
      const rem = await plugin.rem.findOne(r.remId);
      if (rem) await plugin.window.openRem(rem);
    }
    await collapse();
  };

  const loadSaved = (id: string) => {
    setActiveSaved(id);
    const s = saved.find((x) => x.id === id);
    if (!s) return;
    setQuery(s.query);
    setMode(s.mode);
    setSort(s.sort);
    setDesc(s.desc);
    run({ q: s.query, m: s.mode, s: s.sort, d: s.desc });
  };

  const [naming, setNaming] = React.useState<string | null>(null);

  const doPractise = async () => {
    let s = saved.find((x) => x.id === activeSaved);
    if (!s) return;
    if (s.query !== query.trim() || s.mode !== mode || s.sort !== sort || s.desc !== desc) {
      const list = await saveSearch(plugin, { name: s.name, query: query.trim(), mode, sort, desc });
      setSaved(list);
      s = list.find((x) => x.id === s!.id) ?? s;
    }
    setBusy('Filling the Search Queue…');
    try {
      const { doc, count, total: all } = await refreshSearchQueue(plugin, s, (d, t) =>
        setBusy(`Filling the Search Queue… ${d} / ${t}`)
      );
      setSaved(await loadSavedSearches(plugin));
      await plugin.app.toast(
        `${count} Rem(s) in “🔎 ${s.name}”` + (all > count ? ` (the first ${SEARCH_QUEUE_LIMIT} of ${all})` : '') + '. Opening practice…'
      );
      await practiceDocument(plugin, doc);
      await collapse();
    } catch (e: any) {
      setMessage({ text: e?.message || String(e), tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const doPriority = async () => {
    const p = Number(priority);
    if (!Number.isFinite(p) || p < 0 || p > 100 || !targetRemIds.length) return;
    setBusy(`Setting card priority… 0 / ${targetRemIds.length}`);
    const res = await setCardPriorityForRems(plugin, targetRemIds, Math.round(p), (d, t) =>
      setBusy(`Setting card priority… ${d} / ${t}`)
    );
    setBusy(null);
    await plugin.app.toast(`Card priority ${Math.round(p)} set on ${res.done} Rem(s)` + (res.failed.length ? `, ${res.failed.length} failed` : ''));
    run();
  };

  const doReEnable = async () => {
    if (!targetRemIds.length) return;
    setBusy(`Switching cards on… 0 / ${targetRemIds.length}`);
    const res = await reEnableCardsForRems(plugin, targetRemIds, (d, t) => setBusy(`Switching cards on… ${d} / ${t}`));
    setBusy(null);
    await plugin.app.toast(`Cards switched on for ${res.enabled} Rem(s)` + (res.failed.length ? `, ${res.failed.length} failed` : ''));
    run();
  };

  /** Copy the selected ids. Plugin frames have no clipboard permission, so this goes
   *  through lib/clipboard.ts, called synchronously in the click so the click counts as
   *  the gesture execCommand('copy') needs (bridge, then a copy popup, as fallbacks). */
  const doCopy = () => {
    const ids = selectedRows.length ? selectedRows.map((r) => r.cardId ?? r.remId) : targetRemIds;
    if (!ids.length) return;
    const kind = selectedRows.some((r) => r.cardId) ? 'card' : 'Rem';
    void copyTextFromGesture(plugin, ids.join('\n'), ids.length === 1 ? `${kind} ID` : `${ids.length} ${kind} IDs`);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'BUTTON' || (target.tagName === 'INPUT' && target !== inputRef.current) || target.tagName === 'SELECT') {
      if (e.key === 'Escape') collapse();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      collapse();
      return;
    }
    if (focus < 0) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        askAi();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        run();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        walkHistory(1);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        walkHistory(-1);
      } else if (e.key === 'Tab' && !e.shiftKey && rows.length) {
        e.preventDefault();
        setFocus(0);
        containerRef.current?.focus();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocus(Math.min(rows.length - 1, focus + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocus(Math.max(0, focus - 1));
    } else if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      setFocus(-1);
      inputRef.current?.focus();
    } else if (e.key === ' ') {
      e.preventDefault();
      if (rows[focus]) toggle(rows[focus]);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      openRow(rows[focus], e.shiftKey);
    } else if (e.key === '/') {
      e.preventDefault();
      setFocus(-1);
      inputRef.current?.focus();
    }
  };

  React.useEffect(() => {
    if (focus >= 0) document.getElementById(`sb-row-${focus}`)?.scrollIntoView({ block: 'nearest' });
  }, [focus]);

  const columns = COLUMNS.filter((c) => !c.modes || c.modes.includes(mode));
  // The Rem column takes whatever the fixed columns leave, never less than 420 px.
  const grid = `28px ${columns.map((c) => c.width ?? 'minmax(420px, 1fr)').join(' ')}`;
  const btn: React.CSSProperties = {
    padding: '5px 10px',
    fontSize: '12px',
    borderRadius: '6px',
    border: '1px solid var(--rn-clr-border-opaque, #d1d5db)',
    background: 'var(--rn-clr-background-secondary)',
    color: 'var(--rn-clr-content-primary)',
    cursor: 'pointer',
  };
  const noSteal = (e: React.MouseEvent) => e.preventDefault();
  const active = saved.find((x) => x.id === activeSaved);

  return (
    <div
      ref={containerRef}
      data-sb-panel=""
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: panelH ? `${panelH}px` : '100%',
        boxSizing: 'border-box',
        padding: '14px 16px',
        gap: '10px',
        background: 'var(--rn-clr-background-primary)',
        color: 'var(--rn-clr-content-primary)',
        // An accent frame and a deep shadow, so the panel stands out from the
        // document under it (a floating widget gets no frame or backdrop of its own).
        border: `3px solid ${FRAME}`,
        borderRadius: '12px',
        boxShadow: '0 0 0 1px rgba(0,0,0,0.25), 0 24px 64px rgba(0,0,0,0.45)',
        fontSize: '13px',
        outline: 'none',
        // Kept rendered while collapsed or measuring, so rows and scroll survive.
        visibility: collapsed || measuring ? 'hidden' : 'visible',
      }}
    >
      {collapsed && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: `${BAR_W}px`,
            height: `${BAR_H}px`,
            boxSizing: 'border-box',
            visibility: 'visible',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '0 8px 0 12px',
            background: 'var(--rn-clr-background-primary)',
            color: 'var(--rn-clr-content-primary)',
            border: `3px solid ${FRAME}`,
            borderRadius: '10px',
            boxShadow: '0 0 0 1px rgba(0,0,0,0.25), 0 8px 24px rgba(0,0,0,0.4)',
            fontSize: '12px',
          }}
        >
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => expand()}
            style={{ flex: 1, textAlign: 'left', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '12px', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}
            title={ran ? `Back to the search: ${ran}` : 'Back to Search & Browse'}
          >
            ⤢ <strong>Browse</strong>
            {ran ? ` · ${total.toLocaleString()} ${mode === 'rems' ? 'Rems' : 'cards'}` : ''}
          </button>
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => close()}
            style={{ background: 'none', border: 'none', color: 'var(--rn-clr-content-secondary)', cursor: 'pointer', fontSize: '14px' }}
            title="Close Search & Browse"
          >
            ✕
          </button>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 700, fontSize: '15px' }}>Search &amp; Browse</div>
        <div style={{ display: 'flex', gap: '4px' }}>
          {(['rems', 'cards'] as BrowseMode[]).map((m) => (
            <button
              key={m}
              onMouseDown={noSteal}
              onClick={() => changeMode(m)}
              style={{ ...btn, fontWeight: mode === m ? 700 : 400, borderColor: mode === m ? 'var(--rn-clr-border-accent, #3B82F6)' : undefined }}
            >
              {m === 'rems' ? 'Rems' : 'Cards'}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <select
          value={activeSaved}
          onChange={(e) => loadSaved(e.target.value)}
          style={{ ...btn, maxWidth: '260px' }}
          title="Saved searches"
        >
          <option value="">Saved searches…</option>
          {saved.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        {active && (
          <button
            onMouseDown={noSteal}
            onClick={async () => {
              setSaved(await deleteSavedSearch(plugin, active.id));
              setActiveSaved('');
            }}
            style={btn}
            title="Forget this saved search (its Search Queue document stays)"
          >
            Delete
          </button>
        )}
        <button onMouseDown={noSteal} onClick={() => collapse()} style={btn} title="Collapse to a bar at the bottom right (Esc); the search stays">
          –
        </button>
        <button onMouseDown={noSteal} onClick={() => close()} style={btn} title="Close Search & Browse">
          ✕
        </button>
      </div>

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setHistPos(-1);
          }}
          onFocus={() => setFocus(-1)}
          title={history.length ? '↑/↓: your last searches' : undefined}
          placeholder='bow weather · tag:anki* is:due · in:"PSCPP" prop:r<0.7 — or plain words, then ✨ AI'
          style={{
            flex: 1,
            padding: '8px 10px',
            fontSize: '13px',
            borderRadius: '6px',
            border: '1px solid var(--rn-clr-border)',
            background: 'var(--rn-clr-background-secondary)',
            color: 'var(--rn-clr-content-primary)',
            outline: focus < 0 ? RING : 'none',
            outlineOffset: '1px',
          }}
        />
        <button onMouseDown={noSteal} onClick={() => run()} style={btn}>
          {loading ? 'Searching…' : 'Search'}
        </button>
        <button
          onMouseDown={noSteal}
          onClick={askAi}
          style={{ ...btn, opacity: aiBusy ? 0.6 : 1 }}
          disabled={aiBusy || !query.trim()}
          title="Write what you want in plain language, in any language, then press this (or Ctrl/Cmd+Enter): Claude turns it into a search. Uses your Claude subscription through the AI helper."
        >
          {aiBusy ? '✨ Thinking…' : '✨ AI'}
        </button>
        {naming === null ? (
          <button onMouseDown={noSteal} onClick={() => setNaming(active?.name ?? query.trim().slice(0, 40))} style={btn} disabled={!query.trim()}>
            Save…
          </button>
        ) : (
          <span style={{ display: 'flex', gap: '4px' }}>
            <input
              autoFocus
              value={naming}
              onChange={(e) => setNaming(e.target.value)}
              onKeyDown={async (e) => {
                e.stopPropagation();
                if (e.key === 'Enter' && naming.trim()) {
                  const list = await saveSearch(plugin, { name: naming.trim(), query: query.trim(), mode, sort, desc });
                  setSaved(list);
                  setActiveSaved(list.find((x) => x.name.toLowerCase() === naming.trim().toLowerCase())?.id ?? '');
                  setNaming(null);
                  inputRef.current?.focus();
                } else if (e.key === 'Escape') {
                  setNaming(null);
                  inputRef.current?.focus();
                }
              }}
              placeholder="Name, then Enter"
              style={{ ...btn, width: '180px', cursor: 'text' }}
            />
          </span>
        )}
        <button
          onMouseDown={noSteal}
          onClick={doPractise}
          style={{ ...btn, opacity: active ? 1 : 0.5 }}
          disabled={!active || !!busy}
          title={active ? `Fill “🔎 ${active.name}” with up to ${SEARCH_QUEUE_LIMIT} of these Rems and practise it` : 'Save the search first'}
        >
          ▶ Practise
        </button>
      </div>

      {(message || busy) && (
        <div style={{ fontSize: '12px', color: message?.tone === 'error' && !busy ? 'var(--rn-clr-red, #c0392b)' : 'var(--rn-clr-content-secondary)' }}>
          {busy ?? message?.text}
        </div>
      )}

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          border: '1px solid var(--rn-clr-background-tertiary)',
          borderRadius: '8px',
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: grid,
            gap: '8px',
            padding: '6px 10px',
            position: 'sticky',
            top: 0,
            zIndex: 1,
            background: 'var(--rn-clr-background-secondary)',
            fontSize: '11px',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            color: 'var(--rn-clr-content-secondary)',
          }}
        >
          <input
            type="checkbox"
            ref={allBoxRef}
            checked={rows.length > 0 && rows.every((r) => selected.has(rowKey(r)))}
            onChange={toggleAll}
            disabled={!rows.length}
            tabIndex={-1}
            title={`Select or unselect all ${rows.length} loaded rows`}
            style={{ margin: 0 }}
          />
          {columns.map((c) => (
            <span
              key={c.key}
              title={c.title ?? (c.sort ? 'Sort' : undefined)}
              onMouseDown={noSteal}
              onClick={() => c.sort && changeSort(c.sort)}
              style={{ cursor: c.sort ? 'pointer' : 'default', whiteSpace: 'nowrap', overflow: 'hidden' }}
            >
              {c.label}
              {c.sort && sort === c.sort ? (desc ? ' ▼' : ' ▲') : ''}
            </span>
          ))}
        </div>
        {rows.length === 0 ? (
          <div style={{ padding: '16px', color: 'var(--rn-clr-content-tertiary)', fontSize: '12px' }}>
            {ran
              ? 'No matches.'
              : 'Type a search and press Enter. Every key of Find Rem works here; Rems lists each Rem once, Cards lists the cards the search matched. Click a column title to sort.'}
          </div>
        ) : (
          rows.map((r, i) => {
            const isSel = selected.has(rowKey(r));
            return (
              <div
                id={`sb-row-${i}`}
                key={rowKey(r)}
                onMouseEnter={() => focus >= 0 && setFocus(i)}
                onMouseDown={noSteal}
                onClick={(e) => (e.metaKey || e.ctrlKey || e.shiftKey ? toggle(r) : setFocus(i))}
                onDoubleClick={() => openRow(r, false)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: grid,
                  gap: '8px',
                  padding: '5px 10px',
                  alignItems: 'center',
                  borderTop: '1px solid var(--rn-clr-background-tertiary)',
                  background: isSel ? SELECTED_BG : undefined,
                  boxShadow: isSel ? `inset 3px 0 0 ${FRAME}` : undefined,
                  outline: focus === i ? RING : 'none',
                  outlineOffset: '-2px',
                  cursor: 'default',
                }}
              >
                <input type="checkbox" checked={isSel} onChange={() => toggle(r)} tabIndex={-1} />
                {columns.map((c) => (
                  <div key={c.key} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: c.key === 'text' ? undefined : 'nowrap', fontSize: c.key === 'text' ? '13px' : '12px' }}>
                    {c.render(r)}
                  </div>
                ))}
              </div>
            );
          })
        )}
        {rows.length > 0 && rows.length < total && (
          <div style={{ padding: '8px 10px' }}>
            <button onMouseDown={noSteal} onClick={() => run({ append: true })} style={btn}>
              Load {Math.min(PAGE, total - rows.length)} more ({rows.length} of {total.toLocaleString()})
            </button>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: '12px' }}>
        <span style={{ color: 'var(--rn-clr-content-secondary)' }}>
          {ran ? `${total.toLocaleString()} ${mode === 'rems' ? 'Rems' : 'cards'}` : ''}
          {selected.size ? ` · ${selected.size} selected` : ''}
        </span>
        <div style={{ flex: 1 }} />
        <span style={{ color: 'var(--rn-clr-content-secondary)' }}>
          {targetRemIds.length ? `${targetRemIds.length} Rem(s):` : 'Select rows to act on them'}
        </span>
        <input
          value={priority}
          onChange={(e) => setPriority(e.target.value.replace(/[^0-9.]/g, ''))}
          placeholder="0–100"
          style={{ ...btn, width: '56px', cursor: 'text' }}
          title="Card priority to set"
        />
        <button onMouseDown={noSteal} onClick={doPriority} style={btn} disabled={!targetRemIds.length || !priority || !!busy}>
          Set card priority
        </button>
        <button onMouseDown={noSteal} onClick={doReEnable} style={btn} disabled={!targetRemIds.length || !!busy} title="Switch the Rems' cards back on (their Enable Cards toggle)">
          Switch cards on
        </button>
        <button onMouseDown={noSteal} onClick={doCopy} style={btn} disabled={!targetRemIds.length}>
          Copy ids
        </button>
      </div>
      <div style={{ fontSize: '11px', color: 'var(--rn-clr-content-tertiary)' }}>
        In the box: Enter search · Ctrl/Cmd+Enter ✨ AI (plain language) · ↑↓ last searches · Tab to the table — In the table: ↑↓ move · Space select · Enter open · Shift+Enter open in new pane · / or Shift+Tab back to the box — Esc collapse (sb or the bar brings it back) · Ctrl/Cmd+click select
      </div>
    </div>
  );
}

