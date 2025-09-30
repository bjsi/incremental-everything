import { renderWidget, usePlugin, useTracker } from '@remnote/plugin-sdk';
import {
  getSortingRandomness,
  setSortingRandomness,
  DEFAULT_RANDOMNESS,
  getCardsPerRem,
  setCardsPerRem,
  CardsPerRem,
  DEFAULT_CARDS_PER_REM,
} from '../lib/sorting';
import { useState, useEffect } from 'react';
import { noIncRemTimerKey } from '../lib/consts';

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


export function SortingCriteria() {
  const plugin = usePlugin();

  const sortingRandomness = useTracker(async (rp) => await getSortingRandomness(rp), []);
  const storedCards = useTracker(async (rp) => await getCardsPerRem(rp), []);
  const [sliderValue, setSliderValue] = useState<number | undefined>(undefined);

    //No Inc Rem timer
  const noIncRemTimerEnd = useTracker(
    async (rp) => await rp.storage.getSynced<number>(noIncRemTimerKey),
    []
  );

  const [currentTime, setCurrentTime] = useState(Date.now());

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

  const handleSliderChange = (value: number) => {
    setSliderValue(value);
    setCardsPerRem(plugin, sliderValueToCards(value));
  };

  if (sliderValue === undefined) {
    return null; 
  }


  const isTimerActive = noIncRemTimerEnd && noIncRemTimerEnd > currentTime;
  const timeRemainingMs = isTimerActive ? noIncRemTimerEnd - currentTime : 0;
  const minutes = Math.floor(timeRemainingMs / 60000);
  const seconds = Math.floor((timeRemainingMs % 60000) / 1000);

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
              Only flashcards are being shown. Time remaining: {minutes}:{seconds.toString().padStart(2, '0')}
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

      {/* Randomness slider is unchanged */}
      <div className="flex flex-col gap-2 ">
        <div>
          <label htmlFor="randomness" className="font-semibold">
            Randomness
          </label>
        </div>
        <div className="rn-clr-content-secondary">Higher = ignores priority more</div>
        <input
          min={0}
          step={0.01}
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