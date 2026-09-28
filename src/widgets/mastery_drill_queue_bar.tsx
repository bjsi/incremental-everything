import { renderWidget, usePlugin, useSessionStorageState, useSyncedStorageState } from '@remnote/plugin-sdk';
import React from 'react';
import '../style.css';
import '../App.css';
import { NativeDrillState, nativeDrillStateKey } from '../lib/mastery_drill_launch';
import { FinalDrillEntry, finalDrillIdsKey } from '../lib/mastery_drill_status';

/**
 * The regular-queue Mastery Drill's bar, under the queue's top bar. Renders nothing
 * unless that drill is on screen (lib/mastery_drill_native publishes the state).
 *
 * It carries what the popup drill offered around its embedded queue and the regular
 * queue does not: taking the current card out of the drill, and the card list. Rating,
 * priority and the card info are the regular queue's own, plus every plugin's widgets.
 */
function MasteryDrillQueueBar() {
  const plugin = usePlugin();
  const [state] = useSessionStorageState<NativeDrillState | undefined>(nativeDrillStateKey, undefined);
  const [items, setItems] = useSyncedStorageState<FinalDrillEntry[]>(finalDrillIdsKey, []);
  const [busy, setBusy] = React.useState(false);

  if (!state?.active) return null;

  const removeCurrent = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const card = await plugin.queue.getCurrentCard();
      if (!card) {
        await plugin.app.toast('No card on screen.');
        return;
      }
      const cardId = card._id;
      await setItems(items.filter((item) => (typeof item === 'string' ? item : item.cardId) !== cardId));
      await plugin.queue.removeCurrentCardFromQueue(false);
      await plugin.app.toast('Card removed from the Mastery Drill.');
    } finally {
      setBusy(false);
    }
  };

  const button: React.CSSProperties = {
    padding: '1px 8px',
    fontSize: '11px',
    lineHeight: 1.6,
    borderRadius: '4px',
    border: '1px solid var(--rn-clr-border-primary)',
    background: 'var(--rn-clr-background-primary)',
    color: 'var(--rn-clr-content-secondary)',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  };

  return (
    <div style={{ padding: '2px 12px', fontSize: '12px', color: 'var(--rn-clr-content-secondary)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600, color: 'var(--rn-clr-content-primary)' }}>🎯 Mastery Drill</span>
        <button style={button} disabled={busy} onClick={removeCurrent} title="Take the card on screen out of the drill">
          Remove from Drill
        </button>
        <button
          style={button}
          onClick={() => plugin.widget.openPopup('mastery_drill_list')}
          title="Every card in the drill, and whether RemNote can show it"
        >
          Card List
        </button>
      </div>
      {state.buried && (
        <div style={{ marginTop: '2px', fontSize: '11px' }}>
          RemNote hid some drill cards because a related card was just skipped. At "Time to Take a Break",
          press <b>Keep Practicing</b> (or Esc) to get them. It only affects this drill.
        </div>
      )}
    </div>
  );
}

renderWidget(MasteryDrillQueueBar);
