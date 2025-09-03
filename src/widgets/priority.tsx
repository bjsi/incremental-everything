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

  const [absPriority, setAbsPriority] = useState(initialPriority);
  const [relPriority, setRelPriority] = useState(50);

  useEffect(() => {
    setAbsPriority(initialPriority);
  }, [initialPriority]);

  useEffect(() => {
    if (!remId || !allIncrementalRems) return;
    const hypotheticalRems =
      allIncrementalRems.map((r) =>
        r.remId === remId ? { ...r, priority: absPriority } : r
      );
    const newRelPriority = calculateRelativePriority(hypotheticalRems, remId);
    if (newRelPriority !== null) {
      setRelPriority(newRelPriority);
    }
  }, [absPriority, allIncrementalRems, remId]);

  useDebouncedEffect(() => {
    const savePriority = async () => {
      if (!remId) return;
      const rem = await plugin.rem.findOne(remId);
      await rem?.setPowerupProperty(powerupCode, prioritySlotCode, [absPriority.toString()]);
      const newIncRem = await getIncrementalRemInfo(plugin, rem);
      if (newIncRem && allIncrementalRems) {
        const updatedAllRem = allIncrementalRems
          .filter((x) => x.remId !== newIncRem.remId)
          .concat(newIncRem);
        await plugin.storage.setSession(allIncrementalRemKey, updatedAllRem);
      }
    };
    savePriority();
  }, [absPriority, remId], 250);

  const handleRelativeSliderChange = (newRelPriority: number) => {
    setRelPriority(newRelPriority);
    if (!remId || !allIncrementalRems || allIncrementalRems.length < 2) return;
    const otherRems = _.sortBy(
      allIncrementalRems.filter((r) => r.remId !== remId),
      (x) => x.priority
    );
    const targetIndex = Math.floor(((newRelPriority - 1) / 100) * otherRems.length);
    const clampedIndex = Math.max(0, Math.min(otherRems.length - 1, targetIndex));
    const targetAbsPriority = otherRems[clampedIndex]?.priority;
    if (targetAbsPriority !== undefined) {
      setAbsPriority(targetAbsPriority);
    }
  };

  const inputRef = React.useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (remId) {
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 50);
    }
  }, [remId]);

  if (!remId) {
    return null;
  }
  
  return (
    // vvv THE EVENT LISTENER IS NOW HERE vvv
    <div 
      className="flex flex-col p-4 gap-4 priority-popup z-50"
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          plugin.widget.closePopup();
        }
      }}
    >
      <div className="text-2xl font-bold">Set Priority</div>

      <div className="flex flex-col gap-2">
        <div className="flex justify-between items-center">
          <label className="font-semibold">Priority Value (0-100)</label>
          <input
            ref={inputRef}
            type="number"
            min={0}
            max={100}
            value={absPriority}
            onChange={(e) => setAbsPriority(parseInt(e.target.value))}
            className="w-20 text-center"
            // The onKeyDown handler is removed from here
          />
        </div>
        <div className="rn-clr-content-secondary">Lower is more important.</div>
        <div className="relative h-5 flex items-center">
          <div className="absolute w-full h-2 rounded-md bg-gray-200 dark:bg-gray-700"></div>
          <input
            type="range"
            min={0}
            max={100}
            value={absPriority}
            onChange={(e) => setAbsPriority(parseInt(e.target.value))}
            className="absolute w-full custom-transparent-slider"
          />
        </div>
      </div>

      <hr />
      
      <div className="flex flex-col gap-2">
        <div className="flex justify-between items-center min-h-[2.5rem] gap-4">
          <label className="font-semibold">Relative Priority (in entire KB):</label>
          <div className="font-bold flex-shrink-0">{relPriority}%</div>
        </div>
        <div className="rn-clr-content-secondary">
          Position this Rem among all other incremental items.
        </div>
        <div className="relative h-5 flex items-center">
          <div
            className="absolute w-full h-3 rounded-md"
            style={{
              background: `linear-gradient(to right, hsl(0, 80%, 55%), hsl(60, 80%, 55%), hsl(120, 80%, 55%), hsl(240, 80%, 55%))`,
            }}
          ></div>
          <input
            type="range"
            min={1}
            max={100}
            value={relPriority}
            onChange={(e) => handleRelativeSliderChange(parseInt(e.target.value))}
            className="absolute w-full custom-transparent-slider"
          />
        </div>
      </div>
      
    </div>
  );
}

renderWidget(Priority);