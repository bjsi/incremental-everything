// lib/rating_labels.ts
//
// How a queue rating is named and coloured. Shared by every surface that lists
// individual ratings (the Flashcard Repetition History, the Mastery Drill card
// list) so the same answer never reads as two different words or two reds.

import { QueueInteractionScore } from '@remnote/plugin-sdk';

export function scoreLabel(score: QueueInteractionScore): string {
  switch (score) {
    case QueueInteractionScore.AGAIN: return 'Again';
    case QueueInteractionScore.HARD: return 'Hard';
    case QueueInteractionScore.GOOD: return 'Good';
    case QueueInteractionScore.EASY: return 'Easy';
    case QueueInteractionScore.TOO_EARLY: return 'Too Early';
    case QueueInteractionScore.VIEWED_AS_LEECH: return 'Leech';
    case QueueInteractionScore.RESET: return 'Reset';
    case QueueInteractionScore.MANUAL_DATE: return 'Manual Date';
    case QueueInteractionScore.MANUAL_EASE: return 'Manual Ease';
    default: return `Unknown (${score})`;
  }
}

export function scoreColor(score: QueueInteractionScore): string {
  switch (score) {
    case QueueInteractionScore.AGAIN: return '#ef4444';
    case QueueInteractionScore.HARD: return '#f59e0b';
    case QueueInteractionScore.GOOD: return '#22c55e';
    case QueueInteractionScore.EASY: return '#3b82f6';
    default: return 'var(--rn-clr-content-tertiary)';
  }
}
