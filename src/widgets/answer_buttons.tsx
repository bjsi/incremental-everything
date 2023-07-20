import { renderWidget, usePlugin, useTracker, WidgetLocation } from '@remnote/plugin-sdk';
import { scheduleRem } from '../lib/scheduler';

interface ButtonProps {
  children: React.ReactNode;
  onClick?: () => void;
}

function Button(props: ButtonProps) {
  return (
    <button
      className="bg-blue-50 hover:bg-blue-70 text-white font-bold py-2 px-4 rounded"
      style={{
        height: '40px',
      }}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

export function AnswerButtons() {
  const plugin = usePlugin();
  const ctx = useTracker(
    async (rp) => await rp.widget.getWidgetContext<WidgetLocation.FlashcardAnswerButtons>(),
    []
  );
  const rem = useTracker(async (rp) => await rp.rem.findOne(ctx?.remId), [ctx?.remId]);

  return (
    <div className="flex flex-row justify-center items-center gap-4">
      <Button
        onClick={async () => {
          if (rem) {
            await scheduleRem(plugin, rem._id);
            await plugin.queue.removeCurrentCardFromQueue();
          }
        }}
      >
        Next
      </Button>
    </div>
  );
}

renderWidget(AnswerButtons);
