import {
  renderWidget,
  RNPlugin,
  usePlugin,
  useRunAsync,
  useTracker,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import { NextRepTime } from '../components/NextRepTime';
import { allIncrementalRemKey, powerupCode } from '../lib/consts';
import { getIncrementalRemInfo, handleHextRepetitionClick } from '../lib/incremental_rem';
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
  return (
    <div className="flex flex-row justify-center items-center gap-6 incremental-everything-answer-buttons">
      <Button
        className="incremental-everthing-next-button"
        onClick={async () => {
          handleHextRepetitionClick(plugin, incRem);
        }}
      >
        <div className="flex flex-col items-center justify-center">
          <div>Next</div>
          <div className="text-xs">{incRem && <NextRepTime rem={incRem} />}</div>
        </div>
      </Button>
      <Button
        className="incremental-everthing-done-button"
        onClick={async () => {
          const rem = await plugin.rem.findOne(incRem?.remId);
          if (!rem) {
            return;
          }
          const updatedAllRem: IncrementalRem[] = (
            ((await plugin.storage.getSession(allIncrementalRemKey)) || []) as IncrementalRem[]
          ).filter((r) => r.remId !== rem._id);
          await plugin.storage.setSession(allIncrementalRemKey, updatedAllRem);
          await plugin.queue.removeCurrentCardFromQueue(true);
          await rem.removePowerup(powerupCode);
        }}
      >
        <div className="flex flex-col items-center justify-center">
          <div>Done</div>
          <div className="text-xs">Untag this Rem</div>
        </div>
      </Button>
    </div>
  );
}

renderWidget(AnswerButtons);
