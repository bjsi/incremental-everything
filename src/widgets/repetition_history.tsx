import React from 'react';
import { renderWidget, usePlugin, WidgetLocation, useRunAsync } from '@remnote/plugin-sdk';
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

function RepetitionHistoryPopup() {
    const plugin = usePlugin();

    const data = useRunAsync(async () => {
        try {
            const ctx = await plugin.widget.getWidgetContext<WidgetLocation.Popup>();
            const remId = ctx?.contextData?.remId;

            if (!remId) {
                return { history: [], remName: '', error: 'No remId', isDismissed: false, dismissedDate: null };
            }

            const rem = await plugin.rem.findOne(remId);
            if (!rem) {
                return { history: [], remName: '', error: 'Rem not found', isDismissed: false, dismissedDate: null };
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
                    nextRepDate: incRemInfo.nextRepDate || null,
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
                    nextRepDate: null,
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
                nextRepDate: null,
                isDismissed: false,
                dismissedDate: null,
                pdfPageInfo,
                error: null
            };
        } catch (error) {
            console.error('[RepetitionHistoryPopup] Error loading history:', error);
            return { history: [], remName: '', nextRepDate: null, isDismissed: false, dismissedDate: null, error: String(error) };
        }
    }, []);

    const containerStyle: React.CSSProperties = {
        width: '380px',
        maxHeight: '850px',
        backgroundColor: 'var(--rn-clr-background-primary)',
        borderRadius: '12px',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'inherit',
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
        maxWidth: '320px',
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
        gridTemplateColumns: '95px 60px 50px 40px 75px',
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
        gridTemplateColumns: '95px 60px 50px 40px 75px',
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

    const { history, remName, nextRepDate, isDismissed, dismissedDate, pdfPageInfo } = data as typeof data & { pdfPageInfo?: PdfPageInfo | null };
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

    // Sort history by date descending (most recent first)
    const sortedHistory = [...(history || [])].sort((a, b) => b.date - a.date);

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
                        <span>Repetition History</span>
                        <button
                            onClick={async () => {
                                const ctx = await plugin.widget.getWidgetContext<WidgetLocation.Popup>();
                                const remId = ctx?.contextData?.remId;
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
                                color: 'var(--rn-clr-content-secondary)'
                            }}
                            title="Switch to Aggregated View"
                        >
                            Show Aggregated
                        </button>
                    </div>
                    <button
                        style={closeButtonStyle}
                        onClick={() => plugin.widget.closePopup()}
                        title="Close"
                    >
                        ✕
                    </button>
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
                    </div>
                    {sortedHistory.map((rep, index) => {
                        // Render event markers differently
                        if (rep.eventType === 'madeIncremental') {
                            return (
                                <React.Fragment key={index}>
                                <div style={{
                                    display: 'flex',
                                    gridColumn: '1 / -1',
                                    justifyContent: 'center',
                                    backgroundColor: 'rgba(34, 197, 94, 0.1)',
                                    color: '#22c55e',
                                    fontWeight: 600,
                                    fontSize: '11px',
                                    borderRadius: '4px',
                                    padding: '6px 8px',
                                    margin: '4px 0',
                                    whiteSpace: 'nowrap',
                                }}>
                                    ▶ Made Incremental — {dayjs(rep.date).format('MMM D, YYYY')}
                                    {rep.priority !== undefined && ` — Pri: ${rep.priority}`}
                                </div>
                                <NoteAndContextLine rep={rep} />
                                </React.Fragment>
                            );
                        }

                        if (rep.eventType === 'dismissed') {
                            return (
                                <React.Fragment key={index}>
                                <div style={{
                                    display: 'flex',
                                    gridColumn: '1 / -1',
                                    justifyContent: 'center',
                                    backgroundColor: 'rgba(245, 158, 11, 0.1)',
                                    color: '#f59e0b',
                                    fontWeight: 600,
                                    fontSize: '11px',
                                    borderRadius: '4px',
                                    padding: '6px 8px',
                                    margin: '4px 0',
                                    whiteSpace: 'nowrap',
                                }}>
                                    ⏸ Dismissed — {dayjs(rep.date).format('MMM D, YYYY')}
                                </div>
                                <NoteAndContextLine rep={rep} />
                                </React.Fragment>
                            );
                        }

                        // Rescheduled in Editor - event marker (purple, no review counted)
                        if (rep.eventType === 'rescheduledInEditor') {
                            return (
                                <React.Fragment key={index}>
                                <div style={{
                                    display: 'flex',
                                    gridColumn: '1 / -1',
                                    justifyContent: 'center',
                                    backgroundColor: 'rgba(147, 51, 234, 0.1)',
                                    color: '#9333ea',
                                    fontWeight: 600,
                                    fontSize: '11px',
                                    borderRadius: '4px',
                                    padding: '6px 8px',
                                    margin: '4px 0',
                                    whiteSpace: 'nowrap',
                                }}>
                                    📅 Rescheduled in Editor — {dayjs(rep.date).format('MMM D, YYYY')}
                                    {rep.interval !== undefined && ` → ${rep.interval}d`}
                                    {rep.priority !== undefined && ` — Pri: ${rep.priority}`}
                                </div>
                                <NoteAndContextLine rep={rep} />
                                </React.Fragment>
                            );
                        }

                        // Manual Date Reset - event marker (gray, no review counted)
                        if (rep.eventType === 'manualDateReset') {
                            return (
                                <React.Fragment key={index}>
                                <div style={{
                                    display: 'flex',
                                    gridColumn: '1 / -1',
                                    justifyContent: 'center',
                                    backgroundColor: 'rgba(107, 114, 128, 0.1)',
                                    color: '#6b7280',
                                    fontWeight: 600,
                                    fontSize: '11px',
                                    borderRadius: '4px',
                                    padding: '6px 8px',
                                    margin: '4px 0',
                                    whiteSpace: 'nowrap',
                                }}>
                                    ✏️ Manual Date Reset — {dayjs(rep.date).format('MMM D, YYYY')}
                                    {rep.interval !== undefined && ` → ${rep.interval}d`}
                                    {rep.priority !== undefined && ` — Pri: ${rep.priority}`}
                                </div>
                                <NoteAndContextLine rep={rep} />
                                </React.Fragment>
                            );
                        }

                        // Get event indicator for row display
                        const getEventIndicator = () => {
                            if (rep.eventType === 'rescheduledInQueue') return '📅 ';
                            if (rep.eventType === 'executeRepetition') return '⌨️ ';
                            if (rep.eventType === 'importedRep') return '🃏 ';
                            return '';
                        };

                        // Regular rep entry (includes rescheduledInQueue and executeRepetition with indicators)
                        return (
                            <React.Fragment key={index}>
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
                            </div>
                            <NoteAndContextLine rep={rep} />
                            </React.Fragment>
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
        </div>
    );
}

renderWidget(RepetitionHistoryPopup);
