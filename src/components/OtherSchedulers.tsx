/**
 * The two places the imported other-scheduler list shows up: a label on a card's
 * FSRS figures, and the checkbox that leaves those cards out of an analytics view.
 * Both render nothing without a list, so they stay out of the way for anyone who
 * has not run scripts/export_scheduler_cards.py.
 */
import { usePlugin, useTrackerPlugin } from '@remnote/plugin-sdk';
import React from 'react';
import {
  SchedulerCardsManifest,
  findCardScheduler,
  getSchedulerManifest,
  schedulerTypeLabel,
} from '../lib/scheduler_cards';

/** The list for this KB, read once on mount. */
export function useSchedulerManifest(): SchedulerCardsManifest | null {
  const plugin = usePlugin();
  const [manifest, setManifest] = React.useState<SchedulerCardsManifest | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const kbId = (await plugin.kb.getCurrentKnowledgeBaseData())?._id;
      const found = kbId ? await getSchedulerManifest(plugin as any, kbId) : null;
      if (!cancelled) setManifest(found);
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [plugin]);
  return manifest;
}

/** Marks a card whose FSRS figures are the plugin's model, not what RemNote schedules with. */
export function CardSchedulerLabel({ cardId }: { cardId: string | null | undefined }) {
  const plugin = usePlugin();
  const scheduler = useTrackerPlugin(
    async (rp) => {
      if (!cardId) return null;
      // Through `plugin`, not `rp`, so the tracker doesn't subscribe to the KB record.
      const kbId = (await plugin.kb.getCurrentKnowledgeBaseData())?._id;
      return kbId ? findCardScheduler(rp as any, kbId, cardId) : null;
    },
    [cardId],
  );
  if (!scheduler) return null;

  const type = schedulerTypeLabel(scheduler.type);
  const explanation =
    scheduler.type === 'fsrs'
      ? "RemNote uses that scheduler's own weights for this card."
      : 'RemNote does not use FSRS for this card, so it has no stability there.';
  return (
    <span
      title={
        `RemNote schedules this card with "${scheduler.name}" (${type}), not the Global Default. ` +
        `${explanation} The D, S and R shown here come from the plugin's FSRS settings.`
      }
      style={{
        cursor: 'help',
        whiteSpace: 'nowrap',
        padding: '0 5px',
        borderRadius: 4,
        fontSize: '0.9em',
        color: '#b45309',
        background: 'rgba(245, 158, 11, 0.14)',
      }}
    >
      {scheduler.name} · {type}
    </span>
  );
}

export function ExcludeOtherSchedulersToggle({
  manifest,
  checked,
  disabled,
  onChange,
}: {
  manifest: SchedulerCardsManifest | null;
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  if (!manifest) return null;
  const parts = manifest.schedulers.map(
    (s) => `${s.name} (${schedulerTypeLabel(s.type)}): ${s.cardCount.toLocaleString()}`,
  );
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '5px',
        cursor: disabled ? 'wait' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        color: 'var(--rn-clr-content-secondary)',
      }}
      title={
        'Leave out the cards RemNote schedules with something other than the Global Default, ' +
        "since the plugin's FSRS settings don't describe them.\n\n" +
        `${parts.join('\n')}\n\n` +
        `List from ${new Date(manifest.generatedAt).toLocaleDateString()}. Cards created since then ` +
        'count as Global until you export and import it again.'
      }
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ cursor: disabled ? 'wait' : 'pointer' }}
      />
      Exclude other schedulers
    </label>
  );
}
