import {
  renderWidget,
  usePlugin,
  useRunAsync,
  useTracker,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import { NextRepTime } from '../components/NextRepTime';
import { allIncrementalRemKey } from '../lib/consts';
import { getIncrementalRemInfo } from '../lib/incremental_rem';
import { getNextSpacingDateForRem, updateSRSDataForRem } from '../lib/scheduler';
import { IncrementalRem } from '../lib/types';

interface ButtonProps {
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
}

function Button(props: ButtonProps) {
  return (
    <button
      className={
        'bg-blue-50 hover:bg-blue-70 text-white font-bold py-2 px-4 rounded ' + props.className
      }
      style={{
        height: '45px',
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
  const incRem = useTracker(
    async (rp) => {
      const rem = await rp.rem.findOne(ctx?.remId);
      return rem ? await getIncrementalRemInfo(plugin, rem) : undefined;
    },
    [ctx?.remId]
  );
  const inLookbackMode = !!useRunAsync(async () => await plugin.queue.inLookbackMode(), []);

  return (
    <div className="flex flex-row justify-center items-center gap-4 incremental-everything-answer-buttons">
      <Button
        className="incremental-everthing-next-button"
        onClick={async () => {
          if (incRem) {
            // get next rep date
            const data = await getNextSpacingDateForRem(plugin, incRem.remId, inLookbackMode);
            if (!data) {
              return;
            }
            const { newHistory, newNextRepDate } = data;
            // update allIncrementalRem in storage to get around reactivity issues
            const oldAllRem: IncrementalRem[] =
              (await plugin.storage.getSession(allIncrementalRemKey)) || [];
            const oldRem = oldAllRem.find((r) => r.remId === incRem.remId);
            if (!oldRem) {
              return;
            }
            await plugin.storage.setSession(
              allIncrementalRemKey,
              oldAllRem
                .filter((r) => r.remId !== incRem.remId)
                .concat({
                  ...oldRem,
                  nextRepDate: newNextRepDate,
                  history: newHistory,
                })
            );
            // actually update the rem
            await updateSRSDataForRem(plugin, incRem.remId, newNextRepDate, newHistory);
            // move to next card
            await plugin.queue.removeCurrentCardFromQueue();
          }
        }}
      >
        <div className="flex flex-col items-center justify-center">
          <div>Next</div>
          <div className="text-xs">
            {incRem && <NextRepTime rem={incRem} inLookbackMode={inLookbackMode} />}
          </div>
        </div>
      </Button>
    </div>
  );
}

renderWidget(AnswerButtons);
