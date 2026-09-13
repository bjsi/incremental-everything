import { renderWidget, usePlugin, useTrackerPlugin, RemId } from '@remnote/plugin-sdk';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import '../style.css';
import '../App.css';
import { IE_DOCS_BASE_URL } from '../lib/settings';
import {
  PRIORITY_QUEUE_BURST_MAX,
  PRIORITY_QUEUE_BURST_MIN,
  PRIORITY_QUEUE_DEFAULT_BURST,
  PRIORITY_QUEUE_SHIELD_SLICE,
  PRIORITY_QUEUE_SHIELD_SLICE_MAX,
  PRIORITY_QUEUE_SKIP_PAUSED,
  PRIORITY_QUEUE_PAUSED_THRESHOLD,
  allCardPriorityInfoKey,
  coolingCacheKey,
} from '../lib/consts';
import {
  computeShieldOutlook,
  findPriorityQueueDoc,
  isQueueOpen,
  practicePriorityQueue,
  refreshPriorityQueue,
  RefreshMode,
  RefreshResult,
} from '../lib/priority_review_document/queue_doc';
import { scanPriorityReviewDocuments, PrdDocReport } from '../lib/priority_review_document/clean';
import { CoolingVerdict, COOLING_RELATION_LABELS, DAY_MS } from '../lib/priority_review_document/cooling';
import {
  CoolingCache,
  extendCooling,
  releaseCooling,
  setNeverCool,
} from '../lib/priority_review_document/cooling_store';
import { scanCooling } from '../lib/priority_review_document/cooling_gather';
import { CardPriorityInfo } from '../lib/card_priority/types';
import { isPriorityReviewDocument, PRD_TAG_NAME } from '../lib/priority_review_document';
import { buildComprehensiveScope } from '../lib/scope_helpers';

const DOCS_PATH = 'Priority-Review-Document/';

/**
 * The Priority Queue popup — the front door to the persistent review document.
 *
 * One screen per scope: what the document holds, what a refresh would drain,
 * what the card shield stands at and where finishing the document would leave
 * it, and the actions — refresh, drain, refill, practise, open. A second tab
 * lists the Rems currently cooling with the reason and the day they return,
 * and lets you release, extend, or exempt any of them.
 *
 * Keyboard first, like every popup in the plugin: arrows move a selection ring
 * over the controls, Enter activates, Esc closes; keys are read on the
 * container, never on the buttons.
 */

const openDocs = () => {
  const url = `${IE_DOCS_BASE_URL}${DOCS_PATH}`;
  const opened = window.open(url, '_blank');
  if (!opened || opened.closed) {
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    setTimeout(() => document.body.removeChild(link), 100);
  }
};

type Tab = 'queue' | 'cooling';
type Phase = 'loading' | 'ready' | 'working' | 'error';

type Control =
  | 'scope-doc'
  | 'scope-kb'
  | 'burst'
  | 'slice'
  | 'paused'
  | 'pausedThreshold'
  | 'refresh'
  | 'drain'
  | 'refill'
  | 'practice'
  | 'open'
  | 'cooling'
  | 'sorting';

interface ScopeStatus {
  exists: boolean;
  docName: string;
  docRemId: RemId | null;
  burst: number;
  shieldSlice: number;
  skipPaused: boolean;
  pausedThreshold: number;
  lastRefresh: number | null;
  report: PrdDocReport | null;
  outlook: { now: number | null; afterDocument: number | null; overdueRems: number } | null;
}

const formatDate = (ms: number) =>
  new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const formatDateTime = (ms: number) =>
  new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const daysLeft = (until: number) => Math.max(0, Math.ceil((until - Date.now()) / DAY_MS));
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const priorityChip = (p: number | undefined) => (
  <span
    className="text-xs font-mono px-1 rounded shrink-0"
    style={{ background: 'var(--rn-clr-background-elevation-20)', color: 'var(--rn-clr-content-secondary)' }}
  >
    {typeof p === 'number' ? `P${p}` : 'P?'}
  </span>
);

export function PriorityQueuePopup() {
  const plugin = usePlugin();

  const context = useTrackerPlugin(
    async (rp) => (await rp.storage.getSession('reviewDocContext')) as { scopeRemId: string | null; scopeName: string } | null,
    []
  );
  const coolingCache = useTrackerPlugin(
    (rp) => rp.storage.getSession<CoolingCache>(coolingCacheKey),
    []
  );

  const [tab, setTab] = useState<Tab>('queue');
  const [useFullKB, setUseFullKB] = useState<boolean | null>(null);
  /**
   * null = still checking; true = the Rem you came from is itself a review
   * document (or the tag that lists them), so it cannot be a scope — a queue
   * built from a queue would only ever re-select what is already in it.
   */
  const [scopeBlocked, setScopeBlocked] = useState<boolean | null>(null);
  /**
   * Whether the document you came from already has a Priority Queue of its own.
   * Only then does the popup open on it; otherwise it opens on the Full
   * Knowledge Base, since a document scope with no queue has nothing to show
   * and its shield takes seconds to compute on a large document.
   */
  const [docHasQueue, setDocHasQueue] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState<ScopeStatus | null>(null);
  const [burst, setBurst] = useState<number>(PRIORITY_QUEUE_DEFAULT_BURST);
  const [slicePct, setSlicePct] = useState<number>(Math.round(PRIORITY_QUEUE_SHIELD_SLICE * 100));
  const [skipPaused, setSkipPaused] = useState<boolean>(PRIORITY_QUEUE_SKIP_PAUSED);
  const [pausedThreshold, setPausedThreshold] = useState<number>(PRIORITY_QUEUE_PAUSED_THRESHOLD);
  const [result, setResult] = useState<RefreshResult | null>(null);
  const [notice, setNotice] = useState('');
  // Practice is the default action: it is where the daily loop ends up.
  const [control, setControl] = useState<Control>('practice');
  const [coolingRow, setCoolingRow] = useState(0);
  const [rescanning, setRescanning] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const burstRef = useRef<HTMLInputElement>(null);
  const sliceRef = useRef<HTMLInputElement>(null);
  const pausedThresholdRef = useRef<HTMLInputElement>(null);

  // Is the Rem you came from usable as a scope?
  useEffect(() => {
    if (context === undefined) return;
    let cancelled = false;
    (async () => {
      let blocked = false;
      if (context?.scopeRemId) {
        try {
          const rem = await plugin.rem.findOne(context.scopeRemId);
          const text = Array.isArray(rem?.text) ? rem!.text.filter((t) => typeof t === 'string').join('').trim() : '';
          blocked = !rem || text === PRD_TAG_NAME || (await isPriorityReviewDocument(rem));
        } catch {
          blocked = true;
        }
      }
      let hasQueue = false;
      if (context?.scopeRemId && !blocked) {
        try {
          hasQueue = !!(await findPriorityQueueDoc(plugin, context.scopeRemId));
        } catch {
          hasQueue = false;
        }
      }
      if (cancelled) return;
      // docHasQueue first: the default-scope effect waits on scopeBlocked, and
      // these two updates are not batched outside an event handler.
      setDocHasQueue(hasQueue);
      setScopeBlocked(blocked);
    })();
    return () => {
      cancelled = true;
    };
  }, [plugin, context]);

  const docScopeAvailable = !!context?.scopeRemId && scopeBlocked === false;

  // Default scope: the document you came from, when it qualifies AND already has
  // a Priority Queue of its own; the Full Knowledge Base otherwise. The document
  // stays selectable either way.
  useEffect(() => {
    if (context === undefined || scopeBlocked === null) return;
    if (useFullKB === null) setUseFullKB(!(docScopeAvailable && docHasQueue));
    else if (!docScopeAvailable && useFullKB === false) setUseFullKB(true);
  }, [context, scopeBlocked, docScopeAvailable, docHasQueue, useFullKB]);

  const scopeRemId: RemId | null = useFullKB || !docScopeAvailable ? null : context?.scopeRemId ?? null;
  const scopeLabel = scopeRemId ? context?.scopeName || 'Current document' : 'Full Knowledge Base';

  const coolingVerdicts: CoolingVerdict[] = useMemo(() => {
    const now = Date.now();
    return (coolingCache?.verdicts ?? [])
      .filter((v) => v.until > now)
      .sort((a, b) => (a.priority ?? 101) - (b.priority ?? 101) || a.until - b.until);
  }, [coolingCache]);
  const coolingIds = useMemo(() => new Set(coolingVerdicts.map((v) => v.remId)), [coolingVerdicts]);

  /**
   * Every load is numbered, and a result is applied only if no newer load has
   * started since. Switching scope while a slow load is still running used to
   * let the old load finish last and overwrite the new status — a document
   * scope's "no Priority Queue yet" landing under the Full Knowledge Base label.
   */
  const loadGeneration = useRef(0);
  /** Comprehensive scope per document, built once per popup — it can take seconds. */
  const scopeIdsCache = useRef(new Map<RemId, Promise<Set<RemId>>>());
  const [outlookPending, setOutlookPending] = useState(false);

  const scopeIdsFor = (remId: RemId): Promise<Set<RemId>> => {
    let pending = scopeIdsCache.current.get(remId);
    if (!pending) {
      pending = buildComprehensiveScope(plugin, remId);
      // A failed build must not be cached as a permanent failure.
      pending.catch(() => scopeIdsCache.current.delete(remId));
      scopeIdsCache.current.set(remId, pending);
    }
    return pending;
  };

  const loadStatus = useCallback(async () => {
    if (useFullKB === null) return;
    const generation = ++loadGeneration.current;
    const isCurrent = () => generation === loadGeneration.current;
    setPhase('loading');
    setError('');
    setOutlookPending(false);
    try {
      // Status first: finding the document and scanning it is quick. The
      // document-scoped shield needs the comprehensive scope, which on a large
      // document takes several seconds, so it fills in afterwards instead of
      // holding the whole status back.
      const info = await findPriorityQueueDoc(plugin, scopeRemId);
      if (!isCurrent()) return;

      let targets: RemId[] = [];
      if (!info) {
        setStatus({
          exists: false,
          docName: '',
          docRemId: null,
          burst: PRIORITY_QUEUE_DEFAULT_BURST,
          shieldSlice: PRIORITY_QUEUE_SHIELD_SLICE,
          skipPaused: PRIORITY_QUEUE_SKIP_PAUSED,
          pausedThreshold: PRIORITY_QUEUE_PAUSED_THRESHOLD,
          lastRefresh: null,
          report: null,
          outlook: null,
        });
        setBurst(PRIORITY_QUEUE_DEFAULT_BURST);
        setSlicePct(Math.round(PRIORITY_QUEUE_SHIELD_SLICE * 100));
        setSkipPaused(PRIORITY_QUEUE_SKIP_PAUSED);
        setPausedThreshold(PRIORITY_QUEUE_PAUSED_THRESHOLD);
        setPhase('ready');
      } else {
      // The entry targets come out of the scan itself: reading the document a
      // second time only doubled the cost.
      const scan = await scanPriorityReviewDocuments(plugin, undefined, {
        docIds: [info.doc._id],
        coolingRemIds: coolingIds,
      });
      if (!isCurrent()) return;
      const report = scan.docs[0] ?? null;
      targets = report
        ? [...report.dueEntries, ...report.removableEntries, ...report.keptEntries, ...report.unknownEntries]
            .map((e) => e.targetRemId)
            .filter((id): id is RemId => !!id)
        : [];
      setStatus({
        exists: true,
        docName: report?.docName ?? 'Priority Queue',
        docRemId: info.doc._id,
        burst: info.burst,
        shieldSlice: info.shieldSlice,
        skipPaused: info.skipPaused,
        pausedThreshold: info.pausedThreshold,
        lastRefresh: info.lastRefresh,
        report,
        outlook: null,
      });
      setBurst(info.burst);
      setSlicePct(Math.round(info.shieldSlice * 100));
      setSkipPaused(info.skipPaused);
      setPausedThreshold(info.pausedThreshold);
      setPhase('ready');
      }

      // Then the shield outlook, patched into the status it belongs to.
      setOutlookPending(true);
      const scopeIds = scopeRemId ? await scopeIdsFor(scopeRemId) : null;
      if (!isCurrent()) return;
      const outlook = await computeShieldOutlook(plugin, new Set(targets), coolingIds, scopeIds);
      if (!isCurrent()) return;
      setStatus((prev) => (prev ? { ...prev, outlook } : prev));
      setOutlookPending(false);
    } catch (e) {
      if (!isCurrent()) return;
      console.error('[Priority Queue] status failed:', e);
      setError((e as any)?.message ?? String(e));
      setOutlookPending(false);
      setPhase('error');
    }
  }, [plugin, scopeRemId, useFullKB, coolingIds]);

  useEffect(() => {
    void loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeRemId, useFullKB]);

  // Container owns the keys; win against RemNote settling focus after open.
  useEffect(() => {
    let cancelled = false;
    const tryFocus = (attemptsLeft: number) => {
      if (cancelled) return;
      if (document.activeElement?.tagName === 'INPUT') return;
      try {
        window.focus();
      } catch {
        /* ignore */
      }
      containerRef.current?.focus();
      if (document.activeElement !== containerRef.current && attemptsLeft > 0) {
        setTimeout(() => tryFocus(attemptsLeft - 1), 50);
      }
    };
    tryFocus(8);
    return () => {
      cancelled = true;
    };
  }, [phase, tab]);

  const close = () => plugin.widget.closePopup();

  const clampBurstInput = (n: number) =>
    Math.max(PRIORITY_QUEUE_BURST_MIN, Math.min(PRIORITY_QUEUE_BURST_MAX, Math.round(Number.isFinite(n) ? n : PRIORITY_QUEUE_DEFAULT_BURST)));
  const clampThresholdInput = (n: number) =>
    Math.max(0, Math.min(100, Math.round(Number.isFinite(n) ? n : PRIORITY_QUEUE_PAUSED_THRESHOLD)));
  const clampSliceInput = (n: number) =>
    Math.max(0, Math.min(Math.round(PRIORITY_QUEUE_SHIELD_SLICE_MAX * 100), Math.round(Number.isFinite(n) ? n : 0)));

  const runAction = async (mode: RefreshMode) => {
    if (phase === 'working') return;
    setPhase('working');
    setNotice('');
    setResult(null);
    setError('');
    setProgress(mode === 'drain' ? 'Draining…' : mode === 'refill' ? 'Refilling…' : 'Refreshing…');
    try {
      const r = await refreshPriorityQueue(plugin, {
        scopeRemId,
        mode,
        burst: clampBurstInput(burst),
        shieldSlice: clampSliceInput(slicePct) / 100,
        skipPaused,
        pausedThreshold: clampThresholdInput(pausedThreshold),
        onProgress: (m) => setProgress(m),
      });
      if (r.blocked) {
        setNotice('A queue is open. The Priority Queue is never edited during a session — close the queue and try again.');
      } else {
        setResult(r);
      }
      await loadStatus();
    } catch (e) {
      console.error('[Priority Queue] action failed:', e);
      setError((e as any)?.message ?? String(e));
      setPhase('error');
    }
  };

  const practice = async () => {
    if (phase === 'working') return;
    if (await isQueueOpen(plugin)) {
      setNotice('A queue is already open.');
      return;
    }
    let docId = status?.docRemId ?? null;
    if (!docId) {
      // No document yet: build it first, then practise it.
      setPhase('working');
      setProgress('Building the Priority Queue…');
      try {
        const r = await refreshPriorityQueue(plugin, {
          scopeRemId,
          burst: clampBurstInput(burst),
          shieldSlice: clampSliceInput(slicePct) / 100,
          skipPaused,
          pausedThreshold: clampThresholdInput(pausedThreshold),
          onProgress: (m) => setProgress(m),
        });
        docId = r.doc?._id ?? null;
      } catch (e) {
        setError((e as any)?.message ?? String(e));
        setPhase('error');
        return;
      }
    }
    if (!docId) return;
    const doc = await plugin.rem.findOne(docId);
    if (!doc) return;
    await practicePriorityQueue(plugin, doc);
    close();
  };

  const openDocument = async () => {
    if (!status?.docRemId) return;
    const doc = await plugin.rem.findOne(status.docRemId);
    if (!doc) return;
    await doc.openRemAsPage();
    close();
  };

  const rescanCooling = async () => {
    if (rescanning) return;
    setRescanning(true);
    try {
      const infos = (await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey)) || [];
      const top = infos
        .filter((i) => (i.dueCards ?? 0) > 0 && !i.paused)
        .sort((a, b) => a.priority - b.priority)
        .slice(0, 200);
      await scanCooling(plugin, top.map((t) => t.remId), {
        priorityByRemId: new Map(top.map((t) => [t.remId, t.priority])),
        scopeRemId: null,
      });
    } catch (e) {
      console.error('[Priority Queue] cooling rescan failed:', e);
    } finally {
      setRescanning(false);
    }
  };

  const coolingAction = async (kind: 'release' | 'extend' | 'never' | 'open', v: CoolingVerdict) => {
    try {
      if (kind === 'release') await releaseCooling(plugin, v.remId);
      else if (kind === 'extend') await extendCooling(plugin, v.remId, 7);
      else if (kind === 'never') await setNeverCool(plugin, v.remId, true);
      else {
        const rem = await plugin.rem.findOne(v.remId);
        if (rem) {
          await rem.openRemAsPage();
          close();
        }
      }
    } catch (e) {
      console.error('[Priority Queue] cooling action failed:', e);
    }
  };

  // --- keyboard -------------------------------------------------------------

  const controls: Control[] = useMemo(() => {
    const list: Control[] = [];
    if (docScopeAvailable) list.push('scope-doc');
    list.push('scope-kb', 'burst', 'slice', 'paused');
    if (skipPaused) list.push('pausedThreshold');
    list.push('refresh', 'drain', 'refill');
    if (status?.exists) list.push('open');
    list.push('cooling', 'sorting', 'practice');
    return list;
  }, [docScopeAvailable, status?.exists, skipPaused]);

  const activate = (c: Control) => {
    switch (c) {
      case 'scope-doc':
        setUseFullKB(false);
        break;
      case 'scope-kb':
        setUseFullKB(true);
        break;
      case 'burst':
        burstRef.current?.focus();
        burstRef.current?.select();
        break;
      case 'slice':
        sliceRef.current?.focus();
        sliceRef.current?.select();
        break;
      case 'paused':
        setSkipPaused((v) => !v);
        break;
      case 'pausedThreshold':
        pausedThresholdRef.current?.focus();
        pausedThresholdRef.current?.select();
        break;
      case 'refresh':
        void runAction('refresh');
        break;
      case 'drain':
        void runAction('drain');
        break;
      case 'refill':
        void runAction('refill');
        break;
      case 'practice':
        void practice();
        break;
      case 'open':
        void openDocument();
        break;
      case 'cooling':
        setTab('cooling');
        setCoolingRow(0);
        break;
      case 'sorting':
        void plugin.widget.openPopup('sorting_criteria');
        break;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target?.tagName === 'INPUT') {
      // Enter or Esc in a number field hands the keys back to the container.
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault();
        (target as HTMLInputElement).blur();
        containerRef.current?.focus();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (tab === 'cooling') setTab('queue');
      else if (phase !== 'working') close();
      return;
    }
    if (target?.tagName === 'BUTTON') return;

    if (tab === 'cooling') {
      const n = coolingVerdicts.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (n === 0) return;
        setCoolingRow((r) => (e.key === 'ArrowDown' ? (r + 1) % n : (r - 1 + n) % n));
        return;
      }
      const v = coolingVerdicts[coolingRow];
      if (!v) return;
      if (e.key === 'r' || e.key === 'R') void coolingAction('release', v);
      else if (e.key === 'e' || e.key === 'E') void coolingAction('extend', v);
      else if (e.key === 'n' || e.key === 'N') void coolingAction('never', v);
      else if (e.key === 'Enter' || e.key === 'o' || e.key === 'O') void coolingAction('open', v);
      return;
    }

    if (phase === 'working') return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      const idx = Math.max(0, controls.indexOf(control));
      const forward = e.key === 'ArrowRight' || e.key === 'ArrowDown';
      setControl(controls[(idx + (forward ? 1 : controls.length - 1)) % controls.length]);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      activate(control);
    }
  };

  // --- styles ---------------------------------------------------------------

  const ring = (c: Control): React.CSSProperties =>
    control === c && tab === 'queue'
      ? { outline: '2px solid var(--rn-clr-border-accent, #3B82F6)', outlineOffset: '2px' }
      : {};
  const primaryButton: React.CSSProperties = { background: '#3B82F6', color: 'white', border: 'none', cursor: 'pointer' };
  const secondaryButton: React.CSSProperties = {
    background: 'transparent',
    color: 'var(--rn-clr-content-primary)',
    border: '1px solid var(--rn-clr-border-opaque, rgba(128,128,128,0.3))',
    cursor: 'pointer',
  };
  const disabledStyle: React.CSSProperties = { opacity: 0.5, cursor: 'not-allowed' };
  const card: React.CSSProperties = { background: 'var(--rn-clr-background-elevation-10)' };
  const muted: React.CSSProperties = { color: 'var(--rn-clr-content-secondary)' };
  const faint: React.CSSProperties = { color: 'var(--rn-clr-content-tertiary)' };

  const actionButton = (c: Control, label: string, title: string, style: React.CSSProperties, onClick: () => void, disabled = false) => (
    <button
      onClick={onClick}
      onMouseEnter={() => !disabled && setControl(c)}
      onMouseDown={(e) => e.preventDefault()}
      disabled={disabled || phase === 'working'}
      title={title}
      className="px-3 py-1.5 text-sm rounded"
      style={{ ...style, ...(disabled || phase === 'working' ? disabledStyle : {}), ...ring(c) }}
    >
      {label}
    </button>
  );

  // --- pieces ---------------------------------------------------------------

  const header = (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <span style={{ fontSize: 18 }}>🎯</span>
        <span className="font-semibold text-base">Priority Queue</span>
        {tab === 'cooling' && (
          <span className="text-sm" style={muted}>
            · Cooling
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        {tab === 'cooling' && (
          <button
            onClick={() => setTab('queue')}
            onMouseDown={(e) => e.preventDefault()}
            className="text-xs px-2 py-0.5 rounded"
            style={secondaryButton}
          >
            ← Back
          </button>
        )}
        <button
          onClick={openDocs}
          onMouseDown={(e) => e.preventDefault()}
          title="Open the documentation"
          className="rounded-full w-6 h-6 flex items-center justify-center hover:opacity-75"
          style={{ border: '1px solid var(--rn-clr-border-opaque, rgba(128,128,128,0.3))', color: 'var(--rn-clr-content-secondary)', background: 'transparent', cursor: 'pointer' }}
        >
          ?
        </button>
      </div>
    </div>
  );

  const scopeRow = (
    <div className="rounded p-3 flex items-start gap-4" style={card}>
      <div className="font-semibold text-sm" style={{ width: 70 }}>
        Scope
      </div>
      <div className="flex flex-col gap-1.5 min-w-0">
        {docScopeAvailable && (
          <label
            className="flex items-center gap-2 text-sm cursor-pointer rounded px-1"
            style={ring('scope-doc')}
            onMouseEnter={() => setControl('scope-doc')}
          >
            <input type="radio" checked={useFullKB === false} onChange={() => setUseFullKB(false)} onMouseDown={(e) => e.preventDefault()} />
            <span className="truncate">Current document: {context?.scopeName}</span>
          </label>
        )}
        {context?.scopeRemId && scopeBlocked && (
          <div className="text-xs" style={faint}>
            “{context.scopeName}” is a review document, so it cannot be a scope.
          </div>
        )}
        <label
          className="flex items-center gap-2 text-sm cursor-pointer rounded px-1"
          style={ring('scope-kb')}
          onMouseEnter={() => setControl('scope-kb')}
        >
          <input type="radio" checked={useFullKB !== false} onChange={() => setUseFullKB(true)} onMouseDown={(e) => e.preventDefault()} />
          <span>Full Knowledge Base</span>
        </label>
      </div>
    </div>
  );

  const report = status?.report;
  const dueFc = report?.dueFlashcards ?? 0;
  const dueInc = report ? report.dueEntries.length - report.dueFlashcards + report.unknownEntries.length : 0;
  const toDrain = report?.removableEntries.length ?? 0;
  const coolingInDoc = report?.coolingEntries ?? 0;
  const holding = report?.totalEntries ?? 0;
  const willAdd = status ? Math.max(0, clampBurstInput(burst) - (holding - toDrain)) : 0;

  const statusCard = (
    <div className="rounded p-3 flex flex-col gap-1.5 text-sm" style={card}>
      {phase === 'loading' && !status ? (
        <div style={muted}>Reading the Priority Queue…</div>
      ) : !status?.exists ? (
        <>
          <div className="font-medium">No Priority Queue yet for {scopeLabel}.</div>
          <div className="text-xs" style={muted}>
            Refresh builds it: one persistent document, topped up to the fill target with your highest-priority due
            items and drained as you review them. Practise it like any document.
          </div>
        </>
      ) : (
        <>
          <div className="font-medium truncate" title={status.docName}>
            {status.docName}
          </div>
          <div style={muted}>
            Holding <span className="font-bold">{holding}</span> {holding === 1 ? 'entry' : 'entries'} ·{' '}
            <span className="font-bold">{dueFc}</span> flashcard {dueFc === 1 ? 'Rem' : 'Rems'} due ·{' '}
            <span className="font-bold">{dueInc}</span> IncRems
            {toDrain > 0 && (
              <>
                {' '}
                · <span className="font-bold" style={{ color: '#dc2626' }}>{toDrain}</span> to drain
                {coolingInDoc > 0 && <> ({coolingInDoc} cooling)</>}
              </>
            )}
          </div>
          <div className="text-xs" style={faint}>
            {status.lastRefresh ? `Last refresh ${formatDateTime(status.lastRefresh)}` : 'Never refreshed'} · fill target{' '}
            {status.burst} · shield slice {Math.round(status.shieldSlice * 100)}% ·{' '}
            {status.skipPaused ? `paused skipped above P${status.pausedThreshold}` : 'paused included'}
            {willAdd > 0 && phase === 'ready' && <> · a refresh adds up to {willAdd}</>}
          </div>
        </>
      )}
      {!status?.outlook && outlookPending && (
        <div className="text-xs pt-1" style={{ ...faint, borderTop: '1px solid var(--rn-clr-border-opaque, rgba(128,128,128,0.2))' }}>
          {scopeRemId ? 'Computing the document card shield…' : 'Computing the KB card shield…'}
        </div>
      )}
      {status?.outlook && (
        <div className="text-xs pt-1" style={{ ...muted, borderTop: '1px solid var(--rn-clr-border-opaque, rgba(128,128,128,0.2))' }}>
          {scopeRemId ? 'Document card shield now' : 'KB card shield now'}{' '}
          <span className="font-bold" style={{ color: 'var(--rn-clr-content-primary)' }}>
            {status.outlook.now === null ? '—' : `P${status.outlook.now}`}
          </span>
          {status.exists && (
            <>
              {' '}
              · after this document{' '}
              <span className="font-bold" style={{ color: 'var(--rn-clr-content-primary)' }}>
                {status.outlook.afterDocument === null ? '100 (clear)' : `P${status.outlook.afterDocument}`}
              </span>
            </>
          )}{' '}
          · {status.outlook.overdueRems.toLocaleString()} overdue Rems{scopeRemId ? ' in scope' : ''}
          {coolingVerdicts.length > 0 && (
            <>
              {' '}
              · <span className="font-bold">{coolingVerdicts.length}</span> cooling, not counted
            </>
          )}
        </div>
      )}
    </div>
  );

  const settingsRow = (
    <div className="flex items-center gap-4 text-sm flex-wrap">
      <label className="flex items-center gap-2 rounded px-1" style={ring('burst')} onMouseEnter={() => setControl('burst')}>
        <span>Fill target</span>
        <input
          ref={burstRef}
          type="number"
          min={PRIORITY_QUEUE_BURST_MIN}
          max={PRIORITY_QUEUE_BURST_MAX}
          value={burst}
          onChange={(e) => setBurst(Number(e.target.value))}
          onBlur={() => setBurst((b) => clampBurstInput(b))}
          className="w-16 px-1 py-0.5 rounded text-sm"
          style={{ border: '1px solid var(--rn-clr-border-opaque, rgba(128,128,128,0.3))', background: 'var(--rn-clr-background-primary)' }}
        />
        <span className="flex gap-1">
          {[25, 50, 100].map((n) => (
            <button
              key={n}
              onClick={() => setBurst(n)}
              onMouseDown={(e) => e.preventDefault()}
              className="text-xs px-1.5 py-0.5 rounded"
              style={{ ...secondaryButton, ...(burst === n ? { background: 'var(--rn-clr-background-elevation-20)' } : {}) }}
            >
              {n}
            </button>
          ))}
        </span>
      </label>
      <label
        className="flex items-center gap-2 rounded px-1"
        style={ring('slice')}
        onMouseEnter={() => setControl('slice')}
        title="Share of each burst filled strictly by priority before your randomness applies. 0% follows the Sorting Criteria exactly."
      >
        <span>Shield slice</span>
        <input
          ref={sliceRef}
          type="number"
          min={0}
          max={Math.round(PRIORITY_QUEUE_SHIELD_SLICE_MAX * 100)}
          step={5}
          value={slicePct}
          onChange={(e) => setSlicePct(Number(e.target.value))}
          onBlur={() => setSlicePct((s) => clampSliceInput(s))}
          className="w-14 px-1 py-0.5 rounded text-sm"
          style={{ border: '1px solid var(--rn-clr-border-opaque, rgba(128,128,128,0.3))', background: 'var(--rn-clr-background-primary)' }}
        />
        <span>%</span>
      </label>
      <div className="flex items-center gap-2 flex-wrap basis-full">
        <label
          className="flex items-center gap-2 rounded px-1 cursor-pointer"
          style={ring('paused')}
          onMouseEnter={() => setControl('paused')}
          title='Leave out flashcard Rems inside documents whose Deck Status is "Paused". Skipped Rems are listed after each action.'
        >
          <input
            type="checkbox"
            checked={skipPaused}
            onChange={(e) => setSkipPaused(e.target.checked)}
            onMouseDown={(e) => e.preventDefault()}
          />
          <span>Skip paused documents</span>
        </label>
        {skipPaused && (
          <label
            className="flex items-center gap-2 rounded px-1"
            style={ring('pausedThreshold')}
            onMouseEnter={() => setControl('pausedThreshold')}
          >
            <span style={muted}>but always keep priority</span>
            <input
              ref={pausedThresholdRef}
              type="number"
              min={0}
              max={100}
              value={pausedThreshold}
              onChange={(e) => setPausedThreshold(Number(e.target.value))}
              onBlur={() => setPausedThreshold((t) => clampThresholdInput(t))}
              className="w-14 px-1 py-0.5 rounded text-sm"
              style={{ border: '1px solid var(--rn-clr-border-opaque, rgba(128,128,128,0.3))', background: 'var(--rn-clr-background-primary)' }}
            />
            <span style={muted}>or less</span>
          </label>
        )}
      </div>
    </div>
  );

  const actionsRow = (
    <div className="flex items-stretch gap-3">
      <div className="flex flex-wrap gap-2 flex-1 min-w-0 content-start">
        {actionButton('refresh', status?.exists ? 'Refresh' : 'Build', status?.exists ? 'Drain what you reviewed, then top up to the fill target' : 'Create the Priority Queue and fill it', secondaryButton, () => runAction('refresh'))}
        {actionButton('drain', 'Drain', 'Remove reviewed and cooling entries only', secondaryButton, () => runAction('drain'), !status?.exists)}
        {actionButton('refill', 'Refill', 'Top up to the fill target without draining', secondaryButton, () => runAction('refill'), !status?.exists)}
        {status?.exists && actionButton('open', 'Open document', 'Open the Priority Queue document as a page', secondaryButton, () => openDocument())}
        {actionButton('cooling', `Cooling${coolingVerdicts.length ? ` (${coolingVerdicts.length})` : ''}`, 'Rems left out because a card that gives their answer away was reviewed recently', secondaryButton, () => { setTab('cooling'); setCoolingRow(0); })}
        {actionButton('sorting', 'Sorting…', 'Sorting Criteria: randomness and flashcard ratio', secondaryButton, () => plugin.widget.openPopup('sorting_criteria'))}
      </div>
      {/* The default action, set apart: large, primary, and on the right. */}
      <button
        onClick={() => practice()}
        onMouseEnter={() => setControl('practice')}
        onMouseDown={(e) => e.preventDefault()}
        disabled={phase === 'working'}
        title={status?.exists ? 'Open the queue on the Priority Queue document' : 'Build the Priority Queue, then open the queue on it'}
        className="px-5 rounded text-base font-semibold shrink-0 flex items-center justify-center gap-2"
        style={{ ...primaryButton, minWidth: 150, minHeight: 56, ...(phase === 'working' ? disabledStyle : {}), ...ring('practice') }}
      >
        <span style={{ fontSize: 20 }}>▶</span>
        <span>Practice</span>
      </button>
    </div>
  );

  const listPanel = (title: string, color: string, rows: React.ReactNode[]) =>
    rows.length === 0 ? null : (
      <div className="rounded p-2 text-xs flex flex-col gap-0.5" style={{ background: color }}>
        <div className="font-semibold mb-0.5">{title}</div>
        <div style={{ maxHeight: 140, overflowY: 'auto' }}>{rows}</div>
      </div>
    );

  const resultPanel = result && !result.blocked && (
    <div className="flex flex-col gap-2">
      <div className="text-sm">
        Now holding <span className="font-bold">{result.holding.total}</span> ({result.holding.flashcards} FC, {result.holding.incRems} INC) — drained{' '}
        <span className="font-bold">{result.drained.reviewed}</span> reviewed
        {result.drained.cooling > 0 && <>, <span className="font-bold">{result.drained.cooling}</span> cooling</>}
        {result.drained.missing > 0 && <>, {result.drained.missing} missing</>}, added{' '}
        <span className="font-bold">{result.added.total}</span>
        {result.added.shieldSlice > 0 && <> ({result.added.shieldSlice} from the shield slice)</>}.{' '}
        <span style={faint}>{(result.elapsedMs / 1000).toFixed(1)}s</span>
      </div>
      {result.selection &&
        listPanel(
          `🧊 ${plural(result.selection.skippedCoolingItems.length, 'Rem', 'Rems')} left out, cooling`,
          'rgba(59,130,246,0.10)',
          result.selection.skippedCoolingItems.slice(0, 50).map((s) => (
            <div key={s.remId} className="flex items-center gap-2">
              {priorityChip(s.priority)}
              <span className="truncate flex-1" title={s.name}>{s.name}</span>
              <span style={faint}>{s.reason} · back {formatDate(s.until)}</span>
            </div>
          ))
        )}
      {result.selection &&
        listPanel(
          `🎭 ${plural(result.selection.skippedAncestorItems.length, 'Rem', 'Rems')} held back by a due ancestor`,
          'rgba(147,51,234,0.10)',
          result.selection.skippedAncestorItems.slice(0, 50).map((s) => (
            <div key={s.remId} className="flex items-center gap-2">
              {priorityChip(s.priority)}
              <span className="truncate flex-1" title={s.name}>{s.name}</span>
              <span style={faint}>
                {s.level === 1 ? 'parent' : 'grandparent'} “{s.ancestorName.slice(0, 30)}” —{' '}
                {s.ancestorAction === 'added' ? 'swapped in' : s.ancestorAction === 'cooling' ? 'cooling too' : s.ancestorAction === 'already-included' ? 'already in' : 'unavailable'}
              </span>
            </div>
          ))
        )}
      {result.selection && result.selection.skippedPausedItems.length > 0 && (() => {
        const skipped = result.selection.skippedPausedItems;
        const high = skipped.filter((s) => s.priority < 20).length;
        return (
          <div
            className="rounded p-2 text-xs flex flex-col gap-1"
            style={{ background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.45)' }}
          >
            <div className="font-semibold">
              ⚠️ {plural(skipped.length, 'flashcard Rem', 'flashcard Rems')} skipped — inside paused documents
              {high > 0 && <span style={{ color: '#ef4444', marginLeft: 8 }}>— includes {high} HIGH PRIORITY</span>}
            </div>
            <div style={muted}>
              Left out of the document. Unpause their documents, raise the “always keep” priority, or review them separately.
            </div>
            <div style={{ maxHeight: 160, overflowY: 'auto' }}>
              {skipped.slice(0, 100).map((s) => (
                <div key={s.remId} className="flex items-center gap-2" style={{ color: s.priority < 20 ? '#ef4444' : undefined }}>
                  {priorityChip(s.priority)}
                  <span className="truncate flex-1" title={s.name}>{s.name || s.remId}</span>
                </div>
              ))}
              {skipped.length > 100 && <div style={faint}>…and {skipped.length - 100} more — the full list is in the console.</div>}
            </div>
          </div>
        );
      })()}
    </div>
  );

  const queueTab = (
    <>
      {scopeRow}
      {statusCard}
      {settingsRow}
      {actionsRow}
      {phase === 'working' && (
        <div className="text-xs" style={muted}>
          ⏳ {progress}
        </div>
      )}
      {notice && (
        <div className="text-xs p-2 rounded" style={{ background: 'rgba(234,179,8,0.15)' }}>
          {notice}
        </div>
      )}
      {error && (
        <div className="text-xs p-2 rounded" style={{ background: 'rgba(220,38,38,0.1)', color: '#dc2626' }}>
          {error}
        </div>
      )}
      {resultPanel}
      <div className="text-xs" style={faint}>
        <span className="font-mono">←→</span> choose · <span className="font-mono">Enter</span> activate ·{' '}
        <span className="font-mono">Esc</span> close · never runs while a queue is open
      </div>
    </>
  );

  const coolingTab = (
    <>
      <div className="text-sm" style={muted}>
        {coolingVerdicts.length === 0 ? (
          'Nothing is cooling right now.'
        ) : (
          <>
            <span className="font-bold">{coolingVerdicts.length}</span> {coolingVerdicts.length === 1 ? 'Rem is' : 'Rems are'} cooling: a
            card that gives the answer away was reviewed recently, so they stay out of the Priority Queue and cannot set the
            shield until their window ends.
          </>
        )}
        {coolingCache?.computedAt && (
          <span style={faint}> Last scan {formatDateTime(coolingCache.computedAt)}.</span>
        )}
      </div>
      <div className="flex flex-col gap-1" style={{ maxHeight: 380, overflowY: 'auto' }}>
        {coolingVerdicts.map((v, i) => {
          const first = v.reasons[0];
          const selected = i === coolingRow;
          return (
            <div
              key={v.remId}
              className="rounded p-2 flex items-center gap-2 text-xs"
              style={{ ...card, ...(selected ? { outline: '2px solid var(--rn-clr-border-accent, #3B82F6)', outlineOffset: '-2px' } : {}) }}
              onMouseEnter={() => setCoolingRow(i)}
            >
              {priorityChip(v.priority)}
              <div className="flex-1 min-w-0">
                <div className="truncate text-sm" title={v.label ?? v.remId}>
                  {v.label ?? v.remId}
                </div>
                <div style={faint}>
                  {first
                    ? `${COOLING_RELATION_LABELS[first.relation]} ${formatDate(first.seenAt)}${first.sourceLabel && first.relation !== 'same-rem' ? ` (“${first.sourceLabel.slice(0, 40)}”)` : ''}`
                    : 'extended by you'}
                  {' · '}back {formatDate(v.until)} ({plural(daysLeft(v.until), 'day', 'days')}, window {v.windowDays}d)
                </div>
              </div>
              <div className="flex gap-1 shrink-0">
                <button onClick={() => coolingAction('release', v)} onMouseDown={(e) => e.preventDefault()} className="px-1.5 py-0.5 rounded" style={secondaryButton} title="Release now (R): stop cooling; a later sibling review cools it again">
                  Release
                </button>
                <button onClick={() => coolingAction('extend', v)} onMouseDown={(e) => e.preventDefault()} className="px-1.5 py-0.5 rounded" style={secondaryButton} title="Extend (E): keep it cooling 7 more days">
                  +7d
                </button>
                <button onClick={() => coolingAction('never', v)} onMouseDown={(e) => e.preventDefault()} className="px-1.5 py-0.5 rounded" style={secondaryButton} title="Never cool (N): exempt this Rem from cooling for good">
                  Never
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs" style={faint}>
          <span className="font-mono">↑↓</span> choose · <span className="font-mono">R</span> release ·{' '}
          <span className="font-mono">E</span> extend · <span className="font-mono">N</span> never ·{' '}
          <span className="font-mono">Enter</span> open · <span className="font-mono">Esc</span> back
        </div>
        <button
          onClick={rescanCooling}
          onMouseDown={(e) => e.preventDefault()}
          disabled={rescanning}
          className="text-xs px-2 py-1 rounded"
          style={{ ...secondaryButton, ...(rescanning ? disabledStyle : {}) }}
          title="Judge the 200 highest-priority Rems with due cards again"
        >
          {rescanning ? 'Scanning…' : 'Rescan top 200 due'}
        </button>
      </div>
    </>
  );

  return (
    <div ref={containerRef} tabIndex={-1} onKeyDown={onKeyDown} className="flex flex-col gap-3 p-4" style={{ outline: 'none' }}>
      {header}
      {tab === 'queue' ? queueTab : coolingTab}
    </div>
  );
}

renderWidget(PriorityQueuePopup);
