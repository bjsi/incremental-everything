import {
  renderWidget,
  usePlugin,
  useTracker,
  WidgetLocation,
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
import { getIncrementalRemInfo, handleHextRepetitionClick } from '../lib/incremental_rem';
import { calculateRelativePriority } from '../lib/priority';
import { IncrementalRem } from '../lib/types';

interface ButtonProps {
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
}

function Button(props: ButtonProps) {
  return (
    <button
      className={
        'bg-blue-50 hover:bg-blue-70 text-white font-bold py-2 px-4 rounded ' + props.className
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
  
  const incRem = useTracker(
    async (rp) => {
      const rem = await rp.rem.findOne(ctx?.remId);
      return rem ? await getIncrementalRemInfo(plugin, rem) : undefined;
    },
    [ctx?.remId]
  );

    // --- NEW: Fetch all data needed for calculations ---
  const allIncrementalRems = useTracker(
    (rp) => rp.storage.getSession<IncrementalRem[]>(allIncrementalRemKey),
    []
  );
  const currentScopeRemIds = useTracker(
    (rp) => rp.storage.getSession<string[] | null>(currentScopeRemIdsKey),
    []
  );

  // --- NEW: Calculate percentiles and build the label ---
  let relativePriorityLabel = `Current: ${incRem?.priority || '...'}`;
  if (incRem && allIncrementalRems) {
    const kbPercentile = calculateRelativePriority(allIncrementalRems, incRem.remId);
    let docPercentile: number | null = null;
    
    if (currentScopeRemIds && currentScopeRemIds.length > 0) {
      const scopedRems = allIncrementalRems.filter(rem => currentScopeRemIds.includes(rem.remId));
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
      relativePriorityLabel = `Current: ${incRem.priority} (${parts.join('; ')})`;
    }
  }


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
    gap: '1.5rem',
  };

  return (
    <div style={containerStyle} className="incremental-everything-answer-buttons">
      <Button
        className="incremental-everthing-next-button"
        onClick={async () => {
          handleHextRepetitionClick(plugin, incRem);
        }}
      >
        <div className="flex flex-col items-center justify-center">
          <div>Next</div>
          <div className="text-xs">{incRem && <NextRepTime rem={incRem} />}</div>
        </div>
      </Button>

      {/* --- NEW "RESCHEDULE" BUTTON --- */}
      <Button
        className="bg-gray-500 hover:bg-gray-700"
        onClick={async () => {
          if (ctx?.remId) {
            await plugin.widget.openPopup('reschedule', {
              remId: ctx.remId,
            });
          }
        }}
      >
        <div className="flex flex-col items-center justify-center">
          <div>Reschedule</div>
          <div className="text-xs">Set custom interval</div>
        </div>
      </Button>
      
      <Button
        className="incremental-everthing-done-button"
        onClick={async () => {
          const rem = await plugin.rem.findOne(incRem?.remId);
          if (!rem) {
            return;
          }
          const updatedAllRem: IncrementalRem[] = (
            ((await plugin.storage.getSession(allIncrementalRemKey)) || []) as IncrementalRem[]
          ).filter((r) => r.remId !== rem._id);
          await plugin.storage.setSession(allIncrementalRemKey, updatedAllRem);
          await plugin.queue.removeCurrentCardFromQueue(true);
          await rem.removePowerup(powerupCode);
        }}
      >
        <div className="flex flex-col items-center justify-center">
          <div>Done</div>
          <div className="text-xs">Untag this Rem</div>
        </div>
      </Button>

      <Button
        className="bg-gray-500 hover:bg-gray-700"
        onClick={async () => {
          if (ctx?.remId) {
            await plugin.widget.openPopup('priority', {
              remId: ctx.remId,
            });
          }
        }}
      >
        <div className="flex flex-col items-center justify-center">
          <div>Change Priority</div>
          <div className="text-xs">
            {relativePriorityLabel}
          </div>
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
          className="bg-gray-600 text-gray-100 font-bold py-2 px-4 rounded"
          style={{ 
            height: '45px', 
            cursor: 'default',
          }}
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