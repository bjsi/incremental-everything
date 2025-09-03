import {
  renderWidget,
  usePlugin,
  useRunAsync,
  useTracker,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import React, { useState, useEffect } from 'react';
import { allIncrementalRemKey, powerupCode, prioritySlotCode } from '../lib/consts';
import { getIncrementalRemInfo } from '../lib/incremental_rem';
import { calculateRelativePriority } from '../lib/priority';
import { IncrementalRem } from '../lib/types';
import * as _ from 'remeda';

// Debounce function to prevent too many writes while sliding
function useDebouncedEffect(effect: () => void, deps: React.DependencyList, delay: number) {
  useEffect(() => {
    const handler = setTimeout(() => effect(), delay);
    return () => clearTimeout(handler);
  }, [...deps, delay]);
}

export function Priority() {
  const plugin = usePlugin();
  
  const ctx = useRunAsync(
    async () => await plugin.widget.getWidgetContext<WidgetLocation.Popup>(),
    []
  );

  const remId = ctx?.contextData?.remId;

  const allIncrementalRems = useTracker(
    (rp) => rp.storage.getSession<IncrementalRem[]>(allIncrementalRemKey),
    []
  );

  const initialPriority = useTracker(async (rp) => {
    if (!remId) return 10;
    const rem = await rp.rem.findOne(remId);
    if (!rem) return 10;
    const incRem = await getIncrementalRemInfo(plugin, rem);
    return incRem?.priority ?? 10;
  }, [remId]);

  // State for the absolute priority (0-100)
  const [absPriority, setAbsPriority] = useState(initialPriority);
  // State for the relative priority percentile (1-100)
  const [relPriority, setRelPriority] = useState(50);

  // Update the absolute priority when the initial value loads
  useEffect(() => {
    setAbsPriority(initialPriority);
  }, [initialPriority]);

  // EFFECT 1: Update RELATIVE priority when ABSOLUTE priority changes
  useEffect(() => {
    if (!remId || !allIncrementalRems) return;

    // Create a hypothetical list with the updated priority for the current rem
    const hypotheticalRems =
      allIncrementalRems.map((r) =>
        r.remId === remId ? { ...r, priority: absPriority } : r
      );

    const newRelPriority = calculateRelativePriority(hypotheticalRems, remId);
    if (newRelPriority !== null) {
      setRelPriority(newRelPriority);
    }
  }, [absPriority, allIncrementalRems, remId]);

  // EFFECT 2: Save the debounced absolute priority to RemNote
  useDebouncedEffect(() => {
    const savePriority = async () => {
      if (!remId) return;
      const rem = await plugin.rem.findOne(remId);
      await rem?.setPowerupProperty(powerupCode, prioritySlotCode, [absPriority.toString()]);

      // Update the master list in session storage for instant feedback elsewhere
      const newIncRem = await getIncrementalRemInfo(plugin, rem);
      if (newIncRem && allIncrementalRems) {
        const updatedAllRem = allIncrementalRems
          .filter((x) => x.remId !== newIncRem.remId)
          .concat(newIncRem);
        await plugin.storage.setSession(allIncrementalRemKey, updatedAllRem);
      }
    };
    savePriority();
  }, [absPriority, remId], 250); // 250ms debounce delay

  // HANDLER: Update ABSOLUTE priority when RELATIVE slider changes
  const handleRelativeSliderChange = (newRelPriority: number) => {
    setRelPriority(newRelPriority);
    if (!remId || !allIncrementalRems || allIncrementalRems.length < 2) {
      return;
    }

    // Get all other rems, sorted by their priority
    const otherRems = _.sortBy(
      allIncrementalRems.filter((r) => r.remId !== remId),
      (x) => x.priority
    );

    // Calculate the target index based on the desired percentile
    const targetIndex = Math.floor(((newRelPriority - 1) / 100) * otherRems.length);
    const clampedIndex = Math.max(0, Math.min(otherRems.length - 1, targetIndex));

    // Set the absolute priority to match the priority of the rem at that target position
    const targetAbsPriority = otherRems[clampedIndex]?.priority;
    if (targetAbsPriority !== undefined) {
      setAbsPriority(targetAbsPriority);
    }
  };

  const inputRef = React.useRef<HTMLInputElement>(null);

  // --- THIS IS THE FIX ---
  // This effect now waits for `remId` to be loaded before trying to set the focus.
  // The setTimeout ensures the browser has finished rendering the input before we try to focus it.
  useEffect(() => {
    if (remId) {
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 50); // 50ms delay for robustness
    }
  }, [remId]);

  if (!remId) {
    return null;
  }
  
  return (
    <div className="flex flex-col p-4 gap-4 priority-popup">
      <div className="text-2xl font-bold">Set Priority</div>

      {/* --- Absolute Priority Input --- */}
      <div className="flex flex-col gap-2">
        <label className="font-semibold">Priority Value (0-100)</label>
        <div className="rn-clr-content-secondary">Lower is more important.</div>
        <div className="flex items-center gap-4">
          <input
            type="range"
            min={0}
            max={100}
            value={absPriority}
            onChange={(e) => setAbsPriority(parseInt(e.target.value))}
            className="flex-grow"
          />
          <input
            ref={inputRef}
            type="number"
            min={0}
            max={100}
            value={absPriority}
            onChange={(e) => setAbsPriority(parseInt(e.target.value))}
            className="w-20 text-center"
            onKeyDown={(e) => e.key === 'Enter' && plugin.widget.closePopup()}
          />
        </div>
      </div>

      <hr />

      {/* --- Relative Priority Slider --- */}
      <div className="flex flex-col gap-2">
        <label className="font-semibold">Relative Priority (in entire KB)</label>
        <div className="rn-clr-content-secondary">
          Position this Rem among all other incremental items.
        </div>
        <div className="flex items-center gap-4">
          <input
            type="range"
            min={1}
            max={100}
            value={relPriority}
            onChange={(e) => handleRelativeSliderChange(parseInt(e.target.value))}
            className="flex-grow"
          />
          <div className="w-20 text-center font-bold">{relPriority}%</div>
        </div>
      </div>
    </div>
  );
}

renderWidget(Priority);