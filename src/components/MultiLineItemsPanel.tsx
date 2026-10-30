/**
 * The items of a list or set card, for the Flashcard Repetition History: why the
 * card is due, what it tests next, and which items are weak. The calculations are in
 * lib/multi_line_items.ts.
 */
import { QueueInteractionScore, RepetitionStatusInterface } from '@remnote/plugin-sdk';
import React from 'react';
import {
  MultiLineSummary,
  describeMultiLineCard,
  itemAffectsCard,
  nextTestLabel,
  repItemMarks,
} from '../lib/multi_line_items';
import { scoreColor, scoreLabel } from '../lib/rating_labels';
import { formatStabilityDays } from '../lib/utils';

const LAST_2_INFO =
  'The last two times you were scored on this item, oldest first: ✓ recalled, ~ partially recalled, ' +
  '✗ forgot.\n\n' +
  'RemNote treats an item as in trouble while either of these two is a Forgot or a Partially ' +
  'Recalled. An item in trouble can bring the card back before its normal date, and the lowest ' +
  'recent scores decide which items the next partial card tests.\n\n' +
  'Where the scores come from: on a list card, you rate each item as it is revealed. On a set card, ' +
  'the button you press goes to every item, except the items you tick first, which count as Forgot. ' +
  'So pressing Partially Recalled on a set card puts all its other items in trouble too, but those ' +
  'share the main card\'s date, so that changes nothing by itself; ⚠ marks only the items that really ' +
  'change what the card does.\n\n' +
  'It is shown here because it explains what you will see: an item leaves trouble only after two ' +
  'good answers in a row, and then stops bringing the card back early.';

const cellStyle: React.CSSProperties = { padding: '2px 8px 2px 0', whiteSpace: 'nowrap' };

function ScoreMark({ score }: { score: QueueInteractionScore | null }) {
  if (score === null) return <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>·</span>;
  const symbol =
    score === QueueInteractionScore.AGAIN ? '✗' : score === QueueInteractionScore.HARD ? '~' : '✓';
  return <span style={{ color: scoreColor(score), fontWeight: 700 }}>{symbol}</span>;
}

export function MultiLineItemsPanel({
  summary,
  nameOf,
  showMemory,
  now,
}: {
  summary: MultiLineSummary;
  nameOf: (remId: string) => string;
  showMemory: boolean;
  now: number;
}) {
  const { reason, next } = describeMultiLineCard(summary, nameOf, now);
  const withMemory = showMemory && summary.items.some((item) => item.stability !== null);

  return (
    <div
      style={{
        margin: '4px 8px 8px',
        padding: '6px 10px',
        borderRadius: 6,
        fontSize: 11,
        color: 'var(--rn-clr-content-secondary)',
        background: 'var(--rn-clr-background-secondary)',
      }}
    >
      <div style={{ fontWeight: 700, fontSize: 10, letterSpacing: '0.05em', color: 'var(--rn-clr-content-tertiary)' }}>
        ITEMS
      </div>
      <div style={{ margin: '2px 0 6px', fontSize: 12, color: 'var(--rn-clr-content-primary)' }}>
        {reason && <div>{reason}</div>}
        <div>{next}</div>
      </div>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr style={{ fontSize: 10, color: 'var(--rn-clr-content-tertiary)', textAlign: 'left' }}>
            <th style={cellStyle}>Item</th>
            <th style={cellStyle}>
              Last 2{' '}
              <span title={LAST_2_INFO} style={{ cursor: 'help' }} aria-label={LAST_2_INFO}>
                ⓘ
              </span>
            </th>
            {withMemory && <th style={cellStyle}>Memory</th>}
            <th style={cellStyle}>Next test</th>
          </tr>
        </thead>
        <tbody>
          {summary.items.map((item) => (
            <tr key={item.remId}>
              <td
                title={nameOf(item.remId)}
                style={{ ...cellStyle, whiteSpace: 'normal', overflowWrap: 'anywhere', minWidth: 120 }}
              >
                {itemAffectsCard(item, summary) ? '⚠ ' : ''}
                {nameOf(item.remId)}
              </td>
              <td style={cellStyle} title={item.lastScores.map(scoreLabel).join(', ')}>
                <span style={{ display: 'inline-flex', gap: 6 }}>
                  {item.lastScores.map((score, i) => (
                    <ScoreMark key={i} score={score} />
                  ))}
                </span>
              </td>
              {withMemory && (
                <td style={cellStyle} title="This item's FSRS stability">
                  {item.stability !== null ? formatStabilityDays(item.stability) : '—'}
                </td>
              )}
              <td style={cellStyle}>{nextTestLabel(item, summary, now)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The marker on a row of the history table. */
export function RepItemMarks({
  rep,
  summary,
  nameOf,
}: {
  rep: RepetitionStatusInterface;
  summary: MultiLineSummary;
  nameOf: (remId: string) => string;
}) {
  const info = repItemMarks(rep, summary);
  if (!info) return null;
  const title = info.marks
    .filter((mark) => mark.score !== null)
    .map((mark) => `${nameOf(mark.remId)}: ${scoreLabel(mark.score!)}`)
    .join('\n');

  if (info.partial) {
    return (
      <span
        title={`Partial: this rep tested only these items and doesn't count for the main card.\n\n${title}`}
        style={{
          marginLeft: 6,
          padding: '0 4px',
          borderRadius: 4,
          fontSize: 10,
          fontWeight: 600,
          cursor: 'help',
          color: 'var(--rn-clr-content-secondary)',
          background: 'var(--rn-clr-background-tertiary)',
        }}
      >
        Partial {info.tested}/{summary.items.length}
      </span>
    );
  }
  return (
    <span title={title} style={{ marginLeft: 6, display: 'inline-flex', gap: 3, cursor: 'help' }}>
      {info.marks.map((mark) => (
        <ScoreMark key={mark.remId} score={mark.score} />
      ))}
    </span>
  );
}
