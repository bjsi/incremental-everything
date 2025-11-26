import { renderWidget, usePlugin, useTrackerPlugin } from '@remnote/plugin-sdk';
import React, { useState } from 'react';
import { allIncrementalRemKey } from '../lib/consts';
import { IncrementalRem } from '../lib/incremental_rem';
import { extractText, determineIncRemType, getTotalTimeSpent } from '../lib/incRemHelpers';
import { IncRemTable, IncRemWithDetails } from '../components';

export function IncRemMainView() {
  const plugin = usePlugin();
  const [loadingRems, setLoadingRems] = useState<boolean>(false);
  const [incRemsWithDetails, setIncRemsWithDetails] = useState<IncRemWithDetails[]>([]);

  useTrackerPlugin(
    async (rp) => {
      try {
        const incRems = (await rp.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || [];
        loadIncRemDetails(incRems);
        return incRems;
      } catch (error) {
        console.error('INC REM MAIN VIEW: Error loading incRems', error);
        return [];
      }
    },
    []
  );

  const loadIncRemDetails = async (incRems: IncrementalRem[]) => {
    if (loadingRems) return;
    setLoadingRems(true);

    const sortedByPriority = [...incRems].sort((a, b) => a.priority - b.priority);
    const percentiles: Record<string, number> = {};
    sortedByPriority.forEach((item, index) => {
      percentiles[item.remId] = Math.round(((index + 1) / sortedByPriority.length) * 100);
    });

    const remsWithDetails = await Promise.all(
      incRems.map(async (incRem) => {
        try {
          const rem = await plugin.rem.findOne(incRem.remId);
          if (!rem) return null;

          const text = await rem.text;
          let textStr = extractText(text);
          if (textStr.length > 300) textStr = textStr.substring(0, 300) + '...';

          const incRemType = await determineIncRemType(plugin, rem);

          return {
            ...incRem,
            remText: textStr || '[Empty rem]',
            incRemType,
            percentile: percentiles[incRem.remId],
            totalTimeSpent: getTotalTimeSpent(incRem),
          };
        } catch (error) {
          console.error('Error loading rem details:', error);
          return null;
        }
      })
    );

    setIncRemsWithDetails(remsWithDetails.filter((rem): rem is IncRemWithDetails => rem !== null));
    setLoadingRems(false);
  };

  const handleRemClick = async (remId: string) => {
    try {
      const rem = await plugin.rem.findOne(remId);
      if (rem) {
        await plugin.window.openRem(rem);
        await plugin.widget.closePopup();
      }
    } catch (error) {
      console.error('Error opening rem:', error);
    }
  };

  const now = Date.now();
  const dueCount = incRemsWithDetails.filter((r) => r.nextRepDate <= now).length;
  const totalCount = incRemsWithDetails.length;

  return (
    <IncRemTable
      title="All Inc Rems"
      icon="📊"
      incRems={incRemsWithDetails}
      loading={loadingRems}
      dueCount={dueCount}
      totalCount={totalCount}
      onRemClick={handleRemClick}
    />
  );
}

renderWidget(IncRemMainView);
