/**
 * The Mastery Drill header, shared by the popup drill (widgets/mastery_drill.tsx)
 * and the regular-queue drill's bar (widgets/mastery_drill_queue_bar.tsx).
 *
 * Row 1 manages the drill: the count, then captioned clusters — CARD (List,
 * Remove), EDIT LATER (Current, Previous; queue bar only) and CLEAR (All, Low
 * priority, Old). The popup adds its per-card clusters at the right end of the same
 * line — REM (priority, Go to Rem), EDIT LATER and EDIT — standing in for what the
 * regular queue gives natively. The captions mark the groups without boxing their
 * names, and keep the queue bar on one line beside the Beautiful queue's priority badge. The header only renders
 * and collects the Edit Later note and the priority edit: what each action does,
 * and where its panel opens, is up to the widget — the popup swaps its whole
 * window, the queue bar opens a popup.
 */

import React from 'react';
import { CardPriorityInfo } from '../lib/card_priority/types';
import { formatDrillWait } from '../lib/mastery_drill_cooling';
import { DrillIcon } from './DrillIcon';
import { InlinePriorityEditor } from './InlineEditors';
import { PriorityBadge } from './PriorityBadge';

export interface MasteryDrillHeaderProps {
  /** 'queue' is the compact form for the strip under the regular queue's top bar. */
  variant: 'popup' | 'queue';
  readyCount: number;
  coolingCount: number;
  firstReadyAt?: number;
  oldCount: number;
  oldThreshold: number;
  onOpenCardList: () => void;
  onClearAll: () => void;
  onClearLowPriority: () => void;
  onClearOld: () => void;
  onRemoveCurrent: () => void;
  /**
   * Tags the card shown before the current one (usually the one just rated) Edit Later
   * with this note, keeping its rating. Omitted: no button.
   */
  onEditLaterPrevious?: (message: string) => Promise<void>;
  /**
   * The queue bar's Edit Later for the card on screen. The popup passes its own in
   * cardActions instead.
   */
  onEditLaterCurrent?: (message: string) => Promise<void>;
  /** The popup's per-card clusters, at the right end of the row. */
  cardActions?: {
    /** The current card's priority, editable in place. */
    priority?: { info: CardPriorityInfo; onSave: (value: number) => Promise<void> } | null;
    onGoToRem: () => void;
    onEditLater: (message: string) => Promise<void>;
    onEditPrevious: () => void;
    onEditCurrent: () => void;
  };
  showDescription?: boolean;
  /** Shown under the rows, e.g. the regular-queue drill's buried-cards hint. */
  notice?: React.ReactNode;
}

export function MasteryDrillHeader(props: MasteryDrillHeaderProps) {
  const { variant, readyCount, coolingCount, firstReadyAt, oldCount, oldThreshold, cardActions } = props;
  const priority = cardActions?.priority;
  const compact = variant === 'queue';
  // Which card the open Edit Later note is for; null while closed.
  const [editLaterTarget, setEditLaterTarget] = React.useState<'current' | 'previous' | null>(null);
  const [editLaterMessage, setEditLaterMessage] = React.useState('');
  const [editingPriority, setEditingPriority] = React.useState<number | null>(null);

  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

  const openEditLater = (target: 'current' | 'previous') => {
    setEditLaterMessage('');
    setEditLaterTarget(target);
  };
  // In the regular queue the note's input holds the focus, which keeps RemNote's own
  // shortcuts (Space, 1-4) from working; hand it back once the note closes.
  const returnFocusToQueue = () => {
    if (!compact) return;
    try {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      window.parent?.focus();
    } catch (_) {
      /* cross-origin safe */
    }
  };
  const confirmEditLater = async () => {
    if (editLaterTarget === 'previous') await props.onEditLaterPrevious?.(editLaterMessage);
    else await (props.onEditLaterCurrent ?? cardActions?.onEditLater)?.(editLaterMessage);
    setEditLaterTarget(null);
    setEditLaterMessage('');
    returnFocusToQueue();
  };
  const cancelEditLater = () => {
    setEditLaterTarget(null);
    setEditLaterMessage('');
    returnFocusToQueue();
  };

  // EDIT LATER · Current · Previous. Current is the popup's cardActions.onEditLater or
  // the queue bar's onEditLaterCurrent; Previous keeps the rating of the card just rated.
  const hasEditLaterCurrent = !!(props.onEditLaterCurrent ?? cardActions?.onEditLater);
  const editLaterCluster = (hasEditLaterCurrent || props.onEditLaterPrevious) && (
    <Cluster caption="Edit later" tone="edit">
      {hasEditLaterCurrent && (
        <ClusterButton onClick={() => openEditLater('current')} title="Mark the card on screen for Edit Later and remove it from the drill">
          Current
        </ClusterButton>
      )}
      {props.onEditLaterPrevious && (
        <ClusterButton
          onClick={() => openEditLater('previous')}
          title="Mark the card you just rated for Edit Later, keeping its rating, and remove it from the drill"
        >
          Previous
        </ClusterButton>
      )}
    </Cluster>
  );

  return (
    <div className={`ie-drill-header${compact ? '' : ' ie-drill-header--popup border-b rn-clr-border-primary'} flex flex-col`}>
      <style>{DRILL_HEADER_CSS}</style>
      {/* Row 1: the drill as a whole */}
      <div className={`ie-drill-row ${compact ? 'px-2 pt-1 pb-1.5' : 'px-3 pt-2 pb-2'}`}>
        <div className="ie-drill-stat">
          <span className="ie-drill-title">Mastery Drill</span>
          <div className="ie-drill-stat__line">
            <span className="ie-drill-icon">
              <DrillIcon size={compact ? 16 : 18} accent="var(--ie-drill-count)" />
            </span>
            <span
              onClick={props.onOpenCardList}
              className="ie-drill-count"
              title={`List every card in the drill${compact ? '' : ' (L)'}`}
            >
              {readyCount} remaining
            </span>
            {coolingCount > 0 && (
              <span
                className="ie-drill-cooling"
                title={`${coolingCount} card${plural(coolingCount, ' is', 's are')} still cooling and will appear later${
                  firstReadyAt !== undefined ? ` (the first in ${formatDrillWait(firstReadyAt - Date.now())})` : ''
                }`}
              >
                · {coolingCount} cooling
              </span>
            )}
          </div>
        </div>
        <Cluster caption="Card">
          <ClusterButton
            onClick={props.onOpenCardList}
            icon={ListGlyph}
            title={`List every card in the drill and check whether RemNote can show it${compact ? '' : ' (L)'}`}
          >
            List
          </ClusterButton>
          <ClusterButton onClick={props.onRemoveCurrent} icon={CrossGlyph} title="Remove the card on screen from the Mastery Drill">
            Remove
          </ClusterButton>
        </Cluster>
        {compact && editLaterCluster}
        <Cluster caption="Clear" tone="clear">
          <ClusterButton onClick={props.onClearAll} title="Clear all items from the Mastery Drill queue">
            All
          </ClusterButton>
          <ClusterButton onClick={props.onClearLowPriority} title="Remove low priority cards from the Mastery Drill queue">
            Low priority
          </ClusterButton>
          {oldCount > 0 && (
            <ClusterButton
              onClick={props.onClearOld}
              old
              title={`${oldCount} card${plural(oldCount, ' has', 's have')} been ready to drill for more than ${oldThreshold} days. The Mastery Drill is intended for cards you recently rated Hard or Again — after this much time, the spaced repetition algorithm will handle them at their scheduled date instead. Click to remove them, if you prefer to trust the scheduler rather than drilling them now.`}
            >
              Old{' '}
              <span className="ie-drill-old-count">
                {oldCount} &gt; {oldThreshold}d
              </span>
            </ClusterButton>
          )}
        </Cluster>
        {cardActions && (
          // The popup's per-card actions, pushed to the right end of the same line: the
          // regular queue gives these natively, so the queue bar has none of them.
          <div className="ie-drill-card-side">
            <Cluster caption="Rem">
              {priority && (
                <span
                  className="ie-drill-badge"
                  onClick={() => setEditingPriority(priority.info.priority)}
                  title="Click to change priority"
                >
                  <PriorityBadge
                    priority={priority.info.priority}
                    percentile={priority.info.kbPercentile ?? undefined}
                    compact
                    useAbsoluteColoring={priority.info.kbPercentile == null}
                    source={priority.info.source}
                    isCardPriority
                  />
                </span>
              )}
              <ClusterButton onClick={cardActions.onGoToRem} title="Go to the current Rem (closes popup)">
                Go to Rem
              </ClusterButton>
            </Cluster>
            {editLaterCluster}
            <Cluster caption="Edit" tone="editor">
              <ClusterButton onClick={cardActions.onEditCurrent} title="Edit the card on screen">
                Current
              </ClusterButton>
              <ClusterButton onClick={cardActions.onEditPrevious} title="Edit the card you just rated">
                Previous
              </ClusterButton>
            </Cluster>
          </div>
        )}
      </div>

      {editingPriority !== null && priority && (
        <div className="px-2 pt-1">
          <InlinePriorityEditor
            value={editingPriority}
            onChange={setEditingPriority}
            onSave={async () => {
              await priority.onSave(editingPriority);
              setEditingPriority(null);
            }}
            onCancel={() => setEditingPriority(null)}
          />
        </div>
      )}

      {props.showDescription && (
        <div className="px-4 pb-2 flex items-baseline gap-2 flex-nowrap overflow-hidden">
          <span className="text-sm whitespace-nowrap flex-shrink-0">Deliberately practice again your poorly rated flashcards.</span>
          <span className="text-xs truncate" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
            Flashcards you have rated <i>Again</i> or <i>Hard</i> will appear and remain in the Drill until you rate them <i>Good</i> or better.
          </span>
        </div>
      )}

      {editLaterTarget && (
        <EditLaterNote
          label={editLaterTarget === 'previous' ? 'Edit Later note (previous card):' : undefined}
          value={editLaterMessage}
          onChange={setEditLaterMessage}
          onConfirm={confirmEditLater}
          onCancel={cancelEditLater}
          bordered={!compact}
        />
      )}

      {props.notice && (
        <div className="px-3 pb-1 text-xs" style={{ color: 'var(--rn-clr-content-secondary)' }}>
          {props.notice}
        </div>
      )}
    </div>
  );
}

/** The one-line Edit Later note: Enter sets, Esc cancels. Also used by the card editor. */
export function EditLaterNote({
  label = 'Edit Later note:',
  value,
  onChange,
  onConfirm,
  onCancel,
  bordered = true,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  bordered?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 flex-shrink-0 ${bordered ? 'border-t' : ''}`}
      style={{ borderColor: 'var(--rn-clr-border-primary)', backgroundColor: 'var(--rn-clr-background-primary)' }}
    >
      <span className="text-xs font-medium" style={{ color: 'var(--rn-clr-content-secondary)' }}>
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onConfirm();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
        placeholder="Mastery Drill"
        className="flex-1 text-xs p-1 rounded"
        style={{
          border: '1px solid var(--rn-clr-border-primary)',
          backgroundColor: 'var(--rn-clr-background-secondary)',
          color: 'var(--rn-clr-content-primary)',
        }}
        autoFocus
      />
      <button onClick={onConfirm} className="px-2 py-1 text-xs rounded bg-orange-500 text-white hover:bg-orange-600">
        Set
      </button>
      <button
        onClick={onCancel}
        className="px-2 py-1 text-xs rounded"
        style={{ border: '1px solid var(--rn-clr-border-primary)', color: 'var(--rn-clr-content-secondary)' }}
      >
        Cancel
      </button>
    </div>
  );
}

/*
 * Plain CSS with fixed colours, not Tailwind and not --rn-clr-*: the plugin's Tailwind
 * takes `dark:` from the OS, which disagrees with RemNote whenever the two themes
 * differ, and the theme variables did not reach this iframe reliably (the group
 * outlines vanished). RemNote's own theme reaches it as `body.dark`, so the dark
 * values key on that. Design "C · Captioned clusters" (docs/demos/mastery-drill-bar.html).
 */
const DRILL_HEADER_CSS = `
.ie-drill-header {
  --ie-drill-text: #1f2937; --ie-drill-btn: #374151; --ie-drill-cap: #9aa1ad;
  --ie-drill-track: #f5f6f8; --ie-drill-track-border: #e6e8ec; --ie-drill-hover: #ffffff;
  --ie-drill-count: #e11d48; --ie-drill-edit: #ea580c; --ie-drill-clear: #dc2626; --ie-drill-editor: #2563eb;
  --ie-drill-old: #a16207; --ie-drill-old-bg: #fde68a; --ie-drill-old-ink: #78350f;
  color: var(--ie-drill-text);
}
body.dark .ie-drill-header {
  --ie-drill-text: #e5e7eb; --ie-drill-btn: #d1d5db; --ie-drill-cap: #7a808c;
  --ie-drill-track: #23252d; --ie-drill-track-border: #33363f; --ie-drill-hover: #30333c;
  --ie-drill-count: #fb7185; --ie-drill-edit: #fb923c; --ie-drill-clear: #f87171; --ie-drill-editor: #60a5fa;
  --ie-drill-old: #facc15; --ie-drill-old-bg: rgba(250, 204, 21, 0.2); --ie-drill-old-ink: #fde047;
}
.ie-drill-row { display: flex; align-items: flex-end; flex-wrap: wrap; gap: 6px 14px; }
.ie-drill-stat, .ie-drill-cluster { display: flex; flex-direction: column; gap: 2px; }
.ie-drill-title {
  font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase;
  color: var(--ie-drill-text); white-space: nowrap; line-height: 14px;
}
.ie-drill-header--popup .ie-drill-title { font-size: 13px; line-height: 16px; }
.ie-drill-caption {
  font-size: 9.5px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase;
  color: var(--ie-drill-cap); padding-left: 3px; white-space: nowrap; line-height: 12px;
}
.ie-drill-cluster--edit .ie-drill-caption { color: var(--ie-drill-edit); }
.ie-drill-cluster--clear .ie-drill-caption { color: var(--ie-drill-clear); }
.ie-drill-cluster--editor .ie-drill-caption { color: var(--ie-drill-editor); }
.ie-drill-card-side { display: flex; align-items: flex-end; flex-wrap: wrap; gap: 6px 14px; margin-left: auto; }
.ie-drill-badge { display: inline-flex; align-items: center; padding: 0 4px; cursor: pointer; }
.ie-drill-stat__line { display: flex; align-items: center; gap: 6px; height: 28px; white-space: nowrap; }
.ie-drill-icon { color: var(--ie-drill-text); display: inline-flex; }
.ie-drill-count {
  font-size: 12.5px; font-weight: 600; color: var(--ie-drill-count); cursor: pointer;
  font-variant-numeric: tabular-nums;
}
.ie-drill-count:hover { text-decoration: underline; text-underline-offset: 2px; }
.ie-drill-cooling { font-size: 12px; color: var(--ie-drill-cap); cursor: default; }
.ie-drill-track {
  display: inline-flex; gap: 2px; padding: 2px; border-radius: 8px;
  background: var(--ie-drill-track); border: 1px solid var(--ie-drill-track-border);
}
.ie-drill-btn {
  display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 9px;
  border: 0; border-radius: 6px; background: transparent; cursor: pointer; white-space: nowrap;
  font-size: 12px; font-weight: 500; color: var(--ie-drill-btn);
  transition: background-color 120ms ease, color 120ms ease, box-shadow 120ms ease;
}
.ie-drill-header--popup .ie-drill-btn { height: 26px; padding: 0 11px; font-size: 13px; }
.ie-drill-btn:hover { background: var(--ie-drill-hover); color: var(--ie-drill-text); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08); }
.ie-drill-btn svg { width: 13px; height: 13px; opacity: 0.7; }
.ie-drill-btn--old { color: var(--ie-drill-old); }
.ie-drill-old-count {
  font-size: 10.5px; font-weight: 700; border-radius: 999px; padding: 0 5px;
  background: var(--ie-drill-old-bg); color: var(--ie-drill-old-ink);
}
`;

/** A captioned group of buttons on a soft track. */
function Cluster({ caption, tone, children }: { caption: string; tone?: 'edit' | 'clear' | 'editor'; children: React.ReactNode }) {
  return (
    <div className={`ie-drill-cluster${tone ? ` ie-drill-cluster--${tone}` : ''}`}>
      <span className="ie-drill-caption">{caption}</span>
      <div className="ie-drill-track">{children}</div>
    </div>
  );
}

function ClusterButton({
  onClick,
  title,
  icon,
  old = false,
  children,
}: {
  onClick: () => void;
  title: string;
  icon?: React.ReactNode;
  /** The amber Old segment of CLEAR. */
  old?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button onClick={onClick} title={title} className={`ie-drill-btn${old ? ' ie-drill-btn--old' : ''}`}>
      {icon}
      {children}
    </button>
  );
}

const ListGlyph = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden="true">
    <path d="M3 4h10M3 8h10M3 12h6" />
  </svg>
);

const CrossGlyph = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden="true">
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
);
