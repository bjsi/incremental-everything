import {
  renderWidget,
  usePlugin,
  useTrackerPlugin,
  WidgetLocation,
  Rem,
} from '@remnote/plugin-sdk';
import React, { useEffect, useMemo } from 'react';
import { powerupCode, seenCardInSessionKey, currentSubQueueIdKey, allCardPriorityInfoKey } from '../lib/consts';
import { CardPriorityInfo } from '../lib/cardPriority';
import { calculateCardPriorityShield } from '../lib/priority_shield';
import * as _ from 'remeda';
import { percentileToHslColor } from '../lib/color';

// Helper to calculate relative priority on the fly
function calculateRelativeCardPriority(allItems: CardPriorityInfo[], currentRemId: string): number | null {
  if (!allItems || allItems.length === 0) return null;
  const sortedItems = _.sortBy(allItems, (x) => x.priority);
  const index = sortedItems.findIndex((x) => x.remId === currentRemId);
  if (index === -1) return null;
  const percentile = ((index + 1) / sortedItems.length) * 100;
  return Math.round(percentile * 10) / 10;
}

export function CardPriorityDisplay() {
  const plugin = usePlugin();
  // DEBUG LOG: Indicates when the component starts a render cycle.
  console.log('WIDGET: --- Render Cycle Start ---');

  const rem = useTrackerPlugin(async (rp) => {
    const ctx = await rp.widget.getWidgetContext();
    return ctx?.remId ? await rp.rem.findOne(ctx.remId) : undefined;
  }, []);

  // DEBUG LOG: Shows the resolved value of the `rem` object.
  useEffect(() => {
    console.log('WIDGET: Current Rem object is:', rem);
  }, [rem]);

  const isIncRem = useTrackerPlugin(async (rp) => {
    return rem ? await rem.hasPowerup(powerupCode) : false;
  }, [rem]);

  const allPrioritizedCardInfo = useTrackerPlugin(
    (rp) => rp.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey),
    []
  );

  // DEBUG LOG: Shows the content of the cache read from session storage.
  useEffect(() => {
    console.log(`WIDGET: Reading cache. Found ${allPrioritizedCardInfo?.length ?? 'undefined'} items.`, allPrioritizedCardInfo);
  }, [allPrioritizedCardInfo]);

  const cardInfo = useMemo(() => {
    if (!rem || !allPrioritizedCardInfo) {
      return null;
    }
    const foundInfo = allPrioritizedCardInfo.find(info => info.remId === rem._id);
    // DEBUG LOG: Shows if a match for the current Rem was found in the cache.
    console.log('WIDGET: Searched cache for current Rem ID. Found:', foundInfo);
    return foundInfo;
  }, [rem, allPrioritizedCardInfo]);

  const shieldStatus = useTrackerPlugin(async (rp) => {
    if (!rem || isIncRem || !allPrioritizedCardInfo) return null;
    return await calculateCardPriorityShield(rp, allPrioritizedCardInfo, rem._id);
  }, [rem, isIncRem, allPrioritizedCardInfo]);
  
  const docPrioritizedCardInfo = useTrackerPlugin(async (rp) => {
    if (!rem || isIncRem || !allPrioritizedCardInfo) return null;
    const subQueueId = await rp.storage.getSession<string | null>(currentSubQueueIdKey);
    if (!subQueueId) return null;
    const scopeRem = await rp.rem.findOne(subQueueId);
    if (!scopeRem) return null;
    const descendants = await scopeRem.getDescendants();
    const scopeIds = [scopeRem._id, ...descendants.map(d => d._id)];
    return allPrioritizedCardInfo.filter(c => scopeIds.includes(c.remId));
  }, [allPrioritizedCardInfo, rem, isIncRem]);

  useEffect(() => {
    if (rem && !isIncRem) {
      const updateSeen = async () => {
        const seen = (await plugin.storage.getSession<string[]>(seenCardInSessionKey)) || [];
        if (!seen.includes(rem._id)) {
          await plugin.storage.setSession(seenCardInSessionKey, [...seen, rem._id]);
        }
      };
      updateSeen();
    }
  }, [rem?._id, isIncRem, plugin]);
  
  if (!rem || isIncRem || !cardInfo || !allPrioritizedCardInfo) {
    // DEBUG LOG: Explains exactly why the widget is not rendering.
    console.log('WIDGET: Rendering null because a condition failed:', {
      hasRem: !!rem,
      isIncRem,
      hasCardInfo: !!cardInfo,
      cacheIsAvailable: !!allPrioritizedCardInfo,
      cacheHasItems: (allPrioritizedCardInfo?.length || 0) > 0,
    });
    return null;
  }
  
  // DEBUG LOG: Confirms that all checks passed and the widget will now be displayed.
  console.log("WIDGET: All conditions passed. Rendering the priority display.");

  const kbPercentile = calculateRelativeCardPriority(allPrioritizedCardInfo, rem._id);
  const docPercentile = docPrioritizedCardInfo ? calculateRelativeCardPriority(docPrioritizedCardInfo, rem._id) : null;
  const priorityColor = kbPercentile ? percentileToHslColor(kbPercentile) : '#6b7280';

  const infoBarStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '16px',
    padding: '6px 12px',
    backgroundColor: 'rgba(59, 130, 246, 0.05)',
    borderRadius: '6px',
    fontSize: '12px',
    color: '#1e40af',
    borderLeft: `3px solid ${priorityColor}`,
    margin: '4px 0',
  };

  const priorityBadgeStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '4px 10px',
    borderRadius: '12px',
    fontSize: '12px',
    fontWeight: 600,
    color: 'white',
    backgroundColor: priorityColor,
  };

  return (
    <div style={infoBarStyle} className="card-priority-display dark:bg-gray-800 dark:text-gray-200">
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{ fontWeight: 500 }}>🎴 Priority:</span>
        <div style={priorityBadgeStyle}>
          <span>{cardInfo.priority}</span>
          {kbPercentile !== null && (
            <span style={{ opacity: 0.9, fontSize: '11px' }}>
              ({kbPercentile}% of KB{docPercentile !== null && `, ${docPercentile}% of Doc`})
            </span>
          )}
        </div>
      </div>
      
      {shieldStatus && (
        <>
          <span style={{ color: '#9ca3af' }}>|</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontWeight: 600 }}>🛡️ Card Shield</span>
            <div style={{ display: 'flex', gap: '12px' }}>
              {shieldStatus.kb ? (
                <span>KB: <strong>{shieldStatus.kb.absolute}</strong> ({shieldStatus.kb.percentile}%)</span>
              ) : <span>KB: 100%</span>}
              {docPrioritizedCardInfo && (
                  shieldStatus.doc ? (
                  <span>Doc: <strong>{shieldStatus.doc.absolute}</strong> ({shieldStatus.doc.percentile}%)</span>
                ) : <span>Doc: 100%</span>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

renderWidget(CardPriorityDisplay);