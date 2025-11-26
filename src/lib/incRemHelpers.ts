import { BuiltInPowerupCodes, RNPlugin } from '@remnote/plugin-sdk';
import { ActionItemType, IncrementalRem } from './incremental_rem/types';
import { remToActionItemType } from './incremental_rem/action_items';

/**
 * Extract plain text from RemNote rich text format.
 * Handles strings, arrays with text items, and special content markers.
 */
export function extractText(text: unknown): string {
  if (typeof text === 'string') return text;
  if (!Array.isArray(text)) return '[Complex content]';

  const result = text
    .map((item: any) => {
      if (typeof item === 'string') return item;
      if (item?.text) return item.text;
      if (item?.i === 'q') return '[Quote]';
      if (item?.i === 'i') return '[Image]';
      if (item?.url) return '[Link]';
      return '';
    })
    .filter(Boolean)
    .join(' ');

  return result || '[Complex content]';
}

/**
 * Determine the type of an incremental rem (pdf, pdf-note, rem, etc).
 * Checks parent hierarchy to detect if it's a note under a PDF.
 */
export async function determineIncRemType(plugin: RNPlugin, rem: any): Promise<ActionItemType> {
  try {
    const actionItem = await remToActionItemType(plugin, rem);
    if (!actionItem) return 'unknown';

    let type: ActionItemType = actionItem.type;

    // Check if this is a note under a PDF
    if (type === 'rem') {
      let currentRem = rem;
      for (let i = 0; i < 20; i++) {
        const parent = await currentRem.getParentRem();
        if (!parent) break;
        if (await parent.hasPowerup(BuiltInPowerupCodes.UploadedFile)) {
          return 'pdf-note';
        }
        currentRem = parent;
      }
    }

    return type;
  } catch {
    return 'unknown';
  }
}

/**
 * Calculate the total time spent reviewing an incremental rem.
 * Sums up reviewTimeSeconds from all sessions in history.
 */
export function getTotalTimeSpent(incRem: IncrementalRem): number {
  if (!incRem.history || incRem.history.length === 0) return 0;
  return incRem.history.reduce((total, rep) => total + (rep.reviewTimeSeconds || 0), 0);
}
