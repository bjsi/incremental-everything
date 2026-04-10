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

      return {
        incrementalRem,
        cardPriority,
        dismissed,
        isCardDisabledLocally,
        isCardDisabledInAncestors
      };
    },
    [remId]
  );

  if (!debugData) return null;

  const { incrementalRem, cardPriority, dismissed, isCardDisabledLocally, isCardDisabledInAncestors } = debugData;

  const preStyle = { backgroundColor: 'var(--rn-clr-background-secondary)', padding: '8px', borderRadius: '4px', marginTop: '4px', fontSize: '11px', overflowX: 'auto' as 'auto' };

  return (
    <div className="incremental-everything-debug p-4 w-[100%] max-h-[80vh] overflow-y-auto" style={{ fontFamily: 'system-ui, -apple-system, sans-serif', color: 'var(--rn-clr-content-primary)' }}>
      <h2 style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '12px', paddingBottom: '4px', borderBottom: '1px solid var(--rn-clr-background-tertiary)' }}>General Data</h2>
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
           <h2 style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '12px', paddingBottom: '4px', borderBottom: '1px solid var(--rn-clr-background-tertiary)' }}>Card Priority Powerup</h2>
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
