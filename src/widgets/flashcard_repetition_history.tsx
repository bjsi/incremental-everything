/**
 * Flashcard Repetition History popup widget.
 * Shows the card's full repetition history with Delay, Next Interval,
 * per-step FSRS D/S, and any pluginData contents.
 */
import {
    renderWidget,
    usePlugin,
    useTrackerPlugin,
    WidgetLocation,
    QueueInteractionScore,
} from '@remnote/plugin-sdk';
import React, { useMemo } from 'react';
import { computeFSRSStatesPerReview, computeFSRSState, parseWeightsString, FSRSStepState } from '../lib/fsrs';
import { formatStabilityDays } from '../lib/utils';
import { displayFsrsDsrId, fsrsWeightsId } from '../lib/consts';

function scoreLabel(score: QueueInteractionScore): string {
    switch (score) {
        case QueueInteractionScore.AGAIN: return 'Again';
        case QueueInteractionScore.HARD: return 'Hard';
        case QueueInteractionScore.GOOD: return 'Good';
        case QueueInteractionScore.EASY: return 'Easy';
        case QueueInteractionScore.TOO_EARLY: return 'Too Early';
        case QueueInteractionScore.VIEWED_AS_LEECH: return 'Leech';
        case QueueInteractionScore.RESET: return 'Reset';
        case QueueInteractionScore.MANUAL_DATE: return 'Manual Date';
        case QueueInteractionScore.MANUAL_EASE: return 'Manual Ease';
        default: return `Unknown (${score})`;
    }
}

function scoreColor(score: QueueInteractionScore): string {
    switch (score) {
        case QueueInteractionScore.AGAIN: return '#ef4444';
        case QueueInteractionScore.HARD: return '#f59e0b';
        case QueueInteractionScore.GOOD: return '#22c55e';
        case QueueInteractionScore.EASY: return '#3b82f6';
        default: return 'var(--rn-clr-content-tertiary)';
    }
}

/** Format a delay in ms as a human-readable string (like RemNote's display) */
function formatDelay(delayMs: number): string {
    const absDays = Math.abs(delayMs) / (1000 * 60 * 60 * 24);
    const direction = delayMs > 0 ? 'late' : 'early';

    if (absDays < 0.5) return 'On Target Day';
    if (absDays < 1.5) return `1 day ${direction}`;
    if (absDays < 7) return `${Math.round(absDays)} days ${direction}`;
    if (absDays < 30) return `${Math.round(absDays / 7)} weeks ${direction}`;
    if (absDays < 60) return `a month ${direction}`;
    if (absDays < 335) return `${Math.round(absDays / 30.44)} months ${direction}`;
    if (absDays < 548) return `a year ${direction}`;
    return `${(absDays / 365.25).toFixed(1)} years ${direction}`;
}

/** Format an interval in ms as a human-readable duration */
function formatInterval(intervalMs: number): string {
    const days = intervalMs / (1000 * 60 * 60 * 24);
    if (days < 0.007) return 'immediate'; // < 10 min
    if (days < 0.042) return `${Math.round(days * 24 * 60)} min`;
    if (days < 1) return `${Math.round(days * 24)} hours`;
    if (days < 1.5) return '1 day';
    if (days < 30) return `${Math.round(days)} days`;
    if (days < 365) return `${(days / 30.44).toFixed(1)} months`;
    return `${(days / 365.25).toFixed(1)} years`;
}

const cellStyle: React.CSSProperties = { padding: '3px 6px', whiteSpace: 'nowrap' };

function FlashcardRepetitionHistory() {
    const plugin = usePlugin();

    const showFsrsDsr = useTrackerPlugin(
        (rp) => rp.settings.getSetting<boolean>(displayFsrsDsrId),
        []
    ) ?? true;

    const fsrsWeightsRaw = useTrackerPlugin(
        (rp) => rp.settings.getSetting<string>(fsrsWeightsId),
        []
    );

    const data = useTrackerPlugin(async (rp) => {
        const ctx = await rp.widget.getWidgetContext<WidgetLocation.Popup>();
        const cardId = ctx?.contextData?.cardId as string | undefined;
        const remId = ctx?.contextData?.remId as string | undefined;
        if (!cardId && !remId) return null;

        let cards: any[] = [];
        if (cardId) {
            const card = await rp.card.findOne(cardId);
            if (card) cards = [card];
        }
        if (cards.length === 0 && remId) {
            const rem = await rp.rem.findOne(remId);
            if (rem) {
                cards = await rem.getCards();
            }
        }

        return {
            cardId,
            remId,
            cards: cards.map((c: any) => ({
                _id: c._id,
                type: c.type,
                createdAt: c.createdAt,
                nextRepetitionTime: c.nextRepetitionTime,
                timesWrongInRow: c.timesWrongInRow,
                history: c.repetitionHistory || [],
            })),
        };
    }, []);

    // Compute FSRS step states for each card
    const fsrsData = useMemo(() => {
        if (!data) return null;
        const weights = parseWeightsString(fsrsWeightsRaw);
        return data.cards.map(card => ({
            stepStates: computeFSRSStatesPerReview(card.history, weights),
            finalState: computeFSRSState(card.history, weights),
        }));
    }, [data, fsrsWeightsRaw]);

    if (!data) {
        return (
            <div style={{ padding: 16, color: 'var(--rn-clr-content-secondary)', fontSize: 13 }}>
                No card data available. Ensure you opened this from a flashcard context.
            </div>
        );
    }

    return (
        <div style={{ padding: 16, maxHeight: '600px', overflow: 'auto', fontSize: 11, fontFamily: 'system-ui, -apple-system, sans-serif' }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--rn-clr-content-primary)' }}>
                📊 Flashcard Repetition History
            </h3>
            <div style={{ marginBottom: 8, color: 'var(--rn-clr-content-tertiary)', fontSize: 10 }}>
                Card ID: <code>{data.cardId || '—'}</code> · Rem ID: <code>{data.remId || '—'}</code>
            </div>

            {data.cards.map((card, ci) => {
                const fsrs = fsrsData?.[ci];
                const sortedHistory = [...card.history].sort((a: any, b: any) => a.date - b.date);

                return (
                    <div key={card._id} style={{ marginBottom: 16 }}>
                        {/* Card header */}
                        <div style={{
                            fontWeight: 600,
                            marginBottom: 4,
                            padding: '4px 8px',
                            backgroundColor: 'var(--rn-clr-background-secondary)',
                            borderRadius: 6,
                            color: 'var(--rn-clr-content-primary)',
                            fontSize: 12,
                        }}>
                            {typeof card.type === 'string'
                                ? card.type.charAt(0).toUpperCase() + card.type.slice(1) + ' Card'
                                : `Cloze Card (${card.type?.clozeId})`}
                            <span style={{ fontWeight: 400, marginLeft: 8, color: 'var(--rn-clr-content-tertiary)' }}>
                                ({sortedHistory.length} reviews)
                            </span>
                        </div>

                        {/* FSRS summary */}
                        {showFsrsDsr && fsrs?.finalState && (
                            <div style={{
                                padding: '4px 8px',
                                marginBottom: 4,
                                fontSize: 11,
                                color: 'var(--rn-clr-content-secondary)',
                            }}>
                                <strong>D:</strong> {fsrs.finalState.d.toFixed(4)}
                                {' · '}
                                <strong>S:</strong> {fsrs.finalState.s.toFixed(2)}d ({formatStabilityDays(fsrs.finalState.s)})
                                {' · '}
                                <strong>R:</strong>{' '}
                                <span style={{ color: fsrs.finalState.r >= 0.9 ? '#22c55e' : fsrs.finalState.r >= 0.7 ? '#eab308' : '#ef4444' }}>
                                    {(fsrs.finalState.r * 100).toFixed(1)}%
                                </span>
                                {' · '}
                                <span title={`SInc (Stability Increase) — how much stability grows after answering.\n\nHard: ×${fsrs.finalState.sInc.hard.toFixed(2)} → ${formatStabilityDays(fsrs.finalState.s * fsrs.finalState.sInc.hard)}\nGood: ×${fsrs.finalState.sInc.good.toFixed(2)} → ${formatStabilityDays(fsrs.finalState.s * fsrs.finalState.sInc.good)}\nEasy: ×${fsrs.finalState.sInc.easy.toFixed(2)} → ${formatStabilityDays(fsrs.finalState.s * fsrs.finalState.sInc.easy)}\n\nHigher = faster learning. 1.0 = no growth.`}
                                    style={{ cursor: 'help' }}
                                >
                                    <strong>SInc:</strong>{' '}
                                    <span style={{ color: '#f59e0b' }}>×{fsrs.finalState.sInc.hard.toFixed(2)}</span>{' / '}
                                    <span style={{ color: '#22c55e' }}>×{fsrs.finalState.sInc.good.toFixed(2)}</span>{' / '}
                                    <span style={{ color: '#3b82f6' }}>×{fsrs.finalState.sInc.easy.toFixed(2)}</span>
                                </span>
                                {' · '}
                                Next: {card.nextRepetitionTime ? new Date(card.nextRepetitionTime).toLocaleDateString() : '—'}
                            </div>
                        )}

                        {/* History table */}
                        {sortedHistory.length === 0 ? (
                            <div style={{ color: 'var(--rn-clr-content-tertiary)', paddingLeft: 8 }}>No repetition history.</div>
                        ) : (
                            <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 4 }}>
                                <thead>
                                    <tr style={{ borderBottom: '2px solid var(--rn-clr-border-primary)', fontSize: 10, color: 'var(--rn-clr-content-tertiary)' }}>
                                        <th style={{ ...cellStyle, textAlign: 'left' }}>#</th>
                                        <th style={{ ...cellStyle, textAlign: 'left' }}>Rating</th>
                                        <th style={{ ...cellStyle, textAlign: 'right' }}>Time</th>
                                        <th style={{ ...cellStyle, textAlign: 'left' }}>Target Date</th>
                                        <th style={{ ...cellStyle, textAlign: 'left' }}>Practice Date</th>
                                        <th style={{ ...cellStyle, textAlign: 'left' }}>Delay</th>
                                        <th style={{ ...cellStyle, textAlign: 'left' }}>Next Interval</th>
                                        {showFsrsDsr && <th style={{ ...cellStyle, textAlign: 'right' }}>D</th>}
                                        {showFsrsDsr && <th style={{ ...cellStyle, textAlign: 'right' }}>S</th>}
                                        {showFsrsDsr && <th style={{ ...cellStyle, textAlign: 'right' }}>SInc</th>}
                                        <th style={{ ...cellStyle, textAlign: 'left' }}>pluginData</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {sortedHistory.map((rep: any, ri: number) => {
                                        const stepState = fsrs?.stepStates[ri];
                                        // Delay: practice date - scheduled date
                                        const delay = rep.scheduled ? rep.date - rep.scheduled : null;
                                        // Next interval: next review's scheduled date - this review's date
                                        let nextInterval: number | null = null;
                                        if (ri < sortedHistory.length - 1) {
                                            const nextRep = sortedHistory[ri + 1];
                                            if (nextRep.scheduled) {
                                                nextInterval = nextRep.scheduled - rep.date;
                                            }
                                        } else if (card.nextRepetitionTime) {
                                            nextInterval = card.nextRepetitionTime - rep.date;
                                        }

                                        const isLast = ri === sortedHistory.length - 1;

                                        return (
                                            <tr key={ri} style={{
                                                borderBottom: '1px solid var(--rn-clr-border-primary)',
                                                opacity: isLast ? 1 : 0.9,
                                                backgroundColor: isLast ? 'var(--rn-clr-background-secondary)' : 'transparent',
                                            }}>
                                                <td style={cellStyle}>{ri + 1}</td>
                                                <td style={{ ...cellStyle, color: scoreColor(rep.score), fontWeight: 600 }}>
                                                    {scoreLabel(rep.score)}
                                                </td>
                                                <td style={{ ...cellStyle, textAlign: 'right' }}>
                                                    {rep.responseTime != null ? `${(rep.responseTime / 1000).toFixed(1)}s` : '—'}
                                                </td>
                                                <td style={cellStyle}>
                                                    {rep.scheduled ? new Date(rep.scheduled).toLocaleDateString() : '—'}
                                                </td>
                                                <td style={cellStyle}>
                                                    {new Date(rep.date).toLocaleDateString()}
                                                </td>
                                                <td style={cellStyle}>
                                                    {delay !== null ? formatDelay(delay) : '—'}
                                                </td>
                                                <td style={cellStyle}>
                                                    {isLast && card.nextRepetitionTime
                                                        ? formatInterval(card.nextRepetitionTime - rep.date)
                                                        : nextInterval !== null
                                                            ? formatInterval(nextInterval)
                                                            : '—'}
                                                </td>
                                                {showFsrsDsr && (
                                                    <td style={{ ...cellStyle, textAlign: 'right' }}>
                                                        {stepState ? stepState.d.toFixed(2) : '—'}
                                                    </td>
                                                )}
                                                {showFsrsDsr && (
                                                    <td style={{ ...cellStyle, textAlign: 'right' }}>
                                                        {stepState ? `${stepState.s.toFixed(1)}d (${formatStabilityDays(stepState.s)})` : '—'}
                                                    </td>
                                                )}
                                                {showFsrsDsr && (
                                                    <td style={{ ...cellStyle, textAlign: 'right' }}>
                                                        {stepState?.sInc != null ? `×${stepState.sInc.toFixed(2)}` : '—'}
                                                    </td>
                                                )}
                                                <td style={{ ...cellStyle, maxWidth: 250, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                    {rep.pluginData ? (
                                                        <span title={JSON.stringify(rep.pluginData, null, 2)} style={{ cursor: 'help' }}>
                                                            {JSON.stringify(rep.pluginData).slice(0, 80)}…
                                                        </span>
                                                    ) : '—'}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

renderWidget(FlashcardRepetitionHistory);
