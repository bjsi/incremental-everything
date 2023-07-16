import { renderWidget, usePlugin, useTracker } from '@remnote/plugin-sdk';
import {
  getSortingRandomness,
  getRatioBetweenCardsAndIncrementalRem,
  setSortingRandomness,
  DEFAULT_RANDOMNESS,
  DEFAULT_RATIO,
  setRatioBetweenCardsAndIncrementalRem,
} from '../lib/sorting';

export function SortingCriteria() {
  const plugin = usePlugin();
  const sortingRandomness = useTracker(async (rp) => await getSortingRandomness(rp), []);
  const ratioBetweenCardsAndIncrementalRem = useTracker(
    async (rp) => await getRatioBetweenCardsAndIncrementalRem(rp),
    []
  );
  return (
    <div className="flex flex-col p-4 gap-4">
      <div className="text-2xl font-bold">Sorting Criteria</div>
      <div className="flex flex-col gap-2 ">
        <div>
          <label htmlFor="randomness" className="font-semibold">
            Randomness
          </label>
        </div>
        <div className="rn-clr-content-secondary">Higher = ignores priority more</div>
        <input
          min={0}
          step={0.05}
          max={1}
          onChange={(e) => {
            setSortingRandomness(plugin, Number(e.target.value));
          }}
          value={sortingRandomness || DEFAULT_RANDOMNESS}
          type="range"
          id="randomness"
          name="randomness"
        />
      </div>
      <div className="flex flex-col gap-2 ">
        <div>
          <label htmlFor="ratio" className="font-semibold">
            Flashcard Ratio
          </label>
        </div>
        <div className="rn-clr-content-secondary">
          {Math.round(
            1 /
              (ratioBetweenCardsAndIncrementalRem != null
                ? ratioBetweenCardsAndIncrementalRem
                : DEFAULT_RATIO)
          )}{' '}
          cards for every incremental rem
        </div>
        <input
          min={0}
          max={1}
          step={0.05}
          onChange={(e) => setRatioBetweenCardsAndIncrementalRem(plugin, Number(e.target.value))}
          type="range"
          id="ratio"
          name="ratio"
          value={ratioBetweenCardsAndIncrementalRem || DEFAULT_RATIO}
        />
      </div>
    </div>
  );
}

renderWidget(SortingCriteria);
