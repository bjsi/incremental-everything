import {
  ReactRNPlugin,
  RNPlugin,
  SelectionType,
  PluginRem,
  BuiltInPowerupCodes,
  RICH_TEXT_FORMATTING,
  RichTextInterface,
  RemType,
  QueueInteractionScore,
} from '@remnote/plugin-sdk';
import {
  powerupCode,
  currentIncRemKey,
  pageRangeWidgetId,
  noIncRemTimerKey,
  alwaysUseLightModeOnMobileId,
  alwaysUseLightModeOnWebId,
  dismissedPowerupCode,
  currentSubQueueIdKey,
  dismissIncRemCommandId,
  nextInQueueCommandId,
  currentIncrementalRemTypeKey,
  incremReviewStartTimeKey,
} from '../lib/consts';
import { initIncrementalRem } from './powerups';
import { getIncrementalRemFromRem, handleNextRepetitionClick, getCurrentIncrementalRem } from '../lib/incremental_rem';
import { removeIncrementalRemCache } from '../lib/incremental_rem/cache';
import { IncrementalRep } from '../lib/incremental_rem/types';
import { findPDFinRem, safeRemTextToString, getCurrentPageKey, addPageToHistory, registerRemsAsPdfKnown, findPreferredPDFInRem, getDescendantsToDepth, getRemCardContent } from '../lib/pdfUtils';
import { transferToDismissed } from '../lib/dismissed';
import { handleCardPriorityInheritance } from '../lib/card_priority/card_priority_inheritance';
import { CARD_PRIORITY_CODE } from '../lib/card_priority/types';
import dayjs from 'dayjs';
import {
  getOperatingSystem,
  getPlatform,
  isMobileDevice,
  isWebPlatform,
  shouldUseLightMode,
  getEffectivePerformanceMode,
  getFriendlyOSName,
  getFriendlyPlatformName,
  handleMobileDetectionOnStartup,
} from '../lib/mobileUtils';
import { handleQuickPriorityChange } from '../lib/quick_priority';
import {
  removeAllCardPriorityTags,
  updateAllCardPriorities,
  setCardPriority,
} from '../lib/card_priority';
import { loadCardPriorityCache, updateCardPriorityCache } from '../lib/card_priority/cache';
import { computeClozeAutoPriority, ClozeAutoPriorityInfo } from '../lib/cloze_priority';
import {
  REMOVE_PARENT_POWERUP_CODE,
  REMOVE_FROM_QUEUE_POWERUP_CODE,
} from './queue_display_powerups';
import { getPerformanceMode } from '../lib/utils';
import { handleReviewInEditorRem } from '../lib/review_actions';
import {
  detectCase,
  nextCase,
  transformCase,
  transformTitleCase,
} from '../lib/text_case_converter_utils';


export async function registerCommands(plugin: ReactRNPlugin) {
  const createExtract = async (): Promise<PluginRem | PluginRem[] | undefined> => {
    let selection = await plugin.editor.getSelection();
    const url = await plugin.window.getURL();

    if (url.includes('/flashcards')) {
      const currentQueueItem = await plugin.queue.getCurrentCard();
      let isTargetingQueueContext = false;

      if (!selection || !selection.type) {
        isTargetingQueueContext = true;
      } else if (currentQueueItem) {
        if (selection.type === SelectionType.Rem && selection.remIds.includes(currentQueueItem.remId)) {
          isTargetingQueueContext = true;
        } else if (selection.type === SelectionType.Text && selection.remId === currentQueueItem.remId && selection.range.start === selection.range.end) {
          isTargetingQueueContext = true;
        }
      } else {
        const currentIncRemId = await plugin.storage.getSession<string>(currentIncRemKey);
        if (currentIncRemId) {
          if (selection.type === SelectionType.Rem && selection.remIds.includes(currentIncRemId)) {
            isTargetingQueueContext = true;
          } else if (selection.type === SelectionType.Text && selection.remId === currentIncRemId && selection.range.start === selection.range.end) {
            isTargetingQueueContext = true;
          }
        }
      }

      if (isTargetingQueueContext) {
        let targetRemId = currentQueueItem?.remId;
        if (!targetRemId) {
          targetRemId = await plugin.storage.getSession<string>(currentIncRemKey) || undefined;
        }

        if (targetRemId) {
          selection = {
            type: SelectionType.Rem,
            remIds: [targetRemId]
          } as any;
        }
      }
    }

    if (!selection) {
      // plugin.editor.getSelection() returns undefined when focus is inside the PDF
      // iframe. plugin.reader.addHighlight() also returns null in that context —
      // it requires a RemNote-internal pending highlight available only through the
      // PDFHighlightToolbar widget flow. Keyboard shortcuts cannot create PDF highlights.
      return;
    }

    if (selection.type === SelectionType.Text && selection.range.start === selection.range.end) {
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
          pdfExtractTagRem = await plugin.rem.findByName(['pdfextract'], null) || undefined;
        } catch (e) {
          // ignore
        }

        for (const item of rem.text) {
          if (typeof item === 'object' && item !== null && item.i === 'q' && item._id) {
            const referencedRem = await plugin.rem.findOne(item._id);
            if (referencedRem) {
              const isPdfHighlight = await referencedRem.hasPowerup(BuiltInPowerupCodes.PDFHighlight);
              let hasTag = false;
              if (pdfExtractTagRem) {
                const tags = await referencedRem.getTagRems();
                hasTag = tags.some(t => t._id === pdfExtractTagRem!._id);
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
        { i: 'q', _id: rem._id, pin: true }
      ];

      if (pdfExtractPin) {
        newText.push(' ', pdfExtractPin);
      }

      await extractRem.setText(newText);
      await extractRem.setParent(rem);

      // 3. Hide the source rem from queue display when this extract is reviewed.
      //
      // Preferred path: tag the PARENT (source rem) with Remove from Queue. This
      // survives extract relocation cleanly — if the user later deletes the parent
      // and lets extracts stand on their own, the powerup goes with the parent
      // and the standalone extracts behave normally.
      //
      // Fallback path: if Remove from Queue isn't registered (neither our
      // Hide-in-Queue integration nor the standalone plugin is active), tag the
      // EXTRACT itself with Remove Parent (always registered). This works but
      // has a relocation caveat: if the extract is later moved under a new
      // parent, that new parent will be hidden too — the user must remove the
      // powerup manually in that case.
      //
      // Detecting via getPowerupByCode (rather than our integration setting alone)
      // ensures users with only the standalone plugin still hit the preferred path.
      const rfqPowerup = await plugin.powerup.getPowerupByCode(REMOVE_FROM_QUEUE_POWERUP_CODE);
      if (rfqPowerup) {
        await rem.addPowerup(REMOVE_FROM_QUEUE_POWERUP_CODE);
      } else {
        await extractRem.addPowerup(REMOVE_PARENT_POWERUP_CODE);
      }

      // Make Incremental
      // Pass the explicit parent since the SDK cache may not yet reflect `extractRem.setParent(rem)`
      await initIncrementalRem(plugin, extractRem, { explicitParentId: rem._id });
      // 4. Locate and Modify
      const r_start = Math.min(selection.range.start, selection.range.end);

      const frontText = rem.text || [];
      const backText  = rem.backText || [];

      // Plain text extractor — non-text nodes (i:'q' pins etc.) contribute empty string.
      // This gives us text-only positions that are immune to RemNote's reference node
      // cursor-width (which counts i:'q' as 2 chars, not 1).
      const rtPlainStr = (rt: RichTextInterface): string =>
        rt.map((item: any) => typeof item === 'string' ? item : (item.i === 'm' ? (item.text || '') : '')).join('');

      const frontStr = rtPlainStr(frontText);
      const backStr  = rtPlainStr(backText);
      const selStr   = rtPlainStr(selection.richText as RichTextInterface);
      const selLen   = selStr.length;
      const hasBackText = backText.length > 0;

      // Detect which section contains the selection via string-matching (text-only positions).
      // Prefer front; fall back to back; fall back to r_start heuristic.
      let isBack = false;
      let sect_r_start = 0;

      const posInFront = frontStr.indexOf(selStr);
      const posInBack  = hasBackText ? backStr.indexOf(selStr) : -1;

      if (posInFront >= 0 && (posInBack < 0 || r_start < frontStr.length)) {
        isBack = false;
        sect_r_start = posInFront;
      } else if (posInBack >= 0) {
        isBack = true;
        sect_r_start = posInBack;
      } else {
        // Last resort: use r_start directly (may still be slightly off for rems with pins)
        isBack = false;
        sect_r_start = r_start;
      }

      const sect_r_end = sect_r_start + selLen;

      // Process rich text using text-only positions (non-text nodes have length 0 and pass
      // through unchanged). This avoids any mismatch with RemNote's cursor model for pins.
      const processRichText = (richText: RichTextInterface, localStart: number, localEnd: number): RichTextInterface => {
        const newArray: any[] = [];
        let currIdx = 0;
        let pinInserted = false;
        for (const item of richText) {
          const isString = typeof item === 'string';
          const textNode = isString ? { i: 'm' as const, text: item } : (item as any);
          const nodeLen = textNode.i === 'm' ? (textNode.text?.length || 0) : 0;

          if (nodeLen === 0) {
            // Non-text node: insert the new pin here if the selection ends exactly at this point
            if (!pinInserted && currIdx >= localEnd && localEnd > localStart) {
              newArray.push({ i: 'q', _id: extractRem._id, pin: true });
              pinInserted = true;
            }
            newArray.push(item);
          } else {
            const nodeStart = currIdx;
            const nodeEnd   = currIdx + nodeLen;

            if (nodeEnd <= localStart || nodeStart >= localEnd) {
              newArray.push(item);
            } else {
              const textStr  = textNode.text || '';
              const relStart = Math.max(0, localStart - nodeStart);
              const relEnd   = Math.min(nodeLen, localEnd - nodeStart);

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
        // Don't clear the flag — each initIncrementalRem fires pendingInheritanceCascade,
        // and the cascade tracker will clear the flag when the cascade completes.
        // Only clear defensively if no rems were processed (e.g., empty selection).
        if (rems.length === 0) {
          await plugin.storage.setSession('plugin_operation_active', false);
        }
      }
      return rems;
    } else {
      // WebReader or other reader selection — fall back to addHighlight + initIncrementalRem.
      // Note: PDF iframe selections are unreachable here because getSelection() returns
      // undefined for them and we already returned early above.
      const highlight = await plugin.reader.addHighlight();
      if (!highlight) {
        return;
      }
      await initIncrementalRem(plugin, highlight);
      return highlight;
    }
  };




  await plugin.app.registerCommand({
    id: 'extract-with-priority',
    name: 'Extract with Priority',
    keyboardShortcut: 'opt+shift+x',
    quickCode: 'ep',
    action: async () => {
      const result = await createExtract();
      if (!result) {
        return;
      }
      // Clear stale session storage to prevent race condition with widget context
      await plugin.storage.setSession('priorityPopupTargetRemId', undefined);

      if (Array.isArray(result)) {
        // Multi-rem selection: store all remIds for the popup to apply in batch
        const remIds = result.map(r => r._id);
        if (remIds.length === 0) return;
        await plugin.storage.setSession('batchPriorityIntervalRemIds', remIds);
        await plugin.widget.openPopup('priority_interval', {
          remId: remIds[0], // First rem as reference for defaults
          batchMode: true,
        });
      } else {
        // Single rem
        await plugin.storage.setSession('batchPriorityIntervalRemIds', null);
        await plugin.widget.openPopup('priority_interval', {
          remId: result._id,
        });
      }
    },
  });

  const createClozeDeletion = async (): Promise<{
    clozeRem: PluginRem;
    parentRem: PluginRem;
    autoPriority: ClozeAutoPriorityInfo;
  } | undefined> => {
      const selection = await plugin.editor.getSelection();
      if (!selection || selection.type !== SelectionType.Text) return;
      if (selection.range.start === selection.range.end) {
        await plugin.app.toast('Please select some text to create a cloze deletion.');
        return;
      }

      const rem = await plugin.rem.findOne(selection.remId);
      if (!rem) return;

      // Compute auto-priority BEFORE creating the new cloze rem, so the count of existing
      // cloze-extract children reflects only prior clozes (not the one we're about to create).
      const autoPriority = await computeClozeAutoPriority(plugin, rem);

      const r_start = Math.min(selection.range.start, selection.range.end);

      const frontText = rem.text || [];
      const backText = rem.backText || [];
      const hasBackText = backText.length > 0;

      // Plain string from rich text (text nodes only, non-text nodes → '').
      // Used for text-only position matching — immune to RemNote's i:'q' cursor-width (2 chars).
      const rtPlainStr = (rt: RichTextInterface): string =>
        rt.map((item: any) => typeof item === 'string' ? item : (item.i === 'm' ? (item.text || '') : '')).join('');

      const selStr   = rtPlainStr(selection.richText as RichTextInterface);
      const selLen   = selStr.length;
      const frontStr = rtPlainStr(frontText);
      const backStr  = rtPlainStr(backText);

      // Find all offsets at which `needle` occurs in `haystack`.
      const findAllOccurrences = (haystack: string, needle: string): number[] => {
        const offsets: number[] = [];
        if (!needle) return offsets;
        let idx = 0;
        while (true) {
          const found = haystack.indexOf(needle, idx);
          if (found === -1) break;
          offsets.push(found);
          idx = found + 1;
        }
        return offsets;
      };

      // Correct r_start from RemNote's cursor model into plain-string space.
      //
      // RemNote's editor counts each non-text node (i:'q' reference/pin) as 2 chars,
      // while rtPlainStr gives them 0 chars. Each such node before the cursor therefore
      // inflates r_start by 2 relative to our plain-string offset (net: -1 per node,
      // because it contributes 2 to the editor cursor but 0 to plain-string length,
      // and the node itself occupied 1 slot in the old nodeLen=1 model but 0 in ours).
      //
      // Correction: walk the combined rich text (front + back), accumulate editor-model
      // position alongside plain-string position, stop when editor-model pos reaches r_start,
      // and read the plain-string pos at that point.
      const toCorrectedPlainStart = (richText: RichTextInterface, editorOffset: number): number => {
        let editorPos = 0;
        let plainPos  = 0;
        for (const item of richText) {
          if (editorPos >= editorOffset) break;
          const node = typeof item === 'string' ? { i: 'm' as const, text: item as string } : (item as any);
          if (node.i === 'm') {
            const len = node.text?.length || 0;
            const step = Math.min(len, editorOffset - editorPos);
            editorPos += step;
            plainPos  += step;
          } else {
            // Non-text nodes: count as 2 in editor model, 0 in plain-string model.
            editorPos += 2;
            // plainPos unchanged — these nodes contribute nothing to the plain string.
          }
        }
        return plainPos;
      };

      // Build the combined (front + back) rich text as RemNote sees it in its cursor model
      // so we can convert r_start → plain-string offset correctly.
      const combinedRichText = [...frontText, ...backText];
      const plainStart = toCorrectedPlainStart(combinedRichText, r_start);

      // Among all occurrences of the selected text, pick the one whose plain-string
      // start position is closest to the corrected plain-string offset.
      // This correctly handles duplicate phrases — indexOf always returned the first one,
      // and raw r_start was unreliable due to pin node cursor-width inflation.
      const pickBestOccurrence = (offsets: number[], baseOffset: number = 0): number => {
        if (offsets.length === 0) return -1;
        return offsets.reduce((best, off) =>
          Math.abs((off + baseOffset) - plainStart) < Math.abs((best + baseOffset) - plainStart) ? off : best
        , offsets[0]);
      };

      const allFrontOffsets = findAllOccurrences(frontStr, selStr);
      const allBackOffsets  = hasBackText ? findAllOccurrences(backStr, selStr) : [];

      let isBack = false;
      let sect_r_start = 0;

      // Pick the best occurrence in each section. For back text, plain positions are
      // offset by frontStr.length in the combined plain-string space.
      const bestFront = pickBestOccurrence(allFrontOffsets, 0);
      const bestBack  = pickBestOccurrence(allBackOffsets, frontStr.length);

      if (bestFront >= 0 && bestBack < 0) {
        isBack = false;
        sect_r_start = bestFront;
      } else if (bestBack >= 0 && bestFront < 0) {
        isBack = true;
        sect_r_start = bestBack;
      } else if (bestFront >= 0 && bestBack >= 0) {
        // Both sections have a candidate — pick whichever is closest to the corrected plain offset.
        const frontDist = Math.abs(bestFront - plainStart);
        const backDist  = Math.abs((bestBack + frontStr.length) - plainStart);
        if (frontDist <= backDist) {
          isBack = false;
          sect_r_start = bestFront;
        } else {
          isBack = true;
          sect_r_start = bestBack;
        }
      } else {
        // Fallback: use corrected plainStart directly
        isBack = false;
        sect_r_start = plainStart;
      }

      const sect_r_end = sect_r_start + selLen;

      const clozeId = Math.random().toString(36).substring(2, 10);

      // Determine arrow character from the rem's practice direction.
      const practiceDir = hasBackText ? await rem.getPracticeDirection() : 'none';
      const arrowChar = practiceDir === 'forward' ? '⇒'
                      : practiceDir === 'backward' ? '⇐'
                      : practiceDir === 'both' ? '⇔'
                      : '⇔'; // fallback
      const remType = rem.type;

      // Process one rich text section. localStart/localEnd are section-relative character positions.
      // - Delimiter nodes (i:'s') → replaced by arrowChar.
      // - Existing cloze marks outside the selection → stripped, yellow highlight + red font applied.
      // - Text inside [localStart, localEnd) → new clozeId applied.
      const processSection = (
        richText: RichTextInterface,
        applySelection: boolean,
        localStart: number,
        localEnd: number
      ): any[] => {
        const arr: any[] = [];
        let currIdx = 0;
        for (const item of richText) {
          const isStr  = typeof item === 'string';
          const node   = isStr ? { i: 'm' as const, text: item as string } : (item as any);
          // Text-only positions: non-'m' nodes have length 0 (immune to RemNote's i:'q' cursor-width).
          const nodeLen = node.i === 'm' ? (node.text?.length || 0) : 0;
          const nodeStart = currIdx;
          const nodeEnd   = currIdx + nodeLen;
          // For zero-length nodes use a point check; for text nodes use the range overlap check.
          const inSel = applySelection && (
            nodeLen > 0
              ? (nodeStart < localEnd && nodeEnd > localStart)
              : (currIdx > localStart && currIdx < localEnd)
          );

          if (node.i === 's') {
            arr.push(inSel
              ? { i: 'm' as const, text: arrowChar, [RICH_TEXT_FORMATTING.CLOZE]: clozeId }
              : { i: 'm' as const, text: arrowChar }
            );
          } else if (node.i === 'm') {
            const textStr  = node.text || '';
            const baseNode: any = { ...node };
            const hadCloze = RICH_TEXT_FORMATTING.CLOZE in baseNode;
            delete baseNode[RICH_TEXT_FORMATTING.CLOZE];

            if (!inSel) {
              if (hadCloze) {
                arr.push(isStr
                  ? { i: 'm' as const, text: textStr, [RICH_TEXT_FORMATTING.HIGHLIGHT]: 3, [RICH_TEXT_FORMATTING.TEXT_COLOR]: 1 }
                  : { ...baseNode, [RICH_TEXT_FORMATTING.HIGHLIGHT]: 3, [RICH_TEXT_FORMATTING.TEXT_COLOR]: 1 });
              } else {
                arr.push(isStr ? textStr : baseNode);
              }
            } else {
              const relStart = Math.max(0, localStart - nodeStart);
              const relEnd   = Math.min(nodeLen, localEnd - nodeStart);
              if (relStart > 0) {
                const pre = textStr.substring(0, relStart);
                arr.push(hadCloze
                  ? { ...baseNode, text: pre, [RICH_TEXT_FORMATTING.HIGHLIGHT]: 3, [RICH_TEXT_FORMATTING.TEXT_COLOR]: 1 }
                  : (isStr ? pre : { ...baseNode, text: pre }));
              }
              arr.push({ ...baseNode, text: textStr.substring(relStart, relEnd), [RICH_TEXT_FORMATTING.CLOZE]: clozeId });
              if (relEnd < nodeLen) {
                const post = textStr.substring(relEnd);
                arr.push(hadCloze
                  ? { ...baseNode, text: post, [RICH_TEXT_FORMATTING.HIGHLIGHT]: 3, [RICH_TEXT_FORMATTING.TEXT_COLOR]: 1 }
                  : (isStr ? post : { ...baseNode, text: post }));
              }
            }
          } else {
            const baseNode: any = { ...node };
            const hadCloze = RICH_TEXT_FORMATTING.CLOZE in baseNode;
            delete baseNode[RICH_TEXT_FORMATTING.CLOZE];
            if (inSel) {
              arr.push({ ...baseNode, [RICH_TEXT_FORMATTING.CLOZE]: clozeId });
            } else if (hadCloze) {
              arr.push({ ...baseNode, [RICH_TEXT_FORMATTING.HIGHLIGHT]: 3, [RICH_TEXT_FORMATTING.TEXT_COLOR]: 1 });
            } else {
              arr.push(baseNode);
            }
          }
          currIdx += nodeLen;
        }
        return arr;
      };

      // Apply bold (concept) or italic (descriptor) to all text nodes in a node array,
      // matching how RemNote renders the front of concept/descriptor rems.
      const applyTypeFormatting = (nodes: any[]): any[] => {
        if (remType !== RemType.CONCEPT && remType !== RemType.DESCRIPTOR) return nodes;
        const prop = remType === RemType.CONCEPT ? RICH_TEXT_FORMATTING.BOLD : RICH_TEXT_FORMATTING.ITALIC;
        return nodes.map((node: any) => {
          if (typeof node === 'string') return { i: 'm' as const, text: node, [prop]: true };
          if (node.i === 'm') return { ...node, [prop]: true };
          return node;
        });
      };

      // Build child text: processed front + (arrow separator if needed) + processed back + parent pin.
      const buildChildText = (): RichTextInterface => {
        const rawFrontPart = processSection(frontText, !isBack, sect_r_start, sect_r_end);
        const frontPart = applyTypeFormatting(rawFrontPart);
        const result: any[] = [...frontPart];
        if (hasBackText) {
          const hasExplicitDelim = frontText.some((item: any) => typeof item !== 'string' && item?.i === 's');
          if (!hasExplicitDelim) {
            result.push({ i: 'm' as const, text: ' ' + arrowChar + ' ' });
          }
          const backPart = processSection(backText, isBack, sect_r_start, sect_r_end);
          result.push(...backPart);
        }
        result.push({ i: 'q', _id: rem._id, pin: true });
        return result;
      };

      // 1. Create child rem
      const clozeRem = await plugin.rem.createRem();
      if (!clozeRem) return;

      await clozeRem.setText(buildChildText());
      await clozeRem.setParent(rem);

      let clozeExtractTag = await plugin.rem.findByName(['cloze-extract'], null);
      if (!clozeExtractTag) {
        clozeExtractTag = await plugin.rem.createRem();
        if (clozeExtractTag) await clozeExtractTag.setText(['cloze-extract']);
      }
      if (clozeExtractTag) await clozeRem.addTag(clozeExtractTag._id);

      // 2. Apply the Remove Parent powerup to the cloze rem so its parent is hidden
      // from queue display only when this specific cloze is the current card.
      // Tagging the parent with Remove from Queue (the previous behavior) would
      // also hide it for sibling/descendant flashcards (e.g. descriptor children),
      // breaking their context. Scoping the effect to the cloze itself avoids that.
      await clozeRem.addPowerup(REMOVE_PARENT_POWERUP_CODE);

      // 3. Mark selected text in parent with yellow highlight + red font.
      // Uses the same section-relative positions (sect_r_start/sect_r_end).
      const processParentSection = (richText: RichTextInterface, localStart: number, localEnd: number): RichTextInterface => {
        const arr: any[] = [];
        let currIdx = 0;
        for (const item of richText) {
          const isStr  = typeof item === 'string';
          const node   = isStr ? { i: 'm' as const, text: item as string } : (item as any);
          // Text-only positions: non-'m' nodes pass through unchanged.
          const nodeLen = node.i === 'm' ? (node.text?.length || 0) : 0;

          if (nodeLen === 0) {
            arr.push(item);
          } else {
            const nodeStart = currIdx;
            const nodeEnd   = currIdx + nodeLen;
            if (nodeEnd <= localStart || nodeStart >= localEnd) {
              arr.push(item);
            } else {
              const textStr  = node.text || '';
              const relStart = Math.max(0, localStart - nodeStart);
              const relEnd   = Math.min(nodeLen, localEnd - nodeStart);
              if (relStart > 0) {
                arr.push(isStr ? textStr.substring(0, relStart) : { ...node, text: textStr.substring(0, relStart) });
              }
              arr.push({ ...node, text: textStr.substring(relStart, relEnd), [RICH_TEXT_FORMATTING.HIGHLIGHT]: 3, [RICH_TEXT_FORMATTING.TEXT_COLOR]: 1 });
              if (relEnd < nodeLen) {
                arr.push(isStr ? textStr.substring(relEnd) : { ...node, text: textStr.substring(relEnd) });
              }
            }
            currIdx += nodeLen;
          }
        }
        return arr;
      };

      if (isBack) {
        await rem.setBackText(processParentSection(backText, sect_r_start, sect_r_end));
      } else {
        await rem.setText(processParentSection(frontText, sect_r_start, sect_r_end));
      }

      // Apply the auto-priority computed at the top (before the new cloze existed,
      // so the existing-cloze count was correct).
      await setCardPriority(plugin, clozeRem, autoPriority.priority, 'manual');
      await updateCardPriorityCache(plugin, clozeRem._id, true, {
        remId: clozeRem._id,
        priority: autoPriority.priority,
        source: 'manual',
        cardCount: 1,
        dueCards: 1,
      } as any);

      return { clozeRem, parentRem: rem, autoPriority };
  };

  plugin.app.registerCommand({
    id: 'create-cloze-deletion',
    name: 'Create Cloze Deletion',
    keyboardShortcut: 'opt+z',
    action: async () => { await createClozeDeletion(); },
  });

  plugin.app.registerCommand({
    id: 'create-cloze-deletion-with-priority',
    name: 'Create Cloze Deletion with Priority',
    keyboardShortcut: 'opt+shift+z',
    action: async () => {
      const result = await createClozeDeletion();
      if (!result) return;
      const { clozeRem, parentRem, autoPriority } = result;

      const parentContent = await getRemCardContent(plugin, parentRem);
      const parentText = parentContent.front
        + (parentContent.back ? ` → ${parentContent.back}` : '');

      await plugin.storage.setSession('priorityPopupTargetRemId', undefined);
      await plugin.widget.openPopup('priority_light', {
        remId: clozeRem._id,
        parentExtractContext: {
          parentRemId: parentRem._id,
          parentText,
          parentPriority: autoPriority.parentPriority,
          parentPrioritySource: autoPriority.parentPrioritySource,
          clozeChildCount: autoPriority.clozeChildCount,
          parentOwnCardCount: autoPriority.parentOwnCardCount,
          totalExistingCount: autoPriority.totalExistingCount,
          decrementsApplied: autoPriority.decrementsApplied,
          stepSize: autoPriority.stepSize,
          suggestedPriority: autoPriority.priority,
        },
      });
    },
  });

  plugin.app.registerCommand({
    id: 'set-priority',
    name: 'Set Priority',
    keyboardShortcut: 'opt+p',
    quickCode: 'pri',
    action: async () => {
      console.log('--- Set Priority Command Triggered ---');
      let remId: string | undefined;
      const url = await plugin.window.getURL();
      console.log('Current URL:', url);

      // Check if we are in the queue AND targeting the flashcard explicitly
      if (url.includes('/flashcards')) {
        console.log('In flashcards view.');
        const currentQueueItem = await plugin.queue.getCurrentCard();
        const sel = await plugin.editor.getSelection();
        const selType = sel?.type;

        let isTargetingQueueContext = false;

        // If no editor selection, we assume queue context
        if (!selType) {
          isTargetingQueueContext = true;
        } else if (currentQueueItem) { // We have a native card AND a selection
          if (selType === SelectionType.Rem && sel.remIds.includes(currentQueueItem.remId)) {
            isTargetingQueueContext = true;
          } else if (selType === SelectionType.Text && sel.remId === currentQueueItem.remId) {
            isTargetingQueueContext = true;
          }
        } else {
          // No current native card, maybe our Incremental Rem view
          const currentIncRemId = await plugin.storage.getSession<string>(currentIncRemKey);
          if (currentIncRemId) {
            if (selType === SelectionType.Rem && sel.remIds.includes(currentIncRemId)) {
              isTargetingQueueContext = true;
            } else if (selType === SelectionType.Text && sel.remId === currentIncRemId) {
              isTargetingQueueContext = true;
            }
          }
        }

        if (isTargetingQueueContext) {
          if (currentQueueItem) {
            remId = currentQueueItem.remId;
            console.log('Found native card. remId:', remId);
          } else {
            console.log('Not a native card. Checking session storage for incremental rem...');
            remId = await plugin.storage.getSession<string>(currentIncRemKey) || undefined;
            console.log('remId from session storage (currentIncRemKey):', remId);
          }
        } else {
          console.log('In flashcards view, but explicit selection detected. Using selection.');
          if (selType === SelectionType.Rem && sel && 'remIds' in sel) {
            remId = (sel as any).remIds[0];
          } else if (selType === SelectionType.Text && sel && 'remId' in sel) {
            remId = (sel as any).remId;
          }
        }
      } else {
        console.log('Not in flashcards view. Getting focused editor rem.');
        const focusedRem = await plugin.focus.getFocusedRem();
        remId = focusedRem?._id;
        console.log('Focused editor remId:', remId);
      }

      console.log('Final remId to be used:', remId);

      if (!remId) {
        console.log('Set Priority: No focused Rem or card in queue found. Aborting.');
        await plugin.app.toast('Could not find a Rem to set priority for.');
        return;
      }

      console.log(`Opening 'priority' popup for remId: ${remId}`);
      await plugin.widget.openPopup('priority', {
        remId: remId,
      });
    },
  });

  // NEW: Light Priority Command
  plugin.app.registerCommand({
    id: 'set-priority-light',
    name: 'Quick Set Priority',
    description: 'Instant popup to set Incremental and Card priorities',
    keyboardShortcut: 'ctrl+opt+p', // Shortcuts: Ctrl + Option + P
    quickCode: 'qpri',
    action: async () => {
      const tCmd = performance.now();
      console.log('[set-priority-light] Command triggered');
      let remId: string | undefined;
      const url = await plugin.window.getURL();

      // Context detection logic (Same as main command)
      if (url.includes('/flashcards')) {
        const currentQueueItem = await plugin.queue.getCurrentCard();
        const sel = await plugin.editor.getSelection();
        const selType = sel?.type;

        let isTargetingQueueContext = false;

        if (!selType) {
          isTargetingQueueContext = true;
        } else if (currentQueueItem) {
          if (selType === SelectionType.Rem && sel && 'remIds' in sel && sel.remIds.includes(currentQueueItem.remId)) {
            isTargetingQueueContext = true;
          } else if (selType === SelectionType.Text && sel && 'remId' in sel && sel.remId === currentQueueItem.remId) {
            isTargetingQueueContext = true;
          }
        } else {
          const currentIncRemId = await plugin.storage.getSession<string>(currentIncRemKey);
          if (currentIncRemId) {
            if (selType === SelectionType.Rem && sel && 'remIds' in sel && sel.remIds.includes(currentIncRemId)) {
              isTargetingQueueContext = true;
            } else if (selType === SelectionType.Text && sel && 'remId' in sel && sel.remId === currentIncRemId) {
              isTargetingQueueContext = true;
            }
          }
        }

        if (isTargetingQueueContext) {
          if (currentQueueItem) {
            remId = currentQueueItem.remId;
          } else {
            remId = await plugin.storage.getSession<string>(currentIncRemKey) || undefined;
          }
        } else {
          if (selType === SelectionType.Rem && sel && 'remIds' in sel) {
            remId = sel.remIds[0];
          } else if (selType === SelectionType.Text && sel && 'remId' in sel) {
            remId = sel.remId;
          }
        }
      } else {
        const focusedRem = await plugin.focus.getFocusedRem();
        remId = focusedRem?._id;
      }

      console.log(`[set-priority-light] context detection done: ${Math.round(performance.now() - tCmd)}ms, remId: ${remId}`);

      if (!remId) {
        await plugin.app.toast('No Rem found to set priority.');
        return;
      }

      // Clear stale session storage to prevent race condition with widget context
      await plugin.storage.setSession('priorityPopupTargetRemId', undefined);
      console.log(`[set-priority-light] session cleared: ${Math.round(performance.now() - tCmd)}ms`);

      await plugin.widget.openPopup('priority_light', {
        remId: remId,
      });
      console.log(`[set-priority-light] openPopup returned: ${Math.round(performance.now() - tCmd)}ms`);
    },
  });

  plugin.app.registerCommand({
    id: 'reschedule-incremental',
    name: 'Reschedule Incremental Rem',
    keyboardShortcut: 'ctrl+j', // Will be Ctrl+J on Mac also!
    quickCode: 'res',
    action: async () => {
      console.log('--- Reschedule Incremental Rem Command Triggered ---');
      let remId: string | undefined;
      const url = await plugin.window.getURL();
      console.log('Current URL:', url);

      let isTargetingQueueContext = false;

      // Check if we are in the queue AND targeting the flashcard explicitly
      if (url.includes('/flashcards')) {
        console.log('In flashcards view.');
        const currentQueueItem = await plugin.queue.getCurrentCard();
        console.log('Result of getCurrentCard():', currentQueueItem);
        const sel = await plugin.editor.getSelection();
        const selType = sel?.type;

        // If no editor selection, we assume queue context
        if (!selType) {
          isTargetingQueueContext = true;
        } else if (currentQueueItem) { // We have a native card AND a selection
          if (selType === SelectionType.Rem && sel.remIds.includes(currentQueueItem.remId)) {
            isTargetingQueueContext = true;
          } else if (selType === SelectionType.Text && sel.remId === currentQueueItem.remId) {
            isTargetingQueueContext = true;
          }
        } else {
          // No current native card, maybe our Incremental Rem view
          const currentIncRemId = await plugin.storage.getSession<string>(currentIncRemKey);
          if (currentIncRemId) {
            if (selType === SelectionType.Rem && sel.remIds.includes(currentIncRemId)) {
              isTargetingQueueContext = true;
            } else if (selType === SelectionType.Text && sel.remId === currentIncRemId) {
              isTargetingQueueContext = true;
            }
          }
        }

        if (isTargetingQueueContext) {
          if (currentQueueItem) {
            remId = currentQueueItem.remId;
            console.log('Found native card. remId:', remId);
          } else {
            console.log('Not a native card. Checking session storage for incremental rem...');
            remId = await plugin.storage.getSession<string>(currentIncRemKey) || undefined;
            console.log('remId from session storage (currentIncRemKey):', remId);
          }
        } else {
          console.log('In flashcards view, but explicit selection detected. Using selection.');
          if (selType === SelectionType.Rem && sel && 'remIds' in sel) {
            remId = (sel as any).remIds[0];
          } else if (selType === SelectionType.Text && sel && 'remId' in sel) {
            remId = (sel as any).remId;
          }
        }
      } else {
        console.log('Not in flashcards view. Getting focused editor rem.');
        const focusedRem = await plugin.focus.getFocusedRem();
        remId = focusedRem?._id;
        console.log('Focused editor remId:', remId);
      }

      console.log('Final remId to be used:', remId);

      if (!remId) {
        console.log('Reschedule: No focused Rem or card in queue found. Aborting.');
        await plugin.app.toast('Could not find a Rem to reschedule.');
        return;
      }

      // Check if the Rem is an Incremental Rem
      const rem = await plugin.rem.findOne(remId);
      if (!rem) {
        console.log('Reschedule: PluginRem not found. Aborting.');
        await plugin.app.toast('Could not find the Rem.');
        return;
      }

      // Check if it has the Incremental powerup
      const hasIncrementalPowerup = await rem.hasPowerup(powerupCode);
      if (!hasIncrementalPowerup) {
        console.log('Reschedule: PluginRem is not tagged as Incremental. Aborting.');
        await plugin.app.toast('This command only works with Incremental Rems.');
        return;
      }

      // Verify it's actually an Incremental Rem with valid data
      const incRemInfo = await getIncrementalRemFromRem(plugin, rem);
      if (!incRemInfo) {
        console.log('Reschedule: Could not get Incremental Rem info. Aborting.');
        await plugin.app.toast('Could not retrieve Incremental Rem information.');
        return;
      }

      // Determine context (queue vs editor) for event type
      const isQueue = url.includes('/flashcards');
      const context = (isQueue && isTargetingQueueContext) ? 'queue' : 'editor';

      console.log(`Opening 'reschedule' popup for remId: ${remId}, context: ${context}`);
      await plugin.widget.openPopup('reschedule', {
        remId: remId,
        context: context,
      });
    },
  });

  plugin.app.registerCommand({
    id: 'batch-priority-change',
    name: 'Batch Priority Change',
    // keyboardShortcut: 'opt+shift+p', // Removed to avoid conflict/declutter
    action: async () => {
      const focusedRem = await plugin.focus.getFocusedRem();
      if (!focusedRem) {
        await plugin.app.toast('Please focus on a rem to perform batch priority changes');
        return;
      }

      // Store the focused rem ID in session for the popup to access
      await plugin.storage.setSession('batchPriorityFocusedRem', focusedRem._id);

      // Open the popup
      await plugin.widget.openPopup('batch_priority', {
        remId: focusedRem._id,
      });
    },
  });

  // Register command for batch card priority assignment
  plugin.app.registerCommand({
    id: 'batch-card-priority',
    name: 'Batch Assign Card Priority for tagged/referencing rems',
    keyboardShortcut: 'opt+shift+c',
    action: async () => {
      const focused = await plugin.focus.getFocusedRem();

      if (!focused) {
        await plugin.app.toast('Please focus on a rem first');
        return;
      }

      // Allow opening if this rem is used as a tag OR is referenced by other rems
      const [taggedRems, referencingRems] = await Promise.all([
        focused.taggedRem(),
        focused.remsReferencingThis(),
      ]);

      const hasTagged = taggedRems && taggedRems.length > 0;
      const hasReferencing = referencingRems && referencingRems.length > 0;

      if (!hasTagged && !hasReferencing) {
        await plugin.app.toast('No rems are tagged with or referencing this rem.');
        return;
      }

      // Store the anchor rem ID in session storage
      await plugin.storage.setSession('batchCardPriorityTagRem', focused._id);

      // Open the batch card priority widget
      await plugin.widget.openPopup('batch_card_priority');
    },
  });

  plugin.app.registerCommand({
    id: 'pdf-control-panel',
    name: 'PDF Control Panel',
    quickCode: 'pdf',
    action: async () => {
      const rem = await plugin.focus.getFocusedRem();
      if (!rem) {
        return;
      }

      // 1. Find the associated PDF Rem, honouring #preferthispdf when multiple sources exist
      const pdfRem = await findPreferredPDFInRem(plugin, rem);

      // 2. If no PDF is found (or multiple #preferthispdf tags conflict), inform the user and stop.
      if (!pdfRem) {
        // findPreferredPDFInRem already showed a toast for the multi-tag conflict case;
        // only show the generic message when truly no PDF was found.
        const hasSomePdf = await findPDFinRem(plugin, rem);
        if (!hasSomePdf) {
          await plugin.app.toast('No PDF found in the focused Rem or its sources.');
        }
        return;
      }

      // 3. Ensure the focused Rem is an incremental Rem, initializing it if necessary.
      if (!(await rem.hasPowerup(powerupCode))) {
        await initIncrementalRem(plugin, rem);
      }

      // 4. Prepare the context for the popup widget, similar to how the Reader does it.
      //    This context tells the popup which incremental Rem and which PDF to work with.
      const context = {
        incrementalRemId: rem._id,
        pdfRemId: pdfRem._id,
        totalPages: undefined, // Not available in the editor context
        currentPage: undefined, // Not available in the editor context
      };

      // 5. Store the context in session storage so the popup can access it.
      await plugin.storage.setSession('pageRangeContext', context);

      // 6. Open the popup widget.
      await plugin.widget.openPopup(pageRangeWidgetId, {
        remId: rem._id, // Pass remId for consistency, though the widget relies on session context.
      });
    },
  });

  plugin.app.registerCommand({
    id: 'incremental-everything',
    keyboardShortcut: 'opt+x',
    name: 'Make Incremental (Extract)',
    quickCode: 'ext',
    action: async () => {
      createExtract();
    },
  });

  plugin.app.registerCommand({
    id: 'debug-incremental-everything',
    name: 'Debug Incremental Everything',
    action: async () => {
      const rem = await plugin.focus.getFocusedRem();
      if (!rem) {
        return;
      }
      if (!(await rem.hasPowerup(powerupCode)) && !(await rem.hasPowerup(CARD_PRIORITY_CODE)) && !(await rem.hasPowerup(dismissedPowerupCode))) {
        return;
      }
      await plugin.widget.openPopup('debug', {
        remId: rem._id,
      });
    },
  });

  // Update the cancel command to use synced storage
  plugin.app.registerCommand({
    id: 'cancel-no-inc-rem-timer',
    name: 'Cancel No Inc Rem Timer',
    action: async () => {
      const timerEnd = await plugin.storage.getSynced<number>(noIncRemTimerKey);
      if (timerEnd && timerEnd > Date.now()) {
        await plugin.storage.setSynced(noIncRemTimerKey, null);
        await plugin.app.toast('Incremental rem timer cancelled. Normal queue behavior resumed.');
        // Force queue refresh
        await plugin.storage.setSynced('queue-refresh-trigger', Date.now());
      } else {
        await plugin.app.toast('No active timer to cancel.');
      }
    },
  });

  // Register command to create priority review document
  plugin.app.registerCommand({
    id: 'create-priority-review',
    name: 'Create Priority Review Document',
    keyboardShortcut: 'opt+shift+r',
    quickCode: 'prd',
    action: async () => {
      const focused = await plugin.focus.getFocusedRem();

      await plugin.storage.setSession('reviewDocContext', {
        scopeRemId: focused?._id || null,
        scopeName: focused ? await safeRemTextToString(plugin, focused.text) : 'Full KB',
      });

      await plugin.widget.openPopup('review_document_creator');
    },
  });

  // Command to manually refresh the card priority cache ---
  plugin.app.registerCommand({
    id: 'refresh-card-priority-cache',
    name: 'Refresh Card Priority Cache',
    action: async () => {
      await loadCardPriorityCache(plugin);
    },
  });

  // Command to jump to rem by ID using a popup widget
  plugin.app.registerCommand({
    id: 'jump-to-rem-by-id',
    name: 'Jump to Rem by ID',
    action: async () => {
      // Open the popup widget for input
      await plugin.widget.openPopup('jump_to_rem_input');
    },
  });
  plugin.app.registerCommand({
    id: 'review-increm-in-editor',
    name: 'Review in Editor (Execute Repetition)',
    keyboardShortcut: 'ctrl+shift+j',
    quickCode: 'er',
    action: async () => {
      console.log('--- Review Incremental Rem in Editor Command Triggered ---');

      const url = await plugin.window.getURL();
      const isQueue = url && url.includes('/flashcards');

      if (isQueue) {
        // Queue context behavior
        const currentQueueItem = await plugin.queue.getCurrentCard();
        let remId = currentQueueItem?.remId;

        if (!remId) {
          // If the SDK doesn't report an active card (because it's an IncRem or document), fall back to session storage
          remId = (await plugin.storage.getSession<string>(currentIncRemKey)) || undefined;
          console.log('review-increm-in-editor: remId from session storage (currentIncRemKey):', remId);
        }

        if (!remId) {
          await plugin.app.toast('No card or Incremental Rem currently active in the queue.');
          return;
        }

        const rem = await plugin.rem.findOne(remId);
        if (!rem) return;

        const hasIncPowerup = await rem.hasPowerup(powerupCode);
        if (!hasIncPowerup) {
          await plugin.app.toast('Current card is not an Incremental Rem.');
          return;
        }

        // Delegate to exact function used by "Review in Editor"
        await handleReviewInEditorRem(plugin, rem, null);
      } else {
        // Editor context behavior
        // Get focused Rem
        const focusedRem = await plugin.focus.getFocusedRem();
        if (!focusedRem) {
          await plugin.app.toast('No Rem focused');
          return;
        }

        // Check if it's an Incremental Rem
        const hasIncPowerup = await focusedRem.hasPowerup(powerupCode);
        if (!hasIncPowerup) {
          await plugin.app.toast('This Rem is not tagged as an Incremental Rem');
          return;
        }

        // Open the editor review popup
        await plugin.widget.openPopup('editor_review', {
          remId: focusedRem._id,
        });
      }
    },
  });

  plugin.app.registerCommand({
    id: 'debug-video',
    name: 'Debug Video Detection',
    action: async () => {
      const rem = await plugin.focus.getFocusedRem();
      if (!rem) {
        await plugin.app.toast('Please focus on a rem first');
        return;
      }
      await plugin.widget.openPopup('video_debug', {
        remId: rem._id,
      });
    },
  });

  // Pre-computation command
  await plugin.app.registerCommand({
    id: 'update-card-priorities',
    name: 'Update all inherited Card Priorities',
    description: 'Update all inherited Card Priorities (and pre-compute and tag all card not yet prioritized)',
    quickCode: 'ucp',
    action: async () => {
      await updateAllCardPriorities(plugin);
    },
  });

  // Cleanup command
  await plugin.app.registerCommand({
    id: 'cleanup-card-priority',
    name: 'Remove All CardPriority Tags',
    description:
      'Completely remove all CardPriority powerup tags and data from your knowledge base',
    action: async () => {
      await removeAllCardPriorityTags(plugin);
    },
  });

  // Test console function availability (useful for debugging)
  await plugin.app.registerCommand({
    id: 'test-console-function',
    name: 'Test Console Function',
    description: 'Check if jumpToRemById() is available in console',
    action: async () => {
      // Check if function exists on window
      const isOnWindow = typeof (window as any).jumpToRemById === 'function';

      // Log detailed debugging info
      console.log('=== CONSOLE FUNCTION DEBUG ===');
      console.log('typeof (window as any).jumpToRemById:', typeof (window as any).jumpToRemById);
      console.log('typeof window.jumpToRemById:', typeof (window as any).jumpToRemById);
      console.log('Function defined on window:', isOnWindow);
      console.log('window object:', window);
      console.log('Top window === current window:', window === window.top);

      // Try to log the function itself
      if (isOnWindow) {
        console.log('Function reference:', (window as any).jumpToRemById);
      }

      // Check if we're in an iframe
      const inIframe = window !== window.top;
      if (inIframe) {
        console.warn('⚠️ Plugin is running in an iframe!');
        console.log('To use the function in console, you need to:');
        console.log('1. Open DevTools (F12)');
        console.log('2. Look for the context dropdown (usually says "top")');
        console.log('3. Select the RemNote iframe context');
        console.log("OR use: window.jumpToRemById('rem-id')");
      }

      console.log('==============================');

      if (isOnWindow) {
        await plugin.app.toast('✅ Function is defined. Check console for details.');
        console.log('✅ jumpToRemById() is available!');
        console.log("If you get 'not defined' error, try:");
        console.log("  window.jumpToRemById('your-rem-id-here')");
      } else {
        await plugin.app.toast('❌ jumpToRemById() is NOT available');
        console.error('❌ jumpToRemById() is NOT available');
        console.log('This might indicate the plugin needs to be rebuilt');
      }
    },
  });

  plugin.app.registerCommand({
    id: 'open-inc-rem-main-view',
    name: 'Open Incremental Rems Main View',
    keyboardShortcut: 'opt+shift+i',
    quickCode: 'inc',
    action: async () => {
      await plugin.widget.openPopup('inc_rem_main_view');
    },
  });

  plugin.app.registerCommand({
    id: 'test-mobile-detection',
    name: '🧪 Test Mobile & Platform Detection',
    action: async () => {
      // Get all the detection info
      const os = await getOperatingSystem(plugin);
      const platform = await getPlatform(plugin);
      const isMobile = await isMobileDevice(plugin);
      const isWeb = await isWebPlatform(plugin);
      const shouldLight = await shouldUseLightMode(plugin);
      const effective = await getEffectivePerformanceMode(plugin);

      // Get settings
      const setting = await getPerformanceMode(plugin);
      const autoSwitchMobile = await plugin.settings.getSetting<boolean>(alwaysUseLightModeOnMobileId);
      const autoSwitchWeb = await plugin.settings.getSetting<boolean>(alwaysUseLightModeOnWebId);

      // Get friendly names
      const friendlyOS = getFriendlyOSName(os);
      const friendlyPlatform = getFriendlyPlatformName(platform);

      // Log detailed info to console
      console.log('╔═══════════════════════════════════════════════╗');
      console.log('║   Mobile & Platform Detection Test Results   ║');
      console.log('╠═══════════════════════════════════════════════╣');
      console.log('║   ENVIRONMENT DETECTION:                        ║');
      console.log(`║   Operating System: ${friendlyOS.padEnd(26)} ║`);
      console.log(`║   Platform: ${friendlyPlatform.padEnd(32)} ║`);
      console.log(`║   Is Mobile Device: ${(isMobile ? 'Yes' : 'No').padEnd(26)} ║`);
      console.log(`║   Is Web Browser: ${(isWeb ? 'Yes' : 'No').padEnd(28)} ║`);
      console.log('║                                               ║');
      console.log('║ SETTINGS:                                     ║');
      console.log(`║   Performance Mode Setting: ${setting.padEnd(18)} ║`);
      console.log(
        `║   Auto Light on Mobile: ${(autoSwitchMobile !== false ? 'Enabled' : 'Disabled').padEnd(
          22
        )} ║`
      );
      console.log(
        `║   Auto Light on Web: ${(autoSwitchWeb !== false ? 'Enabled' : 'Disabled').padEnd(
          25
        )} ║`
      );
      console.log('║                                               ║');
      console.log('║ RESULT:                                       ║');
      console.log(`║   Should Use Light Mode: ${(shouldLight ? 'YES' : 'NO').padEnd(21)} ║`);
      console.log(`║   Effective Mode: ${effective.padEnd(26)} ║`);
      console.log('╚═══════════════════════════════════════════════╝');

      // Show concise toast
      await plugin.app.toast(
        `${isWeb ? '🌐' : isMobile ? '📱' : '💻'} ${friendlyPlatform} on ${friendlyOS} → ${effective.toUpperCase()} MODE`
      );

      // Optionally, trigger the full startup detection to see the startup toast
      console.log('\nRe-running startup detection...');
      await handleMobileDetectionOnStartup(plugin);
    },
  });

  // NEW: A robust command to open the priority popup that survives widget closure
  plugin.app.registerCommand({
    id: 'force-open-priority',
    name: 'Force Open Priority Popup',
    action: async () => {
      // Small safety delay to ensure previous UI operations (like closing parent selector) have settled
      await new Promise(resolve => setTimeout(resolve, 50));

      // Try reading remId from a custom session key if invoked programmatically
      let remId = await plugin.storage.getSession<string>('forceOpenPriorityTargetRemId');

      // Fallback: look for focused rem or queue card if no session key provided
      if (!remId) {
        const url = await plugin.window.getURL();
        if (url.includes('/flashcards')) {
          const card = await plugin.queue.getCurrentCard();
          if (card) {
            remId = card.remId;
          } else {
            remId = (await plugin.storage.getSession<string>(currentIncRemKey)) || undefined;
          }
        } else {
          const focusedRem = await plugin.focus.getFocusedRem();
          remId = focusedRem?._id;
        }
      }

      if (remId) {
        // Clear stale session storage to prevent race condition with widget context
        await plugin.storage.setSession('priorityPopupTargetRemId', undefined);
        await plugin.storage.setSession('forceOpenPriorityTargetRemId', undefined); // Clear the argument
        await plugin.widget.openPopup('priority_interval', {
          remId: remId,
        });
      } else {
        await plugin.app.toast('No Rem found to open priority popup for.');
      }
    },
  });

  // NEW: Quick Priority Shortcuts
  // Module-level counter to confirm how many times RemNote actually fires the command.
  // Open DevTools → Console and filter by '[QuickPriority]' to count invocations.
  let _quickPriorityCallCount = 0;

  plugin.app.registerCommand({
    id: 'quick-increase-priority',
    name: 'Quick Increase Priority Number (Less Important)',
    description: 'Increases the priority number by the step size (default 10), making it LESS important.',
    keyboardShortcut: 'ctrl+opt+up',
    action: async () => {
      console.log(`[QuickPriority] #${++_quickPriorityCallCount} increase fired at ${Date.now()}`);
      await handleQuickPriorityChange(plugin, 'increase');
    },
  });

  plugin.app.registerCommand({
    id: 'quick-decrease-priority',
    name: 'Quick Decrease Priority Number (More Important)',
    description: 'Decreases the priority number by the step size (default 10), making it MORE important.',
    keyboardShortcut: 'ctrl+opt+down',
    action: async () => {
      console.log(`[QuickPriority] #${++_quickPriorityCallCount} decrease fired at ${Date.now()}`);
      await handleQuickPriorityChange(plugin, 'decrease');
    },
  });

  // Open Repetition History command
  plugin.app.registerCommand({
    id: 'open-repetition-history',
    name: 'Open Repetition History',
    keyboardShortcut: 'ctrl+shift+h',
    quickCode: 'his',
    action: async () => {
      let remId: string | undefined;
      let cardId: string | undefined;
      const url = await plugin.window.getURL();
      const isQueue = url.includes('/flashcards');

      // Check if we are in the queue AND explicitly targeting the card
      if (isQueue) {
        const card = await plugin.queue.getCurrentCard();
        const sel = await plugin.editor.getSelection();
        const selType = sel?.type;

        // Use Selection-Aware targeting identical to setting priority
        let isTargetingQueueContext = false;

        if (!selType) {
          isTargetingQueueContext = true;
        } else if (card) {
          if (selType === SelectionType.Rem && sel && 'remIds' in sel && sel.remIds.includes(card.remId)) {
            isTargetingQueueContext = true;
          } else if (selType === SelectionType.Text && sel && 'remId' in sel && sel.remId === card.remId) {
            isTargetingQueueContext = true;
          }
        } else {
          const currentIncRemId = await plugin.storage.getSession<string>(currentIncRemKey);
          if (currentIncRemId) {
            if (selType === SelectionType.Rem && sel && 'remIds' in sel && sel.remIds.includes(currentIncRemId)) {
              isTargetingQueueContext = true;
            } else if (selType === SelectionType.Text && sel && 'remId' in sel && sel.remId === currentIncRemId) {
              isTargetingQueueContext = true;
            }
          }
        }

        if (isTargetingQueueContext) {
          if (card) {
            remId = card.remId;
            cardId = card._id;
          } else {
            remId = await plugin.storage.getSession<string>(currentIncRemKey) || undefined;
          }
        } else {
          // Explicitly focused on another editor element (like in Preview)
          if (selType === SelectionType.Rem && sel && 'remIds' in sel) {
            remId = (sel as any).remIds[0];
          } else if (selType === SelectionType.Text && sel && 'remId' in sel) {
            remId = (sel as any).remId;
          }
        }
      } else {
        // If not in the queue, get the focused Rem from the editor
        const focusedRem = await plugin.focus.getFocusedRem();
        remId = focusedRem?._id;
      }

      if (!remId) {
        await plugin.app.toast('Could not find a Rem.');
        return;
      }

      const rem = await plugin.rem.findOne(remId);
      if (!rem) {
        await plugin.app.toast('Could not find the Rem.');
        return;
      }

      const hasIncrementalPowerup = await rem.hasPowerup(powerupCode);
      const hasDismissedPowerup = await rem.hasPowerup(dismissedPowerupCode);

      // If we are in the queue reviewing a regular flashcard (not an Incremental Rem)
      if (isQueue && !hasIncrementalPowerup) {
        await plugin.widget.openPopup('flashcard_repetition_history', {
          remId: remId,
          cardId: cardId,
        });
        return;
      }

      if (hasIncrementalPowerup || hasDismissedPowerup) {
        // If it is directly an incremental/dismissed rem, open the single history widget
        await plugin.widget.openPopup('repetition_history', {
          remId: remId,
        });
        return;
      }

      // If not directly incremental, check if it has any incremental descendants
      // We'll use a quick check on getDescendants. This might be heavy for huge trees, 
      // but necessary to know if we should show the aggregated view.
      // Optimization: We could check just one? `getDescendants` returns all.
      const descendants = await rem.getDescendants();
      const hasRelevantDescendant = await Promise.race([
        (async () => {
          for (const d of descendants) {
            if (await d.hasPowerup(powerupCode)) return true;
            if (await d.hasPowerup(dismissedPowerupCode)) return true;
          }
          return false;
        })()
      ]);

      if (hasRelevantDescendant) {
        // If it has relevant descendants, default to aggregated view
        await plugin.widget.openPopup('aggregated_repetition_history', {
          remId: remId,
        });
        return;
      }

      await plugin.app.toast('This Rem has no repetition history (not Incremental/Dismissed and no such descendants).');
    },
  });

  // Open Sorting Criteria Widget Command
  plugin.app.registerCommand({
    id: 'open-sorting-criteria',
    name: 'Open Sorting Criteria',
    description: 'Open the Sorting Criteria widget to adjust randomness and cards per rem.',
    quickCode: 'sort',
    action: async () => {
      await plugin.widget.openPopup('sorting_criteria');
    },
  });

  // Open Priority Shield Graph Command
  plugin.app.registerCommand({
    id: 'open-priority-shield',
    name: 'Open Priority Shield Graph',
    description: 'Open the Priority Shield Graph history.',
    quickCode: 'shi',
    action: async () => {
      let subQueueId: string | null = null;
      const url = await plugin.window.getURL();

      // Check if we are in the queue to get context
      if (url.includes('/flashcards')) {
        subQueueId = (await plugin.storage.getSession<string | null>(currentSubQueueIdKey)) ?? null;
      } else {
        // In editor, use focused rem
        const focusedRem = await plugin.focus.getFocusedRem();
        subQueueId = focusedRem?._id || null;
      }

      await plugin.widget.openPopup('priority_shield_graph', {
        subQueueId,
      });
    },
  });

  // Dismiss Incremental Rem command (Ctrl+D)
  // In Queue: replicates the Dismiss button (card priority inheritance, review time, transfer to dismissed, remove powerup)
  // In Editor: dismisses the focused Incremental Rem (transfer history to dismissed, remove powerup)
  plugin.app.registerCommand({
    id: dismissIncRemCommandId,
    name: 'Dismiss Incremental Rem',
    keyboardShortcut: 'ctrl+d',
    quickCode: 'dis',
    action: async () => {
      const url = await plugin.window.getURL();
      const isQueue = url && url.includes('/flashcards');

      let rem;
      let incRemInfo;

      if (isQueue) {
        // Queue context: check for explicit selection first
        const card = await plugin.queue.getCurrentCard();
        const sel = await plugin.editor.getSelection();
        const selType = sel?.type;

        let isTargetingQueueContext = false;

        if (!selType) {
          isTargetingQueueContext = true;
        } else if (card) {
          if (selType === SelectionType.Rem && sel && 'remIds' in sel && sel.remIds.includes(card.remId)) {
            isTargetingQueueContext = true;
          } else if (selType === SelectionType.Text && sel && 'remId' in sel && sel.remId === card.remId) {
            isTargetingQueueContext = true;
          }
        } else {
          const currentIncRemId = await plugin.storage.getSession<string>(currentIncRemKey);
          if (currentIncRemId) {
            if (selType === SelectionType.Rem && sel && 'remIds' in sel && sel.remIds.includes(currentIncRemId)) {
              isTargetingQueueContext = true;
            } else if (selType === SelectionType.Text && sel && 'remId' in sel && sel.remId === currentIncRemId) {
              isTargetingQueueContext = true;
            }
          }
        }

        let remId: string | undefined;

        if (isTargetingQueueContext) {
          if (card) {
            remId = card.remId;
          } else {
            remId = (await plugin.storage.getSession<string>(currentIncRemKey)) || undefined;
          }
        } else {
          if (selType === SelectionType.Rem && sel && 'remIds' in sel) {
            remId = (sel as any).remIds[0];
          } else if (selType === SelectionType.Text && sel && 'remId' in sel) {
            remId = (sel as any).remId;
          }
        }

        if (!remId) {
          await plugin.app.toast('No Incremental Rem currently active in the queue or selected.');
          return;
        }

        rem = await plugin.rem.findOne(remId);
        if (!rem) {
          await plugin.app.toast('Could not find the Rem.');
          return;
        }

        const hasIncPowerup = await rem.hasPowerup(powerupCode);
        if (!hasIncPowerup) {
          await plugin.app.toast('This command only works with Incremental Rems, not regular flashcards.');
          return;
        }

        incRemInfo = await getIncrementalRemFromRem(plugin, rem);
        if (!incRemInfo) {
          await plugin.app.toast('Could not retrieve Incremental Rem information.');
          return;
        }

        // Replicate the Dismiss button logic from answer_buttons.tsx
        // 1. Handle card priority inheritance
        await handleCardPriorityInheritance(plugin, rem, incRemInfo);

        // 2. Calculate review time
        const startTime = await plugin.storage.getSession<number>(incremReviewStartTimeKey);
        const reviewTimeSeconds = startTime ? dayjs().diff(dayjs(startTime), 'second') : 0;

        // 3. Build the current rep history entry
        const currentRep: IncrementalRep = {
          date: Date.now(),
          scheduled: incRemInfo.nextRepDate,
          reviewTimeSeconds: reviewTimeSeconds,
          eventType: 'rep',
          priority: incRemInfo.priority,
        };

        const updatedHistory = [...(incRemInfo.history || []), currentRep];

        // 4. Transfer history to dismissed powerup
        await transferToDismissed(plugin, rem, updatedHistory);

        // 5. Remove from session cache
        await removeIncrementalRemCache(plugin, rem._id);

        // 6. Remove incremental powerup AND conditionally advance queue simultaneously.
        // removePowerup destroys the widget sandbox on the next microtask,
        // so both IPC messages must be sent in the same tick if targeting queue.
        if (isTargetingQueueContext) {
          await Promise.allSettled([
            rem.removePowerup(powerupCode),
            plugin.queue.removeCurrentCardFromQueue(true),
          ]);
        } else {
          await rem.removePowerup(powerupCode);
        }

      } else {
        // Editor context: dismiss focused Incremental Rem(s)
        // Supports both single-focus and multi-select
        const selection = await plugin.editor.getSelection();
        const remsToDissmiss: PluginRem[] = [];

        if (selection?.type === SelectionType.Rem) {
          // Multi-select: gather all selected rems
          const selectedRems = (await plugin.rem.findMany(selection.remIds)) || [];
          for (const r of selectedRems) {
            if (await r.hasPowerup(powerupCode)) {
              remsToDissmiss.push(r);
            }
          }
        } else {
          // Single focus fallback
          const focusedRem = await plugin.focus.getFocusedRem();
          if (!focusedRem) {
            await plugin.app.toast('No Rem focused.');
            return;
          }
          const hasIncPowerup = await focusedRem.hasPowerup(powerupCode);
          if (!hasIncPowerup) {
            await plugin.app.toast('This Rem is not an Incremental Rem.');
            return;
          }
          remsToDissmiss.push(focusedRem);
        }

        if (remsToDissmiss.length === 0) {
          await plugin.app.toast('No Incremental Rems found in the selection.');
          return;
        }

        for (const r of remsToDissmiss) {
          incRemInfo = await getIncrementalRemFromRem(plugin, r);
          if (incRemInfo) {
            // Transfer existing history to dismissed (no new rep entry needed)
            await transferToDismissed(plugin, r, incRemInfo.history || []);
          }
          // Remove from session cache
          await removeIncrementalRemCache(plugin, r._id);
          // Remove incremental powerup
          await r.removePowerup(powerupCode);
        }

        const count = remsToDissmiss.length;
        await plugin.app.toast(
          count === 1
            ? 'Incremental Rem dismissed.'
            : `${count} Incremental Rems dismissed.`
        );
      }
    },
  });

  // Next item in the queue command (Ctrl+Right Arrow)
  // Only works in the queue with an Incremental Rem active.
  // Replicates the Next button logic: PDF page history + handleNextRepetitionClick.
  plugin.app.registerCommand({
    id: nextInQueueCommandId,
    name: 'Next Item in Queue',
    keyboardShortcut: 'cmd+right',
    quickCode: 'next',
    action: async () => {
      const url = await plugin.window.getURL();

      if (!url || !url.includes('/flashcards')) {
        await plugin.app.toast('This command only works in the queue.');
        return;
      }

      // Get current incremental rem
      const currentQueueItem = await plugin.queue.getCurrentCard();
      let remId = currentQueueItem?.remId;

      if (!remId) {
        remId = (await plugin.storage.getSession<string>(currentIncRemKey)) || undefined;
      }

      if (!remId) {
        await plugin.app.toast('No Incremental Rem currently active in the queue.');
        return;
      }

      const rem = await plugin.rem.findOne(remId);
      if (!rem) {
        await plugin.app.toast('Could not find the Rem.');
        return;
      }

      const hasIncPowerup = await rem.hasPowerup(powerupCode);
      if (!hasIncPowerup) {
        await plugin.app.toast('This command only works with Incremental Rems, not regular flashcards.');
        return;
      }

      const incRemInfo = await getIncrementalRemFromRem(plugin, rem);
      if (!incRemInfo) {
        await plugin.app.toast('Could not retrieve Incremental Rem information.');
        return;
      }

      // Handle PDF page history (same as handleNextClick in answer_buttons.tsx)
      const remType = await plugin.storage.getSession<string | null>(currentIncrementalRemTypeKey);
      if (remType === 'pdf') {
        const pdfRem = await findPDFinRem(plugin, rem);
        if (pdfRem) {
          const pageKey = getCurrentPageKey(rem._id, pdfRem._id);
          const currentPage = await plugin.storage.getSynced<number>(pageKey);
          if (currentPage) {
            await addPageToHistory(plugin, rem._id, pdfRem._id, currentPage);
          }
        }
      }

      // Advance the queue (updates SRS data + removes current card)
      await handleNextRepetitionClick(plugin, incRemInfo);
    },
  });

  // ─── Copy / Paste Rem Sources ────────────────────────────────────────────
  // Designed for the PDF-split workflow: give multiple IncRems the same PDF
  // source so the page-range widget can assign each rem a different page range.
  //
  //   1. Focus the "template" rem (the one whose sources you want to replicate).
  //   2. Run "Copy Rem Sources" → source IDs are saved to session storage.
  //   3. Select one or more target rems.
  //   4. Run "Paste Rem Sources" → every selected rem receives all copied sources
  //      (already-present sources are silently skipped to keep it idempotent).

  const COPIED_SOURCES_KEY = 'copiedRemSourceIds';

  plugin.app.registerCommand({
    id: 'copy-rem-sources',
    name: 'Copy Rem Sources',
    description: 'Copies the sources of the focused Rem to the clipboard (session storage) for pasting onto other Rems.',
    keyboardShortcut: 'ctrl+shift+F1',
    quickCode: 'copy',
    action: async () => {
      const rem = await plugin.focus.getFocusedRem();
      if (!rem) {
        await plugin.app.toast('No Rem focused.');
        return;
      }

      const sources = await rem.getSources();
      if (!sources || sources.length === 0) {
        await plugin.app.toast('This Rem has no sources to copy.');
        return;
      }

      const sourceIds = sources.map(s => s._id);
      await plugin.storage.setSession(COPIED_SOURCES_KEY, sourceIds);

      // Register the focused rem in the known_pdf_rems_ index for each PDF source,
      // so the template rem itself is discoverable by the PDF Control Panel.
      for (const source of sources) {
        const isPdf = await source.hasPowerup(BuiltInPowerupCodes.UploadedFile);
        if (isPdf) {
          await registerRemsAsPdfKnown(plugin, source._id, [rem._id]);
        }
      }

      await plugin.app.toast(
        sources.length === 1
          ? '📋 1 source copied. Select target Rems and run "Paste Rem Sources".'
          : `📋 ${sources.length} sources copied. Select target Rems and run "Paste Rem Sources".`
      );
    },
  });

  plugin.app.registerCommand({
    id: 'paste-rem-sources',
    name: 'Paste Rem Sources',
    description: 'Adds the previously copied sources to all selected Rems (or the focused Rem). Skips sources already present.',
    keyboardShortcut: 'opt+shift+v',
    quickCode: 'paste',
    action: async () => {
      const copiedIds = await plugin.storage.getSession<string[]>(COPIED_SOURCES_KEY);
      if (!copiedIds || copiedIds.length === 0) {
        await plugin.app.toast('No sources copied yet. Run "Copy Rem Sources" first.');
        return;
      }

      // Resolve the copied source RemObjects once (shared across all targets)
      const copiedSources = (await plugin.rem.findMany(copiedIds)) || [];
      if (copiedSources.length === 0) {
        await plugin.app.toast('Could not resolve the copied sources. They may have been deleted.');
        return;
      }

      // Determine target rems: multi-select → all selected; otherwise → focused rem
      const selection = await plugin.editor.getSelection();
      let targetRems: PluginRem[] = [];

      if (selection?.type === SelectionType.Rem && selection.remIds.length > 0) {
        targetRems = (await plugin.rem.findMany(selection.remIds)) || [];
      } else {
        const focused = await plugin.focus.getFocusedRem();
        if (!focused) {
          await plugin.app.toast('No Rem focused or selected.');
          return;
        }
        targetRems = [focused];
      }

      if (targetRems.length === 0) {
        await plugin.app.toast('Could not resolve target Rems.');
        return;
      }

      let totalAdded = 0;
      let totalSkipped = 0;

      for (const target of targetRems) {
        const existingSources = await target.getSources();
        const existingIds = new Set(existingSources.map(s => s._id));

        for (const source of copiedSources) {
          if (existingIds.has(source._id)) {
            totalSkipped++;
            continue;
          }
          await target.addSource(source);
          totalAdded++;

          // If the added source is a PDF, register this target rem in the
          // known_pdf_rems_ synced index so it appears in the PDF Control Panel
          // without needing a full incremental-rem-cache scan first.
          const isPdf = await source.hasPowerup(BuiltInPowerupCodes.UploadedFile);
          if (isPdf) {
            await registerRemsAsPdfKnown(plugin, source._id, [target._id]);
          }
        }
      }

      const remLabel = targetRems.length === 1 ? '1 Rem' : `${targetRems.length} Rems`;
      if (totalAdded === 0) {
        await plugin.app.toast(`✅ All sources already present on ${remLabel}.`);
      } else {
        const skippedNote = totalSkipped > 0 ? ` (${totalSkipped} already present, skipped)` : '';
        await plugin.app.toast(`✅ Added ${totalAdded} source(s) to ${remLabel}${skippedNote}.`);
      }
    },
  });

  plugin.app.registerCommand({
    id: 'text-case-converter',
    name: 'Text Case Converter',
    keyboardShortcut: 'shift+F3',
    quickCode: 'case',
    action: async () => {
      const selection = await plugin.editor.getSelectedText();
      if (!selection?.richText?.length) {
        await plugin.app.toast('No text selected.');
        return;
      }

      const fullText = selection.richText
        .map((e: any) => (typeof e === 'string' ? e : e?.text ?? ''))
        .join('');

      const current = detectCase(fullText);
      const next = nextCase(current);

      const transformed =
        next === 'title'
          ? transformTitleCase(selection.richText, fullText)
          : transformCase(
            selection.richText,
            next === 'upper' ? (s) => s.toUpperCase() : (s) => s.toLowerCase()
          );

      await plugin.editor.delete();
      await plugin.editor.insertRichText(transformed);
      await plugin.editor.selectText({
        start: selection.range.start,
        end: selection.range.start + fullText.length,
      });
    },
  });

  const skipMasteryDrill = Boolean(
    await plugin.settings.getSetting('skip_mastery_drill')
  );
  if (!skipMasteryDrill) {
    plugin.app.registerCommand({
      id: 'open_mastery_drill',
      name: 'Mastery Drill: deliberately practice poorly rated cards',
      quickCode: 'dri',
      action: async () => {
        await plugin.widget.openPopup('mastery_drill');
      },
    });

    plugin.app.registerCommand({
      id: 'debug_audit_mastery_drill',
      name: 'Debug: Audit Mastery Drill Inconsistencies',
      action: async () => {
        type DrillItem = string | { cardId: string; kbId?: string; addedAt?: number };
        const allDrillIds = ((await plugin.storage.getSynced('finalDrillIds')) as DrillItem[]) || [];

        const currentKb = await plugin.kb.getCurrentKnowledgeBaseData();
        const isPrimary = await plugin.kb.isPrimaryKnowledgeBase();
        const currentKbId = currentKb?._id;

        const finalDrillIds = allDrillIds.filter(item =>
          typeof item === 'string' ? isPrimary : item.kbId === currentKbId
        );
        const skippedOtherKb = allDrillIds.length - finalDrillIds.length;

        if (finalDrillIds.length === 0) {
          await plugin.app.toast(
            skippedOtherKb > 0
              ? `No drill items for this KB (${skippedOtherKb} belong to other KBs).`
              : 'Mastery Drill queue is empty.'
          );
          return;
        }

        const scoreName = (score: number): string => {
          const map: Record<number, string> = {
            0: 'AGAIN',
            0.01: 'TOO_EARLY',
            0.5: 'HARD',
            1: 'GOOD',
            1.5: 'EASY',
            2: 'VIEWED_AS_LEECH',
            3: 'RESET',
            4: 'MANUAL_DATE',
            5: 'MANUAL_EASE',
          };
          return map[score] ?? `UNKNOWN(${score})`;
        };

        const inconsistencies: string[] = [];
        let inconsistencyCount = 0;

        for (const item of finalDrillIds) {
          const cardId = typeof item === 'string' ? item : item.cardId;
          const addedAt = typeof item === 'object' && item.addedAt
            ? new Date(item.addedAt).toISOString()
            : 'unknown';

          const card = await plugin.card.findOne(cardId);
          if (!card) {
            inconsistencies.push(`[MISSING_CARD] cardId=${cardId} addedAt=${addedAt}`);
            inconsistencyCount++;
            continue;
          }

          const history = card.repetitionHistory ?? [];
          const meaningful = history.filter(r => r.score !== QueueInteractionScore.TOO_EARLY);

          if (meaningful.length === 0) {
            inconsistencies.push(
              `[NO_HISTORY] cardId=${cardId} remId=${card.remId} — ${history.length === 0 ? 'no reps at all' : 'only TOO_EARLY reps'} (addedAt=${addedAt})`
            );
            inconsistencyCount++;
            continue;
          }

          const last = meaningful[meaningful.length - 1];
          const isExpected =
            last.score === QueueInteractionScore.AGAIN ||
            last.score === QueueInteractionScore.HARD;

          if (!isExpected) {
            const cramFlag = last.isCram ? ' [CRAM]' : '';
            const everHard = meaningful.some(r => r.score === QueueInteractionScore.HARD);
            const everAgain = meaningful.some(r => r.score === QueueInteractionScore.AGAIN);
            const poorRatings = [everAgain ? 'AGAIN' : null, everHard ? 'HARD' : null].filter(Boolean).join('/');
            const everPoorFlag = poorRatings ? ` everPoor=${poorRatings}` : ' everPoor=NEVER';
            inconsistencies.push(
              `[UNEXPECTED_SCORE] cardId=${cardId} remId=${card.remId} — last=${scoreName(last.score)}${cramFlag} ratedAt=${new Date(last.date).toISOString()} addedAt=${addedAt}${everPoorFlag}`
            );
            inconsistencyCount++;
            history.forEach((rep, i) => {
              const cram = rep.isCram ? ' [CRAM]' : '';
              const scheduled = rep.scheduled ? ` scheduled=${new Date(rep.scheduled).toISOString()}` : '';
              inconsistencies.push(
                `      [${i + 1}/${history.length}] ${new Date(rep.date).toISOString()} ${scoreName(rep.score)}${cram}${scheduled}`
              );
            });
          }
        }

        const scopeLabel = `KB=${isPrimary ? 'primary' : currentKbId} (${skippedOtherKb} items skipped from other KBs)`;
        if (inconsistencyCount === 0) {
          console.log(`[MasteryDrillAudit] ${scopeLabel} — all ${finalDrillIds.length} cards OK (last rating is AGAIN or HARD).`);
          await plugin.app.toast(`All ${finalDrillIds.length} drill cards OK.`);
        } else {
          console.log(`[MasteryDrillAudit] ${scopeLabel} — ${inconsistencyCount} inconsistencies out of ${finalDrillIds.length} cards:`);
          for (const msg of inconsistencies) {
            console.log('  ' + msg);
          }
          await plugin.app.toast(`Found ${inconsistencyCount} inconsistent drill cards — check console.`);
        }
      },
    });

    plugin.app.registerCommand({
      id: 'cleanup_mastery_drill',
      name: 'Mastery Drill: Remove cards whose last rating was Good or Easy',
      action: async () => {
        type DrillItem = string | { cardId: string; kbId?: string; addedAt?: number };
        const allDrillIds = ((await plugin.storage.getSynced('finalDrillIds')) as DrillItem[]) || [];

        const currentKb = await plugin.kb.getCurrentKnowledgeBaseData();
        const isPrimary = await plugin.kb.isPrimaryKnowledgeBase();
        const currentKbId = currentKb?._id;
        const getCardId = (item: DrillItem) => typeof item === 'string' ? item : item.cardId;
        const isInCurrentKb = (item: DrillItem) =>
          typeof item === 'string' ? isPrimary : item.kbId === currentKbId;

        const toRemoveIds = new Set<string>();
        let missingCount = 0;
        let noHistoryCount = 0;

        for (const item of allDrillIds) {
          if (!isInCurrentKb(item)) continue;
          const cardId = getCardId(item);
          const card = await plugin.card.findOne(cardId);
          if (!card) {
            toRemoveIds.add(cardId);
            missingCount++;
            continue;
          }
          const history = card.repetitionHistory ?? [];
          const meaningful = history.filter(r => r.score !== QueueInteractionScore.TOO_EARLY);
          if (meaningful.length === 0) {
            toRemoveIds.add(cardId);
            noHistoryCount++;
            continue;
          }
          const last = meaningful[meaningful.length - 1];
          const isExpected =
            last.score === QueueInteractionScore.AGAIN ||
            last.score === QueueInteractionScore.HARD;
          if (!isExpected) {
            toRemoveIds.add(cardId);
          }
        }

        if (toRemoveIds.size === 0) {
          await plugin.app.toast('No cards to remove — the drill is already clean for this KB.');
          return;
        }

        const kept = allDrillIds.filter(item => {
          if (!isInCurrentKb(item)) return true;
          return !toRemoveIds.has(getCardId(item));
        });
        await plugin.storage.setSynced('finalDrillIds', kept);

        const unexpectedCount = toRemoveIds.size - missingCount - noHistoryCount;
        console.log(
          `[MasteryDrillCleanup] Removed ${toRemoveIds.size} cards from current KB ` +
          `(missing=${missingCount}, noHistory=${noHistoryCount}, lastRatingWasGoodOrEasy=${unexpectedCount}). ` +
          `${kept.length} items remain in finalDrillIds (across all KBs).`
        );
        await plugin.app.toast(`Removed ${toRemoveIds.size} cards from drill.`);
      },
    });
  }

  plugin.app.registerCommand({
    id: 'debug_clear_flashcard_history',
    name: 'Debug: Clear Flashcard History (Fix Sync Error)',
    action: async () => {
      await plugin.storage.setSynced('flashcardHistoryData', []);
      await plugin.app.toast('Flashcard History cleared!');
    },
  });

}
