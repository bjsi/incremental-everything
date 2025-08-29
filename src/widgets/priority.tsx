import {
  renderWidget,
  usePlugin,
  useRunAsync,
  useTracker,
  WidgetLocation,
  RNPlugin, // Import RNPlugin for type safety
} from '@remnote/plugin-sdk';
import React from 'react';
import { allIncrementalRemKey, powerupCode, prioritySlotCode, defaultPriorityId } from '../lib/consts';
import { getIncrementalRemInfo } from '../lib/incremental_rem';
import { IncrementalRem } from '../lib/types';

// The props for the slider now include the plugin instance
interface PrioritySliderProps {
  onChange: (value: number) => void;
  value: number;
  plugin: RNPlugin; // Add this line
}

const PrioritySlider: React.FC<PrioritySliderProps> = ({ onChange, value, plugin }) => {
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
          setVal(Math.min(val + 10, 100));
        } else if (e.key === 'PageDown') {
          setVal(Math.max(val - 10, 0));
        } else if (e.key === 'Enter') {
            // Also allow pressing Enter on the slider to close
            plugin.widget.closePopup();
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
          onChange={(e) => {
            const num = parseInt(e.target.value);
            if (!isNaN(num)) {
              setVal(Math.min(100, Math.max(0, num)));
            }
          }}
          // --- START OF CHANGE ---
          // This onKeyDown handler closes the popup when "Enter" is pressed.
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              plugin.widget.closePopup();
            }
          }}
          // --- END OF CHANGE ---
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
  
  const defaultPriority = useTracker(
    async (rp) => {
        const settingValue = (await rp.settings.getSetting<number>(defaultPriorityId)) || 10;
        return Math.min(100, Math.max(0, settingValue));
    },
    []
  );

  const prioritizedRem = useTracker(
    async (rp) => {
      const rem = await rp.rem.findOne(ctx?.contextData?.remId);
      if (!rem) {
        return null;
      }
      
      const priorityRichText = await rem.getPowerupPropertyAsRichText(powerupCode, prioritySlotCode);
      let priority = defaultPriority;
      if (priorityRichText && priorityRichText.length > 0) {
        const priorityString = await rp.richText.toString(priorityRichText);
        const parsedPriority = parseInt(priorityString, 10);
        if (!isNaN(parsedPriority)) {
          priority = parsedPriority;
        }
      }
      
      return { rem, priority };
    },
    [ctx?.contextData?.remId, defaultPriority]
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
          plugin={plugin} // Pass the plugin instance to the slider component
          onChange={async (value) => {
            const parsed = IncrementalRem.shape.priority.safeParse(value);
            if (!parsed.success) {
              return;
            }

            await rem?.setPowerupProperty(powerupCode, prioritySlotCode, [parsed.data.toString()]);

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