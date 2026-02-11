import { renderWidget, usePlugin, useTrackerPlugin } from '@remnote/plugin-sdk';
import React, { useState } from 'react';
import { allIncrementalRemKey, popupDocumentIdKey } from '../lib/consts';
import { IncrementalRem } from '../lib/incremental_rem';
import { buildDocumentScope } from '../lib/scope_helpers';
import { extractText, determineIncRemType, getTotalTimeSpent, getBreadcrumbText } from '../lib/incRemHelpers';
import { IncRemTable, IncRemWithDetails } from '../components';
import '../style.css';
import '../App.css';

export function IncRemList() {
  const plugin = usePlugin();
  const [loadingRems, setLoadingRems] = useState(false);
  const [incRemsWithDetails, setIncRemsWithDetails] = useState<IncRemWithDetails[]>([]);

  const counterData = useTrackerPlugin(
    async (rp) => {
      try {
        const documentId = await rp.storage.getSession(popupDocumentIdKey);
        const allIncRems = (await rp.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || [];
        const now = Date.now();

        if (!documentId) {
          const dueIncRems = allIncRems.filter((incRem) => incRem.nextRepDate <= now);
          loadIncRemDetails(allIncRems);
          return { due: dueIncRems.length, total: allIncRems.length };
        }

        const documentScope = await buildDocumentScope(rp, documentId);
        if (documentScope.size === 0) {
          return { due: 0, total: 0 };
        }

        const docIncRems = allIncRems.filter((incRem) => documentScope.has(incRem.remId));
        const dueIncRems = docIncRems.filter((incRem) => incRem.nextRepDate <= now);
        loadIncRemDetails(docIncRems);

        return { due: dueIncRems.length, total: docIncRems.length };
      } catch (error) {
        console.error('INC REM LIST: Error', error);
        return { due: 0, total: 0 };
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

    const remsWithDetails: IncRemWithDetails[] = [];

    for (const incRem of incRems) {
      try {
        const rem = await plugin.rem.findOne(incRem.remId);
        if (!rem) continue;

        const text = await rem.text;
        let textStr = extractText(text);
        if (textStr.length > 200) textStr = textStr.substring(0, 200) + '...';

        const incRemType = await determineIncRemType(plugin, rem);

        const lastReviewDate = incRem.history && incRem.history.length > 0
          ? Math.max(...incRem.history.map(h => h.date))
          : undefined;

        // Get breadcrumb for tooltip
        const breadcrumb = await getBreadcrumbText(plugin, rem);

        remsWithDetails.push({
          ...incRem,
          remText: textStr || '[Empty rem]',
          incRemType,
          percentile: percentiles[incRem.remId],
          totalTimeSpent: getTotalTimeSpent(incRem),
          lastReviewDate,
          breadcrumb,
        });
      } catch (error) {
        console.error('Error loading rem details:', error);
      }
    }

    setIncRemsWithDetails(remsWithDetails);
    setLoadingRems(false);
  };

  const handleClose = () => plugin.widget.closePopup();

  const handleRemClick = async (remId: string) => {
    const rem = await plugin.rem.findOne(remId);
    const incRem = incRemsWithDetails.find(r => r.remId === remId);

    if (rem) {
      if (incRem?.incRemType === 'pdf-note') {
        // For PDF notes, use openRemAsPage to avoid opening the PDF viewer
        await rem.openRemAsPage();
      } else {
        await plugin.window.openRem(rem);
      }
      await plugin.widget.closePopup();
    }
  };

  return (
    <IncRemTable
      title="Inc Rems in Scope"
      icon="📚"
      incRems={incRemsWithDetails}
      loading={loadingRems}
      dueCount={counterData?.due ?? 0}
      totalCount={counterData?.total ?? 0}
      onRemClick={handleRemClick}
      onClose={handleClose}
    />
  );
}

renderWidget(IncRemList);
