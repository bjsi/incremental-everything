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
    initialIntervalId,
} from '../lib/consts';
import { updateIncrementalRemCache } from '../lib/incremental_rem/cache';
import { PrioritySlider, PrioritySliderRef } from '../components';
import { useAcceleratedKeyboardHandler } from '../lib/keyboard_utils';
import { getIncrementalRemFromRem } from '../lib/incremental_rem';
import { updateSRSDataForRem } from '../lib/scheduler';
import { IncrementalRep } from '../lib/incremental_rem/types';
import dayjs from 'dayjs';

function PriorityInterval() {
    const plugin = usePlugin();

    // Refs
    const prioritySliderRef = useRef<PrioritySliderRef>(null);
    const intervalInputRef = useRef<HTMLInputElement>(null);
    const isSaving = useRef(false);

    // Context
    const context = useRunAsync(async () => {
        return await plugin.widget.getWidgetContext<any>();
    }, []);

    // Batch mode: read batch remIds from session storage (set by extract-with-priority)
    const isBatchMode = context?.contextData?.batchMode === true;
    const batchRemIds = useRunAsync(async () => {
        if (!isBatchMode) return null;
        return await plugin.storage.getSession<string[]>('batchPriorityIntervalRemIds');
    }, [isBatchMode]);

    // Data from DB
    const data = useTrackerPlugin(async (rp) => {
        let remId = context?.contextData?.remId;
        if (!remId) {
            remId = await rp.storage.getSession<string>('priorityPopupTargetRemId');
        }
        if (!remId) return null;

        const rem = await rp.rem.findOne(remId);
        if (!rem) return null;

        const hasIncPowerup = await rem.hasPowerup(powerupCode);
        if (!hasIncPowerup) return null;

        const [incPStr, defaultPriority, defaultInterval] = await Promise.all([
            rem.getPowerupProperty(powerupCode, prioritySlotCode),
            rp.settings.getSetting<number>(defaultPriorityId),
            rp.settings.getSetting<number>(initialIntervalId),
        ]);

        const remContent = await getRemCardContent(rp, rem);

        return {
            rem,
            remId: rem._id,
            incPriority: incPStr ? parseInt(incPStr) : null,
            defaultPriority: defaultPriority || 50,
            defaultInterval: defaultInterval || 1,
            front: remContent.front,
            back: remContent.back,
        };
    }, [context?.contextData?.remId]);

    // State
    const [priorityVal, setPriorityVal] = useState<number | null>(null);
    const [intervalVal, setIntervalVal] = useState<string | null>(null);
    const [futureDate, setFutureDate] = useState('');

    // Sync state from data (only once)
    useEffect(() => {
        if (data && !isSaving.current) {
            if (priorityVal === null) {
                setPriorityVal(data.incPriority ?? data.defaultPriority);
            }
            if (intervalVal === null) {
                setIntervalVal(String(data.defaultInterval));
            }
        }
    }, [data]);

    // Compute future date preview
    useEffect(() => {
        if (intervalVal !== null) {
            const n = parseInt(intervalVal);
            if (!isNaN(n) && n >= 0) {
                setFutureDate(`Next review: ${dayjs().add(n, 'day').format('MMMM D, YY')}`);
            } else {
                setFutureDate('Invalid number of days.');
            }
        }
    }, [intervalVal]);

    // Keyboard handlers
    const priorityKeyboard = useAcceleratedKeyboardHandler(
        priorityVal,
        priorityVal ?? 50,
        (val) => setPriorityVal(Math.max(0, Math.min(100, val)))
    );

    const intervalKeyboard = useAcceleratedKeyboardHandler(
        intervalVal ? parseInt(intervalVal) : 1,
        1,
        (val) => setIntervalVal(String(Math.max(0, val)))
    );

    // Auto-focus priority slider on open
    useEffect(() => {
        if (!data) return;
        setTimeout(() => {
            prioritySliderRef.current?.focus();
            prioritySliderRef.current?.select();
        }, 50);
    }, [!!data]);

    // Tab cycling: priority → interval → priority
    const handleTab = (e: React.KeyboardEvent) => {
        if (e.key !== 'Tab' || e.shiftKey) return;
        e.preventDefault();
        const active = document.activeElement;
        if (active?.closest('[data-section="priority"]')) {
            intervalInputRef.current?.focus();
            intervalInputRef.current?.select();
        } else {
            prioritySliderRef.current?.focus();
            prioritySliderRef.current?.select();
        }
    };

    // Helper: apply priority + interval to a single rem
    const applyPriorityAndInterval = async (
        remId: string,
        effectivePriority: number,
        effectiveInterval: number,
    ) => {
        const rem = await plugin.rem.findOne(remId);
        if (!rem) return;

        // Save priority
        await rem.setPowerupProperty(powerupCode, prioritySlotCode, [effectivePriority.toString()]);

        // Save interval (SRS schedule)
        const incRem = await getIncrementalRemFromRem(plugin, rem);
        if (incRem) {
            const newNextRepDate = Date.now() + effectiveInterval * 1000 * 60 * 60 * 24;
            const scheduledDate = incRem.nextRepDate || Date.now();
            const actualDate = Date.now();
            const daysDifference = (actualDate - scheduledDate) / (1000 * 60 * 60 * 24);
            const wasEarly = daysDifference < 0;
            const daysEarlyOrLate = Math.round(daysDifference * 10) / 10;

            const newHistory: IncrementalRep[] = [
                ...(incRem.history || []),
                {
                    date: actualDate,
                    scheduled: scheduledDate,
                    interval: effectiveInterval,
                    wasEarly,
                    daysEarlyOrLate,
                    reviewTimeSeconds: undefined,
                    priority: effectivePriority,
                    eventType: 'rescheduledInEditor',
                },
            ];

            await updateSRSDataForRem(plugin, remId, newNextRepDate, newHistory);
        }

        // Update cache
        const updatedIncRem = await getIncrementalRemFromRem(plugin, rem);
        if (updatedIncRem) {
            await updateIncrementalRemCache(plugin, updatedIncRem);
        }

        plugin.storage.setSession('pendingInheritanceCascade', remId).catch(console.error);
    };

    const handleSave = useCallback(async (overrideInterval?: number) => {
        if (!data || !data.rem || isSaving.current) return;
        isSaving.current = true;

        // Suppress GlobalRemChanged
        await plugin.storage.setSession('plugin_operation_active', true);

        let triggeredCascade = false;
        try {
            const effectivePriority = priorityVal ?? data.defaultPriority;
            const effectiveInterval = overrideInterval !== undefined
                ? overrideInterval
                : (intervalVal !== null ? parseInt(intervalVal) : data.defaultInterval);

            if (isNaN(effectiveInterval)) {
                return;
            }

            // Determine which rems to update
            const remIdsToUpdate = (isBatchMode && batchRemIds && batchRemIds.length > 0)
                ? batchRemIds
                : [data.remId];

            for (const remId of remIdsToUpdate) {
                await applyPriorityAndInterval(remId, effectivePriority, effectiveInterval);
            }

            triggeredCascade = true;

            // Clean up batch session storage
            if (isBatchMode) {
                await plugin.storage.setSession('batchPriorityIntervalRemIds', null);
            }

            plugin.widget.closePopup();
        } finally {
            isSaving.current = false;
            // Only clear the flag if no cascade was triggered.
            // If cascade IS pending, leave the flag up — the cascade tracker will clear it.
            if (!triggeredCascade) {
                await plugin.storage.setSession('plugin_operation_active', false);
            }
        }
    }, [data, priorityVal, intervalVal, plugin, isBatchMode, batchRemIds]);

    if (!data) {
        return <div className="h-20 flex items-center justify-center text-sm">Loading...</div>;
    }

    const currentPriority = priorityVal ?? data.defaultPriority;

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
                priorityKeyboard.handleKeyUp();
                intervalKeyboard.handleKeyUp();
            }}
        >
            {/* Header */}
            <div className="flex flex-col mb-1">
                <div className="flex items-center justify-between">
                    <h3 className="text-xs font-bold opacity-60 uppercase tracking-wide">Set Priority & Interval</h3>
                    <button
                        className="text-xs opacity-50 hover:opacity-100 px-2"
                        onClick={() => plugin.widget.closePopup()}
                    >✕</button>
                </div>
                {isBatchMode && batchRemIds && batchRemIds.length > 1 ? (
                    <div
                        className="mt-1 px-2 py-1 rounded text-xs font-semibold text-center"
                        style={{
                            backgroundColor: 'rgba(59, 130, 246, 0.12)',
                            color: '#3B82F6',
                            border: '1px solid rgba(59, 130, 246, 0.25)',
                        }}
                    >
                        📋 {batchRemIds.length} rems selected — priority & interval will apply to all
                    </div>
                ) : (
                    <div
                        className="mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap"
                        title={`${data.front}${data.back ? ` → ${data.back}` : ''}`}
                        style={{ width: '100%' }}
                    >
                        <span className="text-sm font-medium">
                            {data.front}
                            {data.back && <span className="opacity-80"> → {data.back}</span>}
                        </span>
                    </div>
                )}
            </div>

            {/* Priority Section */}
            <div className="flex flex-col gap-1" data-section="priority">
                <div className="flex justify-between text-xs font-semibold mb-1">
                    <span className="flex items-center gap-1">
                        <span>📖</span> Incremental Priority
                        <span className="text-[10px] font-normal opacity-70 italic">(Lower = more important)</span>
                    </span>
                </div>
                <PrioritySlider
                    ref={prioritySliderRef}
                    value={currentPriority}
                    onChange={(v) => setPriorityVal(v)}
                    useAbsoluteColoring={true}
                    onKeyDown={(e) => {
                        if (e.key === 'Tab') handleTab(e);
                        else priorityKeyboard.handleKeyDown(e);
                    }}
                />
            </div>

            {/* Interval Section */}
            <div className="flex flex-col gap-1" data-section="interval">
                <div className="flex justify-between text-xs font-semibold mb-1">
                    <span className="flex items-center gap-1">
                        <span>📅</span> Next repetition in (days)
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    <input
                        ref={intervalInputRef}
                        id="priority-interval-days"
                        type="number"
                        min="0"
                        value={intervalVal ?? ''}
                        onChange={(e) => setIntervalVal(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                handleSave();
                            } else if (e.key === 'Tab') {
                                handleTab(e);
                            } else {
                                intervalKeyboard.handleKeyDown(e);
                            }
                        }}
                        onKeyUp={intervalKeyboard.handleKeyUp}
                        className="text-sm font-bold tabular-nums px-2 py-1 rounded shrink-0 border-0 outline-none transition-shadow"
                        style={{
                            backgroundColor: '#F97316',
                            color: 'white',
                            width: '60px',
                            textAlign: 'center',
                            boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.15)',
                        }}
                        onFocus={(e) => {
                            e.currentTarget.style.boxShadow = '0 0 0 3px rgba(249, 115, 22, 0.5), inset 0 1px 2px rgba(0,0,0,0.15)';
                            e.currentTarget.style.border = '2px solid white';
                        }}
                        onBlur={(e) => {
                            e.currentTarget.style.boxShadow = 'inset 0 1px 2px rgba(0,0,0,0.15)';
                            e.currentTarget.style.border = 'none';
                        }}
                    />
                    <span className="text-xs opacity-60 italic">{futureDate}</span>
                </div>
            </div>

            {/* Buttons */}
            <div className="flex gap-2 mt-2 flex-wrap">
                <button
                    onClick={() => handleSave()}
                    className="px-3 py-1.5 text-xs font-bold rounded text-white transition-opacity hover:opacity-90 flex-1"
                    style={{ backgroundColor: '#3B82F6' }}
                >
                    Save
                </button>
                <button
                    onClick={() => handleSave(7)}
                    className="px-3 py-1.5 text-xs font-bold rounded text-white transition-opacity hover:opacity-90"
                    style={{ backgroundColor: '#10B981' }}
                    title="Set priority and schedule next review in 7 days"
                >
                    Next 7 Days
                </button>
                <button
                    onClick={() => handleSave(30)}
                    className="px-3 py-1.5 text-xs font-bold rounded text-white transition-opacity hover:opacity-90"
                    style={{ backgroundColor: '#8B5CF6' }}
                    title="Set priority and schedule next review in 30 days"
                >
                    Next 30 Days
                </button>
            </div>
        </div>
    );
}

renderWidget(PriorityInterval);
