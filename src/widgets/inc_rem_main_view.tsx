import { renderWidget, usePlugin, useTrackerPlugin } from '@remnote/plugin-sdk';
import React, { useState, useMemo } from 'react';
import { allIncrementalRemKey } from '../lib/consts';
import { IncrementalRem } from '../lib/incremental_rem';
import { extractText, determineIncRemType, getTotalTimeSpent, getTopLevelDocument } from '../lib/incRemHelpers';
import { IncRemTable, IncRemWithDetails, DocumentInfo } from '../components';
import { buildDocumentScope } from '../lib/scope_helpers';

export function IncRemMainView() {
  const plugin = usePlugin();
  const [loadingRems, setLoadingRems] = useState<boolean>(false);
  const [incRemsWithDetails, setIncRemsWithDetails] = useState<IncRemWithDetails[]>([]);
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  const [filteredByDocument, setFilteredByDocument] = useState<Set<string> | null>(null);

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

          const topLevelDoc = await getTopLevelDocument(plugin, rem);

          return {
            ...incRem,
            remText: textStr || '[Empty rem]',
            incRemType,
            percentile: percentiles[incRem.remId],
            totalTimeSpent: getTotalTimeSpent(incRem),
            documentId: topLevelDoc?.id,
            documentName: topLevelDoc?.name,
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

  const handleDocumentFilterChange = async (documentId: string | null) => {
    setSelectedDocumentId(documentId);
    if (documentId) {
      const scope = await buildDocumentScope(plugin, documentId);
      setFilteredByDocument(scope);
    } else {
      setFilteredByDocument(null);
    }
  };

  const documents = useMemo<DocumentInfo[]>(() => {
    const now = Date.now();
    const docMap = new Map<string, { name: string; count: number; dueCount: number }>();

    for (const rem of incRemsWithDetails) {
      if (rem.documentId && rem.documentName) {
        const existing = docMap.get(rem.documentId);
        const isDue = rem.nextRepDate <= now;
        if (existing) {
          existing.count++;
          if (isDue) existing.dueCount++;
        } else {
          docMap.set(rem.documentId, {
            name: rem.documentName,
            count: 1,
            dueCount: isDue ? 1 : 0,
          });
        }
      }
    }

    return Array.from(docMap.entries())
      .map(([id, info]) => ({ id, ...info }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [incRemsWithDetails]);

  const displayedRems = useMemo(() => {
    if (!filteredByDocument) return incRemsWithDetails;
    return incRemsWithDetails.filter((rem) => filteredByDocument.has(rem.remId));
  }, [incRemsWithDetails, filteredByDocument]);

  const now = Date.now();
  const dueCount = displayedRems.filter((r) => r.nextRepDate <= now).length;
  const totalCount = displayedRems.length;

  return (
    <IncRemTable
      title="All Inc Rems"
      icon="📊"
      incRems={displayedRems}
      loading={loadingRems}
      dueCount={dueCount}
      totalCount={totalCount}
      onRemClick={handleRemClick}
      documents={documents}
      selectedDocumentId={selectedDocumentId}
      onDocumentFilterChange={handleDocumentFilterChange}
    />
  );
}

renderWidget(IncRemMainView);
