// "Make Incremental (Extract)" core logic.
//
// Lives in lib/ so commands.ts can stay slim. Two registered commands consume
// this function: `incremental-everything` (Opt+X) and `extract-with-priority`
// (Opt+Shift+X). It uses getEffectiveSelection() so it works equally well from
// keyboard shortcuts (live selection) and the Cmd+/ Omnibar (cached selection).

import {
  BuiltInPowerupCodes,
  PluginRem,
  ReactRNPlugin,
  RICH_TEXT_FORMATTING,
  RichTextInterface,
  SelectionType,
} from '@remnote/plugin-sdk';
import { currentIncRemKey } from './consts';
import { initIncrementalRem } from '../register/powerups';
import {
  REMOVE_PARENT_POWERUP_CODE,
  REMOVE_FROM_QUEUE_POWERUP_CODE,
} from '../register/queue_display_powerups';
import { getEffectiveSelection } from './editor_selection';

export const createExtract = async (
  plugin: ReactRNPlugin
): Promise<PluginRem | PluginRem[] | undefined> => {
  let selection = await getEffectiveSelection(plugin);
  const url = await plugin.window.getURL();

  if (url.includes('/flashcards')) {
    const currentQueueItem = await plugin.queue.getCurrentCard();
    let isTargetingQueueContext = false;

    if (!selection || !selection.type) {
      isTargetingQueueContext = true;
    } else if (currentQueueItem) {
      if (
        selection.type === SelectionType.Rem &&
        selection.remIds.includes(currentQueueItem.remId)
      ) {
        isTargetingQueueContext = true;
      } else if (
        selection.type === SelectionType.Text &&
        selection.remId === currentQueueItem.remId &&
        selection.range.start === selection.range.end
      ) {
        isTargetingQueueContext = true;
      }
    } else {
      const currentIncRemId = await plugin.storage.getSession<string>(
        currentIncRemKey
      );
      if (currentIncRemId) {
        if (
          selection.type === SelectionType.Rem &&
          selection.remIds.includes(currentIncRemId)
        ) {
          isTargetingQueueContext = true;
        } else if (
          selection.type === SelectionType.Text &&
          selection.remId === currentIncRemId &&
          selection.range.start === selection.range.end
        ) {
          isTargetingQueueContext = true;
        }
      }
    }

    if (isTargetingQueueContext) {
      let targetRemId = currentQueueItem?.remId;
      if (!targetRemId) {
        targetRemId =
          (await plugin.storage.getSession<string>(currentIncRemKey)) ||
          undefined;
      }

      if (targetRemId) {
        selection = {
          type: SelectionType.Rem,
          remIds: [targetRemId],
        } as any;
      }
    }
  }

  if (!selection) {
    // plugin.editor.getSelection() returns undefined when focus is inside the
    // PDF iframe. plugin.reader.addHighlight() also returns null in that
    // context — it requires a RemNote-internal pending highlight available
    // only through the PDFHighlightToolbar widget flow. Keyboard shortcuts
    // cannot create PDF highlights.
    return;
  }

  if (
    selection.type === SelectionType.Text &&
    selection.range.start === selection.range.end
  ) {
    // Fallback empty text selections to Rem selection behavior
    (selection as any).type = SelectionType.Rem;
    (selection as any).remIds = [selection.remId];
  }

  // Extract within extract
  if (selection.type === SelectionType.Text) {
    // 1. Fetch the Rem
    const rem = await plugin.rem.findOne(selection.remId);
    if (!rem) return;

    // 2. Extract selected text
    const extractRem = await plugin.rem.createRem();
    if (!extractRem) return;

    // Look for a reference pin to the original PDF Highlight in the parent
    let pdfExtractPin: any = null;
    if (rem.text) {
      let pdfExtractTagRem: PluginRem | undefined;
      try {
        pdfExtractTagRem =
          (await plugin.rem.findByName(['pdfextract'], null)) || undefined;
      } catch (e) {
        // ignore
      }

      for (const item of rem.text) {
        if (
          typeof item === 'object' &&
          item !== null &&
          item.i === 'q' &&
          item._id
        ) {
          const referencedRem = await plugin.rem.findOne(item._id);
          if (referencedRem) {
            const isPdfHighlight = await referencedRem.hasPowerup(
              BuiltInPowerupCodes.PDFHighlight
            );
            let hasTag = false;
            if (pdfExtractTagRem) {
              const tags = await referencedRem.getTagRems();
              hasTag = tags.some((t) => t._id === pdfExtractTagRem!._id);
            }

            if (isPdfHighlight || hasTag) {
              // Copy the exact pin
              pdfExtractPin = { ...item, pin: true };
              break;
            }
          }
        }
      }
    }

    const newText: any[] = [
      ...selection.richText,
      { i: 'q', _id: rem._id, pin: true },
    ];

    if (pdfExtractPin) {
      newText.push(' ', pdfExtractPin);
    }

    await extractRem.setText(newText);
    await extractRem.setParent(rem);

    // 3. Hide the source rem from queue display when this extract is reviewed.
    //
    // Preferred path: tag the PARENT (source rem) with Remove from Queue. This
    // survives extract relocation cleanly — if the user later deletes the
    // parent and lets extracts stand on their own, the powerup goes with the
    // parent and the standalone extracts behave normally.
    //
    // Fallback path: if Remove from Queue isn't registered (neither our
    // Hide-in-Queue integration nor the standalone plugin is active), tag the
    // EXTRACT itself with Remove Parent (always registered). This works but
    // has a relocation caveat: if the extract is later moved under a new
    // parent, that new parent will be hidden too — the user must remove the
    // powerup manually in that case.
    //
    // Detecting via getPowerupByCode (rather than our integration setting
    // alone) ensures users with only the standalone plugin still hit the
    // preferred path.
    const rfqPowerup = await plugin.powerup.getPowerupByCode(
      REMOVE_FROM_QUEUE_POWERUP_CODE
    );
    if (rfqPowerup) {
      await rem.addPowerup(REMOVE_FROM_QUEUE_POWERUP_CODE);
    } else {
      await extractRem.addPowerup(REMOVE_PARENT_POWERUP_CODE);
    }

    // Make Incremental
    // Pass the explicit parent since the SDK cache may not yet reflect
    // `extractRem.setParent(rem)`
    await initIncrementalRem(plugin, extractRem, { explicitParentId: rem._id });
    // 4. Locate and Modify
    const r_start = Math.min(selection.range.start, selection.range.end);

    const frontText = rem.text || [];
    const backText = rem.backText || [];

    // Plain text extractor — non-text nodes (i:'q' pins etc.) contribute empty
    // string. This gives us text-only positions that are immune to RemNote's
    // reference node cursor-width (which counts i:'q' as 2 chars, not 1).
    const rtPlainStr = (rt: RichTextInterface): string =>
      rt
        .map((item: any) =>
          typeof item === 'string' ? item : item.i === 'm' ? item.text || '' : ''
        )
        .join('');

    const frontStr = rtPlainStr(frontText);
    const backStr = rtPlainStr(backText);
    const selStr = rtPlainStr(selection.richText as RichTextInterface);
    const selLen = selStr.length;
    const hasBackText = backText.length > 0;

    // Detect which section contains the selection via string-matching
    // (text-only positions). Prefer front; fall back to back; fall back to
    // r_start heuristic.
    let isBack = false;
    let sect_r_start = 0;

    const posInFront = frontStr.indexOf(selStr);
    const posInBack = hasBackText ? backStr.indexOf(selStr) : -1;

    if (posInFront >= 0 && (posInBack < 0 || r_start < frontStr.length)) {
      isBack = false;
      sect_r_start = posInFront;
    } else if (posInBack >= 0) {
      isBack = true;
      sect_r_start = posInBack;
    } else {
      // Last resort: use r_start directly (may still be slightly off for rems
      // with pins)
      isBack = false;
      sect_r_start = r_start;
    }

    const sect_r_end = sect_r_start + selLen;

    // Process rich text using text-only positions (non-text nodes have length
    // 0 and pass through unchanged). This avoids any mismatch with RemNote's
    // cursor model for pins.
    const processRichText = (
      richText: RichTextInterface,
      localStart: number,
      localEnd: number
    ): RichTextInterface => {
      const newArray: any[] = [];
      let currIdx = 0;
      let pinInserted = false;
      for (const item of richText) {
        const isString = typeof item === 'string';
        const textNode = isString ? { i: 'm' as const, text: item } : (item as any);
        const nodeLen = textNode.i === 'm' ? textNode.text?.length || 0 : 0;

        if (nodeLen === 0) {
          // Non-text node: insert the new pin here if the selection ends
          // exactly at this point
          if (!pinInserted && currIdx >= localEnd && localEnd > localStart) {
            newArray.push({ i: 'q', _id: extractRem._id, pin: true });
            pinInserted = true;
          }
          newArray.push(item);
        } else {
          const nodeStart = currIdx;
          const nodeEnd = currIdx + nodeLen;

          if (nodeEnd <= localStart || nodeStart >= localEnd) {
            newArray.push(item);
          } else {
            const textStr = textNode.text || '';
            const relStart = Math.max(0, localStart - nodeStart);
            const relEnd = Math.min(nodeLen, localEnd - nodeStart);

            if (relStart > 0) {
              newArray.push({ ...textNode, text: textStr.substring(0, relStart) });
            }
            newArray.push({
              ...textNode,
              text: textStr.substring(relStart, relEnd),
              [RICH_TEXT_FORMATTING.HIGHLIGHT]: 6, // RemColor.Blue = 6
            });
            if (nodeEnd >= localEnd) {
              newArray.push({ i: 'q', _id: extractRem._id, pin: true });
              pinInserted = true;
            }
            if (relEnd < nodeLen) {
              newArray.push({ ...textNode, text: textStr.substring(relEnd) });
            }
          }
          currIdx += nodeLen;
        }
      }
      if (!pinInserted && localEnd <= currIdx && localStart < currIdx) {
        newArray.push({ i: 'q', _id: extractRem._id, pin: true });
      }
      return newArray;
    };

    // 6. Save the Changes
    if (isBack) {
      await rem.setBackText(processRichText(backText, sect_r_start, sect_r_end));
    } else {
      await rem.setText(processRichText(frontText, sect_r_start, sect_r_end));
    }

    return extractRem;
  } else if (selection.type === SelectionType.Rem) {
    const rems = (await plugin.rem.findMany(selection.remIds)) || [];
    // Single outer flag bracket for the entire batch — each initIncrementalRem
    // skips its own flag management so the flag stays UP for the whole loop.
    await plugin.storage.setSession('plugin_operation_active', true);
    try {
      for (const rem of rems) {
        await initIncrementalRem(plugin, rem, { skipFlagManagement: true });
      }
    } finally {
      // Don't clear the flag — each initIncrementalRem fires
      // pendingInheritanceCascade, and the cascade tracker will clear the flag
      // when the cascade completes. Only clear defensively if no rems were
      // processed (e.g., empty selection).
      if (rems.length === 0) {
        await plugin.storage.setSession('plugin_operation_active', false);
      }
    }
    return rems;
  } else {
    // WebReader or other reader selection — fall back to addHighlight +
    // initIncrementalRem. Note: PDF iframe selections are unreachable here
    // because getSelection() returns undefined for them and we already
    // returned early above.
    const highlight = await plugin.reader.addHighlight();
    if (!highlight) {
      return;
    }
    await initIncrementalRem(plugin, highlight);
    return highlight;
  }
};
