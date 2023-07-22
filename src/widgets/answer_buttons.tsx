import { renderWidget, usePlugin, useTracker, WidgetLocation } from '@remnote/plugin-sdk';
import { getNextSpacingDateForRem, updateSRSDataForRem } from '../lib/scheduler';
import { IncrementalRem } from '../lib/types';

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
            // get next rep date pure
            const { newHistory, newNextRepDate } = await getNextSpacingDateForRem(plugin, rem._id);
            // update allIncrementalRem in storage to get around reactivity issues
            const oldAllRem: IncrementalRem[] =
              (await plugin.storage.getSession('allIncrementalRem')) || [];
            const oldRem = oldAllRem.find((r) => r.remId === rem._id);
            if (!oldRem) {
              return;
            }
            await plugin.storage.setSession(
              'allIncrementalRem',
              oldAllRem
                .filter((r) => r.remId !== rem._id)
                .concat({
                  ...oldRem,
                  nextRepDate: newNextRepDate,
                  history: newHistory,
                })
            );
            // actually update the rem
            await updateSRSDataForRem(plugin, rem._id, newNextRepDate, newHistory);
            // move to next card
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
