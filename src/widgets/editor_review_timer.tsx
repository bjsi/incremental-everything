import {
  renderWidget,
  usePlugin,
  useTrackerPlugin,
} from '@remnote/plugin-sdk';
import React, { useCallback, useEffect, useState } from 'react';
import { EditorReviewJob } from '../lib/incremental_rem/review_jobs';
import { determineIncRemType } from '../lib/incRemHelpers';
import { getActivePdfForIncRem, setActivePdfForIncRem, getAllPDFsInRem, findHTMLinRem, getPageHistory, safeRemTextToString } from '../lib/pdfUtils';
import { openAndScrollToHighlight, openAndFocusRem } from '../lib/remHelpers';
import { getRemReadPoint } from '../lib/remReadPoint';
import { PageControls } from '../components/reader/ui';
import { usePdfPageControls } from '../components/reader/usePdfPageControls';
import { startIncRemEngagement, endIncRemEngagement } from '../lib/queue_session';
import {
  setPendingReviewNote,
  getPendingReviewNote,
  MAX_NOTE_LENGTH,
} from '../lib/history_notes';
import { clearEditorReviewTimerHeights, reportEditorReviewTimerHeight } from '../lib/editor_review_timer_sticky';
import {
  dismissEditorReview,
  editorTimerElapsedMs,
  endEditorReview,
  formatEditorTimer,
  nextEditorReview,
  pauseEditorTimer,
  readEditorTimer,
  resumeEditorTimer,
} from '../lib/editor_review_session';

function EditorReviewTimer() {
  const plugin = usePlugin();
  const [currentTime, setCurrentTime] = useState(Date.now());
  const [pdfRemId, setPdfRemId] = useState<string | null>(null);
  const [isPdfNote, setIsPdfNote] = useState(false);
  // hostRemId is the host doc rem id when the IncRem reads from a PDF or HTML
  // article. pdfRemId remains PDF-only (gates PageControls and page-keyed
  // history saves). hostKind disambiguates the two for the bookmark Scroll
  // button and addPageToHistory's page argument.
  const [hostRemId, setHostRemId] = useState<string | null>(null);
  const [hostKind, setHostKind] = useState<'pdf' | 'html' | null>(null);
  // PDFs available on the timer's IncRem. When length > 1 a small switcher
  // appears next to the page controls.
  const [pdfOptions, setPdfOptions] = useState<Array<{ remId: string; name: string; isPreferred: boolean }>>([]);
  // HTML rem ID parallel to hostRemId — set even when a PDF is also present
  // so the bookmark Scroll button can surface bookmarks saved in Text Reader mode.
  const [htmlRemId, setHtmlRemId] = useState<string | null>(null);
  // Review note (📝): parked per-rem in session storage on every keystroke and
  // attached to this session's history entry by End Review / Next / Dismiss.
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState('');

  const timerData = useTrackerPlugin(async (rp) => readEditorTimer(rp), []);

  // Update current time every second
  useEffect(() => {
    const intervalId = setInterval(() => {
      setCurrentTime(Date.now());
    }, 1000);

    return () => clearInterval(intervalId);
  }, []);

  // Track IncRem engagement for PracticedQueues (count + time). When the
  // timer is started for a rem, engagement starts; when remId changes (Next)
  // or clears (End Review / Cancel), engagement ends and accumulated time is
  // added. For queue→editor handoffs, markIncRemTransition() in
  // handleReviewInEditorRem suppresses the count++ here so the IncRem is
  // counted only once across the combined queue + editor time.
  useEffect(() => {
    if (!timerData?.remId) return;
    startIncRemEngagement(plugin, timerData.remId);
    return () => {
      endIncRemEngagement(plugin);
    };
  }, [timerData?.remId, plugin]);

  // New session/rem: reset the note input, then prefill from a parked note
  // (typed in the queue's note field or the editor review popup before the
  // timer started) so the user sees what will be saved and can extend it.
  useEffect(() => {
    setNoteOpen(false);
    setNoteText('');
    if (!timerData?.remId) return;
    getPendingReviewNote(plugin, timerData.remId).then((parked) => {
      if (parked) {
        setNoteText(parked);
        setNoteOpen(true);
      }
    });
  }, [timerData?.remId]);

  // The name the session snapshot carries is only as good as the writer that
  // parked it. The Execute Repetition popup fills its own name field from an
  // async lookup, so a fast confirm can hand us an empty string, and the
  // header then reads "Unnamed Rem" for a rem that plainly has a name. Resolve
  // it from the rem itself whenever the snapshot is empty or a placeholder —
  // once per rem, outside the tracker, so an edit to the rem being reviewed
  // does not re-run the whole session read.
  const [resolvedName, setResolvedName] = useState<string | null>(null);

  useEffect(() => {
    const remId = timerData?.remId;
    const snapshot = timerData?.remName;
    if (!remId) {
      setResolvedName(null);
      return;
    }
    if (snapshot && snapshot !== 'Unnamed Rem' && snapshot !== 'Untitled') {
      setResolvedName(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const rem = await plugin.rem.findOne(remId);
      if (!rem || cancelled) return;
      const name = await safeRemTextToString(plugin, rem.text);
      if (!cancelled && name && name !== 'Untitled') {
        setResolvedName(name);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [plugin, timerData?.remId, timerData?.remName]);

  /** The rem name to show and to name in toasts — resolution wins over the snapshot. */
  const reviewName = resolvedName || timerData?.remName || 'Unnamed Rem';

  // Auto-scroll to the last bookmark when a timer session starts from the
  // editor popup ("Timer" button). The popup that started the session sets a
  // pending-scroll flag and then closes itself immediately — killing any
  // scroll it might have fired (the warm path's inline setTimeout dies with
  // the popup iframe, and closing the popup bounces focus off the reader).
  // This widget is persistent, so it can drive openAndScrollToHighlight
  // reliably. Gated by remId + a 30s staleness guard, and cleared on consume
  // so it fires exactly once per session start.
  useEffect(() => {
    if (!timerData?.remId) return;
    (async () => {
      const pending = await plugin.storage.getSession<{
        hostRemId: string;
        highlightId: string;
        remId: string;
        requestedAt: number;
      }>('editor-review-timer-pending-scroll');
      if (!pending || pending.remId !== timerData.remId) return;
      if (Date.now() - (pending.requestedAt ?? 0) > 30_000) {
        await plugin.storage.setSession('editor-review-timer-pending-scroll', undefined);
        return;
      }
      // Clear right before firing so it runs exactly once (even under a
      // StrictMode double-mount, the second pass sees no flag and no-ops).
      await plugin.storage.setSession('editor-review-timer-pending-scroll', undefined);
      await openAndScrollToHighlight(plugin, pending.hostRemId, pending.highlightId);
    })();
  }, [timerData?.remId, plugin]);

  const pdfControls = usePdfPageControls(plugin, timerData?.remId, pdfRemId, 0);

  // Load host (PDF or HTML article) info if the rem reads from one. PDFs
  // additionally enable PageControls; HTML hosts only get the bookmark Scroll
  // button.
  useEffect(() => {
    if (!timerData?.remId) return;

    const loadHostData = async () => {
      const rem = await plugin.rem.findOne(timerData.remId);
      if (!rem) {
        setIsPdfNote(false);
        setPdfRemId(null);
        setHostRemId(null);
        setHostKind(null);
        setHtmlRemId(null);
        setPdfOptions([]);
        return;
      }

      const pdfRem = await getActivePdfForIncRem(plugin, rem);
      // Always resolve the HTML rem — even when a PDF is present, bookmarks
      // created in Text Reader mode are stored under the HTML rem's history key.
      const htmlRem = await findHTMLinRem(plugin, rem);
      const host = pdfRem ?? htmlRem;

      if (pdfRem) {
        setIsPdfNote(true);
        setPdfRemId(pdfRem._id);
      } else {
        setIsPdfNote(false);
        setPdfRemId(null);
      }

      if (host) {
        setHostRemId(host._id);
        setHostKind(pdfRem ? 'pdf' : 'html');
      } else {
        setHostRemId(null);
        setHostKind(null);
      }

      setHtmlRemId(htmlRem?._id ?? null);

      // Populate PDF selector options (shown only when >1 PDF)
      try {
        const pdfs = await getAllPDFsInRem(plugin, rem);
        const options = await Promise.all(
          pdfs.map(async (p) => ({
            remId: p.rem._id,
            name: await safeRemTextToString(plugin, p.rem.text),
            isPreferred: p.isPreferred,
          }))
        );
        setPdfOptions(options);
      } catch (e) {
        console.error('[editor_review_timer] Failed to load PDF options:', e);
        setPdfOptions([]);
      }
    };
    loadHostData();
  }, [timerData?.remId, plugin]);

  // Switch the active PDF for the timer's IncRem. Pins the choice, then
  // updates the in-widget host state so PageControls, the Scroll bookmark,
  // and any subsequent reading-time records target the new PDF.
  const handlePdfSwitch = useCallback(async (newPdfId: string) => {
    if (!timerData?.remId || newPdfId === pdfRemId) return;

    await setActivePdfForIncRem(plugin, timerData.remId, newPdfId);

    setPdfRemId(newPdfId);
    setHostRemId(newPdfId);
    setHostKind('pdf');
    setIsPdfNote(true);

  }, [plugin, timerData?.remId, pdfRemId]);

  // Reactively track the latest bookmark highlight across PDF and HTML histories.
  // Host rem ID is resolved INSIDE the tracker (not from React state) so the
  // tracker subscribes to the active-PDF synced key and re-fires correctly.
  // Using React state (hostRemId) as a dep would cause the tracker to run once
  // with hostRemId=null (before loadHostData completes), subscribe to nothing,
  // and never re-fire — making existing bookmarks invisible until a new one
  // is saved mid-session.
  const bookmarkInfo = useTrackerPlugin(
    async (rp) => {
      if (!timerData?.remId) return null;

      const rem = await rp.rem.findOne(timerData.remId);
      if (!rem) return null;

      let best: { highlightId: string; hostRemId: string; timestamp: number } | null = null;

      // PDF history — resolving via getActivePdfForIncRem subscribes the tracker
      // to the active-PDF synced key so it re-fires on host changes.
      const pdfRem = await getActivePdfForIncRem(rp as any, rem);
      if (pdfRem) {
        const history = await getPageHistory(rp as any, timerData.remId, pdfRem._id);
        const last = history[history.length - 1];
        if (last?.highlightId) {
          best = { highlightId: last.highlightId, hostRemId: pdfRem._id, timestamp: last.timestamp };
        }
      }

      // HTML (Text Reader) history — check even when a PDF is present, bookmarks
      // saved in Text Reader mode are stored under the HTML rem's history key.
      const htmlRem = await findHTMLinRem(rp as any, rem);
      if (htmlRem && htmlRem._id !== pdfRem?._id) {
        const htmlHistory = await getPageHistory(rp as any, timerData.remId, htmlRem._id);
        const last = htmlHistory[htmlHistory.length - 1];
        if (last?.highlightId && (!best || last.timestamp > best.timestamp)) {
          best = { highlightId: last.highlightId, hostRemId: htmlRem._id, timestamp: last.timestamp };
        }
      }

      return best;
    },
    [timerData?.remId]
  ) ?? null;

  const bookmarkHighlightId = bookmarkInfo?.highlightId ?? null;
  const bookmarkHostRemId = bookmarkInfo?.hostRemId ?? hostRemId;

  // Read point for the IncRem's own outline (a bookmarked descendant rem). This
  // is stored under its OWN history key (host = incRemId), independent of any
  // PDF/HTML bookmark — so a "hybrid" IncRem (a PDF/HTML source AND its own
  // descendant content) can carry both. We therefore DON'T bail when a PDF/HTML
  // source exists: a read point and a reader bookmark target different places
  // (a node in the outline vs. a spot in the document) and jump differently, so
  // both buttons can legitimately appear.
  const remReadPoint = useTrackerPlugin(
    async (rp) => {
      if (!timerData?.remId) return null;
      const rem = await rp.rem.findOne(timerData.remId);
      if (!rem) return null;
      const entry = await getRemReadPoint(rp as any, timerData.remId);
      return entry?.highlightId
        ? { targetRemId: entry.highlightId, timestamp: entry.timestamp }
        : null;
    },
    [timerData?.remId]
  ) ?? null;

  // When both a reader bookmark and a read point exist, mark whichever was saved
  // most recently as "latest" so the user knows which reflects their last action.
  const bothBookmarksExist = !!bookmarkHighlightId && !!remReadPoint;
  const readPointIsLatest =
    bothBookmarksExist && (remReadPoint!.timestamp ?? 0) > (bookmarkInfo?.timestamp ?? 0);
  const readerBookmarkIsLatest = bothBookmarksExist && !readPointIsLatest;

  // Small "latest" pill appended to whichever bookmark button is the most recent.
  const latestBadgeStyle: React.CSSProperties = {
    marginLeft: 5,
    fontSize: 9,
    fontWeight: 700,
    padding: '1px 4px',
    borderRadius: 6,
    backgroundColor: '#10b981',
    color: 'white',
    verticalAlign: 'middle',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  };

  const isPaused = !!(timerData?.pausedAt);
  const elapsedMs = timerData ? editorTimerElapsedMs(timerData, currentTime) : 0;
  const timeDisplay = formatEditorTimer(elapsedMs);

  const handlePause = async () => {
    if (timerData) await pauseEditorTimer(plugin, timerData);
  };

  const handleResume = async () => {
    if (timerData) await resumeEditorTimer(plugin, timerData);
  };

  // The reading host and page as the timer shows them right now — what the
  // repetition's reading time is logged against.
  const currentHost = (): EditorReviewJob['host'] =>
    hostRemId ? { remId: hostRemId, page: hostKind === 'pdf' ? pdfControls.currentPage : null } : undefined;

  const closing = () => ({ elapsedMs, host: currentHost(), reviewName });

  const handleEndReview = async (navigateBack: boolean = true) => {
    if (timerData) await endEditorReview(plugin, timerData, closing(), navigateBack);
  };

  const handleNextReview = async () => {
    if (timerData) await nextEditorReview(plugin, timerData, closing());
  };

  const handleDismiss = async () => {
    if (timerData) await dismissEditorReview(plugin, timerData, closing());
  };

  const handleGoToRem = async () => {
    if (!timerData) return;

    const rem = await plugin.rem.findOne(timerData.remId);
    if (!rem) {
      await plugin.app.toast('Error: Rem not found');
      return;
    }

    // Check if it's a PDF note to open it properly without invoking the PDF viewer
    const incRemType = await determineIncRemType(plugin, rem);
    if (incRemType === 'pdf-note') {
      await rem.openRemAsPage();
    } else {
      await plugin.window.openRem(rem);
    }
  };

  const handleCancel = async () => {
    await plugin.storage.setSession('editor-review-timer-rem-id', undefined);
    await plugin.storage.setSession('editor-review-timer-start', undefined);
    await plugin.storage.setSession('editor-review-timer-interval', undefined);
    await plugin.storage.setSession('editor-review-timer-priority', undefined);
    await plugin.storage.setSession('editor-review-timer-rem-name', undefined);
    await plugin.storage.setSession('editor-review-timer-from-queue', undefined);
    await plugin.storage.setSession('editor-review-timer-origin', undefined);
    await plugin.storage.setSession('editor-review-timer-paused-at', undefined);
    await plugin.storage.setSession('editor-review-timer-accumulated-ms', undefined);
    await plugin.storage.setSession('editor-review-timer-date-override', undefined);
    // Clear stored list state if cancelling
    await plugin.storage.setSession('inc-rem-list-state', undefined);
    await plugin.storage.setSession('inc-rem-main-view-state', undefined);
    await plugin.storage.setSession('inc-rem-main-view-doc-filter', undefined);
    await plugin.storage.setSession('editor-review-timer-queue-list', undefined);

    await plugin.app.toast('Timer cancelled');
  };

  // Report how much of the pane the pinned bar covers, so RemNote's sticky headers
  // can be moved below it (lib/editor_review_timer_sticky).
  const barObserverRef = React.useRef<ResizeObserver | null>(null);
  const reportBarHeight = useCallback(async (height: number) => {
    const ctx: any = await plugin.widget.getWidgetContext().catch(() => null);
    if (ctx?.documentId) await reportEditorReviewTimerHeight(plugin, ctx.documentId, height);
  }, [plugin]);
  const barRef = useCallback((el: HTMLDivElement | null) => {
    barObserverRef.current?.disconnect();
    barObserverRef.current = null;
    if (!el) return;
    // The bar's bottom edge in the iframe, which starts at the top of the pane.
    const observer = new ResizeObserver(() => {
      void reportBarHeight(el.getBoundingClientRect().bottom);
    });
    observer.observe(el);
    barObserverRef.current = observer;
  }, [reportBarHeight]);
  // null is "no review"; undefined is the tracker still loading, which must not
  // wipe what the other panes' timers have reported.
  useEffect(() => {
    if (timerData === null) void clearEditorReviewTimerHeights(plugin);
  }, [timerData === null, plugin]);

  if (!timerData || !timerData.startTime) {
    return null;
  }

  // Truncate rem name if too long
  const displayName = reviewName.length > 40
    ? reviewName.substring(0, 37) + '...'
    : reviewName;

  return (
    <div
      ref={barRef}
      style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '12px',
        rowGap: '8px',
        padding: '8px 16px',
        backgroundColor: '#dbeafe',
        borderRadius: '6px',
        border: '1px solid #3b82f6',
        boxShadow: '0 2px 4px rgba(0, 0, 0, 0.1)',
        maxWidth: '100%',
      }}
    >
      <span style={{ fontSize: '18px', flexShrink: 0 }}>{isPaused ? '⏸️' : '⏱️'}</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1, minWidth: '140px' }}>
        <div style={{
          fontSize: '13px',
          fontWeight: 600,
          color: isPaused ? '#92400e' : '#1e40af',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {isPaused ? 'Paused: ' : 'Reviewing: '}{displayName}
        </div>
        <div style={{
          fontSize: '16px',
          color: isPaused ? '#78350f' : '#1e3a8a',
          fontVariantNumeric: 'tabular-nums',
          fontWeight: 700,
        }}>
          {timeDisplay}
        </div>
      </div>

      {(isPdfNote || (hostRemId && bookmarkHighlightId) || remReadPoint) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginRight: '8px', paddingRight: '12px', borderRight: '1px solid #93c5fd' }}>
          {/* PDF switcher — only when the IncRem has >1 PDF source. */}
          {pdfOptions.length > 1 && pdfRemId && (
            <select
              value={pdfRemId}
              onChange={(e) => handlePdfSwitch(e.target.value)}
              title="Switch active PDF for this IncRem"
              style={{
                fontSize: '12px',
                padding: '3px 6px',
                borderRadius: '4px',
                border: '1px solid #3b82f6',
                backgroundColor: 'white',
                color: '#1e40af',
                maxWidth: '180px',
                fontWeight: 600,
              }}
            >
              {pdfOptions.map((opt) => (
                <option key={opt.remId} value={opt.remId}>
                  {opt.name}{opt.isPreferred ? ' ★' : ''}
                </option>
              ))}
            </select>
          )}
          {/* Page controls only apply to PDF hosts. */}
          {isPdfNote && pdfRemId && (
            <PageControls
              incrementalRemId={timerData.remId as any}
              {...pdfControls}
              totalPages={0}
            />
          )}
          {hostRemId && bookmarkHighlightId && (
            <button
              onClick={async () => {
                // Re-read at click time from both PDF and HTML histories to
                // catch any bookmark saved mid-session after the tracker last ran.
                let freshHighlightId = bookmarkHighlightId;
                let freshHostRemId = bookmarkHostRemId ?? hostRemId;
                if (timerData?.remId) {
                  let latestTs = 0;
                  if (hostRemId) {
                    const history = await getPageHistory(plugin, timerData.remId, hostRemId);
                    const last = history[history.length - 1];
                    if (last?.highlightId && last.timestamp > latestTs) {
                      latestTs = last.timestamp;
                      freshHighlightId = last.highlightId;
                      freshHostRemId = hostRemId;
                    }
                  }
                  if (htmlRemId && htmlRemId !== hostRemId) {
                    const htmlHistory = await getPageHistory(plugin, timerData.remId, htmlRemId);
                    const last = htmlHistory[htmlHistory.length - 1];
                    if (last?.highlightId && last.timestamp > latestTs) {
                      latestTs = last.timestamp;
                      freshHighlightId = last.highlightId;
                      freshHostRemId = htmlRemId;
                    }
                  }
                }
                await openAndScrollToHighlight(plugin, freshHostRemId, freshHighlightId);
              }}
              style={{
                padding: '4px 10px',
                fontSize: '12px',
                fontWeight: 600,
                backgroundColor: 'transparent',
                color: '#3b82f6',
                border: '2px solid #3b82f6',
                borderRadius: '4px',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = '#3b82f6';
                e.currentTarget.style.color = 'white';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'transparent';
                e.currentTarget.style.color = '#3b82f6';
              }}
              title={(hostKind === 'html'
                ? 'Open the article and scroll to your last bookmark position'
                : 'Open PDF and scroll to your last bookmark position')
                + (readerBookmarkIsLatest ? ' (most recent reading position)' : '')}
            >
              🔖 Scroll
              {readerBookmarkIsLatest && (
                <span style={latestBadgeStyle}>latest</span>
              )}
            </button>
          )}
          {remReadPoint && (
            <button
              onClick={async () => {
                // Re-read at click time to catch a read point set mid-session
                // after the tracker last ran.
                let targetRemId = remReadPoint.targetRemId;
                if (timerData?.remId) {
                  const fresh = await getRemReadPoint(plugin, timerData.remId);
                  if (fresh?.highlightId) targetRemId = fresh.highlightId;
                }
                await openAndFocusRem(plugin, targetRemId);
              }}
              style={{
                padding: '4px 10px',
                fontSize: '12px',
                fontWeight: 600,
                backgroundColor: 'transparent',
                color: '#3b82f6',
                border: '2px solid #3b82f6',
                borderRadius: '4px',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = '#3b82f6';
                e.currentTarget.style.color = 'white';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'transparent';
                e.currentTarget.style.color = '#3b82f6';
              }}
              title={'Jump to your read point (the bookmarked rem inside this outline)'
                + (readPointIsLatest ? ' (most recent reading position)' : '')}
            >
              🔖 Go to Read Point
              {readPointIsLatest && (
                <span style={latestBadgeStyle}>latest</span>
              )}
            </button>
          )}
        </div>
      )}

      {/* Review-note input — parked in session storage on every keystroke and
          attached to this session's history entry by End Review / Next / Dismiss. */}
      {noteOpen && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
          <span style={{ fontSize: '13px' }}>📝</span>
          <input
            type="text"
            autoFocus
            value={noteText}
            maxLength={MAX_NOTE_LENGTH}
            placeholder="Observation for this repetition (saved on End Review / Next / Dismiss)…"
            onChange={(e) => {
              setNoteText(e.target.value);
              if (timerData?.remId) {
                setPendingReviewNote(plugin, timerData.remId, e.target.value).catch(console.error);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setNoteOpen(false);
              e.stopPropagation();
            }}
            style={{
              flex: 1,
              fontSize: '12px',
              padding: '5px 10px',
              borderRadius: '4px',
              border: '1px solid var(--rn-clr-border-primary, rgba(128,128,128,0.35))',
              backgroundColor: 'var(--rn-clr-background-secondary)',
              color: 'var(--rn-clr-content-primary)',
              outline: 'none',
            }}
          />
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', rowGap: '6px' }}>
        {/* Note toggle */}
        <button
          onClick={() => setNoteOpen((o) => !o)}
          style={{
            padding: '6px 10px',
            fontSize: '13px',
            backgroundColor: noteOpen ? '#8b5cf6' : '#6b7280',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontWeight: 600,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = noteOpen ? '#7c3aed' : '#4b5563';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = noteOpen ? '#8b5cf6' : '#6b7280';
          }}
          title="Review note: attach an observation to this repetition's history entry"
        >
          📝
        </button>
        {/* Pause / Continue button */}
        <button
          onClick={isPaused ? handleResume : handlePause}
          style={{
            padding: '6px 12px',
            fontSize: '13px',
            backgroundColor: isPaused ? '#f59e0b' : '#6b7280',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontWeight: 600,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = isPaused ? '#d97706' : '#4b5563';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = isPaused ? '#f59e0b' : '#6b7280';
          }}
          title={isPaused ? 'Resume timer' : 'Pause timer'}
        >
          {isPaused ? '▶ Resume' : '⏸ Pause'}
        </button>
        {/* "Next" button — shown sequentially when queue list has items */}
        {timerData.queueList && timerData.queueList.length > 0 && (
          <button
            onClick={handleNextReview}
            style={{
              padding: '6px 14px',
              fontSize: '13px',
              backgroundColor: '#10b981',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontWeight: 600,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = '#059669';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = '#10b981';
            }}
            title={`Save & move to next item (${timerData.queueList.length} left)`}
            autoFocus
          >
            Next ({timerData.queueList.length}) →
          </button>
        )}

        {/* "Back to..." button — shown when origin is queue or inc-rem-list/main-view */}
        {(timerData.origin === 'queue' || timerData.origin === 'inc-rem-list' || timerData.origin === 'inc-rem-main-view') && (
          <button
            onClick={() => handleEndReview(true)}
            style={{
              padding: '5px 12px',
              backgroundColor: timerData.queueList && timerData.queueList.length > 0 ? '#6b7280' : '#10b981',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '1px',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = timerData.queueList && timerData.queueList.length > 0 ? '#4b5563' : '#059669';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = timerData.queueList && timerData.queueList.length > 0 ? '#6b7280' : '#10b981';
            }}
          >
            <span style={{ fontSize: '13px', fontWeight: 700, lineHeight: 1.2 }}>✓ End Review</span>
            <span style={{ fontSize: '10px', fontWeight: 500, opacity: 0.9, lineHeight: 1.2 }}>
              {timerData.origin === 'queue' ? 'and Back to Queue' : 'and Back to IncRem List'}
            </span>
          </button>
        )}

        {/* Plain "End Review" button — always shown */}
        <button
          onClick={() => handleEndReview(false)}
          style={{
            padding: '6px 14px',
            fontSize: '13px',
            backgroundColor: (timerData.origin === 'queue' || timerData.origin === 'inc-rem-list' || timerData.origin === 'inc-rem-main-view')
              ? '#6b7280' : '#10b981',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontWeight: 600,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = (timerData.origin === 'queue' || timerData.origin === 'inc-rem-list' || timerData.origin === 'inc-rem-main-view')
              ? '#4b5563' : '#059669';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = (timerData.origin === 'queue' || timerData.origin === 'inc-rem-list' || timerData.origin === 'inc-rem-main-view')
              ? '#6b7280' : '#10b981';
          }}
        >
          ✓ End Review
        </button>
        <button
          onClick={handleGoToRem}
          style={{
            padding: '6px 14px',
            fontSize: '13px',
            backgroundColor: '#3b82f6',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontWeight: 600,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = '#2563eb';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = '#3b82f6';
          }}
        >
          ↗ Go to Rem
        </button>
        {/* "Dismiss" button — always available while a timer is active. When a
            queueList is present it advances to the next item; otherwise it
            simply ends the timer (Ctrl+Shift+J / Start Timer flows). */}
        <button
          onClick={handleDismiss}
          style={{
            padding: '6px 14px',
            fontSize: '13px',
            backgroundColor: '#ef4444',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontWeight: 600,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = '#dc2626';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = '#ef4444';
          }}
          title={timerData.queueList && timerData.queueList.length > 0
            ? 'Dismiss: Remove incremental status, add Dismissed powerup, and advance to next item'
            : 'Dismiss: Remove incremental status, add Dismissed powerup, and end the timer'}
        >
          ✓ Dismiss
        </button>
        <button
          onClick={handleCancel}
          style={{
            padding: '6px 12px',
            fontSize: '13px',
            backgroundColor: '#ef4444',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontWeight: 500,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = '#dc2626';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = '#ef4444';
          }}
        >
          ✕
        </button>
      </div>
    </div>
  );
}

renderWidget(EditorReviewTimer);
