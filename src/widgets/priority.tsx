import {
  renderWidget,
  usePlugin,
  useRunAsync,
  useTracker,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import React from 'react';
import { allIncrementalRemKey, powerupCode, prioritySlotCode } from '../lib/consts';
import { getIncrementalRemInfo } from '../lib/incremental_rem';
import { IncrementalRem } from '../lib/types';
import { tryParseJson } from '../lib/utils';

interface PrioritySliderProps {
  onChange: (value: number) => void;
  value: number;
}

const PrioritySlider: React.FC<PrioritySliderProps> = ({ onChange, value }) => {
  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = parseInt(event.target.value);
    onChange(newValue);
  };

  const sliderRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (!sliderRef?.current) {
      return;
    }
    sliderRef.current.focus();
  }, [sliderRef?.current]);

  return (
    <div className="flex flex-col gap-2">
      <div className="rn-clr-content-secondary priority-label">Lower = more important</div>
      <input
        ref={sliderRef}
        type="range"
        className="priority-slider"
        min={0}
        max={100}
        value={value}
        onChange={handleChange}
      />
      <div className="rn-clr-content-secondary">
        Priority Value:{' '}
        <input
          type="number"
          min={0}
          max={100}
          value={value}
          onChange={handleChange}
          className="priority-input"
        ></input>
      </div>
    </div>
  );
};

export function Priority() {
  const plugin = usePlugin();
  const ctx = useRunAsync(async () => {
    return await plugin.widget.getWidgetContext<WidgetLocation.Popup>();
  }, []);
  const prioritizedRem = useTracker(
    async (rp) => {
      const rem = await rp.rem.findOne(ctx?.contextData?.remId);
      if (!rem) {
        return null;
      }
      const parsed = IncrementalRem.shape.priority.safeParse(
        tryParseJson(await rem?.getPowerupProperty(powerupCode, prioritySlotCode))
      );
      if (!parsed.success) {
        return null;
      }
      return { rem, priority: parsed.data };
    },
    [ctx?.contextData?.remId]
  );

  if (!prioritizedRem) {
    return null;
  }

  const { rem, priority } = prioritizedRem;

  return (
    <div className="flex flex-col p-4 gap-4 priority-popup">
      <div className="text-2xl font-bold">Priority</div>
      <div className="flex flex-col gap-2 ">
        <PrioritySlider
          value={priority}
          onChange={async (value) => {
            const parsed = IncrementalRem.shape.priority.safeParse(value);
            if (!parsed.success) {
              return;
            }

            await rem?.setPowerupProperty(powerupCode, prioritySlotCode, [parsed.data.toString()]);

            // update allIncrementalRem in storage
            const newIncRem = await getIncrementalRemInfo(plugin, rem);
            if (!newIncRem) {
              return;
            }

            const allIncrementalRem: IncrementalRem[] =
              (await plugin.storage.getSession(allIncrementalRemKey)) || [];
            const updatedAllRem = allIncrementalRem
              .filter((x) => x.remId !== newIncRem.remId)
              .concat(newIncRem);
            await plugin.storage.setSession(allIncrementalRemKey, updatedAllRem);
          }}
        />
      </div>
    </div>
  );
}

renderWidget(Priority);
