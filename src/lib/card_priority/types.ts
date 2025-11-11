import { RemId } from '@remnote/plugin-sdk';
import { IncrementalRem } from '../incremental_rem';

export const CARD_PRIORITY_CODE = 'cardPriority';
export const PRIORITY_SLOT = 'priority';
export const SOURCE_SLOT = 'prioritySource';
export const LAST_UPDATED_SLOT = 'lastUpdated';

export type PrioritySource = 'manual' | 'inherited' | 'default';

export interface CardPriorityInfo {
  remId: string;
  priority: number;
  source: PrioritySource;
  lastUpdated: number;
  cardCount: number;
  dueCards: number;
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
}
