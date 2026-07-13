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
    pendingIntervalBatchSaveKey,
} from '../lib/consts';
import { PrioritySlider, PrioritySliderRef } from '../components';
import { useAcceleratedKeyboardHandler } from '../lib/keyboard_utils';
import dayjs from 'dayjs';

function PriorityInterval() {
    const plugin = usePlugin();

    // Refs
    const prioritySliderRef = useRef<PrioritySliderRef>(null);
    const intervalInputRef = useRef<HTMLInputElement>(null);
    const saveButtonRef = useRef<HTMLButtonElement>(null);
    const next7ButtonRef = useRef<HTMLButtonElement>(null);
    const next30ButtonRef = useRef<HTMLButtonElement>(null);
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

    // Tab cycling: priority → interval → Save → Next 7 Days → Next 30 Days → priority
    // Shift+Tab reverses the cycle.
    const focusCycle = [
        () => { prioritySliderRef.current?.focus(); prioritySliderRef.current?.select(); },
        () => { intervalInputRef.current?.focus(); intervalInputRef.current?.select(); },
        () => saveButtonRef.current?.focus(),
        () => next7ButtonRef.current?.focus(),
        () => next30ButtonRef.current?.focus(),
    ];

    const handleTab = (e: React.KeyboardEvent) => {
        if (e.key !== 'Tab') return;
        e.preventDefault();
        const active = document.activeElement as HTMLElement | null;
        // Determine current position:
        // - Priority slider: active element is inside [data-section="priority"]
        // - Others: direct ref comparison
        let currentIdx = 0;
        if (active?.closest?.('[data-section="priority"]')) {
            currentIdx = 0;
        } else if (active === intervalInputRef.current) {
            currentIdx = 1;
        } else if (active === saveButtonRef.current) {
            currentIdx = 2;
        } else if (active === next7ButtonRef.current) {
            currentIdx = 3;
        } else if (active === next30ButtonRef.current) {
            currentIdx = 4;
        }
        const step = e.shiftKey ? -1 : 1;
        const nextIdx = (currentIdx + step + focusCycle.length) % focusCycle.length;
        focusCycle[nextIdx]?.();
    };

    // handleSave: writes job to session storage, closes popup immediately.
    // ALL heavy work (DB writes, cache, cascade) is delegated to the tracker
    // watcher in tracker.ts, which runs in the persistent index iframe and
    // cannot be killed by popup teardown.
    const handleSave = useCallback(async (overrideInterval?: number) => {
        if (!data || !data.rem || isSaving.current) return;
        isSaving.current = true;

        try {
            const effectivePriority = priorityVal ?? data.defaultPriority;
            const effectiveInterval = overrideInterval !== undefined
                ? overrideInterval
                : (intervalVal !== null ? parseInt(intervalVal) : data.defaultInterval);

            if (isNaN(effectiveInterval)) return;

            const remIdsToUpdate = (isBatchMode && batchRemIds && batchRemIds.length > 0)
                ? batchRemIds
                : [data.remId];

            if (remIdsToUpdate.length === 0) return;

            // Write the job — one await, then close immediately.
            await plugin.storage.setSession(pendingIntervalBatchSaveKey, {
                remIds: remIdsToUpdate,
                priority: effectivePriority,
                interval: effectiveInterval,
            });

            // Clean up batch session storage
            if (isBatchMode) {
                await plugin.storage.setSession('batchPriorityIntervalRemIds', null);
            }

            plugin.widget.closePopup();
        } finally {
            isSaving.current = false;
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
                    const active = document.activeElement;
                    // Let preset buttons handle Enter themselves via native click
                    if (active === next7ButtonRef.current || active === next30ButtonRef.current) return;
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
                    ref={saveButtonRef}
                    onClick={() => handleSave()}
                    onKeyDown={handleTab}
                    tabIndex={0}
                    className="px-3 py-1.5 text-xs font-bold rounded text-white transition-opacity hover:opacity-90 flex-1"
                    style={{ backgroundColor: '#3B82F6', outline: 'none' }}
                    onFocus={(e) => { e.currentTarget.style.boxShadow = '0 0 0 3px rgba(59, 130, 246, 0.6), 0 0 0 1px white'; }}
                    onBlur={(e) => { e.currentTarget.style.boxShadow = 'none'; }}
                >
                    Save
                </button>
                <button
                    ref={next7ButtonRef}
                    onClick={() => handleSave(7)}
                    onKeyDown={handleTab}
                    tabIndex={0}
                    className="px-3 py-1.5 text-xs font-bold rounded text-white transition-opacity hover:opacity-90"
                    style={{ backgroundColor: '#10B981', outline: 'none' }}
                    onFocus={(e) => { e.currentTarget.style.boxShadow = '0 0 0 3px rgba(16, 185, 129, 0.6), 0 0 0 1px white'; }}
                    onBlur={(e) => { e.currentTarget.style.boxShadow = 'none'; }}
                    title="Set priority and schedule next review in 7 days"
                >
                    Next 7 Days
                </button>
                <button
                    ref={next30ButtonRef}
                    onClick={() => handleSave(30)}
                    onKeyDown={handleTab}
                    tabIndex={0}
                    className="px-3 py-1.5 text-xs font-bold rounded text-white transition-opacity hover:opacity-90"
                    style={{ backgroundColor: '#8B5CF6', outline: 'none' }}
                    onFocus={(e) => { e.currentTarget.style.boxShadow = '0 0 0 3px rgba(139, 92, 246, 0.6), 0 0 0 1px white'; }}
                    onBlur={(e) => { e.currentTarget.style.boxShadow = 'none'; }}
                    title="Set priority and schedule next review in 30 days"
                >
                    Next 30 Days
                </button>
            </div>
        </div>
    );
}

renderWidget(PriorityInterval);
