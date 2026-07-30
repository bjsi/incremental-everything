import {
    renderWidget,
    usePlugin,
    useRunAsync,
    useTrackerPlugin,
} from '@remnote/plugin-sdk';
import { getRemCardContent } from '../lib/pdfUtils';
import React, { useCallback, useEffect, useState, useRef } from 'react';
import {
    powerupCode,
    prioritySlotCode,
    defaultPriorityId,
    defaultCardPriorityId,
    cardPriorityCacheRefreshKey,
    pendingPrioritySaveKey,
    batchPriorityTargetRemIdsKey,
} from '../lib/consts';
import {
    CARD_PRIORITY_CODE,
    PRIORITY_SLOT,
    setCardPriority,
    getCardPriorityValue,
} from '../lib/card_priority';
import { updateIncrementalRemCache } from '../lib/incremental_rem/cache';
import { updateCardPriorityCache } from '../lib/card_priority/cache';
import { PrioritySlider, PrioritySliderRef } from '../components';
import { useAcceleratedKeyboardHandler } from '../lib/keyboard_utils';
import { initIncrementalRem } from '../lib/incremental_rem';
import { scanBatchTargets } from '../lib/priority_targets';


interface ParentExtractContext {
    parentRemId: string;
    parentText: string;
    parentPriority: number;
    parentPrioritySource: 'incremental' | 'card-or-inherited';
    clozeChildCount: number;
    parentOwnCardCount: number;
    totalExistingCount: number;
    decrementsApplied: number;
    stepSize: number;
    suggestedPriority: number;
}

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

    const parentExtractContext: ParentExtractContext | undefined =
        context?.contextData?.parentExtractContext;

    // Batch mode: Opt+P / Ctrl+Opt+P over a multi-rem selection (e.g. several
    // table rows). The sliders are seeded from the first rem, and on save the
    // chosen values are applied to every target — see handleSave below.
    const isBatchMode = context?.contextData?.batchMode === true;
    const batchRemIds = useRunAsync(async () => {
        if (!isBatchMode) return null;
        return await plugin.storage.getSession<string[]>(batchPriorityTargetRemIdsKey);
    }, [isBatchMode]);
    const batchCount: number =
        batchRemIds?.length ?? context?.contextData?.batchCount ?? 0;

    // Composition of the selection, so the sections below reflect every target
    // rather than just the first one.
    const batchScan = useRunAsync(async () => {
        if (!isBatchMode || !batchRemIds?.length) return null;
        return await scanBatchTargets(plugin, batchRemIds);
    }, [isBatchMode, batchRemIds]);

    // In batch mode only the sliders the user actually moves are applied, so a
    // bulk card-priority edit never pushes rem #1's IncRem value onto every
    // other IncRem in the selection.
    const incTouched = useRef(false);
    const cardTouched = useRef(false);

    // 2. Ultra-Fast Data Fetching (O(1))
    // We only fetch the primitive values needed to render the sliders.
    // We avoid heavy object construction (like getIncrementalRemFromRem or card stats).
    const data = useTrackerPlugin(async (rp) => {
        const t0 = performance.now();
        // Resolve remId: from context OR from session storage (fallback for Create Incremental Rem flow)
        let remId = context?.contextData?.remId;
        if (!remId) {
            remId = await rp.storage.getSession<string>('priorityPopupTargetRemId');
        }
        if (!remId) return null;

        const rem = await rp.rem.findOne(remId);
        if (!rem) return null;
        console.log(`[PriorityLight] remId resolved + findOne: ${Math.round(performance.now() - t0)}ms`);

        // Parallel fetch for speed
        // Parallel fetch for speed - Step 1: Fetch raw data
        const t1 = performance.now();
        const [
            incPStr,
            hasIncPowerup,
            hasCardPowerup,
            cards,
            cardPriorityVal,
            cardPStr, // Fetch raw slot value to verify existence
            defaultInc,
        ] = await Promise.all([
            rem.getPowerupProperty(powerupCode, prioritySlotCode),
            rem.hasPowerup(powerupCode),
            rem.hasPowerup(CARD_PRIORITY_CODE), // check using constant
            rem.getCards(),
            getCardPriorityValue(rp, rem),
            rem.getPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT), // Get raw string check
            rp.settings.getSetting<number>(defaultPriorityId),
        ]);
        console.log(`[PriorityLight] parallel SDK fetches: ${Math.round(performance.now() - t1)}ms (cards: ${cards.length})`);

        // Step 2: Fetch content
        const t2 = performance.now();
        const remContent = await getRemCardContent(rp, rem);
        console.log(`[PriorityLight] getRemCardContent: ${Math.round(performance.now() - t2)}ms`);

        const hasCards = cards.length > 0;

        console.log(`[PriorityLight] total data load: ${Math.round(performance.now() - t0)}ms`);
        return {
            rem,
            incPriority: incPStr ? parseInt(incPStr) : null,
            cardPriority: cardPriorityVal, // correctly resolved number
            hasIncPowerup,
            hasCardPowerup: hasCardPowerup || !!cardPStr,
            hasCards,
            cardCount: cards.length,
            dueCards: cards.filter(c => (c.nextRepetitionTime ?? Infinity) <= Date.now()).length,
            defaults: {
                inc: defaultInc || 50,
                card: 50 // inherited/default handled by cardPriorityVal
            },
            remName: remContent.front, // Legacy fallback
            front: remContent.front,
            back: remContent.back,
        };
    }, [context?.contextData?.remId]);

    // Which sections apply. Single-rem: whatever this rem is. Batch: whatever
    // ANY target in the selection is, so a mixed set offers both dimensions
    // instead of mirroring rem #1. Declared here (not further down) because the
    // focus, keyboard and save paths below all need the batch-aware value —
    // gating any of them on data.hasIncPowerup would hide the Incremental
    // section whenever the first selected rem happened to be a plain card.
    const showIncSection = isBatchMode
        ? (batchScan?.incCount ?? 0) > 0
        : !!data?.hasIncPowerup;
    // Match priority.tsx logic: only show Card section if has cards OR has cardPriority powerup
    const showCardSection = isBatchMode
        ? (batchScan?.cardCount ?? 0) > 0
        : !!(data?.hasCards || data?.hasCardPowerup);

    // State
    const [incVal, setIncVal] = useState<number | null>(null);
    const [cardVal, setCardVal] = useState<number | null>(null);

    // Sync State with Data (only if not saving/dirty).
    // In batch mode the seed is the mean current priority of each class across
    // the whole selection, not rem #1's value — which would otherwise be the
    // default (50) for any dimension rem #1 happens to lack.
    useEffect(() => {
        // Wait for the scan in batch mode: it resolves after `data`, and seeding
        // the defaults first would leave the sliders non-null, so the averages
        // below would never be applied.
        if (isBatchMode && !batchScan) return;

        if (data && !isSaving.current) {
            const incSeed = isBatchMode ? batchScan?.incSeed ?? null : data.incPriority;
            const cardSeed = isBatchMode ? batchScan?.cardSeed ?? null : data.cardPriority;

            if (incVal === null && incSeed !== null) setIncVal(incSeed);
            if (cardVal === null && cardSeed !== null) setCardVal(cardSeed);

            // If null, set defaults for the slider visual (but don't save yet)
            if (incVal === null && incSeed === null) setIncVal(data.defaults.inc);
            if (cardVal === null && cardSeed === null) setCardVal(data.defaults.card);
        }
    }, [data, isBatchMode, batchScan]);

    // Keyboard Handlers
    const incKeyboard = useAcceleratedKeyboardHandler(
        incVal,
        incVal ?? 50,
        (val) => { incTouched.current = true; setIncVal(Math.max(0, Math.min(100, val))); }
    );

    const cardKeyboard = useAcceleratedKeyboardHandler(
        cardVal,
        cardVal ?? 50,
        (val) => { cardTouched.current = true; setCardVal(Math.max(0, Math.min(100, val))); }
    );

    // Focus Logic
    useEffect(() => {
        if (!data) return;
        setTimeout(() => {
            // If we are showing the Inc section (it has powerup), try to focus it first
            if (showIncSection && incSliderRef.current) {
                incSliderRef.current.focus();
                incSliderRef.current.select();
            } else if (cardSliderRef.current) {
                // Otherwise (or if Inc ref failed), focus Card
                cardSliderRef.current.focus();
                cardSliderRef.current.select();
            }
        }, 50);
    }, [!!data, showIncSection]); // Re-run if data loaded

    // Save Handlers
    const handleSave = useCallback(async () => {
        if (!data || !data.rem) return;
        const tSave = performance.now();
        console.log('[PriorityLight] handleSave started');
        isSaving.current = true;

        // --- Compute what changed ---
        const effectiveInc = data.hasIncPowerup ? (incVal ?? data.defaults.inc) : null;
        const incChanged = effectiveInc !== null && effectiveInc !== data.incPriority;

        const cardSectionForThisRem = data.hasCards || data.hasCardPowerup;
        const effectiveCard = cardSectionForThisRem ? (cardVal ?? data.defaults.card) : null;
        const cardChanged = effectiveCard !== null && (effectiveCard !== data.cardPriority || !data.hasCardPowerup);

        // --- Batch: hand the whole target list to the tracker and close ---
        // Only dimensions the user actually adjusted are sent, and each is sent
        // only if the selection contains rems it applies to. tracker.ts then
        // routes per rem (IncRem slot vs card slot). The optimistic cache
        // updates below are skipped: they are per-rem and we only hold loaded
        // data for the first target, so the tracker refreshes caches as it writes.
        if (isBatchMode && batchRemIds && batchRemIds.length > 1) {
            const sendInc = incTouched.current && (batchScan?.incCount ?? 0) > 0;
            const sendCard = cardTouched.current && (batchScan?.cardCount ?? 0) > 0;

            if (sendInc || sendCard) {
                plugin.storage.setSession(pendingPrioritySaveKey, {
                    remIds: batchRemIds,
                    incPriority: sendInc ? (incVal ?? data.defaults.inc) : null,
                    cardPriority: sendCard ? (cardVal ?? data.defaults.card) : null,
                    cardSource: 'manual',
                    triggerCascade: true,
                }).catch(console.error);
                plugin.storage.setSession(cardPriorityCacheRefreshKey, Date.now()).catch(console.error);
            }
            plugin.storage.setSession(batchPriorityTargetRemIdsKey, null).catch(console.error);
            plugin.widget.closePopup();
            return;
        }

        // --- Optimistic UI updates (sync session writes — safe in popup context) ---
        if (incChanged) {
            updateIncrementalRemCache(plugin, { remId: data.rem._id, priority: effectiveInc! } as any);
        }
        if (cardChanged) {
            // Signal events.ts to allow this update even if in queue
            plugin.storage.getSession<string[]>('manual_priority_pending_rems').then(manualRems => {
                const arr = manualRems || [];
                if (!arr.includes(data.rem._id)) {
                    arr.push(data.rem._id);
                    plugin.storage.setSession('manual_priority_pending_rems', arr);
                }
            }).catch(console.error);

            // Lightweight in-memory optimistic override (5s TTL) — read by getPendingCacheUpdate
            updateCardPriorityCache(plugin, data.rem._id, true, {
                remId: data.rem._id,
                priority: effectiveCard!,
                source: 'manual',
                cardCount: data.cardCount,
                dueCards: data.dueCards,
            } as any);

            // Signal listeners (e.g. display widget) to refresh immediately
            plugin.storage.setSession(cardPriorityCacheRefreshKey, Date.now()).catch(console.error);
        }

        // --- Write the DB job to session storage for tracker.ts to execute ---
        // tracker.ts runs in the persistent index widget (not killed by popup close)
        // and will set plugin_operation_active=true before writing to suppress GlobalRemChanged.
        if (incChanged || cardChanged) {
            plugin.storage.setSession(pendingPrioritySaveKey, {
                remId: data.rem._id,
                incPriority: incChanged ? effectiveInc : null,
                cardPriority: cardChanged ? effectiveCard : null,
                cardSource: 'manual',
                needsAddPowerup: cardChanged && !data.hasCardPowerup,
                triggerCascade: incChanged || cardChanged,
            }).catch(console.error);
        }

        // ⚡ Close immediately — optimistic cache is already in place, DB writes happen in tracker.ts
        console.log(`[PriorityLight] handleSave total before closePopup: ${Math.round(performance.now() - tSave)}ms`);
        plugin.widget.closePopup();
    }, [data, incVal, cardVal, plugin, isBatchMode, batchRemIds, batchScan]);

    // Tab cycling
    const handleTab = (e: React.KeyboardEvent) => {
        if (e.key !== 'Tab' || e.shiftKey) return;
        e.preventDefault();
        const active = document.activeElement;

        // If Inc is present, we might cycle. If not, Tab might just refocus Card or do nothing.
        if (showIncSection) {
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

    // React Error #310 fix: Move redirect side-effect to a top-level unconditional useEffect
    // This ensures hook order is consistent across renders
    // Never redirect in batch mode: rem #1 may be a bare rem while other targets
    // are cards or IncRems, and handing off to the single-rem popup would drop
    // the rest of the selection.
    useEffect(() => {
        if (!isBatchMode && data && !data.hasIncPowerup && !(data.hasCards || data.hasCardPowerup)) {
            const redirect = async () => {
                // Set session storage fallback so priority.tsx can find the remId
                await plugin.storage.setSession('priorityPopupTargetRemId', data.rem._id);
                // Close this popup first
                await plugin.widget.closePopup();
                // Then open the full priority widget
                await plugin.widget.openPopup('priority', { remId: data.rem._id });
            };
            redirect();
        }
    }, [data, plugin, isBatchMode]);

    if (!data) {
        return <div className="h-20 flex items-center justify-center text-sm">Loading...</div>;
    }

    const currentInc = incVal ?? data.defaults.inc;
    const currentCard = cardVal ?? data.defaults.card;

    // If neither section can be shown, redirect to the main priority widget
    // which handles inheritance and complex priority cases
    if (!showIncSection && !showCardSection) {
        if (isBatchMode) {
            return (
                <div className="h-20 flex items-center justify-center text-sm text-center px-4 opacity-70">
                    {batchScan
                        ? 'None of the selected rems are IncRems or have flashcards.'
                        : 'Checking selection…'}
                </div>
            );
        }
        // UI feedback only - side effect handled in useEffect above
        return <div className="h-20 flex items-center justify-center text-sm">Redirecting...</div>;
    }

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
                if (showIncSection) incKeyboard.handleKeyUp();
                cardKeyboard.handleKeyUp();
            }}
        >
            <div className="flex flex-col mb-2">
                <div className="flex items-center justify-between">
                    <h3 className="text-xs font-bold opacity-60 uppercase tracking-wide">
                        {batchCount > 1 ? `Light Priority — ${batchCount} rems` : 'Light Priority'}
                    </h3>
                    <button
                        className="text-xs opacity-50 hover:opacity-100 px-2"
                        onClick={() => plugin.widget.closePopup()}
                    >✕</button>
                </div>
                <div
                    className="mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap"
                    title={`${data.front}${data.back ? ` → ${data.back}` : ''}`}
                    style={{ width: '100%' }}
                >
                    <span className="text-sm font-medium">
                        {data.front}
                        {data.back && <span className="opacity-80"> → {data.back}</span>}
                    </span>
                    {batchCount > 1 && (
                        <span className="text-xs opacity-60"> and {batchCount - 1} more</span>
                    )}
                </div>
                {batchCount > 1 && (
                    <div className="mt-1 text-[10px] opacity-60 leading-snug">
                        Only sliders you adjust are applied.
                        {!!batchScan?.skippedCount && (
                            <> {batchScan.skippedCount} rem{batchScan.skippedCount > 1 ? 's' : ''} skipped (no IncRem or cards).</>
                        )}
                    </div>
                )}
            </div>

            {/* Parent extract context — only shown for the "Create Cloze with Priority" flow */}
            {parentExtractContext && (
                <div
                    className="rounded p-2 mb-1 text-xs"
                    style={{
                        backgroundColor: 'var(--rn-clr-background-secondary)',
                        border: '1px solid var(--rn-clr-border-primary)',
                    }}
                >
                    <div className="font-semibold opacity-70 mb-1">From extract</div>
                    <div
                        className="opacity-90 mb-1.5 overflow-hidden text-ellipsis whitespace-nowrap"
                        title={parentExtractContext.parentText}
                    >
                        {parentExtractContext.parentText || <span className="italic opacity-60">(empty)</span>}
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 opacity-80">
                        <span>
                            Priority: <strong>{parentExtractContext.parentPriority}</strong>
                            <span className="opacity-60 ml-0.5">
                                ({parentExtractContext.parentPrioritySource === 'incremental' ? 'IncRem' : 'card/inherited'})
                            </span>
                        </span>
                        <span>
                            Existing clozes/cards: <strong>{parentExtractContext.totalExistingCount}</strong>
                            {parentExtractContext.parentOwnCardCount > 0 && (
                                <span className="opacity-60 ml-0.5">
                                    ({parentExtractContext.clozeChildCount} child + {parentExtractContext.parentOwnCardCount} in extract)
                                </span>
                            )}
                        </span>
                        <span>
                            Suggested: <strong>{parentExtractContext.suggestedPriority}</strong>
                            <span className="opacity-60 ml-0.5">
                                ({parentExtractContext.parentPriority}
                                {parentExtractContext.decrementsApplied > 0
                                    ? ` + ${parentExtractContext.decrementsApplied}×${parentExtractContext.stepSize}`
                                    : ''})
                            </span>
                        </span>
                    </div>
                </div>
            )}

            {/* Incremental Rem Section - HIDDEN if not an Incremental Rem */}
            {showIncSection && (
                <div
                    className="flex flex-col gap-1"
                    data-section="inc"
                >
                    <div className="flex justify-between text-xs font-semibold mb-1">
                        <span className="flex items-center gap-1">
                            <span>📖</span> Incremental
                            {isBatchMode && batchScan && (
                                <span className="text-[10px] font-normal opacity-70">
                                    ({batchScan.incCount} of {batchScan.total}
                                    {batchScan.incSpread?.mixed
                                        ? ` · mixed ${batchScan.incSpread.min}–${batchScan.incSpread.max}, avg ${batchScan.incSeed}`
                                        : ''})
                                </span>
                            )}
                        </span>
                    </div>
                    <PrioritySlider
                        ref={incSliderRef}
                        value={currentInc}
                        onChange={(v) => { incTouched.current = true; setIncVal(v); }}
                        useAbsoluteColoring={true}
                        onKeyDown={(e) => {
                            if (e.key === 'Tab') handleTab(e);
                            else incKeyboard.handleKeyDown(e);
                        }}
                    />
                </div>
            )}

            {/* Card Priority Section - Only shown if rem has cards OR cardPriority powerup */}
            {showCardSection && (
                <div
                    className="flex flex-col gap-1 mt-1"
                    data-section="card"
                    style={{ opacity: data.hasCardPowerup ? 1 : 0.8 }}
                >
                    <div className="flex justify-between text-xs font-semibold mb-1">
                        <span className="flex items-center gap-1">
                            <span>🎴</span> Flashcard
                            {isBatchMode && batchScan ? (
                                <span className="text-[10px] font-normal opacity-70">
                                    ({batchScan.cardCount} of {batchScan.total}
                                    {batchScan.cardSpread?.mixed
                                        ? ` · mixed ${batchScan.cardSpread.min}–${batchScan.cardSpread.max}, avg ${batchScan.cardSeed}`
                                        : ''})
                                </span>
                            ) : (
                                !data.hasCardPowerup && <span className="text-[10px] font-normal opacity-70 italic">(Create)</span>
                            )}
                        </span>
                    </div>
                    <PrioritySlider
                        ref={cardSliderRef}
                        value={currentCard}
                        onChange={(v) => { cardTouched.current = true; setCardVal(v); }}
                        useAbsoluteColoring={true}
                        onKeyDown={(e) => {
                            if (e.key === 'Tab') handleTab(e);
                            else cardKeyboard.handleKeyDown(e);
                        }}
                    />
                </div>
            )}

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