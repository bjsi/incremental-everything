import {
  renderWidget,
  usePlugin,
  useTracker,
  WidgetLocation,
  RNPlugin,
  Rem,
} from '@remnote/plugin-sdk';
import React from 'react';
import { NextRepTime } from '../components/NextRepTime';
import {
  allIncrementalRemKey,
  powerupCode,
  activeHighlightIdKey,
  currentIncrementalRemTypeKey,
  currentScopeRemIdsKey,
  displayPriorityShieldId,
  seenRemInSessionKey,
} from '../lib/consts';
import { getIncrementalRemInfo, handleHextRepetitionClick, reviewRem } from '../lib/incremental_rem';
import { calculateRelativePriority } from '../lib/priority';
import { IncrementalRem } from '../lib/types';
import { percentileToHslColor } from '../lib/color';
import { calculatePriorityShield } from '../lib/priority_shield';

// ... (handleReviewAndOpenRem, Button component are unchanged)
const handleReviewAndOpenRem = async (plugin: RNPlugin, rem: Rem | undefined) => {
  if (!rem) return;
  const incRemInfo = await getIncrementalRemInfo(plugin, rem);
  await reviewRem(plugin, incRemInfo);
  await plugin.window.openRem(rem);
};
interface ButtonProps {
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
}
function Button(props: ButtonProps) {
  return (
    <button
      className={
        'bg-blue-50 hover:bg-blue-70 text-white font-bold py-1 px-2 rounded ' + props.className
      }
      style={{
        height: '45px',
      }}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}


export function AnswerButtons() {
  const plugin = usePlugin();
  const ctx = useTracker(
    async (rp) => await rp.widget.getWidgetContext<WidgetLocation.FlashcardAnswerButtons>(),
    []
  );

  const rem = useTracker(
    (rp) => rp.rem.findOne(ctx?.remId),
    [ctx?.remId]
  );

  const incRem = useTracker(
    async () => rem ? await getIncrementalRemInfo(plugin, rem) : undefined,
    [rem]
  );

  const allIncrementalRems = useTracker(
    (rp) => rp.storage.getSession<IncrementalRem[]>(allIncrementalRemKey),
    []
  );
  const currentScopeRemIds = useTracker(
    (rp) => rp.storage.getSession<string[] | null>(currentScopeRemIdsKey),
    []
  );

  const shouldDisplayShield = useTracker(
    (rp) => rp.settings.getSetting<boolean>(displayPriorityShieldId),
    []
  );

  const shieldStatus = useTracker(
    async (rp) => {
      await rp.storage.getSession(allIncrementalRemKey);
      await rp.storage.getSession(seenRemInSessionKey);
      await rp.storage.getSession(currentScopeRemIdsKey);
      return await calculatePriorityShield(plugin);
    },
    [plugin]
  );

  let kbPercentile: number | null = null;
  let docPercentile: number | null = null;
  let relativePriorityLabel = `${incRem?.priority || '...'}`;

  if (incRem && allIncrementalRems) {
    kbPercentile = calculateRelativePriority(allIncrementalRems, incRem.remId);

    if (currentScopeRemIds && currentScopeRemIds.length > 0) {
      const scopedRems = allIncrementalRems.filter(r => currentScopeRemIds.includes(r.remId));
      docPercentile = calculateRelativePriority(scopedRems, incRem.remId);
    }

    const parts = [];
    if (kbPercentile !== null) {
      parts.push(`${kbPercentile}% of KB`);
    }
    if (docPercentile !== null) {
      parts.push(`${docPercentile}% of Doc`);
    }

    if (parts.length > 0) {
      relativePriorityLabel = `${incRem.priority} (${parts.join('; ')})`;
    } else {
      relativePriorityLabel = `${incRem.priority}`;
    }
  }

  const priorityColor = kbPercentile ? percentileToHslColor(kbPercentile) : 'transparent';

  const activeHighlightId = useTracker(
    (rp) => rp.storage.getSession<string | null>(activeHighlightIdKey),
    []
  );

  const remType = useTracker(
    (rp) => rp.storage.getSession<string | null>(currentIncrementalRemTypeKey),
    []
  );

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: '1rem',
    flexWrap: 'wrap',
    marginBottom: '0.5rem',
  };

  return (
    <div style={containerStyle} className="incremental-everything-answer-buttons">
      {/* --- All the existing buttons are unchanged --- */}
      <Button
        className="incremental-everthing-next-button"
        onClick={() => handleHextRepetitionClick(plugin, incRem)}
      >
        <div className="flex flex-col items-center justify-center">
          <div>Next</div>
          <div className="text-xs">{incRem && <NextRepTime rem={incRem} />}</div>
        </div>
      </Button>
      <Button
        className="bg-gray-500 hover:bg-gray-700"
        onClick={async () => { if (ctx?.remId) await plugin.widget.openPopup('reschedule', { remId: ctx.remId }); }}
      >
        <div className="flex flex-col items-center justify-center">
          <div>Reschedule</div>
          <div className="text-xs">Set interval</div>
        </div>
      </Button>
      <Button
        className="incremental-everthing-done-button"
        onClick={async () => {
          if (!rem) { return; }
          const updatedAllRem = ((await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || []).filter((r) => r.remId !== rem._id);
          await plugin.storage.setSession(allIncrementalRemKey, updatedAllRem);
          await plugin.queue.removeCurrentCardFromQueue(true);
          await rem.removePowerup(powerupCode);
        }}
      >
        <div className="flex flex-col items-center justify-center">
          <div>Done</div>
          <div className="text-xs">Untag Rem</div>
        </div>
      </Button>
      <Button
        className="bg-gray-500 hover:bg-gray-700"
        onClick={async () => { if (ctx?.remId) await plugin.widget.openPopup('priority', { remId: ctx.remId }); }}
      >
          <div className="flex flex-col items-center justify-center">
            <div>Change Priority</div>
            <div
              className="text-xs"
              style={{
                backgroundColor: priorityColor,
              }}
              >
              {relativePriorityLabel}
            </div>
          </div>
      </Button>
      <Button
        className="bg-gray-500 hover:bg-gray-700"
        onClick={() => handleReviewAndOpenRem(plugin, rem)}
      >
        <div className="flex flex-col items-center justify-center">
          <div>Review & Open</div>
          <div className="text-xs">Go to Editor</div>
        </div>
      </Button>
      {activeHighlightId && (
        <Button
          className="incremental-everything-scroll-button"
          onClick={async () => {
            const highlightRem = await plugin.rem.findOne(activeHighlightId);
            await highlightRem?.scrollToReaderHighlight();
          }}
        >
          <div className="flex flex-col items-center justify-center">
            <div>Scroll to</div>
            <div className="text-xs">Highlight</div>
          </div>
        </Button>
      )}
      {['rem', 'pdf', 'pdf-highlight'].includes(remType || '') && (
        <button
          className="bg-gray-600 text-gray-100 font-bold py-2 px-2 rounded desktop-only-hint"
          style={{ height: '45px', cursor: 'default' }}
        >
          <div className="flex flex-col items-center justify-center">
            <div>Press 'P' to</div>
            <div className="text-xs">Edit in Previewer</div>
          </div>
        </button>
      )}

      {/* vvv CHANGED: THE DISPLAY LOGIC IS NOW UPDATED FOR THE NEW FORMAT vvv */}
      {shouldDisplayShield && shieldStatus && (
        <div
          className="text-sm rn-clr-content-secondary whitespace-nowrap w-full text-center"
          style={{ marginTop: '0.5rem' }}
        >
          {'🛡️ Priority Shield'}
          {shieldStatus.kb.absolute !== null ? (
            `   --   of KB: ${shieldStatus.kb.absolute} (${shieldStatus.kb.percentile}%)`
          ) : (
            `   --   KB: 100%`
          )}
          {shieldStatus.doc.absolute !== null ? (
            `   --   of this Document: ${shieldStatus.doc.absolute} (${shieldStatus.doc.percentile}%)`
          ) : (
            // Only show Doc status if there's a document scope active.
            currentScopeRemIds && '   --   Doc: 100%'
          )}
        </div>
      )}
      {/* ^^^ CHANGED ^^^ */}
    </div>
  );
}

renderWidget(AnswerButtons);