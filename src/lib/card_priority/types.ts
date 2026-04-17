import { RemId } from '@remnote/plugin-sdk';
import { IncrementalRem } from '../incremental_rem';

export const CARD_PRIORITY_CODE = 'cardPriority';
export const PRIORITY_SLOT = 'priority';
export const SOURCE_SLOT = 'prioritySource';
export const LAST_UPDATED_SLOT = 'lastUpdated';

export type PrioritySource = 'manual' | 'inherited' | 'default' | 'incremental';

export interface CardPriorityInfo {
  remId: string;
  priority: number;
  source: PrioritySource;
  lastUpdated: number;
  cardCount: number;
  dueCards: number;
  /** Count of cards with nextRepetitionTime <= start of today (user's local timezone).
   * Used exclusively by the priority shield to filter intraday scheduling noise. */
  dueCardsOverdue?: number;
  kbPercentile?: number;
}

export interface QueueSessionCache {
  /**
   * A map of RemID -> document-level percentile.
   * Pre-calculated for every card in the current document scope.
   * Allows for an instant lookup of the "X% of Doc" value.
   */
  docPercentiles: Record<RemId, number>;

  /**
   * A pre-filtered list of all due cards that are part of the current document/folder.
   * Used for the fast Document Shield calculation.
   */
  dueCardsInScope: CardPriorityInfo[];

  /**
   * A pre-filtered list of all due cards from the entire Knowledge Base.
   * Used for the fast KB Shield calculation.
   */
  dueCardsInKB: CardPriorityInfo[];

  /**
   * A pre-filtered list of cards due before the start of today (user timezone).
   * Used exclusively by the card priority shield to filter intraday scheduling noise.
   */
  overdueCardsInKB?: CardPriorityInfo[];

  /**
   * Same as overdueCardsInKB but scoped to the current document/folder.
   */
  overdueCardsInScope?: CardPriorityInfo[];

  /**
   * A pre-filtered list of all due Incremental Rems in the document scope.
   * Used for the fast Incremental Rem Document Shield.
   */
  dueIncRemsInScope: IncrementalRem[];

  /**
   * A pre-filtered list of all due Incremental Rems in the entire KB.
   * Used for the fast Incremental Rem KB Shield.
   */
  dueIncRemsInKB: IncrementalRem[];

  /**
   * A map of RemID -> document-level percentile for Incremental Rems.
   * Pre-calculated for every IncRem in the current document scope.
   */
  incRemDocPercentiles: Record<RemId, number>;

  /**
   * Pre-computed weighted shield value for cards at KB scope.
   * null when not enabled or not yet computed.
   */
  weightedShieldCardKB?: number | null;

  /**
   * Pre-computed weighted shield value for cards at document scope.
   * null when not enabled or not yet computed.
   */
  weightedShieldCardDoc?: number | null;

  /**
   * Pre-computed weighted shield value for IncRems at KB scope.
   * null when not enabled or not yet computed.
   */
  weightedShieldIncRemKB?: number | null;

  /**
   * Pre-computed weighted shield value for IncRems at document scope.
   * null when not enabled or not yet computed.
   */
  weightedShieldIncRemDoc?: number | null;
}
