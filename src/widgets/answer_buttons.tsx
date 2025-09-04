import {
  renderWidget,
  usePlugin,
  useTracker,
  WidgetLocation,
  RNPlugin,
  Rem, // Import the Rem type
} from '@remnote/plugin-sdk';
import React from 'react';
import { NextRepTime } from '../components/NextRepTime';
import { 
  allIncrementalRemKey, 
  powerupCode, 
  activeHighlightIdKey, 
  currentIncrementalRemTypeKey,
  currentScopeRemIdsKey,
} from '../lib/consts';
import { getIncrementalRemInfo, handleHextRepetitionClick, reviewRem } from '../lib/incremental_rem';
import { calculateRelativePriority } from '../lib/priority';
import { IncrementalRem } from '../lib/types';
import { percentileToHslColor } from '../lib/color';

// vvv THIS FUNCTION IS NOW UPDATED vvv
const handleReviewAndOpenRem = async (plugin: RNPlugin, rem: Rem | undefined) => {
  if (!rem) return;
  // We no longer need the 'incRem' object here, just the original Rem.
  // First, get the incremental info to pass to the review function.
  const incRemInfo = await getIncrementalRemInfo(plugin, rem);

  // Step 1: Perform the repetition ONLY, without advancing the queue.
  await reviewRem(plugin, incRemInfo);
  // Step 2: Open the Rem in the main editor by passing the full Rem object.
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
        height: '45px', // Adjusted height
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

  // vvv THIS IS NOW SIMPLIFIED vvv
  // We get the full Rem object here and use it everywhere.
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
    gap: '1rem', // Slightly reduced gap for mobile
    flexWrap: 'wrap', // <-- Allows buttons to wrap to the next line
    marginBottom: '0.5rem', // Adds space below the button rows
  };

  return (
    <div style={containerStyle} className="incremental-everything-answer-buttons">
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
        // vvv PASSING THE FULL REM OBJECT NOW vvv
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
    </div>
  );
}

renderWidget(AnswerButtons);