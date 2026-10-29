/**
 * The Mastery Drill header, shared by the popup drill (widgets/mastery_drill.tsx)
 * and the regular-queue drill's bar (widgets/mastery_drill_queue_bar.tsx).
 *
 * Row 1 manages the drill as a whole (counts, card list, clearing); row 2 acts on
 * the card on screen. The header only renders and collects the Edit Later note and
 * the priority edit: what each action does, and where its panel opens, is up to the
 * widget — the popup swaps its whole window, the queue bar opens a popup.
 */

import React from 'react';
import { CardPriorityInfo } from '../lib/card_priority/types';
import { formatDrillWait } from '../lib/mastery_drill_cooling';
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
  /** The current card's priority, editable in place. Left out where the host shows priority itself. */
  priority?: { info: CardPriorityInfo; onSave: (value: number) => Promise<void> } | null;
  onGoToRem: () => void;
  onEditLater: (message: string) => Promise<void>;
  onEditPrevious: () => void;
  onEditCurrent: () => void;
  onRemoveCurrent: () => void;
  goToRemTitle?: string;
  showDescription?: boolean;
  /** Shown under the rows, e.g. the regular-queue drill's buried-cards hint. */
  notice?: React.ReactNode;
}

const neutral: React.CSSProperties = {
  backgroundColor: 'var(--rn-clr-background-primary)',
  color: 'var(--rn-clr-content-primary)',
  border: '1px solid var(--rn-clr-border-primary)',
};

export function MasteryDrillHeader(props: MasteryDrillHeaderProps) {
  const { variant, readyCount, coolingCount, firstReadyAt, oldCount, oldThreshold, priority } = props;
  const compact = variant === 'queue';
  const [editLaterOpen, setEditLaterOpen] = React.useState(false);
  const [editLaterMessage, setEditLaterMessage] = React.useState('');
  const [editingPriority, setEditingPriority] = React.useState<number | null>(null);

  // Row 2 is the popup's main toolbar; in the queue strip it matches row 1.
  const actionSize = compact ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm';
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

  const confirmEditLater = async () => {
    await props.onEditLater(editLaterMessage);
    setEditLaterOpen(false);
    setEditLaterMessage('');
  };
  const cancelEditLater = () => {
    setEditLaterOpen(false);
    setEditLaterMessage('');
  };

  return (
    <div className={compact ? 'flex flex-col' : 'border-b rn-clr-border-primary flex flex-col'}>
      {/* Row 1: the drill as a whole */}
      <div className={`flex items-center gap-2 flex-wrap ${compact ? 'px-3 pt-1' : 'px-2 pt-2 pb-1'}`}>
        <span
          className={`whitespace-nowrap flex-shrink-0 ${compact ? 'font-semibold text-sm' : 'font-bold text-lg'}`}
          style={{ color: 'var(--rn-clr-content-primary)' }}
        >
          {compact ? '🎯 Mastery Drill' : 'Mastery Drill'}
        </span>
        <span
          onClick={props.onOpenCardList}
          className="text-xs px-2 py-1 rounded bg-red-100 text-red-800 whitespace-nowrap cursor-pointer"
          title={`List every card in the drill${compact ? '' : ' (L)'}`}
        >
          {readyCount} Remaining
        </span>
        {coolingCount > 0 && (
          <span
            className="text-xs px-2 py-1 rounded whitespace-nowrap"
            style={{
              backgroundColor: 'var(--rn-clr-background-secondary)',
              color: 'var(--rn-clr-content-secondary)',
              border: '1px solid var(--rn-clr-border-primary)',
            }}
            title={`${coolingCount} card${plural(coolingCount, ' is', 's are')} still cooling and will appear later${
              firstReadyAt !== undefined ? ` (the first in ${formatDrillWait(firstReadyAt - Date.now())})` : ''
            }`}
          >
            {coolingCount} cooling
          </span>
        )}
        <button
          onClick={props.onOpenCardList}
          className="text-xs px-2 py-1 rounded whitespace-nowrap"
          style={neutral}
          title={`List every card in the drill and check whether RemNote can show it${compact ? '' : ' (L)'}`}
        >
          List Cards
        </button>
        <button
          onClick={props.onClearAll}
          className="text-xs px-2 py-1 rounded border border-red-200 text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/20 whitespace-nowrap"
          title="Clear all items from the Mastery Drill queue"
        >
          Clear Queue
        </button>
        <button
          onClick={props.onClearLowPriority}
          className="text-xs px-2 py-1 rounded border border-orange-200 text-orange-600 hover:bg-orange-50 dark:border-orange-800 dark:text-orange-400 dark:hover:bg-orange-900/20 whitespace-nowrap"
          title="Remove low priority cards from the Mastery Drill queue"
        >
          Clear Low Priority
        </button>
        {oldCount > 0 && (
          <div
            className="flex items-center gap-1.5 px-2 py-1 rounded bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800"
            title={`${oldCount} card${plural(oldCount, ' has', 's have')} been ready to drill for more than ${oldThreshold} days. The Mastery Drill is intended for cards you recently rated Hard or Again — after this much time, the spaced repetition algorithm will handle them at their scheduled date instead. You can remove them here if you prefer to trust the scheduler rather than drilling them now.`}
          >
            <span className="text-xs text-yellow-800 dark:text-yellow-200 whitespace-nowrap">
              {oldCount} &gt; {oldThreshold} days.
            </span>
            <button
              onClick={props.onClearOld}
              className="text-xs px-2 py-0.5 rounded bg-yellow-100 text-yellow-800 border border-yellow-300 hover:bg-yellow-200 dark:bg-yellow-800 dark:text-yellow-100 dark:border-yellow-600 whitespace-nowrap"
            >
              Clear Old
            </button>
          </div>
        )}
      </div>

      {/* Row 2: the card on screen */}
      <div className={`flex items-center gap-2 flex-wrap ${compact ? 'px-3 pt-1 pb-1' : 'px-2 pb-2'}`}>
        {priority && (
          <div className="cursor-pointer" onClick={() => setEditingPriority(priority.info.priority)} title="Click to change priority">
            <PriorityBadge
              priority={priority.info.priority}
              percentile={priority.info.kbPercentile ?? undefined}
              compact
              useAbsoluteColoring={priority.info.kbPercentile == null}
              source={priority.info.source}
              isCardPriority
            />
          </div>
        )}
        <button
          onClick={props.onGoToRem}
          className={`${actionSize} rounded transition-colors shadow-sm font-medium whitespace-nowrap`}
          style={neutral}
          title={props.goToRemTitle ?? 'Go to the current Rem'}
        >
          Go to Rem
        </button>
        <button
          onClick={() => {
            setEditLaterMessage('');
            setEditLaterOpen(true);
          }}
          className={`${actionSize} rounded bg-orange-500 text-white hover:bg-orange-600 font-medium transition-colors shadow-md whitespace-nowrap`}
          title="Mark for Edit Later and remove from drill"
        >
          Edit Later
        </button>
        <button
          onClick={props.onEditPrevious}
          className={`${actionSize} rounded font-medium transition-colors shadow-sm whitespace-nowrap`}
          style={{ ...neutral, backgroundColor: 'var(--rn-clr-background-secondary)' }}
          title="Edit the card you just rated"
        >
          Edit Previous
        </button>
        <button
          onClick={props.onEditCurrent}
          className={`${actionSize} rounded bg-blue-500 text-white hover:bg-blue-600 font-medium transition-colors shadow-sm whitespace-nowrap`}
          title="Edit the currently visible card"
        >
          Edit Current
        </button>
        <button
          onClick={props.onRemoveCurrent}
          className={`${actionSize} rounded border border-red-200 text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/20 font-medium transition-colors whitespace-nowrap`}
          title="Remove current card from the Mastery Drill"
        >
          Remove from Drill
        </button>
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
          <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
            Flashcards you have rated <i>Again</i> or <i>Hard</i> will appear and remain in the Drill until you rate them <i>Good</i> or better.
          </span>
        </div>
      )}

      {editLaterOpen && (
        <EditLaterNote
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
  value,
  onChange,
  onConfirm,
  onCancel,
  bordered = true,
}: {
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
        Edit Later note:
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
