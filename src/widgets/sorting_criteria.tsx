import { renderWidget, usePlugin, useTrackerPlugin } from '@remnote/plugin-sdk';
import {
  getSortingRandomness,
  setSortingRandomness,
  DEFAULT_RANDOMNESS,
  getCardsPerRem,
  setCardsPerRem,
  CardsPerRem,
  DEFAULT_CARDS_PER_REM,
  getCardRandomness,
  setCardRandomness,
  DEFAULT_CARD_RANDOMNESS,
  SortingPreset,
  getSortingPresets,
  setSortingPresets,
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

  const savedPresets = useTrackerPlugin(async (rp) => await getSortingPresets(rp), []);
  const presets = savedPresets ?? [];

  const [sliderValue, setSliderValue] = useState<number | undefined>(undefined);
  const [selectedPresetName, setSelectedPresetName] = useState('');
  const [newPresetName, setNewPresetName] = useState('');

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

  useEffect(() => {
    if (sortingRandomness === undefined || cardRandomness === undefined || storedCards === undefined) return;
    const match = (savedPresets ?? []).find(
      (p) =>
        p.randomness === sortingRandomness &&
        p.cardRandomness === cardRandomness &&
        p.cardsPerRem === storedCards
    );
    setSelectedPresetName(match?.name ?? '');
  }, [sortingRandomness, cardRandomness, storedCards, savedPresets]);

  // --- EVENT HANDLER ---
  const handleSliderChange = (value: number) => {
    setSliderValue(value);
    setCardsPerRem(plugin, sliderValueToCards(value));
  };

  const handleLoadPreset = async (name: string) => {
    const preset = presets.find(p => p.name === name);
    if (!preset) return;
    await setSortingRandomness(plugin, preset.randomness);
    await setCardRandomness(plugin, preset.cardRandomness);
    await setCardsPerRem(plugin, preset.cardsPerRem);
    await plugin.app.toast(`Loaded preset "${name}"`);
  };

  const handleSavePreset = async () => {
    const name = newPresetName.trim();
    if (!name) return;
    const preset: SortingPreset = {
      name,
      randomness: sortingRandomness ?? DEFAULT_RANDOMNESS,
      cardRandomness: cardRandomness ?? DEFAULT_CARD_RANDOMNESS,
      cardsPerRem: sliderValueToCards(sliderValue!),
    };
    const updated = [...presets.filter(p => p.name !== name), preset];
    await setSortingPresets(plugin, updated);
    setNewPresetName('');
    await plugin.app.toast(`Saved preset "${name}"`);
  };

  const handleDeletePreset = async (name: string) => {
    const updated = presets.filter(p => p.name !== name);
    await setSortingPresets(plugin, updated);
    await plugin.app.toast(`Deleted preset "${name}"`);
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

      {/* Preset Selector */}
      <div style={{
        border: '1px solid var(--rn-clr-border-primary)',
        borderRadius: '6px',
        padding: '10px 12px',
        backgroundColor: 'var(--rn-clr-background-secondary)',
      }}>
        <div className="text-xs font-semibold mb-2" style={{ color: 'var(--rn-clr-content-secondary)' }}>
          🎛️ Presets
        </div>
        {presets.length > 0 && (
          <div className="flex items-center gap-2 mb-2">
            <select
              value={selectedPresetName}
              onChange={(e) => handleLoadPreset(e.target.value)}
              className="text-xs px-2 py-1 rounded flex-1"
              style={{
                border: '1px solid var(--rn-clr-border-primary)',
                backgroundColor: 'var(--rn-clr-background-primary)',
                color: 'var(--rn-clr-content-primary)',
              }}
            >
              <option value="">— select to load —</option>
              {presets.map((p) => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
            </select>
            {selectedPresetName && (
              <button
                onClick={() => handleDeletePreset(selectedPresetName)}
                className="text-xs px-2 py-1 rounded"
                style={{ backgroundColor: '#dc2626', color: 'white', border: 'none', cursor: 'pointer' }}
                title="Delete this preset"
              >
                Delete
              </button>
            )}
          </div>
        )}
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={newPresetName}
            onChange={(e) => setNewPresetName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSavePreset(); }}
            placeholder="Preset name…"
            className="text-xs px-2 py-1 rounded flex-1"
            style={{
              border: '1px solid var(--rn-clr-border-primary)',
              backgroundColor: 'var(--rn-clr-background-primary)',
              color: 'var(--rn-clr-content-primary)',
            }}
          />
          <button
            onClick={handleSavePreset}
            disabled={!newPresetName.trim()}
            className="text-xs px-2 py-1 rounded"
            style={{
              backgroundColor: newPresetName.trim() ? '#3b82f6' : 'var(--rn-clr-background-tertiary)',
              color: newPresetName.trim() ? 'white' : 'var(--rn-clr-content-tertiary)',
              border: 'none',
              cursor: newPresetName.trim() ? 'pointer' : 'default',
            }}
          >
            💾 Save
          </button>
        </div>
      </div>

      {/* Randomness sliders — priority-weighted lottery (quadratic slider scaling) */}
      <div className="flex flex-col gap-2 ">
        <div>
          <label htmlFor="randomness" className="font-semibold">
            Incremental Rem Randomness
          </label>
        </div>
        <div className="rn-clr-content-secondary text-xs italic">
          Higher values stay priority-safe: the randomized share favors higher-priority items.
        </div>
        <div className="rn-clr-content-secondary">
          {formatPercentage(sortingRandomness ?? DEFAULT_RANDOMNESS)}% randomized (priority-weighted)
        </div>
        <input
          className="w-full"
          min={0}
          step={0.01}
          max={1}
          onChange={(e) => {
            const sliderPosition = Number(e.target.value);
            setSortingRandomness(plugin, Math.pow(sliderPosition, 2));
          }}
          value={Math.sqrt(sortingRandomness ?? DEFAULT_RANDOMNESS)}
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
          {formatPercentage(cardRandomness ?? DEFAULT_CARD_RANDOMNESS)}% randomized (priority-weighted)
        </div>
        <input
          className="w-full"
          min={0}
          step={0.01}
          max={1}
          onChange={(e) => {
            const sliderPosition = Number(e.target.value);
            setCardRandomness(plugin, Math.pow(sliderPosition, 2));
          }}
          value={Math.sqrt(cardRandomness ?? DEFAULT_CARD_RANDOMNESS)}
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