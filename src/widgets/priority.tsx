import {
  renderWidget,
  usePlugin,
  useRunAsync,
  useTracker,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import React from 'react';
import { powerupCode, prioritySlotCode } from '../lib/consts';

interface PrioritySliderProps {
  onChange: (value: number) => void;
  value: number;
}

const PrioritySlider: React.FC<PrioritySliderProps> = ({ onChange, value }) => {
  const handleSliderChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = parseInt(event.target.value, 10);
    onChange(newValue);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="rn-clr-content-secondary">Higher = more important</div>
      <input
        type="range"
        id="priority-slider"
        name="priority-slider"
        min={0}
        max={100}
        value={value}
        onChange={handleSliderChange}
      />
      <div className="rn-clr-content-secondary">Priority Value: {value}</div>
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
      const priority = JSON.parse(await rem?.getPowerupProperty(powerupCode, prioritySlotCode));
      if (priority == null) {
        return null;
      }
      return { rem, priority };
    },
    [ctx?.contextData?.remId]
  );

  if (!prioritizedRem) {
    return null;
  }

  const { rem, priority } = prioritizedRem;

  return (
    <div className="flex flex-col p-4 gap-4">
      <div className="text-2xl font-bold">Priority</div>
      <div className="flex flex-col gap-2 ">
        <PrioritySlider
          value={priority}
          onChange={(value) =>
            rem?.setPowerupProperty(powerupCode, prioritySlotCode, [value.toString()])
          }
        />
      </div>
    </div>
  );
}

renderWidget(Priority);
