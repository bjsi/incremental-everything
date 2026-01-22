import {
    renderWidget,
    usePlugin,
    useRunAsync,
    useTrackerPlugin,
} from '@remnote/plugin-sdk';
import React, { useCallback, useEffect, useState, useRef } from 'react';
import {
    powerupCode,
    prioritySlotCode,
    defaultPriorityId,
    defaultCardPriorityId,
} from '../lib/consts';
import {
    CARD_PRIORITY_CODE,
    PRIORITY_SLOT,
    setCardPriority,
} from '../lib/card_priority';
import { updateIncrementalRemCache } from '../lib/incremental_rem/cache';
import { updateCardPriorityCache, flushLightCacheUpdates } from '../lib/card_priority/cache';
import { PrioritySlider, PrioritySliderRef } from '../components';
import { useAcceleratedKeyboardHandler } from '../lib/keyboard_utils';
import { initIncrementalRem } from '../lib/incremental_rem';

function PriorityLight() {
    const plugin = usePlugin();

    // Refs for focusing
    const incSliderRef = useRef<PrioritySliderRef>(null);
    const cardSliderRef = useRef<PrioritySliderRef>(null);
    const isSaving = useRef(false);

    // 1. Fast Context Retrieval
    const context = useRunAsync(async () => {
        // Use 'any' to bypass strict WidgetLocation constraint for custom popup context
        return await plugin.widget.getWidgetContext<any>();
    }, []);

    const remId = context?.contextData?.remId;

    // 2. Ultra-Fast Data Fetching (O(1))
    // We only fetch the primitive values needed to render the sliders.
    // We avoid heavy object construction (like getIncrementalRemFromRem or card stats).
    const data = useTrackerPlugin(async (rp) => {
        if (!remId) return null;
        const rem = await rp.rem.findOne(remId);
        if (!rem) return null;

        // Parallel fetch for speed
        const [
            incPStr,
            cardPStr,
            hasIncPowerup,
            hasCardPowerup,
            defaultInc,
            defaultCard
        ] = await Promise.all([
            rem.getPowerupProperty(powerupCode, prioritySlotCode),
            rem.getPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT),
            rem.hasPowerup(powerupCode),
            rem.hasPowerup('cardPriority'), // check using string or const if available
            rp.settings.getSetting<number>(defaultPriorityId),
            rp.settings.getSetting<number>(defaultCardPriorityId)
        ]);

        return {
            rem,
            incPriority: incPStr ? parseInt(incPStr) : null,
            cardPriority: cardPStr ? parseInt(cardPStr) : null,
            hasIncPowerup,
            hasCardPowerup,
            defaults: {
                inc: defaultInc || 50,
                card: defaultCard || 50
            }
        };
    }, [remId]);

    // State
    const [incVal, setIncVal] = useState<number | null>(null);
    const [cardVal, setCardVal] = useState<number | null>(null);

    // Sync State with Data (only if not saving/dirty)
    useEffect(() => {
        if (data && !isSaving.current) {
            if (incVal === null && data.incPriority !== null) setIncVal(data.incPriority);
            if (cardVal === null && data.cardPriority !== null) setCardVal(data.cardPriority);

            // If null, set defaults for the slider visual (but don't save yet)
            if (incVal === null && data.incPriority === null) setIncVal(data.defaults.inc);
            if (cardVal === null && data.cardPriority === null) setCardVal(data.defaults.card);
        }
    }, [data]);

    // Keyboard Handlers
    const incKeyboard = useAcceleratedKeyboardHandler(
        incVal,
        incVal ?? 50,
        (val) => setIncVal(Math.max(0, Math.min(100, val)))
    );

    const cardKeyboard = useAcceleratedKeyboardHandler(
        cardVal,
        cardVal ?? 50,
        (val) => setCardVal(Math.max(0, Math.min(100, val)))
    );

    // Focus Logic
    useEffect(() => {
        if (!data) return;
        setTimeout(() => {
            // If we are showing the Inc section (it has powerup), try to focus it first
            if (data.hasIncPowerup && incSliderRef.current) {
                incSliderRef.current.focus();
                incSliderRef.current.select();
            } else if (cardSliderRef.current) {
                // Otherwise (or if Inc ref failed), focus Card
                cardSliderRef.current.focus();
                cardSliderRef.current.select();
            }
        }, 50);
    }, [!!data, data?.hasIncPowerup]); // Re-run if data loaded

    // Save Handlers
    const handleSave = useCallback(async () => {
        if (!data || !data.rem) return;
        isSaving.current = true;

        const promises: Promise<any>[] = [];

        // Save Inc Priority
        if (data.hasIncPowerup) {
            const effectiveInc = incVal ?? data.defaults.inc;
            if (effectiveInc !== data.incPriority) {
                // Fire and forget
                promises.push(data.rem.setPowerupProperty(powerupCode, prioritySlotCode, [effectiveInc.toString()]));
                updateIncrementalRemCache(plugin, { remId: data.rem._id, priority: effectiveInc } as any);
            }
        }

        // Save Card Priority
        const effectiveCard = cardVal ?? data.defaults.card;
        if (effectiveCard !== data.cardPriority || !data.hasCardPowerup) {
            // Signal events.ts to allow this update even if in queue (Global Context Survivor)
            plugin.storage.setSession('manual_priority_update_pending', true).catch(console.error);

            // Fire and forget DB write
            promises.push(setCardPriority(plugin, data.rem, effectiveCard, 'manual', data.hasCardPowerup));

            // Optimistic Cache Update
            updateCardPriorityCache(plugin, data.rem._id, true, { remId: data.rem._id, priority: effectiveCard, source: 'manual' } as any);

            // FLUSH IMMEDIATELY to resolve race condition and signal listeners
            // This replaces the manual 'cardPriorityCacheRefreshKey' set
            flushLightCacheUpdates(plugin).catch(console.error);
        }

        // Ensure all DB writes are at least triggered (caught to avoid unhandled rejections)
        Promise.all(promises).catch(e => console.error("Error saving priority:", e));

        // Close immediately
        plugin.widget.closePopup();
    }, [data, incVal, cardVal, plugin]);

    // Tab cycling
    const handleTab = (e: React.KeyboardEvent) => {
        if (e.key !== 'Tab' || e.shiftKey) return;
        e.preventDefault();
        const active = document.activeElement;

        // If Inc is present, we might cycle. If not, Tab might just refocus Card or do nothing.
        if (data?.hasIncPowerup) {
            if (active?.closest('[data-section="inc"]')) {
                cardSliderRef.current?.focus();
                cardSliderRef.current?.select();
            } else {
                incSliderRef.current?.focus();
                incSliderRef.current?.select();
            }
        } else {
            // If only Card is visible, keep focus there
            cardSliderRef.current?.focus();
            cardSliderRef.current?.select();
        }
    };

    if (!data) {
        return <div className="h-20 flex items-center justify-center text-sm">Loading...</div>;
    }

    const currentInc = incVal ?? data.defaults.inc;
    const currentCard = cardVal ?? data.defaults.card;

    return (
        <div
            className="flex flex-col gap-3 p-4 relative"
            style={{
                backgroundColor: 'var(--rn-clr-background-primary)',
                color: 'var(--rn-clr-content-primary)',
            }}
            onKeyDown={(e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    handleSave();
                } else if (e.key === 'Escape') {
                    plugin.widget.closePopup();
                }
            }}
            onKeyUp={() => {
                if (data.hasIncPowerup) incKeyboard.handleKeyUp();
                cardKeyboard.handleKeyUp();
            }}
        >
            <div className="flex items-center justify-between mb-1">
                <h3 className="text-sm font-bold opacity-80">Quick Priority</h3>
                <button
                    className="text-xs opacity-50 hover:opacity-100 px-2"
                    onClick={() => plugin.widget.closePopup()}
                >✕</button>
            </div>

            {/* Incremental Rem Section - HIDDEN if not an Incremental Rem */}
            {data.hasIncPowerup && (
                <div
                    className="flex flex-col gap-1"
                    data-section="inc"
                >
                    <div className="flex justify-between text-xs font-semibold mb-1">
                        <span className="flex items-center gap-1">
                            <span>📖</span> Incremental
                        </span>
                    </div>
                    <PrioritySlider
                        ref={incSliderRef}
                        value={currentInc}
                        onChange={(v) => { setIncVal(v); }}
                        useAbsoluteColoring={true}
                        onKeyDown={(e) => {
                            if (e.key === 'Tab') handleTab(e);
                            else incKeyboard.handleKeyDown(e);
                        }}
                    />
                </div>
            )}

            {/* Card Priority Section */}
            <div
                className="flex flex-col gap-1 mt-1"
                data-section="card"
                style={{ opacity: data.hasCardPowerup ? 1 : 0.8 }}
            >
                <div className="flex justify-between text-xs font-semibold mb-1">
                    <span className="flex items-center gap-1">
                        <span>🎴</span> Flashcard
                        {!data.hasCardPowerup && <span className="text-[10px] font-normal opacity-70 italic">(Create)</span>}
                    </span>
                </div>
                <PrioritySlider
                    ref={cardSliderRef}
                    value={currentCard}
                    onChange={(v) => { setCardVal(v); }}
                    useAbsoluteColoring={true}
                    onKeyDown={(e) => {
                        if (e.key === 'Tab') handleTab(e);
                        else cardKeyboard.handleKeyDown(e);
                    }}
                />
            </div>

            <button
                onClick={handleSave}
                className="mt-2 px-3 py-1.5 text-xs font-bold rounded text-white transition-opacity hover:opacity-90"
                style={{ backgroundColor: '#3B82F6' }}
            >
                Save
            </button>
        </div>
    );
}

renderWidget(PriorityLight);