import { renderWidget, usePlugin } from '@remnote/plugin-sdk';
import { withHoverTips } from '../components/HoverTipLayer';
import React, { useEffect, useRef, useState } from 'react';
import dayjs from 'dayjs';
import '../style.css';
import '../App.css';
import '../rn_theme_vars.css';
import {
  EditorReviewCheckpoint,
  EditorReviewRecoveryAction,
  listInterruptedReviews,
  postEditorReviewRecoveryRequest,
} from '../lib/editor_review_recovery';
import { formatEditorTimer } from '../lib/editor_review_session';

/** The Enter that ran a command from the Omnibar can reach the popup; ignore Enter this soon after opening. */
const ENTER_GRACE_MS = 300;

const ACTIONS: { action: EditorReviewRecoveryAction; label: string; tip: string; primary?: boolean }[] = [
  {
    action: 'resume',
    label: 'Resume timer',
    tip: 'Opens the Rem with the Editor Review Timer running again from the time recorded',
    primary: true,
  },
  { action: 'save', label: 'Save repetition', tip: 'Records the repetition now, with the time recorded and the note' },
  { action: 'discard', label: 'Discard', tip: 'Forgets this review; nothing is written' },
];

const originLabel = (origin: string) =>
  origin === 'queue' ? 'from the queue' : origin === 'inc-rem-list' || origin === 'inc-rem-main-view' ? 'from the IncRem list' : 'in the editor';

/**
 * Reviews the Editor Review Timer was running when RemNote went away
 * (lib/editor_review_recovery.ts). The answer is posted to the index, which
 * carries it out after the popup has closed.
 */
function EditorReviewRecovery() {
  const plugin = usePlugin();
  const [reviews, setReviews] = useState<EditorReviewCheckpoint[] | null>(null);
  const [selected, setSelected] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const openedAt = useRef(Date.now());

  useEffect(() => {
    listInterruptedReviews(plugin).then(setReviews);
  }, []);

  useEffect(() => {
    let tries = 0;
    const timer = setInterval(() => {
      containerRef.current?.focus();
      if (document.activeElement === containerRef.current || ++tries >= 8) clearInterval(timer);
    }, 50);
    return () => clearInterval(timer);
  }, []);

  const close = () => plugin.widget.closePopup();

  // One answer per popup: the index takes one request at a time, and the rest
  // stay for the command (or the next startup).
  const answer = async (review: EditorReviewCheckpoint, action: EditorReviewRecoveryAction) => {
    await postEditorReviewRecoveryRequest(plugin, review.windowId, action);
    close();
  };

  const buttons = (reviews ?? []).flatMap((review) =>
    ACTIONS.map((a) => ({ review, ...a, run: () => answer(review, a.action) }))
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (Date.now() - openedAt.current >= ENTER_GRACE_MS) buttons[selected]?.run();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((i) => (i + 1) % Math.max(1, buttons.length));
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((i) => (i - 1 + buttons.length) % Math.max(1, buttons.length));
    }
  };

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-3 p-4"
      style={{ outline: 'none', color: 'var(--rn-clr-content-primary)' }}
    >
      <div className="text-base font-semibold">⏱️ Interrupted Editor Review</div>
      {reviews === null ? null : reviews.length === 0 ? (
        <div className="text-sm" style={{ color: 'var(--rn-clr-content-secondary)' }}>
          No interrupted review to recover.
        </div>
      ) : (
        <>
          <div className="text-xs" style={{ color: 'var(--rn-clr-content-secondary)' }}>
            RemNote closed while the Editor Review Timer was running. The time below was recorded up
            to 15 seconds before it closed. Esc keeps it for later (command: Recover Interrupted
            Editor Review).
          </div>
          {reviews.map((review) => (
            <div
              key={review.windowId}
              className="flex flex-col gap-2 p-3 rounded"
              style={{
                background: 'var(--rn-clr-background-secondary)',
                border: '1px solid var(--rn-clr-border-primary)',
              }}
            >
              <div className="text-sm font-semibold" style={{ overflowWrap: 'anywhere' }}>
                {review.remName}
              </div>
              <div className="text-xs" style={{ color: 'var(--rn-clr-content-secondary)' }}>
                <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                  {formatEditorTimer(review.elapsedMs)}
                </span>
                {review.paused ? ' (paused)' : ''} · started {originLabel(review.origin)}{' '}
                {dayjs(review.startedAt).format('MMM D, HH:mm')} · last recorded{' '}
                {dayjs(review.savedAt).format('MMM D, HH:mm')}
                {review.queueList.length > 0 ? ` · ${review.queueList.length} more in its list` : ''}
              </div>
              {review.note && (
                <div
                  className="text-xs"
                  style={{ whiteSpace: 'pre-wrap', color: 'var(--rn-clr-content-primary)' }}
                >
                  📝 {review.note}
                </div>
              )}
              <div className="flex items-center justify-end gap-2">
                {buttons.map((button, i) =>
                  button.review !== review ? null : (
                    <button
                      key={button.action}
                      onClick={button.run}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setSelected(i)}
                      title={button.tip}
                      className="py-1.5 px-3 text-sm font-medium rounded"
                      style={{
                        background: button.primary ? '#3B82F6' : 'var(--rn-clr-background-primary)',
                        color: button.primary ? 'white' : 'var(--rn-clr-content-primary)',
                        border: 'none',
                        cursor: 'pointer',
                        outline: selected === i ? '2px solid var(--rn-clr-border-accent, #3B82F6)' : 'none',
                        outlineOffset: '2px',
                      }}
                    >
                      {button.label}
                    </button>
                  )
                )}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

renderWidget(withHoverTips(EditorReviewRecovery));
