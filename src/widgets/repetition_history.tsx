import React from 'react';
import { renderWidget, usePlugin, WidgetLocation, useRunAsync, RNPlugin } from '@remnote/plugin-sdk';
import { IncrementalRep, repCountsForStats } from '../lib/incremental_rem/types';
import { formatDuration } from '../lib/utils';
import dayjs from 'dayjs';
import { getIncrementalRemFromRem } from '../lib/incremental_rem';
import {
    safeRemTextToString,
    getActivePdfForIncRem,
    getIncrementalPageRange,
    getIncrementalReadingPosition,
} from '../lib/pdfUtils';
import { getDismissedHistoryFromRem } from '../lib/dismissed';
import {
    addExternalSessionRep,
    updateHistoryEntry,
    deleteHistoryEntry,
    isNewestEntry,
} from '../lib/history_edit';
import { getNextSpacingDateForRem } from '../lib/scheduler';
import { MAX_NOTE_LENGTH } from '../lib/history_notes';

interface PdfPageInfo {
    pdfName: string;
    start: number;
    end: number; // 0 = unbounded (∞)
    currentPage: number;
    percentRead: number | null; // null when the range has no finite end
}

/**
 * Resolve the active PDF source for a rem and, when an explicit page range is
 * set, compute the reading position and degree of processing. Works for both
 * active IncRems and dismissed rems — the page range / current page are stored
 * under synced keys that survive dismissal.
 */
async function loadPdfPageInfo(plugin: any, rem: any, remId: string): Promise<PdfPageInfo | null> {
    try {
        const pdfRem = await getActivePdfForIncRem(plugin, rem);
        if (!pdfRem) return null;

        const range = await getIncrementalPageRange(plugin, remId, pdfRem._id);
        // Only surface this when an explicit range is set (mirrors PageControls'
        // "active range" test: start > 1 or a finite end).
        if (!range || (range.start <= 1 && !(range.end > 0))) return null;

        const start = range.start || 1;
        const end = range.end || 0; // 0 = to the end of the document (∞)
        const savedPage = await getIncrementalReadingPosition(plugin, remId, pdfRem._id);
        const currentPage = savedPage && savedPage > 0 ? savedPage : start;

        // Degree of processing: 0% at the range start, 100% at the range end.
        // Unbounded ranges (end === 0) have no denominator, so percent is null.
        let percentRead: number | null = null;
        if (end > start) {
            percentRead = Math.max(0, Math.min(100, Math.round(((currentPage - start) / (end - start)) * 100)));
        } else if (end === start) {
            percentRead = 100;
        }

        const pdfName = await safeRemTextToString(plugin, pdfRem.text);
        return { pdfName, start, end, currentPage, percentRead };
    } catch (e) {
        console.error('[RepetitionHistoryPopup] Error loading PDF page info:', e);
        return null;
    }
}

/**
 * Human label for a QueueInteractionScore (as stored in context.flashcardScore).
 * Numeric values come from the SDK enum: AGAIN=0, TOO_EARLY=0.01, HARD=0.5,
 * GOOD=1, EASY=1.5. Returns undefined for scores without a review-grade meaning
 * or when score is undefined. Exported as the single source of truth so other
 * history/dashboard widgets import it instead of redefining the mapping.
 */
export function scoreLabel(score: number | undefined): string | undefined {
    switch (score) {
        case 0: return 'Again';
        case 0.01: return 'Too early';
        case 0.5: return 'Hard';
        case 1: return 'Good';
        case 1.5: return 'Easy';
        default: return undefined;
    }
}

/**
 * Compact one-line rendering of a machine context snapshot (IncrementalRep.context):
 * "p.57 of 40–80 · Deep Learning.pdf · 🔖 “bookmark…”".
 */
function formatRepContext(ctx: NonNullable<IncrementalRep['context']>): string {
    const parts: string[] = [];
    if (ctx.page !== undefined) {
        const range =
            ctx.rangeStart !== undefined ? ` of ${ctx.rangeStart}–${ctx.rangeEnd ?? '∞'}` : '';
        parts.push(`p.${ctx.page}${range}`);
    } else if (ctx.rangeStart !== undefined) {
        parts.push(`pp.${ctx.rangeStart}–${ctx.rangeEnd ?? '∞'}`);
    }
    if (ctx.videoTime !== undefined) {
        const m = Math.floor(ctx.videoTime / 60);
        const s = Math.floor(ctx.videoTime % 60).toString().padStart(2, '0');
        parts.push(`▶ ${m}:${s}`);
    }
    if (ctx.pdfName) parts.push(ctx.pdfName);
    if (ctx.bookmark) parts.push(`🔖 “${ctx.bookmark}”`);
    // Imported-from-flashcard provenance (eventType 'importedRep').
    if (ctx.flashcardName || ctx.flashcardScore !== undefined) {
        const label = scoreLabel(ctx.flashcardScore);
        const name = ctx.flashcardName ? `“${ctx.flashcardName}”` : 'flashcard';
        parts.push(`🃏 ${name}${label ? ` · ${label}` : ''}`);
    }
    return parts.join(' · ');
}

/**
 * Sub-row shown under a history row / event banner when the entry carries a
 * user note (📝) and/or a machine context snapshot.
 */
function NoteAndContextLine({ rep }: { rep: IncrementalRep }) {
    if (!rep.notes && !rep.context) return null;
    return (
        <div
            style={{
                padding: '2px 16px 8px',
                display: 'flex',
                flexDirection: 'column',
                gap: '2px',
                borderBottom: '1px solid var(--rn-clr-border-secondary)',
                marginTop: '-1px', // merge with the row above (which has its own border)
            }}
        >
            {rep.notes && (
                <div
                    style={{
                        fontSize: '11px',
                        color: 'var(--rn-clr-content-secondary)',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                    }}
                >
                    📝 {rep.notes}
                </div>
            )}
            {rep.context && (
                <div
                    style={{
                        fontSize: '10px',
                        color: 'var(--rn-clr-content-tertiary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                    }}
                    title={formatRepContext(rep.context)}
                >
                    {formatRepContext(rep.context)}
                </div>
            )}
        </div>
    );
}

/**
 * Formats the early/late status into a human-readable string.
 */
function formatEarlyLate(rep: IncrementalRep): string {
    if (rep.daysEarlyOrLate === undefined || rep.daysEarlyOrLate === 0) {
        return '—';
    }
    const days = Math.round(Math.abs(rep.daysEarlyOrLate)); // Round to whole days
    if (rep.daysEarlyOrLate < 0) {
        return `${days}d early`;
    }
    return `+${days}d late`;
}

/**
 * Calculate age since first repetition.
 */
function calculateAge(history: IncrementalRep[]): string {
    if (!history || history.length === 0) return '—';
    // Sort to find the earliest date
    const sortedByDate = [...history].sort((a, b) => a.date - b.date);
    const firstRepDate = sortedByDate[0].date;
    const now = Date.now();
    const diffMs = now - firstRepDate;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'today';
    if (diffDays === 1) return '1 day';
    if (diffDays < 30) return `${diffDays} days`;
    if (diffDays < 365) {
        const months = Math.floor(diffDays / 30);
        return months === 1 ? '1 month' : `${months} months`;
    }
    const years = Math.floor(diffDays / 365);
    return years === 1 ? '1 year' : `${years} years`;
}

/**
 * Calculate total time spent from history.
 */
function getTotalTime(history: IncrementalRep[]): number {
    if (!history || history.length === 0) return 0;
    return history.reduce((total, rep) => total + (rep.reviewTimeSeconds || 0), 0);
}

// ─── After-the-fact history editing ─────────────────────────────────────────

type DialogMode = 'add' | 'edit';

interface DialogTarget {
    mode: DialogMode;
    /** The entry being edited (absent in 'add' mode). */
    entry?: IncrementalRep;
    /** Its index in the STORED (chronological) history — a hint for re-location. */
    index?: number;
    /** Open straight into the delete confirmation (row 🗑 button). */
    confirmDelete?: boolean;
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/** "YYYY-MM-DD" + "HH:mm" (both local) → epoch ms; NaN when either is missing/invalid. */
function combineDateTime(dateStr: string, timeStr: string): number {
    if (!dateStr) return NaN;
    return new Date(`${dateStr}T${timeStr || '00:00'}`).getTime();
}

/** Human label for an entry, used in the delete confirmation. */
function describeEntry(rep: IncrementalRep): string {
    const when = dayjs(rep.date).format('MMM D, YYYY HH:mm');
    switch (rep.eventType) {
        case 'madeIncremental': return `Made Incremental — ${when}`;
        case 'dismissed': return `Dismissed — ${when}`;
        case 'rescheduledInEditor': return `Rescheduled in Editor — ${when}`;
        case 'rescheduledInQueue': return `Rescheduled in Queue — ${when}`;
        case 'manualDateReset': return `Manual Date Reset — ${when}`;
        case 'executeRepetition': return `Editor review — ${when}`;
        case 'importedRep': return `Imported flashcard review — ${when}`;
        case 'externalRep': return `External session — ${when}`;
        default: return `Review — ${when}`;
    }
}

/** Lifecycle markers the scheduler reads positionally — deleting one has consequences. */
function isLifecycleMarker(rep: IncrementalRep): boolean {
    return rep.eventType === 'madeIncremental' || rep.eventType === 'dismissed';
}

/**
 * Overlay form for recording an external study session, and for editing or
 * deleting an existing history entry. Rendered inside the popup (not as a
 * nested popup, which would close this one).
 */
function HistoryEntryDialog({
    plugin,
    remId,
    target,
    history,
    canSchedule,
    onClose,
    onSaved,
}: {
    plugin: RNPlugin;
    remId: string;
    target: DialogTarget;
    history: IncrementalRep[];
    /** False for dismissed rems: there is no schedule to move. */
    canSchedule: boolean;
    onClose: () => void;
    onSaved: (message: string) => void;
}) {
    const entry = target.entry;
    const isAdd = target.mode === 'add';

    const initial = entry?.date ?? Date.now();
    const [dateStr, setDateStr] = React.useState(dayjs(initial).format('YYYY-MM-DD'));
    const [timeStr, setTimeStr] = React.useState(dayjs(initial).format('HH:mm'));
    const initialSeconds = entry?.reviewTimeSeconds || 0;
    const [hours, setHours] = React.useState(String(Math.floor(initialSeconds / 3600)));
    const [minutes, setMinutes] = React.useState(String(Math.round((initialSeconds % 3600) / 60)));
    const [note, setNote] = React.useState(entry?.notes || '');
    const [confirmingDelete, setConfirmingDelete] = React.useState(!!target.confirmDelete);
    const [error, setError] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);

    // Rescheduling (add mode only, and only when the session is the newest entry)
    const [reschedule, setReschedule] = React.useState(true);
    const [nextRepStr, setNextRepStr] = React.useState('');
    const nextRepTouched = React.useRef(false);

    // A successful save unmounts this dialog (the parent clears it), and the user
    // can also close it mid-write. Every state update that happens after an await
    // therefore has to check we're still mounted, or React warns about updating
    // an unmounted component.
    const mounted = React.useRef(true);
    React.useEffect(() => () => { mounted.current = false; }, []);
    const failWith = (message: string) => { if (mounted.current) setError(message); };
    const stopBusy = () => { if (mounted.current) setBusy(false); };

    const sessionMs = combineDateTime(dateStr, timeStr);
    const sessionValid = !Number.isNaN(sessionMs);
    const willBeNewest = sessionValid && isNewestEntry(history, sessionMs);
    const schedulingAvailable = isAdd && canSchedule && sessionValid && willBeNewest;

    // The interval the scheduler would give this rem right now — used to prefill
    // the next-repetition date, exactly as the Ctrl+Shift+J flow does.
    const suggestedInterval = useRunAsync(async () => {
        if (!isAdd || !canSchedule) return null;
        try {
            const data = await getNextSpacingDateForRem(plugin, remId, false);
            return data?.newInterval ?? null;
        } catch {
            return null;
        }
    }, [isAdd, canSchedule, remId]);

    // Keep the next-rep date in step with the session date until the user edits it.
    React.useEffect(() => {
        if (!schedulingAvailable || nextRepTouched.current) return;
        const days = suggestedInterval ?? 1;
        setNextRepStr(dayjs(sessionMs + days * MS_PER_DAY).format('YYYY-MM-DD'));
    }, [schedulingAvailable, sessionMs, suggestedInterval]);

    const durationSeconds =
        (parseInt(hours || '0', 10) || 0) * 3600 + (parseInt(minutes || '0', 10) || 0) * 60;

    // Total time is only meaningful for entries that represent actual study.
    const showDuration = isAdd || !entry || !isLifecycleMarker(entry);

    const handleSave = async () => {
        setError(null);
        if (!sessionValid) {
            setError('Enter a valid date and end time.');
            return;
        }
        if (sessionMs > Date.now()) {
            setError("The session's end time can't be in the future.");
            return;
        }
        if (isAdd && durationSeconds <= 0) {
            setError('Enter how long the session lasted.');
            return;
        }

        let nextRepMs: number | undefined;
        if (schedulingAvailable && reschedule) {
            nextRepMs = combineDateTime(nextRepStr, '09:00');
            if (Number.isNaN(nextRepMs)) {
                setError('Enter a valid next-repetition date, or untick the reschedule box.');
                return;
            }
        }

        setBusy(true);
        try {
            if (isAdd) {
                const result = await addExternalSessionRep(plugin, remId, {
                    date: sessionMs,
                    reviewTimeSeconds: durationSeconds,
                    note,
                    nextRepDate: nextRepMs,
                });
                if (!result.ok) {
                    failWith(result.error || 'Could not record the session.');
                    return;
                }
                onSaved(
                    result.rescheduled
                        ? `✓ Session recorded — next repetition ${dayjs(nextRepMs).format('MMM D, YYYY')}`
                        : '✓ Session recorded (schedule unchanged)'
                );
            } else {
                const result = await updateHistoryEntry(
                    plugin,
                    remId,
                    entry!,
                    {
                        date: sessionMs,
                        ...(showDuration ? { reviewTimeSeconds: durationSeconds } : {}),
                        notes: note,
                    },
                    target.index
                );
                if (!result.ok) {
                    failWith(result.error || 'Could not update the entry.');
                    return;
                }
                onSaved('✓ Entry updated');
            }
        } catch (e) {
            console.error('[RepetitionHistoryPopup] save failed:', e);
            failWith(String(e));
        } finally {
            stopBusy();
        }
    };

    const handleDelete = async () => {
        setBusy(true);
        setError(null);
        try {
            const result = await deleteHistoryEntry(plugin, remId, entry!, target.index);
            if (!result.ok) {
                failWith(result.error || 'Could not delete the entry.');
                return;
            }
            onSaved('✓ Entry deleted');
        } catch (e) {
            console.error('[RepetitionHistoryPopup] delete failed:', e);
            failWith(String(e));
        } finally {
            stopBusy();
        }
    };

    const overlayStyle: React.CSSProperties = {
        position: 'absolute',
        inset: 0,
        backgroundColor: 'var(--rn-clr-background-primary)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 10,
    };

    const labelStyle: React.CSSProperties = {
        fontSize: '10px',
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
        color: 'var(--rn-clr-content-tertiary)',
        marginBottom: '3px',
        display: 'block',
    };

    const inputStyle: React.CSSProperties = {
        width: '100%',
        padding: '6px 8px',
        fontSize: '12px',
        borderRadius: '6px',
        border: '1px solid var(--rn-clr-border-primary)',
        background: 'var(--rn-clr-background-secondary)',
        color: 'var(--rn-clr-content-primary)',
        boxSizing: 'border-box',
    };

    const buttonStyle = (primary?: boolean, danger?: boolean): React.CSSProperties => ({
        flex: 1,
        padding: '7px 10px',
        fontSize: '12px',
        fontWeight: 600,
        borderRadius: '6px',
        cursor: busy ? 'default' : 'pointer',
        opacity: busy ? 0.6 : 1,
        border: '1px solid var(--rn-clr-border-primary)',
        background: danger ? '#ef4444' : primary ? '#3b82f6' : 'transparent',
        color: danger || primary ? '#fff' : 'var(--rn-clr-content-secondary)',
    });

    if (confirmingDelete && entry) {
        return (
            <div style={overlayStyle}>
                <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--rn-clr-border-primary)', fontWeight: 600, fontSize: '14px' }}>
                    🗑 Delete this record?
                </div>
                <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '12px' }}>
                    <div style={{ color: 'var(--rn-clr-content-secondary)' }}>{describeEntry(entry)}</div>
                    {entry.reviewTimeSeconds ? (
                        <div style={{ color: 'var(--rn-clr-content-tertiary)' }}>
                            {formatDuration(entry.reviewTimeSeconds)} of study time will be removed from this Rem's totals.
                        </div>
                    ) : null}
                    {isLifecycleMarker(entry) && (
                        <div style={{ color: '#f59e0b' }}>
                            ⚠️ This is a lifecycle marker. Removing it changes how the scheduler counts
                            repetitions for this Rem.
                        </div>
                    )}
                    <div style={{ color: 'var(--rn-clr-content-tertiary)' }}>This cannot be undone.</div>
                    {error && <div style={{ color: '#ef4444' }}>{error}</div>}
                    <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                        <button
                            style={buttonStyle(false)}
                            disabled={busy}
                            onClick={() => (target.confirmDelete ? onClose() : setConfirmingDelete(false))}
                        >
                            Cancel
                        </button>
                        <button style={buttonStyle(false, true)} disabled={busy} onClick={handleDelete}>
                            Delete
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div style={overlayStyle}>
            <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--rn-clr-border-primary)', fontWeight: 600, fontSize: '14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{isAdd ? '➕ Add external session' : '✏️ Edit record'}</span>
                <button
                    style={{ background: 'none', border: 'none', fontSize: '16px', cursor: 'pointer', opacity: 0.6, padding: '2px' }}
                    onClick={onClose}
                    title="Cancel"
                >
                    ✕
                </button>
            </div>

            <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '12px', overflowY: 'auto' }}>
                {isAdd && (
                    <div style={{ fontSize: '11px', color: 'var(--rn-clr-content-tertiary)', lineHeight: 1.4 }}>
                        Record study done away from RemNote. The entry is logged as an external
                        session (📖) and counts towards this Rem's reps and total time.
                    </div>
                )}

                <div style={{ display: 'flex', gap: '8px' }}>
                    <div style={{ flex: 1 }}>
                        <label style={labelStyle}>Date</label>
                        <input
                            type="date"
                            value={dateStr}
                            max={dayjs().format('YYYY-MM-DD')}
                            onChange={(e) => setDateStr(e.target.value)}
                            style={inputStyle}
                        />
                    </div>
                    <div style={{ width: '110px' }}>
                        <label style={labelStyle}>End time</label>
                        <input
                            type="time"
                            value={timeStr}
                            onChange={(e) => setTimeStr(e.target.value)}
                            style={inputStyle}
                        />
                    </div>
                </div>

                {showDuration && (
                    <div>
                        <label style={labelStyle}>Total time</label>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <input
                                type="number"
                                min={0}
                                value={hours}
                                onChange={(e) => setHours(e.target.value)}
                                style={{ ...inputStyle, width: '70px' }}
                            />
                            <span style={{ fontSize: '12px', color: 'var(--rn-clr-content-tertiary)' }}>h</span>
                            <input
                                type="number"
                                min={0}
                                max={59}
                                value={minutes}
                                onChange={(e) => setMinutes(e.target.value)}
                                style={{ ...inputStyle, width: '70px' }}
                            />
                            <span style={{ fontSize: '12px', color: 'var(--rn-clr-content-tertiary)' }}>m</span>
                            <span style={{ fontSize: '11px', color: 'var(--rn-clr-content-tertiary)', marginLeft: 'auto' }}>
                                {durationSeconds > 0 ? formatDuration(durationSeconds) : '—'}
                            </span>
                        </div>
                    </div>
                )}

                <div>
                    <label style={labelStyle}>Note (optional)</label>
                    <textarea
                        value={note}
                        maxLength={MAX_NOTE_LENGTH}
                        rows={2}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder="What you covered, where you read it…"
                        style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
                    />
                </div>

                {isAdd && canSchedule && (
                    schedulingAvailable ? (
                        <div style={{ borderTop: '1px solid var(--rn-clr-border-secondary)', paddingTop: '10px' }}>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', cursor: 'pointer' }}>
                                <input
                                    type="checkbox"
                                    checked={reschedule}
                                    onChange={(e) => setReschedule(e.target.checked)}
                                />
                                <span>Reschedule next repetition</span>
                            </label>
                            {reschedule && (
                                <div style={{ marginTop: '8px' }}>
                                    <label style={labelStyle}>Next repetition</label>
                                    <input
                                        type="date"
                                        value={nextRepStr}
                                        onChange={(e) => {
                                            nextRepTouched.current = true;
                                            setNextRepStr(e.target.value);
                                        }}
                                        style={inputStyle}
                                    />
                                    <div style={{ fontSize: '10px', color: 'var(--rn-clr-content-tertiary)', marginTop: '4px' }}>
                                        {suggestedInterval
                                            ? `Suggested: ${suggestedInterval}d after the session${nextRepTouched.current ? '' : ' (applied)'}`
                                            : 'Pick when this Rem should come up next.'}
                                    </div>
                                </div>
                            )}
                        </div>
                    ) : (
                        <div style={{ borderTop: '1px solid var(--rn-clr-border-secondary)', paddingTop: '10px', fontSize: '11px', color: 'var(--rn-clr-content-tertiary)', lineHeight: 1.4 }}>
                            ⏪ This session predates the most recent record, so the schedule is left
                            untouched — only the history entry is added.
                        </div>
                    )
                )}

                {!isAdd && (
                    <div style={{ fontSize: '10px', color: 'var(--rn-clr-content-tertiary)', lineHeight: 1.4 }}>
                        Editing a record never changes the schedule. Early/late status is recomputed
                        against the date this repetition was originally due.
                    </div>
                )}

                {error && <div style={{ fontSize: '11px', color: '#ef4444' }}>{error}</div>}

                <div style={{ display: 'flex', gap: '8px', marginTop: '2px' }}>
                    <button style={buttonStyle(false)} disabled={busy} onClick={onClose}>
                        Cancel
                    </button>
                    {!isAdd && (
                        <button
                            style={{ ...buttonStyle(false), flex: '0 0 auto', color: '#ef4444' }}
                            disabled={busy}
                            onClick={() => setConfirmingDelete(true)}
                            title="Delete this record"
                        >
                            🗑
                        </button>
                    )}
                    <button style={buttonStyle(true)} disabled={busy} onClick={handleSave}>
                        {busy ? 'Saving…' : isAdd ? 'Record session' : 'Save changes'}
                    </button>
                </div>
            </div>
        </div>
    );
}

function RepetitionHistoryPopup() {
    const plugin = usePlugin();

    // Bumped after every add/edit/delete so the history reloads from the rem.
    const [refreshKey, setRefreshKey] = React.useState(0);
    const [dialog, setDialog] = React.useState<DialogTarget | null>(null);
    const [hoveredIndex, setHoveredIndex] = React.useState<number | null>(null);

    const data = useRunAsync(async () => {
        try {
            const ctx = await plugin.widget.getWidgetContext<WidgetLocation.Popup>();
            const remId = ctx?.contextData?.remId;

            if (!remId) {
                return { history: [], remName: '', remId: null, error: 'No remId', isDismissed: false, dismissedDate: null };
            }

            const rem = await plugin.rem.findOne(remId);
            if (!rem) {
                return { history: [], remName: '', remId, error: 'Rem not found', isDismissed: false, dismissedDate: null };
            }

            // Get rem name
            const remName = await safeRemTextToString(plugin, rem.text);

            // PDF page-range / reading-progress info (shown for both active
            // IncRems and dismissed rems that read from a PDF with a range set).
            const pdfPageInfo = await loadPdfPageInfo(plugin, rem, remId);

            // First try to get incremental rem info
            const incRemInfo = await getIncrementalRemFromRem(plugin, rem);

            if (incRemInfo) {
                // Active incremental rem
                return {
                    history: incRemInfo.history || [],
                    remName: remName || 'Unknown Rem',
                    remId,
                    nextRepDate: incRemInfo.nextRepDate || null,
                    isIncremental: true,
                    isDismissed: false,
                    dismissedDate: null,
                    pdfPageInfo,
                    error: null
                };
            }

            // Check for dismissed history if not an active incremental rem
            const dismissedInfo = await getDismissedHistoryFromRem(plugin, rem);

            if (dismissedInfo) {
                // Dismissed rem with history
                return {
                    history: dismissedInfo.history || [],
                    remName: remName || 'Unknown Rem',
                    remId,
                    nextRepDate: null,
                    isIncremental: false,
                    isDismissed: true,
                    dismissedDate: dismissedInfo.dismissedDate,
                    pdfPageInfo,
                    error: null
                };
            }

            // Neither incremental nor dismissed
            return {
                history: [],
                remName: remName || 'Unknown Rem',
                remId,
                nextRepDate: null,
                isIncremental: false,
                isDismissed: false,
                dismissedDate: null,
                pdfPageInfo,
                error: null
            };
        } catch (error) {
            console.error('[RepetitionHistoryPopup] Error loading history:', error);
            return { history: [], remName: '', remId: null, nextRepDate: null, isDismissed: false, dismissedDate: null, error: String(error) };
        }
    }, [refreshKey]);

    const containerStyle: React.CSSProperties = {
        width: '440px',
        maxHeight: '850px',
        backgroundColor: 'var(--rn-clr-background-primary)',
        borderRadius: '12px',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'inherit',
        position: 'relative', // anchors the add/edit overlay
    };

    const headerStyle: React.CSSProperties = {
        padding: '14px 16px',
        borderBottom: '1px solid var(--rn-clr-border-primary)',
        backgroundColor: 'var(--rn-clr-background-secondary)',
        fontWeight: 600,
        fontSize: '14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
    };

    const headerTopRowStyle: React.CSSProperties = {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
    };

    const headerTitleStyle: React.CSSProperties = {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
    };

    const remNameStyle: React.CSSProperties = {
        fontSize: '12px',
        fontWeight: 400,
        color: 'var(--rn-clr-content-secondary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        maxWidth: '380px',
    };

    const closeButtonStyle: React.CSSProperties = {
        background: 'none',
        border: 'none',
        fontSize: '18px',
        cursor: 'pointer',
        opacity: 0.6,
        padding: '4px',
        lineHeight: 1,
    };

    const statsRowStyle: React.CSSProperties = {
        display: 'flex',
        justifyContent: 'space-around',
        padding: '12px 16px',
        backgroundColor: 'var(--rn-clr-background-secondary)',
        borderBottom: '1px solid var(--rn-clr-border-primary)',
        fontSize: '12px',
    };

    const statStyle: React.CSSProperties = {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '4px',
    };

    const statValueStyle: React.CSSProperties = {
        fontWeight: 700,
        fontSize: '16px',
        color: 'var(--rn-clr-content-primary)',
    };

    const statLabelStyle: React.CSSProperties = {
        color: 'var(--rn-clr-content-tertiary)',
        fontSize: '10px',
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
    };

    const gridContainerStyle: React.CSSProperties = {
        flex: 1,
        overflowY: 'auto',
        padding: '8px 0',
    };

    const gridHeaderStyle: React.CSSProperties = {
        display: 'grid',
        gridTemplateColumns: '95px 60px 50px 40px 75px 46px',
        padding: '8px 16px',
        fontSize: '10px',
        fontWeight: 600,
        color: 'var(--rn-clr-content-tertiary)',
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
        borderBottom: '1px solid var(--rn-clr-border-primary)',
        position: 'sticky',
        top: 0,
        backgroundColor: 'var(--rn-clr-background-primary)',
    };

    const gridRowStyle: React.CSSProperties = {
        display: 'grid',
        gridTemplateColumns: '95px 60px 50px 40px 75px 46px',
        padding: '10px 16px',
        fontSize: '12px',
        borderBottom: '1px solid var(--rn-clr-border-secondary)',
    };

    const emptyStyle: React.CSSProperties = {
        padding: '32px',
        textAlign: 'center',
        color: 'var(--rn-clr-content-tertiary)',
        fontSize: '13px',
    };

    const loadingStyle: React.CSSProperties = {
        padding: '32px',
        textAlign: 'center',
        color: 'var(--rn-clr-content-tertiary)',
        fontSize: '13px',
    };

    if (!data) {
        return (
            <div style={containerStyle}>
                <div style={loadingStyle}>Loading...</div>
            </div>
        );
    }

    const { history, remName, remId, nextRepDate, isDismissed, dismissedDate, pdfPageInfo } =
        data as typeof data & { pdfPageInfo?: PdfPageInfo | null; isIncremental?: boolean };
    const isIncremental = (data as any).isIncremental === true;
    // History can only be amended where it is actually stored: on the Incremental
    // powerup, or on the Dismissed powerup of a dismissed rem.
    const canEditHistory = !!remId && (isIncremental || isDismissed);
    const totalTime = getTotalTime(history);
    const age = calculateAge(history);

    // Estimated remaining reading time: extrapolate the time already spent to
    // the portion of the range still unread. Only meaningful when we have a
    // finite degree of processing strictly between 0% and 100% and some time
    // recorded — otherwise there is no rate to project from.
    const estRemainingSeconds =
        pdfPageInfo && pdfPageInfo.percentRead !== null &&
        pdfPageInfo.percentRead > 0 && pdfPageInfo.percentRead < 100 && totalTime > 0
            ? Math.round((totalTime * (100 - pdfPageInfo.percentRead)) / pdfPageInfo.percentRead)
            : null;
    // Count only events that represent actual reviews (shared stats predicate;
    // includes imported flashcard reps on preserved-history tombstones).
    const repCount = history?.filter(h => repCountsForStats(h.eventType)).length || 0;

    // Calculate days late/early for next scheduled rep
    const now = Date.now();
    const daysLate = nextRepDate ? Math.round((now - nextRepDate) / (1000 * 60 * 60 * 24)) : null;
    const daysLateText = daysLate !== null
        ? (daysLate > 0 ? `${daysLate}d late` : daysLate < 0 ? `${Math.abs(daysLate)}d early` : 'today')
        : '—';

    // Sort history by date descending (most recent first). The stored index is
    // carried along so the edit/delete actions can point at the right entry in
    // the underlying (chronological) array.
    const sortedHistory = (history || [])
        .map((rep, storedIndex) => ({ rep, storedIndex }))
        .sort((a, b) => b.rep.date - a.rep.date);

    const secondaryStatsStyle: React.CSSProperties = {
        display: 'flex',
        justifyContent: 'center',
        gap: '24px',
        padding: '8px 16px',
        backgroundColor: 'var(--rn-clr-background-primary)',
        borderBottom: '1px solid var(--rn-clr-border-primary)',
        fontSize: '11px',
        color: 'var(--rn-clr-content-tertiary)',
    };

    const bannerBaseStyle: React.CSSProperties = {
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
        display: 'flex',
        justifyContent: 'center',
        fontWeight: 600,
        fontSize: '11px',
        borderRadius: '4px',
        padding: '6px 8px',
        margin: '4px 0',
        whiteSpace: 'nowrap',
    };

    const rowActionButtonStyle: React.CSSProperties = {
        background: 'none',
        border: 'none',
        padding: 0,
        fontSize: '12px',
        lineHeight: 1,
        cursor: 'pointer',
        opacity: 0.75,
    };

    const pdfFooterStyle: React.CSSProperties = {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '10px 16px',
        borderTop: '1px solid rgba(128, 128, 128, 0.25)',
        backgroundColor: 'var(--rn-clr-background-secondary)',
        fontSize: '11px',
        color: 'var(--rn-clr-content-secondary)',
    };

    return (
        <div style={containerStyle}>
            <div style={headerStyle}>
                <div style={headerTopRowStyle}>
                    <div style={headerTitleStyle}>
                        <span>📊</span>
                        <span style={{ whiteSpace: 'nowrap' }}>Repetition History</span>
                        <button
                            onClick={async () => {
                                if (remId) {
                                    await plugin.widget.openPopup('aggregated_repetition_history', { remId });
                                }
                            }}
                            style={{
                                marginLeft: '12px',
                                fontSize: '11px',
                                padding: '2px 6px',
                                borderRadius: '4px',
                                border: '1px solid var(--rn-clr-border-primary)',
                                background: 'transparent',
                                cursor: 'pointer',
                                color: 'var(--rn-clr-content-secondary)',
                                whiteSpace: 'nowrap',
                                flexShrink: 0,
                            }}
                            title="Switch to Aggregated View"
                        >
                            Show Aggregated
                        </button>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                        {canEditHistory && (
                            <button
                                onClick={() => setDialog({ mode: 'add' })}
                                style={{
                                    fontSize: '11px',
                                    padding: '2px 6px',
                                    borderRadius: '4px',
                                    border: '1px solid var(--rn-clr-border-primary)',
                                    background: 'transparent',
                                    cursor: 'pointer',
                                    color: 'var(--rn-clr-content-secondary)',
                                    whiteSpace: 'nowrap',
                                    flexShrink: 0,
                                }}
                                title="Record a study session done outside RemNote (past date, end time and total time)"
                            >
                                ➕ Session
                            </button>
                        )}
                        <button
                            style={closeButtonStyle}
                            onClick={() => plugin.widget.closePopup()}
                            title="Close"
                        >
                            ✕
                        </button>
                    </div>
                </div>
                {remName && <div style={remNameStyle} title={remName}>{remName}</div>}
            </div>

            <div style={statsRowStyle}>
                <div style={statStyle}>
                    <span style={statValueStyle}>{repCount}</span>
                    <span style={statLabelStyle}>Reps</span>
                </div>
                <div style={statStyle}>
                    <span style={statValueStyle}>{formatDuration(totalTime) || '0s'}</span>
                    <span style={statLabelStyle}>Total Time</span>
                </div>
                <div style={statStyle}>
                    <span style={statValueStyle}>{age}</span>
                    <span style={statLabelStyle}>Age</span>
                </div>
            </div>

            <div style={secondaryStatsStyle}>
                {isDismissed ? (
                    <span style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '4px 10px',
                        borderRadius: '12px',
                        backgroundColor: 'rgba(245, 158, 11, 0.15)',
                        color: '#f59e0b',
                        fontWeight: 600,
                        fontSize: '11px',
                    }}>
                        ⚪ Dismissed {dismissedDate ? `on ${dayjs(dismissedDate).format('MMM D, YYYY')}` : ''}
                    </span>
                ) : (
                    <>
                        <span>Next: <strong>{nextRepDate ? dayjs(nextRepDate).format('MMM D, YYYY') : '—'}</strong></span>
                        <span style={{ color: daysLate !== null && daysLate > 0 ? 'var(--rn-clr-red, #ef4444)' : daysLate !== null && daysLate < 0 ? 'var(--rn-clr-green, #22c55e)' : 'inherit' }}>
                            {daysLateText}
                        </span>
                    </>
                )}
            </div>

            {sortedHistory.length === 0 ? (
                <div style={emptyStyle}>
                    No repetitions yet. Complete your first review!
                </div>
            ) : (
                <div style={gridContainerStyle}>
                    <div style={gridHeaderStyle}>
                        <span>Date</span>
                        <span>Time</span>
                        <span>Int.</span>
                        <span>Pri.</span>
                        <span>Status</span>
                        <span />
                    </div>
                    {sortedHistory.map(({ rep, storedIndex }, index) => {
                        const hovered = hoveredIndex === index;

                        // Edit / delete affordances, revealed on hover. Their space is
                        // reserved even while hidden so rows don't shift under the cursor.
                        const actions = (
                            <span
                                style={{
                                    display: 'flex',
                                    justifyContent: 'flex-end',
                                    alignItems: 'center',
                                    gap: '3px',
                                    visibility: hovered ? 'visible' : 'hidden',
                                }}
                            >
                                <button
                                    style={rowActionButtonStyle}
                                    title="Edit this record (date, end time, total time)"
                                    onClick={() => setDialog({ mode: 'edit', entry: rep, index: storedIndex })}
                                >
                                    ✏️
                                </button>
                                <button
                                    style={rowActionButtonStyle}
                                    title="Delete this record"
                                    onClick={() =>
                                        setDialog({ mode: 'edit', entry: rep, index: storedIndex, confirmDelete: true })
                                    }
                                >
                                    🗑
                                </button>
                            </span>
                        );

                        const wrap = (content: React.ReactNode) => (
                            <div
                                key={index}
                                onMouseEnter={() => setHoveredIndex(index)}
                                onMouseLeave={() => setHoveredIndex((cur) => (cur === index ? null : cur))}
                            >
                                {content}
                                <NoteAndContextLine rep={rep} />
                            </div>
                        );

                        // Banner timestamp: date plus the local wall-clock time the
                        // event was recorded. Same information the rep rows show —
                        // it disambiguates several lifecycle events on one day
                        // (make incremental → dismiss → make incremental again).
                        //
                        // Spacing comes from the span's own margins, never from plain
                        // spaces around it: the banner is a flex container, so this
                        // span is a flex item and the layout trims the whitespace at
                        // its edges — that is what glued "2026" to "09:44", and what
                        // ate the space before a trailing " — Pri: 26" once the span
                        // split that text off into its own item.
                        const bannerWhen = (
                            <>
                                {dayjs(rep.date).format('MMM D, YYYY')}
                                <span
                                    style={{
                                        opacity: 0.75,
                                        fontWeight: 400,
                                        margin: '0 5px',
                                        letterSpacing: '0.2px',
                                    }}
                                >
                                    · {dayjs(rep.date).format('HH:mm')}
                                </span>
                            </>
                        );

                        // Lifecycle / slot-edit events render as a banner; the row actions
                        // sit beside it instead of in a grid cell.
                        const banner = (accent: React.CSSProperties, body: React.ReactNode) =>
                            wrap(
                                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                    <div style={{ ...bannerBaseStyle, ...accent }}>{body}</div>
                                    {canEditHistory && <span style={{ flex: '0 0 44px' }}>{actions}</span>}
                                </div>
                            );

                        if (rep.eventType === 'madeIncremental') {
                            return banner(
                                { backgroundColor: 'rgba(34, 197, 94, 0.1)', color: '#22c55e' },
                                <>
                                    ▶ Made Incremental — {bannerWhen}
                                    {rep.priority !== undefined && ` — Pri: ${rep.priority}`}
                                </>
                            );
                        }

                        if (rep.eventType === 'dismissed') {
                            return banner(
                                { backgroundColor: 'rgba(245, 158, 11, 0.1)', color: '#f59e0b' },
                                <>⏸ Dismissed — {bannerWhen}</>
                            );
                        }

                        // Rescheduled in Editor - event marker (purple, no review counted)
                        if (rep.eventType === 'rescheduledInEditor') {
                            return banner(
                                { backgroundColor: 'rgba(147, 51, 234, 0.1)', color: '#9333ea' },
                                <>
                                    📅 Rescheduled in Editor — {bannerWhen}
                                    {rep.interval !== undefined && ` → ${rep.interval}d`}
                                    {rep.priority !== undefined && ` — Pri: ${rep.priority}`}
                                </>
                            );
                        }

                        // Manual Date Reset - event marker (gray, no review counted)
                        if (rep.eventType === 'manualDateReset') {
                            return banner(
                                { backgroundColor: 'rgba(107, 114, 128, 0.1)', color: '#6b7280' },
                                <>
                                    ✏️ Manual Date Reset — {bannerWhen}
                                    {rep.interval !== undefined && ` → ${rep.interval}d`}
                                    {rep.priority !== undefined && ` — Pri: ${rep.priority}`}
                                </>
                            );
                        }

                        // Get event indicator for row display
                        const getEventIndicator = () => {
                            if (rep.eventType === 'rescheduledInQueue') return '📅 ';
                            if (rep.eventType === 'executeRepetition') return '⌨️ ';
                            if (rep.eventType === 'importedRep') return '🃏 ';
                            if (rep.eventType === 'externalRep') return '📖 ';
                            return '';
                        };

                        // Regular rep entry (includes rescheduledInQueue, executeRepetition
                        // and externalRep, each with its own indicator)
                        return wrap(
                            <div style={gridRowStyle}>
                                <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.3 }}>
                                    <span>{getEventIndicator()}{dayjs(rep.date).format('MMM D, YYYY')}</span>
                                    {/* Local wall-clock time of the review (24h) — disambiguates
                                        multiple reviews on the same day. */}
                                    <span style={{ fontSize: '10px', color: 'var(--rn-clr-content-tertiary)' }}>
                                        {dayjs(rep.date).format('HH:mm')}
                                    </span>
                                </span>
                                <span>{formatDuration(rep.reviewTimeSeconds || 0) || '—'}</span>
                                <span>{rep.interval !== undefined ? `${rep.interval}d` : '—'}</span>
                                <span>{rep.priority !== undefined ? rep.priority : '—'}</span>
                                <span style={{
                                    color: rep.daysEarlyOrLate !== undefined && rep.daysEarlyOrLate > 0
                                        ? 'var(--rn-clr-red, #ef4444)'
                                        : rep.daysEarlyOrLate !== undefined && rep.daysEarlyOrLate < 0
                                            ? 'var(--rn-clr-green, #22c55e)'
                                            : 'inherit'
                                }}>
                                    {formatEarlyLate(rep)}
                                </span>
                                {canEditHistory ? actions : <span />}
                            </div>
                        );
                    })}
                </div>
            )}

            {pdfPageInfo && (
                <div style={pdfFooterStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span>📄</span>
                        <span
                            title={pdfPageInfo.pdfName}
                            style={{
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                fontWeight: 600,
                            }}
                        >
                            {pdfPageInfo.pdfName}
                        </span>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '16px' }}>
                        <span>
                            Range: <strong>{pdfPageInfo.start}–{pdfPageInfo.end || '∞'}</strong>
                        </span>
                        <span>
                            Current page: <strong>{pdfPageInfo.currentPage}</strong>
                        </span>
                        {pdfPageInfo.percentRead !== null && (
                            <span>
                                <strong>{pdfPageInfo.percentRead}%</strong> read
                                {pdfPageInfo.end > pdfPageInfo.start && (
                                    <> ({pdfPageInfo.currentPage - pdfPageInfo.start}/{pdfPageInfo.end - pdfPageInfo.start}p)</>
                                )}
                            </span>
                        )}
                        {pdfPageInfo.currentPage > pdfPageInfo.start && totalTime > 0 && (
                            <span title="Average reading speed: pages read ÷ total time spent">
                                <strong>{((pdfPageInfo.currentPage - pdfPageInfo.start) * 3600 / totalTime).toFixed(1)}</strong> pages/h
                            </span>
                        )}
                        {estRemainingSeconds !== null && (
                            <span title="Estimated from time spent so far and the degree of processing achieved">
                                Est. remaining: <strong>~{formatDuration(estRemainingSeconds)}</strong>
                            </span>
                        )}
                        {estRemainingSeconds !== null && (
                            <span title="Estimated total = time already spent + estimated remaining">
                                Est. total: <strong>~{formatDuration(totalTime + estRemainingSeconds)}</strong>
                            </span>
                        )}
                    </div>
                    {pdfPageInfo.percentRead !== null && (
                        <div
                            style={{
                                height: '6px',
                                borderRadius: '3px',
                                backgroundColor: 'rgba(128, 128, 128, 0.25)',
                                overflow: 'hidden',
                            }}
                        >
                            <div
                                style={{
                                    width: `${pdfPageInfo.percentRead}%`,
                                    height: '100%',
                                    backgroundColor: '#3b82f6',
                                    borderRadius: '3px',
                                    transition: 'width 0.2s ease',
                                }}
                            />
                        </div>
                    )}
                </div>
            )}

            {dialog && remId && (
                <HistoryEntryDialog
                    plugin={plugin}
                    remId={remId}
                    target={dialog}
                    history={history || []}
                    canSchedule={isIncremental}
                    onClose={() => setDialog(null)}
                    onSaved={async (message) => {
                        setDialog(null);
                        setHoveredIndex(null);
                        setRefreshKey((k) => k + 1);
                        await plugin.app.toast(message);
                    }}
                />
            )}
        </div>
    );
}

renderWidget(RepetitionHistoryPopup);
