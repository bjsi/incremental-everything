import {
  renderWidget,
  usePlugin,
  useRunAsync,
  useTracker,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import { getIncrementalRemInfo } from '../lib/incremental_rem';

interface InfoProps {
  className: string;
  label: string;
  data: any;
}

const Info = (props: InfoProps) => {
  return (
    <div className="flex flex-row gap-2">
      <div className="font-semibold">{props.label}</div>
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
  const incrementalRem = useTracker(
    async (rp) => {
      const rem = await rp.rem.findOne(remId);
      if (!rem) {
        return null;
      }
      const incrementalRem = await getIncrementalRemInfo(rem);
      return incrementalRem;
    },
    [remId]
  );

  return (
    <div className="incremental-everything-debug p-3">
      <Info className="rem-id" label="Rem ID" data={remId} />
      <Info className="next-rep-date" label="Next Rep Date" data={incrementalRem?.nextRepDate} />
      <Info className="priority" label="Priority" data={incrementalRem?.priority} />
      <Info
        className="history"
        label="History"
        data={incrementalRem?.history ? JSON.stringify(incrementalRem?.history, null, 2) : '[]'}
      />
    </div>
  );
}

renderWidget(Debug);