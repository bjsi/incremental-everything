import { RNPlugin, PluginRem } from '@remnote/plugin-sdk';
import { IncrementalRem } from '../incremental_rem/types';
import { setCardPriority } from './index';

/**
 * Stamp an Incremental Rem's priority onto its own `cardPriority` tag, so the
 * value survives the Incremental powerup being removed (Dismiss) and anchors
 * inheritance for every card created beneath it later.
 *
 * The tag is written unconditionally — no flashcard search, same in Light Mode
 * and Full Mode. Earlier versions only wrote it when the Rem itself, or a
 * descendant within three levels, already owned a flashcard. That gate cost a
 * subtree walk on every call and, worse, silently dropped the priority of the
 * rems that most need an anchor: an IncRem whose cards do not exist yet (a PDF
 * section with only extracted children) lost its priority on Dismiss, and any
 * card added under it afterwards inherited from a distant ancestor instead.
 *
 * A `manual` source is still never overwritten — that is the user's explicit
 * choice on this Rem.
 */
export const handleCardPriorityInheritance = async (
    plugin: RNPlugin,
    rem: PluginRem,
    incRemInfo: IncrementalRem | null
) => {
    if (!rem || !incRemInfo) return;

    try {
        // Only bail out if the source is 'manual' (user explicitly set it and we must not overwrite).
        // 'inherited' is overwritable: the IncRem's own priority takes precedence over an
        // ancestor-inherited value. 'default' and null (no tag) also proceed.
        const existingSource = await rem.getPowerupProperty('cardPriority', 'prioritySource');
        if (existingSource && typeof existingSource === 'string' && existingSource.toLowerCase() === 'manual') {
            return;
        }

        await setCardPriority(plugin, rem, incRemInfo.priority, 'incremental');
    } catch (error) {
        // Silently handle errors
    }
};
