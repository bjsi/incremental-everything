import { renderWidget, usePlugin, useTrackerPlugin } from '@remnote/plugin-sdk';
import {
  getSortingRandomness,
  setSortingRandomness,
  DEFAULT_RANDOMNESS,
  getCardsPerRem,
  setCardsPerRem,
  CardsPerRem,
  DEFAULT_CARDS_PER_REM,
  getCardRandomness,  // Add this
  setCardRandomness,   // Add this
  DEFAULT_CARD_RANDOMNESS  // Add this
} from '../lib/sorting';
import { useState, useEffect } from 'react';
import { noIncRemTimerKey } from '../lib/consts';
import { formatCountdown } from '../lib/utils';

const MAX_CARDS = 25;
const ONLY_INC_VALUE = 0;
const ONLY_FLASHCARDS_VALUE = MAX_CARDS + 1;

// Convert the stored value (number or string) to a slider position
const cardsToSliderValue = (cards: CardsPerRem): number => {
  if (cards === 'no-cards') return ONLY_INC_VALUE;
  if (cards === 'no-rem') return ONLY_FLASHCARDS_VALUE;
  if (typeof cards === 'number') return cards;
  return DEFAULT_CARDS_PER_REM;
};

// Convert the slider position back to a value for storage
const sliderValueToCards = (value: number): CardsPerRem => {
  if (value === ONLY_INC_VALUE) return 'no-cards';
  if (value === ONLY_FLASHCARDS_VALUE) return 'no-rem';
  return value;
};

// Generate the display text
const sliderValueToLabel = (value: number): string => {
  if (value === ONLY_INC_VALUE) return 'Only Incremental Rem';
  if (value === ONLY_FLASHCARDS_VALUE) return 'Only Flashcards';
  return `${value} card${value !== 1 ? 's' : ''} for every incremental rem`;
};

const sliderTicks = (
  <div className="flex justify-between w-full px-2 text-[10px] text-gray-400 mt-[-4px] pointer-events-none">
    {[...Array(21)].map((_, i) => (
      <span key={i}>{i % 5 === 0 ? '|' : '·'}</span>
    ))}
  </div>
);

const formatPercentage = (val: number) => {
  const pct = val * 100;
  if (pct > 0 && pct < 1) {
    return pct.toFixed(1);
  }
  return Math.round(pct).toString();
};

export function SortingCriteria() {
  const plugin = usePlugin();

  // --- ALL HOOKS MOVED TO THE TOP ---
  const sortingRandomness = useTrackerPlugin(async (rp) => await getSortingRandomness(rp), []);
  const storedCards = useTrackerPlugin(async (rp) => await getCardsPerRem(rp), []);

  //No Inc Rem timer
  const noIncRemTimerEnd = useTrackerPlugin(
    async (rp) => await rp.storage.getSynced<number>(noIncRemTimerKey),
    []
  );

  const cardRandomness = useTrackerPlugin(
    async (rp) => await getCardRandomness(rp),
    []
  );

  const currentKbName = useTrackerPlugin(
    async (rp) => (await rp.kb.getCurrentKnowledgeBaseData())?.name,
    []
  );

  const [sliderValue, setSliderValue] = useState<number | undefined>(undefined);

  const [currentTime, setCurrentTime] = useState(Date.now());

  // --- EFFECTS ---
  // Add timer update effect
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(Date.now());
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (storedCards !== undefined) {
      setSliderValue(cardsToSliderValue(storedCards));
    }
  }, [storedCards]);

  // --- EVENT HANDLER ---
  const handleSliderChange = (value: number) => {
    setSliderValue(value);
    setCardsPerRem(plugin, sliderValueToCards(value));
  };

  // --- CONDITIONAL RETURN ---

  if (sliderValue === undefined) {
    return null;
  }

  // --- RENDER LOGIC ---
  const isTimerActive = noIncRemTimerEnd && noIncRemTimerEnd > currentTime;
  const timeRemainingMs = isTimerActive ? noIncRemTimerEnd - currentTime : 0;


  return (
    <div className="flex flex-col p-4 gap-4">
      {/* Timer notification if active */}
      {isTimerActive && (
        <div style={{
          padding: '12px',
          marginBottom: '4px',
          backgroundColor: '#fef3c7',
          borderRadius: '6px',
          border: '2px solid #f59e0b',
        }}>
          <div style={{ fontSize: '14px', fontWeight: 600, color: '#92400e', marginBottom: '4px' }}>
            ⏱️ No Inc Rem Timer Active
          </div>
          <div style={{ fontSize: '13px', color: '#78350f', marginBottom: '8px' }}>
            Only flashcards are being shown. Time remaining: {formatCountdown(timeRemainingMs)}
          </div>
          <div style={{ fontSize: '11px', color: '#92400e', fontStyle: 'italic' }}>
            Note: The settings below are temporarily overridden while this timer is active.
          </div>
          <button
            onClick={async () => {
              await plugin.storage.setSynced(noIncRemTimerKey, null);
              await plugin.app.toast('Timer cancelled - Incremental rems re-enabled');
            }}
            style={{
              marginTop: '8px',
              padding: '6px 12px',
              fontSize: '12px',
              backgroundColor: '#dc2626',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontWeight: 500
            }}
          >
            Cancel Timer & Re-enable Inc Rems
          </button>
        </div>
      )}

      <div className="text-2xl font-bold">Sorting Criteria</div>
      {currentKbName && (
        <div className="rn-clr-content-secondary text-sm italic mt-[-8px]">
          Knowledge Base: {currentKbName}
        </div>
      )}

      {/* Randomness slider is unchanged */}
      <div className="flex flex-col gap-2 ">
        <div>
          <label htmlFor="randomness" className="font-semibold">
            Incremental Rem Randomness
          </label>
        </div>
        <div className="rn-clr-content-secondary">
          {formatPercentage(sortingRandomness ?? DEFAULT_RANDOMNESS)}% of Items Swapped
        </div>
        <input
          className="w-full"
          min={0}
          step={0.01}
          max={1}
          onChange={(e) => {
            const sliderPosition = Number(e.target.value);
            setSortingRandomness(plugin, Math.pow(sliderPosition, 3));
          }}
          value={sortingRandomness == null ? DEFAULT_RANDOMNESS : Math.cbrt(sortingRandomness)}
          type="range"
          id="randomness"
          name="randomness"
        />
        {sliderTicks}
      </div>

      {/* Flashcard Randomness slider */}
      <div className="flex flex-col gap-2">
        <div>
          <label htmlFor="card-randomness" className="font-semibold">
            Flashcard Randomness
          </label>
        </div>
        <div className="rn-clr-content-secondary text-xs italic">
          For Priority Review Documents (do not affect regular RemNote Queue!)
        </div>
        <div className="rn-clr-content-secondary">
          {formatPercentage(cardRandomness ?? DEFAULT_CARD_RANDOMNESS)}% of Items Swapped
        </div>
        <input
          className="w-full"
          min={0}
          step={0.01}
          max={1}
          onChange={(e) => {
            const sliderPosition = Number(e.target.value);
            setCardRandomness(plugin, Math.pow(sliderPosition, 3));
          }}
          value={cardRandomness == null ? DEFAULT_CARD_RANDOMNESS : Math.cbrt(cardRandomness)}
          type="range"
          id="card-randomness"
          name="card-randomness"
        />
        {sliderTicks}
      </div>

      {/* Simplified Flashcard Ratio Section */}
      <div className="flex flex-col gap-2 ">
        <div>
          <label htmlFor="ratio" className="font-semibold">
            Flashcard Ratio
          </label>
        </div>
        <div className="rn-clr-content-secondary">
          {sliderValueToLabel(sliderValue)}
        </div>
        <input
          min={ONLY_INC_VALUE}
          max={ONLY_FLASHCARDS_VALUE}
          step={1}
          onChange={(e) => handleSliderChange(Number(e.target.value))}
          type="range"
          id="ratio"
          name="ratio"
          value={sliderValue}
        />
      </div>
    </div>
  );
}

renderWidget(SortingCriteria);