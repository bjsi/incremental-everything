import { RNPlugin, PluginRem } from '@remnote/plugin-sdk';
import { IncrementalRem } from '../incremental_rem/types';
import { setCardPriority } from './index';
import { shouldUseLightMode } from '../mobileUtils';
import { getDescendantsToDepth } from '../pdfUtils';

const MAX_DEPTH_CHECK = 3;

/**
 * Smart function to check if a Rem or its descendants have flashcards.
 * **OPTIMIZED: Checks up to MAX_DEPTH_CHECK (3 levels: PluginRem, Children, Grandchildren).**
 * **PERFORMANCE MODE: In Light Mode, skips flashcard checking and adds cardPriority directly.**
 */
export const handleCardPriorityInheritance = async (
    plugin: RNPlugin,
    rem: PluginRem,
    incRemInfo: IncrementalRem | null
) => {
    if (!rem || !incRemInfo) return;

    const startTime = Date.now();

    try {
        // 1. Check if the Rem already has a *set* cardPriority tag with a non-default source.
        const existingSource = await rem.getPowerupProperty('cardPriority', 'prioritySource');

        // If the Rem is tagged AND the source is 'manual' or 'inherited', we stop.
        // We proceed if the Rem is untagged (existingSource is null) or if the tag source is 'default'.
        if (existingSource && typeof existingSource === 'string' && existingSource.toLowerCase() !== 'default') {
            return;
        }

        // 2. Check if we should use Light Mode for performance
        const useLightMode = await shouldUseLightMode(plugin);

        if (useLightMode) {
            // In Light Mode, skip expensive flashcard checking and add cardPriority directly
            await setCardPriority(plugin, rem, incRemInfo.priority, 'incremental');
            return;
        }

        // 3. Full Mode: Check the Rem itself for flashcards (Depth 1)
        const remCards = await rem.getCards();
        if (remCards && remCards.length > 0) {
            await setCardPriority(plugin, rem, incRemInfo.priority, 'incremental');
            return;
        }

        // 4. Full Mode: Check descendants up to MAX_DEPTH_CHECK (Children and Grandchildren)
        const descendantsToCheck = await getDescendantsToDepth(rem, MAX_DEPTH_CHECK);

        if (descendantsToCheck.length === 0) {
            return;
        }

        // 5. Full Mode: Batch-check the limited descendants with early termination
        const BATCH_SIZE = 50;

        for (let i = 0; i < descendantsToCheck.length; i += BATCH_SIZE) {
            const batch = descendantsToCheck.slice(i, i + BATCH_SIZE);

            const batchResults = await Promise.all(
                batch.map(async (descendant) => {
                    const cards = await descendant.getCards();
                    return cards && cards.length > 0;
                })
            );

            if (batchResults.some(hasCards => hasCards)) {
                await setCardPriority(plugin, rem, incRemInfo.priority, 'incremental');
                return;
            }
        }
    } catch (error) {
        // Silently handle errors
    }
};
