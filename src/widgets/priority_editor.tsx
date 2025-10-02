import {
  renderWidget,
  usePlugin,
  useRunAsync,
  useTrackerPlugin,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import { useState } from 'react';
import { getIncrementalRemInfo } from '../lib/incremental_rem';
import { getCardPriority, setCardPriority } from '../lib/cardPriority';
import { allIncrementalRemKey, powerupCode, prioritySlotCode } from '../lib/consts';  // Added imports
import { IncrementalRem } from '../lib/types';

export function PriorityEditor() {
  const plugin = usePlugin();
  const widgetContext = useRunAsync(async () => await plugin.widget.getWidgetContext(), []);
  const remId = widgetContext?.remId;
  
  const [isExpanded, setIsExpanded] = useState(false);
  
  const rem = useTrackerPlugin(
    async (plugin) => {
      if (!remId) return null;
      return await plugin.rem.findOne(remId);
    },
    [remId]
  );

  const incRemInfo = useTrackerPlugin(
    async (plugin) => {
      if (!rem) return null;
      return await getIncrementalRemInfo(plugin, rem);
    },
    [rem]
  );

  const cardInfo = useTrackerPlugin(
    async (plugin) => {
      if (!rem) return null;
      return await getCardPriority(plugin, rem);
    },
    [rem]
  );

  const hasCards = useTrackerPlugin(
    async (plugin) => {
      if (!rem) return false;
      const cards = await rem.getCards();
      return cards && cards.length > 0;
    },
    [rem]
  );

  if (!rem || (!incRemInfo && !hasCards)) return null;

  // UPDATED FUNCTION - using the correct approach
  const quickUpdateIncPriority = async (delta: number) => {
    if (!incRemInfo || !rem) return;
    const newPriority = Math.max(0, Math.min(100, incRemInfo.priority + delta));
    
    // Update the priority in the powerup
    await rem.setPowerupProperty(powerupCode, prioritySlotCode, [newPriority.toString()]);
    
    // Update the session storage
    const updatedInfo = { ...incRemInfo, priority: newPriority };
    const allIncRems = (await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || [];
    const updated = allIncRems.map((r) => 
      r.remId === remId ? updatedInfo : r
    );
    await plugin.storage.setSession(allIncrementalRemKey, updated);
  };

  const quickUpdateCardPriority = async (delta: number) => {
    if (!rem) return;
    const currentPriority = cardInfo?.priority || 50;
    const newPriority = Math.max(0, Math.min(100, currentPriority + delta));
    await setCardPriority(plugin, rem, newPriority, 'manual');
  };

  return (
    <div 
      className="priority-editor-widget"
      style={{
        position: 'fixed',
        right: '10px',
        top: '50%',
        transform: 'translateY(-50%)',
        backgroundColor: 'white',
        border: '1px solid #e5e7eb',
        borderRadius: '8px',
        padding: isExpanded ? '12px' : '8px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
        transition: 'all 0.3s ease',
        minWidth: isExpanded ? '200px' : '40px',
        zIndex: 1000,
      }}
    >
      {!isExpanded ? (
        // Collapsed view - just priority indicators
        <div 
          onClick={() => setIsExpanded(true)}
          className="cursor-pointer"
          title="Click to expand priority controls"
        >
          {incRemInfo && (
            <div className="text-center mb-1" title={`Inc Priority: ${incRemInfo.priority}`}>
              <span className="text-xs font-bold text-blue-600">
                I:{incRemInfo.priority}
              </span>
            </div>
          )}
          {(hasCards || cardInfo) && (
            <div className="text-center" title={`Card Priority: ${cardInfo?.priority || 'None'}`}>
              <span className="text-xs font-bold text-green-600">
                C:{cardInfo?.priority || '-'}
              </span>
            </div>
          )}
        </div>
      ) : (
        // Expanded view with controls
        <div>
          <button
            onClick={() => setIsExpanded(false)}
            className="absolute top-1 right-1 text-gray-400 hover:text-gray-600"
            style={{ fontSize: '12px' }}
          >
            ✕
          </button>
          
          <div className="mb-3">
            <div className="text-xs font-bold text-gray-700 mb-2">Priority Control</div>
            
            {/* Incremental Rem Controls */}
            {incRemInfo && (
              <div className="mb-3">
                <div className="text-xs text-blue-600 mb-1">Inc Rem</div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => quickUpdateIncPriority(-10)}
                    className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded"
                  >
                    -10
                  </button>
                  <button
                    onClick={() => quickUpdateIncPriority(-1)}
                    className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded"
                  >
                    -1
                  </button>
                  <span className="px-2 text-sm font-bold">{incRemInfo.priority}</span>
                  <button
                    onClick={() => quickUpdateIncPriority(1)}
                    className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded"
                  >
                    +1
                  </button>
                  <button
                    onClick={() => quickUpdateIncPriority(10)}
                    className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded"
                  >
                    +10
                  </button>
                </div>
              </div>
            )}
            
            {/* Card Controls */}
            {hasCards && (
              <div>
                <div className="text-xs text-green-600 mb-1">Cards</div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => quickUpdateCardPriority(-10)}
                    className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded"
                  >
                    -10
                  </button>
                  <button
                    onClick={() => quickUpdateCardPriority(-1)}
                    className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded"
                  >
                    -1
                  </button>
                  <span className="px-2 text-sm font-bold">{cardInfo?.priority || 50}</span>
                  <button
                    onClick={() => quickUpdateCardPriority(1)}
                    className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded"
                  >
                    +1
                  </button>
                  <button
                    onClick={() => quickUpdateCardPriority(10)}
                    className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded"
                  >
                    +10
                  </button>
                </div>
                {cardInfo?.source && (
                  <div className="text-xs text-gray-500 mt-1">
                    Source: {cardInfo.source}
                  </div>
                )}
              </div>
            )}
          </div>
          
          <button
            onClick={() => plugin.widget.openPopup('priority', { remId })}
            className="w-full px-2 py-1 text-xs bg-blue-500 text-white rounded hover:bg-blue-600"
          >
            Open Full Priority Panel
          </button>
        </div>
      )}
    </div>
  );
}

renderWidget(PriorityEditor);