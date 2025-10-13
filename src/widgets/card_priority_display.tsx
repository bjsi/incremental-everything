import {
  renderWidget,
  usePlugin,
  useTrackerPlugin,
  Rem,
} from '@remnote/plugin-sdk';
import React, { useEffect, useMemo } from 'react';
import { powerupCode, seenCardInSessionKey, allCardPriorityInfoKey } from '../lib/consts';
import { CardPriorityInfo } from '../lib/cardPriority';
import { calculateCardPriorityShield } from '../lib/priority_shield';
import { percentileToHslColor } from '../lib/color';

export function CardPriorityDisplay() {
  const plugin = usePlugin();

  const rem = useTrackerPlugin(async (rp) => {
    const ctx = await rp.widget.getWidgetContext();
    return ctx?.remId ? await rp.rem.findOne(ctx.remId) : undefined;
  }, []);

  const isIncRem = useTrackerPlugin(async (rp) => {
    return rem ? await rem.hasPowerup(powerupCode) : false;
  }, [rem]);

  // 1. Fetch the entire enriched cache. This is a single, fast read from session storage.
  const allPrioritizedCardInfo = useTrackerPlugin(
    (rp) => rp.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey),
    []
  );

  // 2. Derive the specific card's info from the cache using useMemo. This is an instant, in-memory lookup.
  const cardInfo = useMemo(() => {
    if (!rem || isIncRem || !allPrioritizedCardInfo) {
      return null;
    }
    return allPrioritizedCardInfo.find(info => info.remId === rem._id);
  }, [rem, isIncRem, allPrioritizedCardInfo]);
  
  // 3. The shield calculation uses the cache and is fast, as we will only display the KB part.
  const shieldStatus = useTrackerPlugin(async (rp) => {
    if (!rem || isIncRem || !allPrioritizedCardInfo) return null;
    return await calculateCardPriorityShield(rp, allPrioritizedCardInfo, rem._id);
  }, [rem, isIncRem, allPrioritizedCardInfo]);

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
    return null;
  }

  // 4. SIMPLIFIED: Directly read the pre-calculated percentile from the card's info object.
  const kbPercentile = cardInfo.kbPercentile;
  
  const priorityColor = (kbPercentile !== undefined) ? percentileToHslColor(kbPercentile) : '#6b7280';

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
          {kbPercentile !== undefined && (
            <span style={{ opacity: 0.9, fontSize: '11px' }}>
              ({kbPercentile}% of KB)
            </span>
          )}
        </div>
      </div>
      
      {shieldStatus?.kb && (
        <>
          <span style={{ color: '#9ca3af' }}>|</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontWeight: 600 }}>🛡️ Card Shield</span>
            <div style={{ display: 'flex', gap: '12px' }}>
              <span>KB: <strong>{shieldStatus.kb.absolute}</strong> ({shieldStatus.kb.percentile}%)</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

renderWidget(CardPriorityDisplay);