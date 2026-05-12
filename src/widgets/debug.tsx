import {
  renderWidget,
  usePlugin,
  useRunAsync,
  useTrackerPlugin,
  WidgetLocation,
  BuiltInPowerupCodes,
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

      const spuriousRems = await getSpuriousCardPriorityTags(rp, rem, false);
      const hasSpuriousTags = spuriousRems.length > 0;

      return {
        incrementalRem,
        cardPriority,
        dismissed,
        isCardDisabledLocally,
        isCardDisabledInAncestors,
        hasSpuriousTags,
        spuriousRems,
        rem
      };
    },
    [remId]
  );

  if (!debugData) return null;

  const { incrementalRem, cardPriority, dismissed, isCardDisabledLocally, isCardDisabledInAncestors, hasSpuriousTags, spuriousRems, rem } = debugData;

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
      const textRaw = await child.text;
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
    if (!spuriousRems || spuriousRems.length === 0) return;
    
    let totalCleaned = 0;
    const CHUNK_SIZE = 20;
    
    for (let i = 0; i < spuriousRems.length; i += CHUNK_SIZE) {
      const chunk = spuriousRems.slice(i, i + CHUNK_SIZE);
      const listString = chunk.map((r: any) => `- ${r.name} (${r.id})`).join('\n');
      
      const chunkMsg = spuriousRems.length > CHUNK_SIZE 
        ? `(Batch ${Math.floor(i/CHUNK_SIZE) + 1} of ${Math.ceil(spuriousRems.length/CHUNK_SIZE)})` 
        : '';
        
      const confirmed = confirm(`This will remove CardPriority from ${chunk.length} non-flashcard rem(s) ${chunkMsg}:\n\n${listString}\n\nContinue?`);
      
      if (!confirmed) {
        if (totalCleaned > 0) await plugin.app.toast(`Sanitize aborted. Cleaned ${totalCleaned} rogue tags total.`);
        return;
      }
      
      await plugin.app.toast(`Sanitizing ${chunk.length} rogue properties...`);
      const result = await removeCardPriorityFromSpecificRems(plugin, chunk.map((r: any) => r.id));
      if (result.success) {
        totalCleaned += result.cleanedCount;
      } else {
        await plugin.app.toast('Sanitize failed during batch. Check console.');
        return;
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
    </div>
  );
}

renderWidget(Debug);
