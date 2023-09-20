import { renderWidget, usePlugin, useRunAsync, useTracker } from '@remnote/plugin-sdk';
import {
  getSortingRandomness,
  getRatioBetweenCardsAndIncrementalRem,
  setSortingRandomness,
  DEFAULT_RANDOMNESS,
  DEFAULT_RATIO,
  setRatioBetweenCardsAndIncrementalRem,
  getNumCardsPerIncRem,
} from '../lib/sorting';

export function SortingCriteria() {
  const plugin = usePlugin();
  const sortingRandomness = useTracker(async (rp) => await getSortingRandomness(rp), []);
  const ratioCardsAndIncRem = useTracker(
    async (rp) => await getRatioBetweenCardsAndIncrementalRem(rp),
    []
  );
  const cardsPerIncRem = useRunAsync(async () => {
    return await getNumCardsPerIncRem(plugin);
  }, [ratioCardsAndIncRem]);
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
          step={0.1}
          max={1}
          onChange={(e) => {
            setSortingRandomness(plugin, Number(e.target.value));
          }}
          value={sortingRandomness == null ? DEFAULT_RANDOMNESS : sortingRandomness}
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
        {cardsPerIncRem != null && (
          <div className="rn-clr-content-secondary">
            {typeof cardsPerIncRem === 'string'
              ? cardsPerIncRem
              : `${cardsPerIncRem} card${
                  cardsPerIncRem !== 1 ? 's' : ''
                } for every incremental rem`}
          </div>
        )}
        <input
          min={0}
          max={1}
          step={0.01}
          onChange={(e) => setRatioBetweenCardsAndIncrementalRem(plugin, Number(e.target.value))}
          type="range"
          id="ratio"
          name="ratio"
          value={
            ratioCardsAndIncRem == null
              ? DEFAULT_RATIO
              : ratioCardsAndIncRem === 'no-cards'
              ? 0
              : ratioCardsAndIncRem === 'no-rem'
              ? 1
              : ratioCardsAndIncRem
          }
        />
      </div>
    </div>
  );
}

renderWidget(SortingCriteria);
