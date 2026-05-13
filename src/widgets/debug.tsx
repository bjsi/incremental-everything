import { useState } from 'react';
import {
  renderWidget,
  usePlugin,
  useRunAsync,
  useTrackerPlugin,
  WidgetLocation,
  BuiltInPowerupCodes,
  Card,
} from '@remnote/plugin-sdk';
import { getIncrementalRemFromRem } from '../lib/incremental_rem';
import { getCardPriority } from '../lib/card_priority';
import { getSpuriousCardPriorityTags, removeCardPriorityFromSpecificRems } from '../lib/card_priority/batch';
import { getDismissedHistoryFromRem } from '../lib/dismissed';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
dayjs.extend(relativeTime);

interface InfoProps {
  className: string;
  label: string;
  data: any;
}

const Info = (props: InfoProps) => {
  return (
    <div className="flex flex-col mb-2">
      <div className="font-semibold text-xs text-[var(--rn-clr-content-tertiary)] uppercase tracking-wider">{props.label}</div>
      <div className={props.className}>{props.data}</div>
    </div>
  );
};

function Debug() {
  const plugin = usePlugin();
  const ctx = useRunAsync(
    async () => await plugin.widget.getWidgetContext<WidgetLocation.Popup>(),
    []
  );
  const remId = ctx?.contextData?.remId;
  const debugData = useTrackerPlugin(
    async (rp) => {
      const rem = await rp.rem.findOne(remId);
      if (!rem) return null;

      const incrementalRem = await getIncrementalRemFromRem(rp, rem);
      const cardPriority = await getCardPriority(rp, rem);
      const dismissed = await getDismissedHistoryFromRem(rp, rem);
      
      const isCardDisabledLocally = await rem.hasPowerup(BuiltInPowerupCodes.DisableCards);
      
      let isCardDisabledInAncestors = false;
      let currentParent = await rem.getParentRem();
      while (currentParent) {
         if (await currentParent.hasPowerup(BuiltInPowerupCodes.DisableCards)) {
             isCardDisabledInAncestors = true;
             break;
         }
         currentParent = await currentParent.getParentRem();
      }

      const { guaranteedRogue, suspicious } = await getSpuriousCardPriorityTags(rp, rem, false);
      const hasSpuriousTags = guaranteedRogue.length > 0 || suspicious.length > 0;

      return {
        incrementalRem,
        cardPriority,
        dismissed,
        isCardDisabledLocally,
        isCardDisabledInAncestors,
        hasSpuriousTags,
        guaranteedRogue,
        suspicious,
        rem
      };
    },
    [remId]
  );

  const [cardCompare, setCardCompare] = useState<{
    remCards: { id: string; type: string; nextRepTime: number | null; historyLen: number; disabled: boolean }[];
    filteredCards: { id: string; type: string; nextRepTime: number | null; historyLen: number; disabled: boolean }[];
    onlyInRem: string[];
    onlyInAll: string[];
    totalKb: number;
    match: boolean;
    documentStatus: string | null;
    documentRemId: string | null;
    deckStatus: string | null;
    deckRemId: string | null;
  } | null>(null);
  const [isComparing, setIsComparing] = useState(false);

  if (!debugData) return null;

  const { incrementalRem, cardPriority, dismissed, isCardDisabledLocally, isCardDisabledInAncestors, hasSpuriousTags, guaranteedRogue, suspicious, rem } = debugData;

  const handleCardCompare = async () => {
    if (!remId) return;
    setIsComparing(true);
    try {
      const rem = await plugin.rem.findOne(remId);
      if (!rem) { await plugin.app.toast('No rem found!'); return; }

      // Walk ancestors to collect Document + Deck powerup status slots
      let documentStatus: string | null = null;
      let documentRemId: string | null = null;
      let deckStatus: string | null = null;
      let deckRemId: string | null = null;
      let cursor = await rem.getParentRem();
      while (cursor) {
        if (documentRemId === null && await cursor.hasPowerup(BuiltInPowerupCodes.Document)) {
          documentRemId = cursor._id;
          const raw = await cursor.getPowerupProperty(BuiltInPowerupCodes.Document, 'Status');
          documentStatus = raw != null ? String(raw) : '(null)';
        }
        if (deckRemId === null && await cursor.hasPowerup(BuiltInPowerupCodes.Deck)) {
          deckRemId = cursor._id;
          const raw = await cursor.getPowerupProperty(BuiltInPowerupCodes.Deck, 'Status');
          deckStatus = raw != null ? String(raw) : '(null)';
        }
        if (documentRemId && deckRemId) break;
        cursor = await cursor.getParentRem();
      }

      const remCards = await rem.getCards();
      const allCards = await plugin.card.getAll();
      const filteredCards = (allCards || []).filter((c: Card) => c.remId === remId);

      const parse = (c: Card) => ({
        id: c._id,
        type: typeof c.type === 'object' && c.type !== null ? `cloze:${(c.type as { clozeId: string }).clozeId}` : String(c.type),
        nextRepTime: c.nextRepetitionTime ?? null,
        historyLen: c.repetitionHistory?.length ?? 0,
        disabled: c.nextRepetitionTime == null,
      });

      const remCardsParsed = remCards.map(parse);
      const filteredCardsParsed = filteredCards.map(parse);
      const remIdSet = new Set(remCards.map((c: Card) => c._id));
      const filtIdSet = new Set(filteredCards.map((c: Card) => c._id));
      const onlyInRem = remCards.filter((c: Card) => !filtIdSet.has(c._id)).map((c: Card) => c._id);
      const onlyInAll = filteredCards.filter((c: Card) => !remIdSet.has(c._id)).map((c: Card) => c._id);

      const result = {
        remCards: remCardsParsed,
        filteredCards: filteredCardsParsed,
        onlyInRem,
        onlyInAll,
        totalKb: allCards?.length ?? 0,
        match: onlyInRem.length === 0 && onlyInAll.length === 0,
        documentStatus,
        documentRemId,
        deckStatus,
        deckRemId,
      };

      console.log(`\n========== CARD COMPARE: ${remId} ==========`);
      console.log('Document ancestor:', documentRemId, '| Status slot:', documentStatus);
      console.log('Deck ancestor:', deckRemId, '| Status slot:', deckStatus);
      console.log('rem.getCards():', JSON.stringify(remCardsParsed, null, 2));
      console.log('card.getAll() filtered:', JSON.stringify(filteredCardsParsed, null, 2));
      console.log('Only in rem.getCards():', onlyInRem);
      console.log('Only in card.getAll():', onlyInAll);
      console.log('Total KB cards:', result.totalKb);
      console.log('Match:', result.match);
      console.log('===========================================\n');

      setCardCompare(result);
    } finally {
      setIsComparing(false);
    }
  };

  const handleDeepLog = async () => {
    console.log(`\n=================== DEEP LOG REM: ${rem._id} ===================`);
    const tags = await rem.getTagRems();
    const mainTagsMapped = await Promise.all(tags.map(async t => ({ 
      id: t._id, 
      name: t.text ? await plugin.richText.toString(t.text) : '' 
    })));
    const mainTagsStr = mainTagsMapped.length > 0
      ? mainTagsMapped.map(t => t.name || t.id).join(', ')
      : 'None';
    console.log(`Tags: [${mainTagsStr}]`);
    
    const children = await rem.getChildrenRem();
    console.log(`Found ${children.length} total children.`);
    
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const isProp = await child.isProperty();
      const isPowerupProp = await child.isPowerupProperty();
      const childTags = await child.getTagRems();
      const textRaw = child.text;
      const textString = textRaw ? await plugin.richText.toString(textRaw) : '';
      
      const childTagsMapped = await Promise.all(childTags.map(async t => ({ 
        id: t._id, 
        name: t.text ? await plugin.richText.toString(t.text) : '' 
      })));
      
      const tagsStr = childTagsMapped.length > 0 
        ? childTagsMapped.map(t => t.name || t.id).join(', ') 
        : 'None';
        
      console.log(`Child ${i + 1} (${child._id}): text="${textString}", isProp=${isProp}, isPowerupProp=${isPowerupProp}, tags=[${tagsStr}]`);
    }
    console.log(`=================================================================\n`);
    await plugin.app.toast('Deep log printed to console! Please check Developer Tools.');
  };

  const handleSanitize = async () => {
    if (!hasSpuriousTags) return;
    
    let totalCleaned = 0;
    const CHUNK_SIZE = 20;
    
    if (guaranteedRogue.length > 0) {
      for (let i = 0; i < guaranteedRogue.length; i += CHUNK_SIZE) {
        const chunk = guaranteedRogue.slice(i, i + CHUNK_SIZE);
        const listString = chunk.map((r: any) => `- ${r.name}`).join('\n');
        
        const chunkMsg = guaranteedRogue.length > CHUNK_SIZE 
          ? `(Batch ${Math.floor(i/CHUNK_SIZE) + 1} of ${Math.ceil(guaranteedRogue.length/CHUNK_SIZE)})` 
          : '';
          
        const confirmed = confirm(`Found ${guaranteedRogue.length} GUARANTEED rogue properties. This will safely remove CardPriority from ${chunk.length} of them ${chunkMsg}:\n\n${listString}\n\nContinue?`);
        
        if (!confirmed) {
          if (totalCleaned > 0) await plugin.app.toast(`Sanitize aborted. Cleaned ${totalCleaned} rogue tags total.`);
          return;
        }
        
        await plugin.app.toast(`Sanitizing ${chunk.length} guaranteed rogue properties...`);
        const result = await removeCardPriorityFromSpecificRems(plugin, chunk.map((r: any) => r.id));
        if (result.success) {
          totalCleaned += result.cleanedCount;
        } else {
          await plugin.app.toast('Sanitize failed during batch. Check console.');
          return;
        }
      }
    }

    if (suspicious.length > 0) {
      const proceed = confirm(`We found ${suspicious.length} SUSPICIOUS properties.\nThese are property nodes from other plugins that have CardPriority but 0 flashcards. They might be bugs, or they might be intentional.\n\nDo you want to review them one by one?`);
      
      if (proceed) {
        for (const r of suspicious) {
          const confirmDelete = confirm(`⚠️ Suspicious Property Found\n\nProperty Text: "${r.name}"\nParent Rem: "${r.parentName}"\n\nThis property has no flashcards. Do you want to remove CardPriority from it?`);
          
          if (confirmDelete) {
            const result = await removeCardPriorityFromSpecificRems(plugin, [r.id]);
            if (result.success) {
              totalCleaned += result.cleanedCount;
            }
          }
        }
      }
    }
    
    await plugin.app.toast(`Sanitized! Cleaned ${totalCleaned} rogue tags total.`);
  };

  const preStyle = { backgroundColor: 'var(--rn-clr-background-secondary)', padding: '8px', borderRadius: '4px', marginTop: '4px', fontSize: '11px', overflowX: 'auto' as 'auto' };

  return (
    <div className="incremental-everything-debug p-4 max-h-[80vh] overflow-y-auto" style={{ fontFamily: 'system-ui, -apple-system, sans-serif', color: 'var(--rn-clr-content-primary)', boxSizing: 'border-box' }}>
      <h2 style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '12px', paddingBottom: '4px', borderBottom: '1px solid var(--rn-clr-background-tertiary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
         General Data
         <button
           onClick={handleDeepLog}
           style={{
             fontSize: '11px',
             padding: '2px 8px',
             backgroundColor: 'var(--rn-clr-background-secondary)',
             color: 'var(--rn-clr-content-primary)',
             border: '1px solid var(--rn-clr-border)',
             borderRadius: '4px',
             cursor: 'pointer'
           }}
         >
           Deep Log Structure
         </button>
      </h2>
      <Info className="rem-id" label="Rem ID" data={<code>{remId}</code>} />
      <div className="flex gap-4">
        <Info className="card-disabled" label="Cards Disabled (Locally)" data={isCardDisabledLocally ? <span style={{color: '#ef4444', fontWeight: 600}}>YES</span> : 'No'} />
        <Info className="card-disabled-ancestor" label="Cards Disabled (Inherited)" data={isCardDisabledInAncestors ? <span style={{color: '#ef4444', fontWeight: 600}}>YES</span> : 'No'} />
      </div>
      
      {incrementalRem && (
        <div style={{ marginTop: '16px' }}>
          <h2 style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '12px', paddingBottom: '4px', borderBottom: '1px solid var(--rn-clr-background-tertiary)' }}>Incremental Powerup</h2>
          <Info className="next-rep-date" label="Next Rep (Raw)" data={incrementalRem.nextRepDate} />
          <Info
            className="human-date"
            label="Next Rep (Human)"
            data={`${dayjs(incrementalRem.nextRepDate).format('MMMM D, YYYY')} (${dayjs(incrementalRem.nextRepDate).fromNow()})`}
          />
          <Info className="priority" label="Priority" data={incrementalRem.priority} />
          <Info
            className="created-at-raw"
            label="Created At (Raw)"
            data={incrementalRem.createdAt !== undefined
              ? incrementalRem.createdAt
              : <span style={{ color: 'var(--rn-clr-content-tertiary)', fontStyle: 'italic' }}>Not set (dismissed or legacy rem)</span>}
          />
          <Info
            className="created-at-human"
            label="Created At (Human)"
            data={incrementalRem.createdAt !== undefined
              ? `${dayjs(incrementalRem.createdAt).format('MMMM D, YYYY')} (${dayjs(incrementalRem.createdAt).fromNow()})`
              : <span style={{ color: 'var(--rn-clr-content-tertiary)', fontStyle: 'italic' }}>Not set (dismissed or legacy rem)</span>}
          />
          <Info
            className="history"
            label="History"
            data={<pre style={preStyle}>{incrementalRem?.history ? JSON.stringify(incrementalRem.history, null, 2) : '[]'}</pre>}
          />
        </div>
      )}

      {cardPriority && (
        <div style={{ marginTop: '16px' }}>
           <h2 style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '12px', paddingBottom: '4px', borderBottom: '1px solid var(--rn-clr-background-tertiary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
             Card Priority Powerup
             <button
               onClick={handleSanitize}
               style={{
                 fontSize: '11px',
                 padding: '2px 8px',
                 backgroundColor: 'var(--rn-clr-background-warning)',
                 color: 'var(--rn-clr-content-warning)',
                 border: '1px solid var(--rn-clr-border-warning)',
                 borderRadius: '4px',
                 cursor: 'pointer'
               }}
             >
               Sanitize Rogue Tags
             </button>
           </h2>
           {hasSpuriousTags && (
             <div style={{ marginBottom: '12px', padding: '8px', backgroundColor: 'var(--rn-clr-background-warning)', color: 'var(--rn-clr-content-warning)', borderRadius: '4px', fontSize: '12px', border: '1px solid var(--rn-clr-border-warning)' }}>
               ⚠️ <strong>Spurious Tags Detected:</strong> Rogue CardPriority tags were found on non-flashcard children. Please click "Sanitize Rogue Tags" to cure this rem.
             </div>
           )}
           <div className="flex gap-4 mb-2">
             <Info className="cp-priority" label="Priority" data={cardPriority.priority} />
             <Info className="cp-source" label="Source" data={<span style={{ textTransform: 'capitalize' }}>{cardPriority.source}</span>} />
           </div>
           <div className="flex gap-4 mb-2">
             <Info className="cp-duecards" label="Due Cards" data={cardPriority.dueCards} />
             <Info className="cp-cardcount" label="Total Cards" data={cardPriority.cardCount} />
           </div>
           <Info className="cp-updated" label="Last Updated" data={`${dayjs(cardPriority.lastUpdated).format('MMMM D, YYYY, h:mm a')} (${dayjs(cardPriority.lastUpdated).fromNow()})`} />
        </div>
      )}

      {dismissed && (
        <div style={{ marginTop: '16px' }}>
           <h2 style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '12px', paddingBottom: '4px', borderBottom: '1px solid var(--rn-clr-background-tertiary)' }}>Dismissed Powerup</h2>
           <Info className="dismissed-date" label="Dismissed Date" data={dismissed.dismissedDate ? `${dayjs(dismissed.dismissedDate).format('MMMM D, YYYY')} (${dayjs(dismissed.dismissedDate).fromNow()})` : 'None'} />
           <Info
            className="history"
            label="Dismissed History"
            data={<pre style={preStyle}>{dismissed?.history ? JSON.stringify(dismissed.history, null, 2) : '[]'}</pre>}
          />
        </div>
      )}

      <div style={{ marginTop: '16px' }}>
        <h2 style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '12px', paddingBottom: '4px', borderBottom: '1px solid var(--rn-clr-background-tertiary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          Card API Comparison
          <button
            onClick={handleCardCompare}
            disabled={isComparing}
            style={{ fontSize: '11px', padding: '2px 8px', backgroundColor: 'var(--rn-clr-background-secondary)', color: 'var(--rn-clr-content-primary)', border: '1px solid var(--rn-clr-border)', borderRadius: '4px', cursor: isComparing ? 'wait' : 'pointer' }}
          >
            {isComparing ? 'Running…' : 'Run Comparison'}
          </button>
        </h2>
        {!cardCompare && <div style={{ fontSize: '12px', color: 'var(--rn-clr-content-tertiary)' }}>Click "Run Comparison" to compare rem.getCards() vs card.getAll() for this rem.</div>}
        {cardCompare && (
          <div>
            <div className="flex gap-4 mb-2">
              <Info className="" label="rem.getCards()" data={<strong>{cardCompare.remCards.length}</strong>} />
              <Info className="" label="card.getAll() filtered" data={<strong>{cardCompare.filteredCards.length}</strong>} />
              <Info className="" label="Total KB Cards" data={cardCompare.totalKb} />
            </div>
            <Info className="" label="Match?" data={
              cardCompare.match
                ? <span style={{ color: '#22c55e', fontWeight: 600 }}>YES — counts and IDs agree</span>
                : <span style={{ color: '#ef4444', fontWeight: 600 }}>NO — mismatch detected!</span>
            } />
            <Info className="" label="Document ancestor Status" data={
              cardCompare.documentRemId
                ? <span><code>{cardCompare.documentStatus ?? '(null/empty)'}</code><span style={{ color: 'var(--rn-clr-content-tertiary)', fontSize: '10px', marginLeft: '6px' }}>{cardCompare.documentRemId}</span></span>
                : <span style={{ color: 'var(--rn-clr-content-tertiary)', fontStyle: 'italic' }}>No Document ancestor found</span>
            } />
            <Info className="" label="Deck ancestor Status" data={
              cardCompare.deckRemId
                ? <span><code>{cardCompare.deckStatus ?? '(null/empty)'}</code><span style={{ color: 'var(--rn-clr-content-tertiary)', fontSize: '10px', marginLeft: '6px' }}>{cardCompare.deckRemId}</span></span>
                : <span style={{ color: 'var(--rn-clr-content-tertiary)', fontStyle: 'italic' }}>No Deck ancestor found</span>
            } />
            {!cardCompare.match && cardCompare.onlyInRem.length > 0 && (
              <Info className="" label="Only in rem.getCards()" data={<pre style={preStyle}>{JSON.stringify(cardCompare.onlyInRem, null, 2)}</pre>} />
            )}
            {!cardCompare.match && cardCompare.onlyInAll.length > 0 && (
              <Info className="" label="Only in card.getAll() — missing from rem.getCards()" data={
                <pre style={preStyle}>{JSON.stringify(
                  cardCompare.filteredCards.filter(c => cardCompare.onlyInAll.includes(c.id)).map(c => {
                    let diagnosis: string;
                    if (c.disabled) {
                      diagnosis = 'DISABLED (nextRepTime=null)';
                    } else if (cardCompare.deckStatus === 'Paused') {
                      diagnosis = 'PAUSED (Deck Status="Paused")';
                    } else {
                      diagnosis = `UNKNOWN — nextRepTime set, not in rem.getCards; Deck Status="${cardCompare.deckStatus ?? 'not set'}"`;
                    }
                    return { ...c, diagnosis };
                  }),
                  null, 2
                )}</pre>
              } />
            )}
            <Info className="" label="rem.getCards() — cards" data={
              <pre style={preStyle}>{JSON.stringify(cardCompare.remCards, null, 2)}</pre>
            } />
            <Info className="" label="card.getAll() filtered — cards" data={
              <pre style={preStyle}>{JSON.stringify(cardCompare.filteredCards, null, 2)}</pre>
            } />
          </div>
        )}
      </div>
    </div>
  );
}

renderWidget(Debug);
