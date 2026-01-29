import React from 'react';
import { renderWidget, usePlugin, WidgetLocation, useRunAsync } from '@remnote/plugin-sdk';
import { IncrementalRep } from '../lib/incremental_rem/types';
import { formatDuration } from '../lib/utils';
import dayjs from 'dayjs';
import { getIncrementalRemFromRem } from '../lib/incremental_rem';
import { safeRemTextToString } from '../lib/pdfUtils';

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
                return { history: [], remName: '', error: 'No remId' };
            }

            const rem = await plugin.rem.findOne(remId);
            if (!rem) {
                return { history: [], remName: '', error: 'Rem not found' };
            }

            // Get rem name
            const remName = await safeRemTextToString(plugin, rem.text);
            const incRemInfo = await getIncrementalRemFromRem(plugin, rem);

            return {
                history: incRemInfo?.history || [],
                remName: remName || 'Unknown Rem',
                nextRepDate: incRemInfo?.nextRepDate || null,
                error: null
            };
        } catch (error) {
            console.error('[RepetitionHistoryPopup] Error loading history:', error);
            return { history: [], remName: '', nextRepDate: null, error: String(error) };
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
        gridTemplateColumns: '95px 60px 50px 75px',
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
        gridTemplateColumns: '95px 60px 50px 75px',
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

    const { history, remName, nextRepDate } = data;
    const totalTime = getTotalTime(history);
    const age = calculateAge(history);
    const repCount = history?.length || 0;

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

    return (
        <div style={containerStyle}>
            <div style={headerStyle}>
                <div style={headerTopRowStyle}>
                    <div style={headerTitleStyle}>
                        <span>📊</span>
                        <span>Repetition History</span>
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
                <span>Next: <strong>{nextRepDate ? dayjs(nextRepDate).format('MMM D, YYYY') : '—'}</strong></span>
                <span style={{ color: daysLate !== null && daysLate > 0 ? 'var(--rn-clr-red, #ef4444)' : daysLate !== null && daysLate < 0 ? 'var(--rn-clr-green, #22c55e)' : 'inherit' }}>
                    {daysLateText}
                </span>
            </div>

            {repCount === 0 ? (
                <div style={emptyStyle}>
                    No repetitions yet. Complete your first review!
                </div>
            ) : (
                <div style={gridContainerStyle}>
                    <div style={gridHeaderStyle}>
                        <span>Date</span>
                        <span>Time</span>
                        <span>Int.</span>
                        <span>Status</span>
                    </div>
                    {sortedHistory.map((rep, index) => (
                        <div key={index} style={gridRowStyle}>
                            <span>{dayjs(rep.date).format('MMM D, YYYY')}</span>
                            <span>{formatDuration(rep.reviewTimeSeconds || 0) || '—'}</span>
                            <span>{rep.interval !== undefined ? `${rep.interval}d` : '—'}</span>
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
                    ))}
                </div>
            )}
        </div>
    );
}

renderWidget(RepetitionHistoryPopup);
