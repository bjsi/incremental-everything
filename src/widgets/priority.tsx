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
  // can be undefined
  const [val, setVal] = React.useState(value);
  React.useEffect(() => {
    if (val != null) {
      onChange(val);
    }
  }, [val]);

  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [inputRef.current]);

  return (
    <div
      onKeyDown={(e) => {
        if (e.key === 'PageUp') {
          setVal(val + 10);
        } else if (e.key === 'PageDown') {
          setVal(val - 10);
        }
      }}
      className="flex flex-col gap-2"
    >
      <div className="rn-clr-content-secondary priority-label">Lower = more important</div>
      <input
        type="range"
        className="priority-slider"
        min={0}
        max={100}
        value={val}
        onChange={(e) => setVal(parseInt(e.target.value))}
      />
      <div className="rn-clr-content-secondary">
        Priority Value:{' '}
        <input
          ref={inputRef}
          autoFocus
          type="number"
          min={0}
          max={100}
          value={val}
          onChange={(e) => setVal(parseInt(e.target.value))}
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
