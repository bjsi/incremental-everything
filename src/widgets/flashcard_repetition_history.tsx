/**
 * Flashcard Repetition History popup widget.
 *
 * Shows every card of one Rem: its full repetition history with Delay, Next
 * Interval, per-step FSRS D/S, and any pluginData — and, underneath them all,
 * the Rem's CardPriority history (every priority it has held, with the source
 * and the gesture that set it).
 *
 * WHY THE CARDS COLLAPSE
 *
 * A Rem can easily carry eight cards (five clozes plus forward/backward is an
 * ordinary shape), and eight full tables stacked in a popup is unreadable. So
 * each card is a section that opens and closes, modelled on RemNote's own
 * "Bullet Information" panel: the header names the card the way that panel does
 * — `Cloze (the pressure differences)`, `Forward Card` — and carries the
 * totals, so a collapsed section still answers "how many reps, how much time,
 * when next". Sections start collapsed whenever there is more than one card;
 * a single-card Rem opens straight into its table, since there is nothing to
 * choose between.
 */
import {
    renderWidget,
    usePlugin,
    useTrackerPlugin,
    WidgetLocation,
    QueueInteractionScore,
} from '@remnote/plugin-sdk';
import React, { useMemo, useEffect, useState } from 'react';
import { computeFSRSStatesPerReview, computeFSRSState, parseWeightsString } from '../lib/fsrs';
import { formatStabilityDays, formatTimeAgo, getRetrievabilityColor } from '../lib/utils';
import { resolveRemTextForBreadcrumb } from '../lib/richTextRemRefs';
import { displayFsrsDsrId, fsrsWeightsId, powerupCode, dismissedPowerupCode } from '../lib/consts';
import { useIESetting } from '../lib/settings';
import { buildCardLabels, CardLabel } from '../lib/card_labels';
import {
    PriorityHistoryEntry,
    readCardPriorityHistory,
    priorityEventLabel,
    priorityEventIcon,
    summarizePriorityHistory,
} from '../lib/priority_history';
import { LAPSE_COLOR, retentionColorHex, retentionPercent } from '../lib/retention';

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

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * A delay in the narrowest form that still reads: `+3d`, `−2w`, `+1.4y`, `0d`.
 *
 * The history table carries four date-ish columns across two comparison groups,
 * and "2 months late" spelled out four times is what pushed it past the popup.
 * Single-letter units and a leading sign instead of the words early/late, which
 * the colour already says. The letters are `formatStabilityDays`' — `d` / `m`
 * (months) / `y`, plus `w` for the week range it does not cover — so this column
 * and the S column beside it are read the same way. `m` cannot be mistaken for
 * minutes here: sub-day values use `h`, and the minute case (interval column
 * only) is spelled `min`. The verbose form stays in the cell's tooltip, so
 * nothing is actually lost.
 *
 * The month→year boundary is ONE YEAR, not the ~18 months a "still reads as
 * months" instinct suggests: `formatStabilityDays` switches at 365 and so does
 * RemNote's own answer-button display, so a wider boundary here printed `17.7m`
 * beside RemNote's `1.5 years` for the same interval.
 *
 * A true minus (−, U+2212) rather than a hyphen: it matches the `+` in width,
 * so a column of signed values stays aligned.
 */
function formatDelayCompact(delayMs: number): string {
    const days = delayMs / MS_PER_DAY;
    const abs = Math.abs(days);
    if (abs < 0.5) return '0d';
    const sign = days > 0 ? '+' : '−';
    if (abs < 1) return `${sign}${Math.round(abs * 24)}h`;
    if (abs < 14) return `${sign}${Math.round(abs)}d`;
    if (abs < 60) return `${sign}${Math.round(abs / 7)}w`;
    if (abs < 365) return `${sign}${Math.round(abs / 30.44)}m`;
    return `${sign}${(abs / 365.25).toFixed(1)}y`;
}

/**
 * Late is red, early is green, on target is neutral — the same reading the
 * IncRem Repetition History gives its early/late column, so the two histories
 * do not use one colour for opposite meanings.
 */
function delayColor(delayMs: number): string {
    const days = delayMs / MS_PER_DAY;
    if (Math.abs(days) < 0.5) return 'var(--rn-clr-content-tertiary)';
    return days > 0 ? '#ef4444' : '#22c55e';
}

/** {@link formatInterval} in the table's units. */
function formatIntervalCompact(intervalMs: number): string {
    const days = intervalMs / MS_PER_DAY;
    if (days < 0.007) return 'now';
    if (days < 0.042) return `${Math.round(days * 24 * 60)}min`;
    if (days < 1) return `${Math.round(days * 24)}h`;
    if (days < 14) return `${Math.round(days)}d`;
    if (days < 60) return `${Math.round(days / 7)}w`;
    if (days < 365) return `${(days / 30.44).toFixed(1)}m`;
    return `${(days / 365.25).toFixed(1)}y`;
}

/** Short date for the table: `11/1/21` rather than `11/1/2021`. */
function shortDate(ms: number): string {
    return new Date(ms).toLocaleDateString(undefined, {
        year: '2-digit',
        month: 'numeric',
        day: 'numeric',
    });
}

/**
 * The two column groups of the history table, tinted so the eye can tell which
 * Target/Delay pair it is reading without tracking back up to the header.
 *
 * Sky for what RemNote actually scheduled, violet for what FSRS would have
 * chosen. Neither collides with the rating colours in the column to their left
 * (red/amber/green/blue) because those are TEXT colours and these are washes
 * behind whole columns.
 */
interface ColumnGroupTint {
    accent: string;
    head: string;
    body: string;
    edge: string;
}
const SCHEDULED_TINT: ColumnGroupTint = {
    accent: '#0284c7',
    head: 'rgba(14, 165, 233, 0.16)',
    body: 'rgba(14, 165, 233, 0.06)',
    edge: 'rgba(14, 165, 233, 0.45)',
};
const FSRS_TINT: ColumnGroupTint = {
    accent: '#7c3aed',
    head: 'rgba(139, 92, 246, 0.16)',
    body: 'rgba(139, 92, 246, 0.06)',
    edge: 'rgba(139, 92, 246, 0.45)',
};

/** Body-cell style for a column inside a tinted group. */
function groupCell(tint: ColumnGroupTint, edge: 'left' | 'right'): React.CSSProperties {
    return {
        ...cellStyle,
        backgroundColor: tint.body,
        ...(edge === 'left'
            ? { borderLeft: `2px solid ${tint.edge}` }
            : { borderRight: `2px solid ${tint.edge}` }),
    };
}

/** "4 min", "1.2 h" — the TIME SPENT figure, from summed response times. */
function formatMinutes(totalMinutes: number): string {
    if (totalMinutes <= 0) return 'None';
    if (totalMinutes < 60) return `${totalMinutes} min`;
    return `${(totalMinutes / 60).toFixed(1)} h`;
}

const cellStyle: React.CSSProperties = { padding: '3px 6px', whiteSpace: 'nowrap' };

/**
 * Retention over a set of graded answers: the share that were not "Again".
 *
 * The same `kept ÷ answered` the Practiced Queues dashboard reports for a
 * session, applied to a card's own history — hence the shared helper, and the
 * shared colour scale beneath it.
 */
function retentionOf(gradeableCount: number, lapses: number): number | null {
    return retentionPercent(gradeableCount - lapses, gradeableCount);
}

/** "7 (2)" — repetitions with lapses called out in red. */
function RepsWithLapses({ reps, lapses }: { reps: number; lapses: number }) {
    return (
        <>
            {reps}
            {lapses > 0 && (
                <span
                    style={{ color: LAPSE_COLOR, marginLeft: 4 }}
                    title={`${lapses} lapse${lapses === 1 ? '' : 's'} — answers graded "Again"`}
                >
                    ({lapses})
                </span>
            )}
        </>
    );
}

/** "94% retention", coloured on the dashboard's thresholds. */
function RetentionText({ retention }: { retention: number | null }) {
    if (retention === null) {
        return <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>no retention yet</span>;
    }
    return (
        <span title="Share of graded answers that were not “Again”">
            <span style={{ color: retentionColorHex(retention), fontWeight: 600 }}>
                {retention.toFixed(0)}%
            </span>{' '}
            retention
        </span>
    );
}

const buttonStyle: React.CSSProperties = {
    fontSize: 11,
    padding: '2px 6px',
    borderRadius: 4,
    border: '1px solid var(--rn-clr-border-primary)',
    background: 'transparent',
    cursor: 'pointer',
    color: 'var(--rn-clr-content-secondary)',
    whiteSpace: 'nowrap',
    flexShrink: 0,
};

interface CardStats {
    /** History sorted oldest-first, everything included. */
    sortedHistory: any[];
    /** The slice after the last RESET — what the current schedule is built on. */
    activeHistory: any[];
    totalMinutes: number;
    /** Answers with a real grade (Again/Hard/Good/Easy) — retention's denominator. */
    gradeableCount: number;
    /** Answers graded "Again". */
    lapses: number;
    /** Share of `gradeableCount` that was not a lapse; null when nothing is graded. */
    retention: number | null;
    /** No repetitions at all — RemNote's "New Card". */
    isNew: boolean;
    cardAgeText: string;
    cardAgeMs: number;
    firstRepDate: number | null;
    lastPracticeDate: Date | null;
    nextRepDate: Date | null;
    staleDate: Date | null;
    isStale: boolean;
    nextIntervalMs: number | null;
    coverageText: string;
    costText: string;
}

/**
 * Everything both the collapsed header and the expanded body need for one card.
 *
 * Extracted so the two renderings cannot disagree: the totals in a collapsed
 * header are the same numbers the open section shows, computed once.
 */
function computeCardStats(card: any): CardStats {
    const sortedHistory = [...card.history].sort((a: any, b: any) => a.date - b.date);

    const lastResetIndex = sortedHistory.map((h: any) => h.score).lastIndexOf(QueueInteractionScore.RESET);
    const activeHistory = lastResetIndex !== -1 ? sortedHistory.slice(lastResetIndex + 1) : sortedHistory;

    const gradeableReps = activeHistory.filter((h: any) =>
        h.score === QueueInteractionScore.AGAIN ||
        h.score === QueueInteractionScore.HARD ||
        h.score === QueueInteractionScore.GOOD ||
        h.score === QueueInteractionScore.EASY
    );
    const totalMs = gradeableReps.reduce((acc: number, h: any) => acc + (h.responseTime || 0), 0);
    const totalMinutes = Math.round(totalMs / 6000) / 10;

    const lapses = gradeableReps.filter((h: any) => h.score === QueueInteractionScore.AGAIN).length;
    const retention = retentionOf(gradeableReps.length, lapses);

    const firstRepDate = activeHistory.length > 0 ? activeHistory[0].date : null;
    const cardAgeMs = firstRepDate ? Date.now() - firstRepDate : 0;
    const cardAgeDays = Math.max(0, Math.floor(cardAgeMs / (1000 * 60 * 60 * 24)));
    const cardAgeText = formatStabilityDays(cardAgeDays);

    const lastRep = sortedHistory.length > 0 ? sortedHistory[sortedHistory.length - 1] : null;
    const lastPracticeDate = lastRep ? new Date(lastRep.date) : null;
    const nextRepDate = card.nextRepetitionTime ? new Date(card.nextRepetitionTime) : null;

    let coverageText = '';
    let coverageMsForCost = 0;
    if (firstRepDate && nextRepDate) {
        const coverageMs = nextRepDate.getTime() - firstRepDate;
        if (coverageMs > 0) {
            const coverageDays = Math.max(0, Math.floor(coverageMs / (1000 * 60 * 60 * 24)));
            coverageText = `, 📊 Coverage: ${formatStabilityDays(coverageDays)}`;
            coverageMsForCost = coverageMs;
        }
    }

    let costText = '';
    const isNextRepInFuture = nextRepDate && nextRepDate.getTime() > Date.now();
    if (firstRepDate && totalMinutes > 0) {
        if (isNextRepInFuture && coverageMsForCost > 0) {
            const coverageYears = coverageMsForCost / (1000 * 60 * 60 * 24 * 365);
            if (coverageYears > 0) {
                costText = `, 💰 Cost: ${(totalMinutes / coverageYears).toFixed(1)} min/year`;
            }
        } else {
            const ageYears = cardAgeMs / (1000 * 60 * 60 * 24 * 365);
            if (ageYears > 0) {
                costText = `, 💰 Cost: ${(totalMinutes / ageYears).toFixed(1)} min/year`;
            }
        }
    }

    let isStale = false;
    let staleDate: Date | null = null;
    let nextIntervalMs: number | null = null;
    if (lastRep && nextRepDate) {
        nextIntervalMs = nextRepDate.getTime() - lastRep.date;
        // Stale means overdue by more than twice the last interval.
        staleDate = new Date(lastRep.date + 2 * nextIntervalMs);
        isStale = Date.now() > staleDate.getTime();
    }

    return {
        sortedHistory,
        activeHistory,
        totalMinutes,
        gradeableCount: gradeableReps.length,
        lapses,
        retention,
        isNew: sortedHistory.length === 0,
        cardAgeText,
        cardAgeMs,
        firstRepDate,
        lastPracticeDate,
        nextRepDate,
        staleDate,
        isStale,
        nextIntervalMs,
        coverageText,
        costText,
    };
}

/** One of the four tiles in a card's collapsed summary, mirroring RemNote's panel. */
function StatTile({
    label,
    value,
    sub,
}: {
    label: string;
    value: React.ReactNode;
    sub?: React.ReactNode;
}) {
    return (
        <div
            style={{
                flex: '1 1 110px',
                minWidth: 96,
                padding: '5px 8px',
                borderRadius: 6,
                border: '1px solid var(--rn-clr-border-primary)',
                background: 'var(--rn-clr-background-primary)',
            }}
        >
            <div style={{ fontSize: 9, letterSpacing: '0.4px', color: 'var(--rn-clr-content-tertiary)' }}>
                {label}
            </div>
            <div style={{ fontSize: 12, color: 'var(--rn-clr-content-primary)' }}>{value}</div>
            {sub && (
                <div style={{ fontSize: 9, color: 'var(--rn-clr-content-tertiary)' }}>{sub}</div>
            )}
        </div>
    );
}

interface RemTotals {
    cards: number;
    newCards: number;
    staleCards: number;
    reps: number;
    lapses: number;
    minutes: number;
    retention: number | null;
}

/**
 * Rem-wide totals across every card.
 *
 * Retention is pooled, not a mean of the per-card percentages: averaging a card
 * with 40 answers against one with 2 would let the small card swing the figure,
 * and the dashboard's definition — remembered ÷ practised — is already an
 * aggregate. Summing both sides first keeps this number comparable with the one
 * the Practiced Queues history shows for a session.
 */
function computeRemTotals(statsList: CardStats[]): RemTotals {
    let newCards = 0;
    let staleCards = 0;
    let reps = 0;
    let lapses = 0;
    let minutes = 0;
    let gradeable = 0;
    for (const s of statsList) {
        if (s.isNew) newCards++;
        if (s.isStale) staleCards++;
        reps += s.activeHistory.length;
        lapses += s.lapses;
        minutes += s.totalMinutes;
        gradeable += s.gradeableCount;
    }
    return {
        cards: statsList.length,
        newCards,
        staleCards,
        reps,
        lapses,
        minutes: Math.round(minutes * 10) / 10,
        retention: retentionOf(gradeable, lapses),
    };
}

/** The four rem-wide tiles, above the per-card sections. */
function RemTotalsHeader({ totals }: { totals: RemTotals }) {
    const composition: string[] = [];
    if (totals.newCards > 0) composition.push(`${totals.newCards} new`);
    if (totals.staleCards > 0) composition.push(`${totals.staleCards} stale`);

    return (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            <StatTile
                label="CARDS"
                value={`${totals.cards}`}
                sub={composition.length ? composition.join(' · ') : 'all reviewed'}
            />
            <StatTile
                label="REPETITIONS"
                value={<RepsWithLapses reps={totals.reps} lapses={totals.lapses} />}
                sub="across all cards"
            />
            <StatTile label="TIME SPENT" value={formatMinutes(totals.minutes)} sub="all cards" />
            <StatTile
                label="RETENTION"
                value={
                    totals.retention === null ? (
                        '—'
                    ) : (
                        <span style={{ color: retentionColorHex(totals.retention), fontWeight: 700 }}>
                            {totals.retention.toFixed(0)}%
                        </span>
                    )
                }
                sub="graded answers kept"
            />
        </div>
    );
}

/**
 * Record a review of one card without going through the queue.
 *
 * WHY IT EXISTS
 *
 * The IncRem history has had "➕ Session" for a while, for reading done away
 * from RemNote. A flashcard has the same gap and a narrower fix: you tested
 * yourself on a card somewhere the queue was not — aloud, on paper, in
 * conversation — and the only way to tell RemNote was to find the card in a
 * queue and answer it there, which schedules from *that* moment anyway.
 * `updateCardRepetitionStatus` appends the repetition directly.
 *
 * WHAT IT CANNOT DO
 *
 * Unlike ➕ Session, it cannot be backdated: the SDK takes a score and nothing
 * else, so the repetition lands NOW. That is stated on the panel rather than
 * hidden, because a user who expects backdating would otherwise silently
 * mis-record when they studied.
 *
 * THE PREDICTED INTERVALS
 *
 * Each button carries what FSRS projects that grade would buy, from this
 * plugin's own model and the user's configured weights. RemNote's scheduler
 * decides the date that is actually written, and the two can differ — for the
 * same reasons the "Optimum Next repetition date" line above already documents
 * (a non-FSRS scheduler, different weights, fuzz, load balancing). So the
 * numbers are labelled as a projection, not as a promise.
 *
 * AGAIN NEEDS ITS OWN CAVEAT
 *
 * The Again figure is the post-lapse stability — where FSRS RESUMES once the
 * card has been relearnt. It is not what RemNote will show you next. A
 * scheduler with Relearning Phase Steps configured (Settings → Schedulers →
 * Relearning Phase, e.g. `1h`) walks those steps first, and they are not FSRS
 * intervals at all: they exist to confirm the material was actually relearnt,
 * and the scheduler does not count them. So a card whose Again projection reads
 * `6w` is shown by RemNote's own Forgot button as `1 hour` — both correct, a
 * relearning step apart. Left unsaid, the two numbers look like a contradiction.
 */
function AddRepetitionPanel({
    cardId,
    finalState,
    onRecorded,
}: {
    cardId: string;
    finalState: ReturnType<typeof computeFSRSState>;
    onRecorded: () => void;
}) {
    const plugin = usePlugin();
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);

    const grades: { score: QueueInteractionScore; label: string; days: number | null }[] = [
        { score: QueueInteractionScore.AGAIN, label: 'Again', days: finalState?.nextInterval.again ?? null },
        { score: QueueInteractionScore.HARD, label: 'Hard', days: finalState?.nextInterval.hard ?? null },
        { score: QueueInteractionScore.GOOD, label: 'Good', days: finalState?.nextInterval.good ?? null },
        { score: QueueInteractionScore.EASY, label: 'Easy', days: finalState?.nextInterval.easy ?? null },
    ];

    const record = async (score: QueueInteractionScore, label: string) => {
        if (busy) return;
        setBusy(true);
        try {
            const card = await plugin.card.findOne(cardId);
            if (!card) {
                await plugin.app.toast('Could not find that card.');
                return;
            }
            await card.updateCardRepetitionStatus(score);
            await plugin.app.toast(`Recorded “${label}” on this card.`);
            setOpen(false);
            onRecorded();
        } catch (err) {
            console.error('[FlashcardHistory] failed to record a repetition', err);
            await plugin.app.toast('Could not record that repetition.');
        } finally {
            setBusy(false);
        }
    };

    if (!open) {
        return (
            <div style={{ padding: '2px 8px 6px' }}>
                <button
                    style={buttonStyle}
                    onClick={() => setOpen(true)}
                    title="Record a review of this card done outside the queue"
                >
                    ➕ Repetition
                </button>
            </div>
        );
    }

    return (
        <div
            style={{
                margin: '2px 8px 8px',
                padding: 8,
                borderRadius: 6,
                border: '1px solid var(--rn-clr-border-primary)',
                background: 'var(--rn-clr-background-primary)',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
            }}
        >
            <div style={{ fontSize: 10, color: 'var(--rn-clr-content-tertiary)', lineHeight: 1.4 }}>
                How did it go? The repetition is recorded <strong>now</strong> — this cannot be
                backdated. Intervals are what FSRS projects with your weights; RemNote's scheduler
                sets the date it actually writes.
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {grades.map((g) => (
                    <button
                        key={g.label}
                        disabled={busy}
                        onClick={() => record(g.score, g.label)}
                        title={
                            `Append a “${g.label}” repetition to this card, dated now.` +
                            (g.days !== null
                                ? ` FSRS projects a ${formatIntervalCompact(g.days * MS_PER_DAY)} interval.`
                                : '') +
                            (g.score === QueueInteractionScore.AGAIN
                                ? '\n\nThat is where FSRS resumes once the card has been relearnt. ' +
                                  'If your scheduler has Relearning Phase Steps configured, RemNote ' +
                                  'walks those first — so it will show the card again after the first ' +
                                  'step (e.g. 1 hour), not after this interval.'
                                : '')
                        }
                        style={{
                            flex: '1 1 70px',
                            padding: '4px 8px',
                            borderRadius: 4,
                            border: `1px solid ${scoreColor(g.score)}`,
                            background: 'transparent',
                            color: scoreColor(g.score),
                            fontWeight: 600,
                            fontSize: 11,
                            cursor: busy ? 'wait' : 'pointer',
                            opacity: busy ? 0.5 : 1,
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            gap: 1,
                        }}
                    >
                        <span>
                            {g.label}
                            {g.score === QueueInteractionScore.AGAIN && (
                                <span style={{ fontWeight: 400, opacity: 0.7 }}> †</span>
                            )}
                        </span>
                        <span style={{ fontWeight: 400, fontSize: 10, opacity: 0.85 }}>
                            {g.days !== null ? formatIntervalCompact(g.days * MS_PER_DAY) : '—'}
                        </span>
                    </button>
                ))}
                <button style={buttonStyle} disabled={busy} onClick={() => setOpen(false)}>
                    Cancel
                </button>
            </div>
            <div style={{ fontSize: 10, color: 'var(--rn-clr-content-tertiary)', lineHeight: 1.4 }}>
                <strong>Again †</strong> is where FSRS <em>resumes</em>, after any{' '}
                <strong>relearning steps</strong> your scheduler adds (Settings → Schedulers →
                Relearning Phase). Those steps are extra reps that confirm you have relearnt the
                card, and the scheduler does not count them — so RemNote's own Forgot button will
                show the first step (e.g. 1 hour) rather than this figure.
            </div>
            {!finalState && (
                <div style={{ fontSize: 10, color: 'var(--rn-clr-content-tertiary)' }}>
                    No graded history yet, so there is nothing to project an interval from.
                </div>
            )}
        </div>
    );
}

/**
 * The Rem's CardPriority history — every priority it has held, newest first.
 *
 * Rem-level, so it sits once at the bottom rather than inside any card section:
 * the CardPriority powerup tags the Rem, and all of its cards share the value.
 */
function PriorityHistorySection({ entries }: { entries: PriorityHistoryEntry[] }) {
    const summary = useMemo(() => summarizePriorityHistory(entries), [entries]);

    return (
        <div style={{ marginTop: 18, borderTop: '2px solid var(--rn-clr-border-primary)', paddingTop: 10 }}>
            <div
                style={{
                    fontWeight: 600,
                    fontSize: 12,
                    color: 'var(--rn-clr-content-primary)',
                    marginBottom: 6,
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 8,
                    flexWrap: 'wrap',
                }}
            >
                <span>🎚 Card Priority History</span>
                {summary.last && (
                    <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--rn-clr-content-tertiary)' }}>
                        now {summary.last.p} · {summary.entries.length} change
                        {summary.entries.length === 1 ? '' : 's'}
                        {summary.min !== null && summary.min !== summary.max
                            ? ` · range ${summary.min}–${summary.max}`
                            : ''}
                        {summary.manualCount > 0 ? ` · ${summary.manualCount} by hand` : ''}
                    </span>
                )}
            </div>

            {entries.length === 0 ? (
                <div style={{ fontSize: 11, color: 'var(--rn-clr-content-tertiary)', paddingLeft: 2 }}>
                    No priority changes recorded yet. Changes are recorded from the moment this
                    version of the plugin sets a priority — earlier ones left no trace to recover.
                </div>
            ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                        <tr style={{ borderBottom: '2px solid var(--rn-clr-border-primary)', fontSize: 10, color: 'var(--rn-clr-content-tertiary)' }}>
                            <th style={{ ...cellStyle, textAlign: 'left' }}>When</th>
                            <th style={{ ...cellStyle, textAlign: 'right' }}>Priority</th>
                            <th style={{ ...cellStyle, textAlign: 'left' }}>Change</th>
                            <th style={{ ...cellStyle, textAlign: 'left' }}>Event</th>
                            <th style={{ ...cellStyle, textAlign: 'left' }}>Source</th>
                        </tr>
                    </thead>
                    <tbody>
                        {/* Newest first — the current priority is the thing being explained. */}
                        {[...entries].reverse().map((entry, i) => {
                            const previous = entries[entries.length - 1 - i - 1];
                            const delta = previous ? entry.p - previous.p : null;
                            const isCurrent = i === 0;
                            const isOrigin = i === entries.length - 1;
                            return (
                                <tr
                                    key={`${entry.t}-${i}`}
                                    style={{
                                        borderBottom: '1px solid var(--rn-clr-border-primary)',
                                        backgroundColor: isCurrent
                                            ? 'var(--rn-clr-background-secondary)'
                                            : 'transparent',
                                    }}
                                >
                                    <td style={cellStyle}>
                                        {new Date(entry.t).toLocaleDateString()}
                                        <span style={{ color: 'var(--rn-clr-content-tertiary)', marginLeft: 4 }}>
                                            {new Date(entry.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                        </span>
                                    </td>
                                    <td style={{ ...cellStyle, textAlign: 'right', fontWeight: 600 }}>{entry.p}</td>
                                    <td style={cellStyle}>
                                        {isOrigin ? (
                                            <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>first set</span>
                                        ) : delta === null || delta === 0 ? (
                                            '—'
                                        ) : (
                                            <span style={{ color: delta < 0 ? '#22c55e' : '#f59e0b' }}>
                                                {previous.p} → {entry.p} ({delta > 0 ? '+' : ''}
                                                {delta})
                                            </span>
                                        )}
                                    </td>
                                    <td style={cellStyle}>
                                        {priorityEventIcon(entry.e)} {priorityEventLabel(entry.e)}
                                    </td>
                                    <td style={{ ...cellStyle, color: 'var(--rn-clr-content-tertiary)' }}>
                                        {entry.s}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}
        </div>
    );
}

function FlashcardRepetitionHistory() {
    const plugin = usePlugin();

    const showFsrsDsr = useIESetting(displayFsrsDsrId);
    const fsrsWeightsRaw = useIESetting(fsrsWeightsId);

    // Bumped after a repetition is recorded. The tracker does not reliably
    // re-run on a card's repetitionHistory changing — it is not a Rem edit —
    // so the reload is forced, the same way the IncRem history popup does it
    // after an edited or deleted record.
    const [refreshKey, setRefreshKey] = useState(0);

    const data = useTrackerPlugin(async (rp) => {
        const ctx = await rp.widget.getWidgetContext<WidgetLocation.Popup>();
        const cardId = ctx?.contextData?.cardId as string | undefined;
        const remId = ctx?.contextData?.remId as string | undefined;
        if (!cardId && !remId) return null;

        // Resolve the Rem first, then take ALL of its cards. The Ctrl+Shift+H
        // contract is per-Rem — "show the history of them all" — so a cardId
        // coming from the queue narrows nothing; it only says which section to
        // open first.
        let rem = remId ? await rp.rem.findOne(remId) : null;
        if (!rem && cardId) {
            const card = await rp.card.findOne(cardId);
            if (card?.remId) rem = await rp.rem.findOne(card.remId);
        }

        let cards: any[] = [];
        let remName = '';
        let priorityHistory: PriorityHistoryEntry[] = [];
        let hasIncrementalHistory = false;
        let labels = new Map<string, CardLabel>();

        if (rem) {
            const [remCards, name, history, hasInc, hasDismissed] = await Promise.all([
                rem.getCards(),
                // Same renderer the card labels use: rem references resolved
                // in [ ] and reference pins collapsed to 📌, rather than
                // safeRemTextToString's expansion of a pin into the whole rem
                // it points at.
                resolveRemTextForBreadcrumb(rp, rem.text),
                readCardPriorityHistory(rem),
                rem.hasPowerup(powerupCode),
                rem.hasPowerup(dismissedPowerupCode),
            ]);
            cards = remCards || [];
            remName = name;
            priorityHistory = history;
            hasIncrementalHistory = !!hasInc || !!hasDismissed;
            labels = await buildCardLabels(rp, rem, cards);
        } else if (cardId) {
            const card = await rp.card.findOne(cardId);
            if (card) cards = [card];
        }

        return {
            cardId,
            remId: rem?._id ?? remId,
            remName,
            priorityHistory,
            hasIncrementalHistory,
            cards: cards.map((c: any) => ({
                _id: c._id,
                type: c.type,
                label: labels.get(c._id) ?? null,
                createdAt: c.createdAt,
                nextRepetitionTime: c.nextRepetitionTime,
                timesWrongInRow: c.timesWrongInRow,
                history: c.repetitionHistory || [],
            })),
        };
    }, [refreshKey]);

    // Which card sections are open. Undefined until the data lands, so the
    // default below can depend on how many cards there turned out to be.
    const [expanded, setExpanded] = useState<Record<string, boolean> | null>(null);
    // Which card header the keyboard is on. -1 = none, so the arrows can enter
    // the list from the top without a card being pre-selected on open.
    const [selected, setSelected] = useState(-1);

    useEffect(() => {
        if (!data || expanded !== null) return;
        const next: Record<string, boolean> = {};
        for (const card of data.cards) {
            // One card: nothing to choose between, so open it. Several: start
            // collapsed, except the card the queue was actually showing.
            next[card._id] = data.cards.length === 1 || card._id === data.cardId;
        }
        setExpanded(next);
    }, [data, expanded]);

    // FSRS step states, per card, in the same order as data.cards.
    const fsrsData = useMemo(() => {
        if (!data) return null;
        const weights = parseWeightsString(fsrsWeightsRaw);
        return data.cards.map(card => ({
            stepStates: computeFSRSStatesPerReview(card.history, weights),
            finalState: computeFSRSState(card.history, weights),
        }));
    }, [data, fsrsWeightsRaw]);

    // Keyboard driving, the same contract every popup in this plugin honours:
    // ↑/↓ walk the card sections, Enter/Space opens or closes the selected one,
    // Esc closes the popup. Bound on the window rather than on the headers so it
    // works before anything has been clicked — a popup that opens with no focus
    // must still respond to the first arrow key.
    useEffect(() => {
        const cardIds = data?.cards.map((c) => c._id) ?? [];
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                plugin.widget.closePopup();
                return;
            }
            if (cardIds.length === 0) return;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setSelected((cur) => {
                    if (cur < 0) return e.key === 'ArrowDown' ? 0 : cardIds.length - 1;
                    const next = cur + (e.key === 'ArrowDown' ? 1 : -1);
                    return Math.max(0, Math.min(cardIds.length - 1, next));
                });
                return;
            }
            if (e.key === 'Enter' || e.key === ' ') {
                if (selected < 0) return;
                e.preventDefault();
                const id = cardIds[selected];
                setExpanded((prev) => ({ ...(prev || {}), [id]: !prev?.[id] }));
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [plugin, data, selected]);

    if (!data) {
        return (
            <div style={{ padding: 16, color: 'var(--rn-clr-content-secondary)', fontSize: 13 }}>
                No card data available. Ensure you opened this from a flashcard context.
            </div>
        );
    }

    // One pass over the cards, reused by the totals header and by every section:
    // the header's figures must be the sum of exactly what the sections show.
    const statsByCard = data.cards.map((card) => computeCardStats(card));
    const totals = computeRemTotals(statsByCard);

    const allExpanded = data.cards.length > 0 && data.cards.every((c) => expanded?.[c._id]);
    const setAll = (open: boolean) => {
        const next: Record<string, boolean> = {};
        for (const card of data.cards) next[card._id] = open;
        setExpanded(next);
    };

    return (
        <div style={{ padding: 16, maxHeight: '600px', overflow: 'auto', fontSize: 11, fontFamily: 'system-ui, -apple-system, sans-serif' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                <h3 style={{ margin: 0, fontSize: 14, color: 'var(--rn-clr-content-primary)' }}>
                    📊 Flashcard Repetition History
                </h3>
                {data.cards.length > 1 && (
                    <button style={buttonStyle} onClick={() => setAll(!allExpanded)}>
                        {allExpanded ? 'Collapse all' : 'Expand all'}
                    </button>
                )}
                {data.hasIncrementalHistory && data.remId && (
                    <button
                        style={buttonStyle}
                        title="This Rem is also Incremental — switch to its repetition history"
                        onClick={async () => {
                            // Open only — NEVER close first. closePopup destroys
                            // this widget's sandbox immediately, so the await
                            // after it never resumes and openPopup is never
                            // called. Opening a popup replaces the current one
                            // regardless.
                            await plugin.widget.openPopup('repetition_history', { remId: data.remId });
                        }}
                    >
                        ♾ Incremental History
                    </button>
                )}
                <button
                    style={{ ...buttonStyle, marginLeft: 'auto' }}
                    onClick={() => plugin.widget.closePopup()}
                    title="Close"
                >
                    ✕
                </button>
            </div>
            <div style={{ marginBottom: 8, color: 'var(--rn-clr-content-tertiary)', fontSize: 10 }}>
                {data.remName && (
                    <span title={data.remName}>
                        <strong>{data.remName.length > 100 ? `${data.remName.substring(0, 100)}…` : data.remName}</strong> ·{' '}
                    </span>
                )}
                {data.cards.length} card{data.cards.length === 1 ? '' : 's'} · Rem ID:{' '}
                <code>{data.remId || '—'}</code>
            </div>

            {data.cards.length > 0 && <RemTotalsHeader totals={totals} />}

            {data.cards.length === 0 && (
                <div style={{ color: 'var(--rn-clr-content-tertiary)', padding: '8px 0' }}>
                    This Rem has no flashcards.
                </div>
            )}

            {data.cards.map((card, ci) => {
                const fsrs = fsrsData?.[ci];
                const stats = statsByCard[ci];
                const isOpen = !!expanded?.[card._id];
                const label = card.label;
                const headerName = label?.typeName
                    ?? (typeof card.type === 'string'
                        ? card.type.charAt(0).toUpperCase() + card.type.slice(1) + ' Card'
                        : `Cloze Card (${card.type?.clozeId})`);

                return (
                    <div key={card._id} style={{ marginBottom: 12 }}>
                        {/* Card header — click anywhere to open/close */}
                        <div
                            role="button"
                            tabIndex={0}
                            onClick={() => {
                                setSelected(ci);
                                setExpanded((prev) => ({ ...(prev || {}), [card._id]: !isOpen }));
                            }}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    setExpanded((prev) => ({ ...(prev || {}), [card._id]: !isOpen }));
                                }
                            }}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                fontWeight: 600,
                                marginBottom: 4,
                                padding: '4px 8px',
                                backgroundColor: 'var(--rn-clr-background-secondary)',
                                borderRadius: 6,
                                color: 'var(--rn-clr-content-primary)',
                                fontSize: 12,
                                cursor: 'pointer',
                                userSelect: 'none',
                                outline:
                                    selected === ci ? '2px solid var(--rn-clr-content-accent, #3b82f6)' : 'none',
                                outlineOffset: '-1px',
                            }}
                        >
                            <span style={{ width: 10, color: 'var(--rn-clr-content-tertiary)' }}>
                                {isOpen ? '▾' : '▸'}
                            </span>
                            <span style={{ flexShrink: 0 }}>{headerName}</span>
                            {label?.identifier && (
                                <span
                                    title={label.identifier}
                                    style={{
                                        fontWeight: 400,
                                        color: 'var(--rn-clr-content-secondary)',
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                        minWidth: 0,
                                    }}
                                >
                                    ({label.identifier})
                                </span>
                            )}
                            {card._id === data.cardId && (
                                <span
                                    style={{
                                        padding: '1px 5px',
                                        borderRadius: 4,
                                        fontSize: 9,
                                        fontWeight: 700,
                                        backgroundColor: 'rgba(59, 130, 246, 0.15)',
                                        color: '#3b82f6',
                                    }}
                                    title="The card you were reviewing"
                                >
                                    IN QUEUE
                                </span>
                            )}
                            {stats.isStale && (
                                <span style={{
                                    padding: '1px 5px',
                                    backgroundColor: '#ef4444',
                                    color: 'white',
                                    borderRadius: 4,
                                    fontSize: 9,
                                    fontWeight: 'bold',
                                }}>
                                    STALE
                                </span>
                            )}
                            <span
                                style={{
                                    marginLeft: 'auto',
                                    fontWeight: 400,
                                    color: 'var(--rn-clr-content-tertiary)',
                                    fontSize: 11,
                                    whiteSpace: 'nowrap',
                                }}
                            >
                                {stats.activeHistory.length} rep
                                {stats.activeHistory.length === 1 ? '' : 's'}
                                {stats.lapses > 0 && (
                                    <span
                                        style={{ color: LAPSE_COLOR, marginLeft: 4 }}
                                        title={`${stats.lapses} lapse${stats.lapses === 1 ? '' : 's'} — answers graded “Again”`}
                                    >
                                        ({stats.lapses})
                                    </span>
                                )}{' '}
                                · ⏳ {formatMinutes(stats.totalMinutes)}
                                {stats.retention !== null && (
                                    <>
                                        {' · '}
                                        <span
                                            style={{ color: retentionColorHex(stats.retention), fontWeight: 600 }}
                                            title="Share of graded answers that were not “Again”"
                                        >
                                            {stats.retention.toFixed(0)}%
                                        </span>
                                    </>
                                )}
                            </span>
                        </div>

                        {/* Collapsed: the four totals, the same tiles RemNote's panel shows. */}
                        {!isOpen && (
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '0 2px 4px' }}>
                                <StatTile
                                    label="NEXT PRACTICE"
                                    value={stats.nextRepDate ? formatTimeAgo(stats.nextRepDate.getTime(), Date.now()) : 'New Card'}
                                    sub={stats.nextRepDate ? stats.nextRepDate.toLocaleDateString() : undefined}
                                />
                                <StatTile
                                    label="LAST PRACTICED"
                                    value={stats.lastPracticeDate ? formatTimeAgo(stats.lastPracticeDate.getTime(), Date.now()) : 'Never'}
                                    sub={stats.lastPracticeDate ? stats.lastPracticeDate.toLocaleDateString() : undefined}
                                />
                                <StatTile
                                    label="REPETITIONS"
                                    value={
                                        <RepsWithLapses
                                            reps={stats.activeHistory.length}
                                            lapses={stats.lapses}
                                        />
                                    }
                                    sub={<RetentionText retention={stats.retention} />}
                                />
                                <StatTile
                                    label="TIME SPENT"
                                    value={formatMinutes(stats.totalMinutes)}
                                    sub={stats.firstRepDate ? `${stats.cardAgeText} age` : undefined}
                                />
                            </div>
                        )}

                        {isOpen && (
                            <>
                                <div style={{
                                    padding: '0 8px 4px',
                                    fontSize: 11,
                                    color: 'var(--rn-clr-content-tertiary)',
                                }}>
                                    {stats.activeHistory.length} reviews
                                    {stats.lapses > 0 && (
                                        <span
                                            style={{ color: LAPSE_COLOR }}
                                            title={`${stats.lapses} lapse${stats.lapses === 1 ? '' : 's'} — answers graded “Again”`}
                                        >
                                            {' '}({stats.lapses})
                                        </span>
                                    )}
                                    , <RetentionText retention={stats.retention} />, ⏳{' '}
                                    {stats.totalMinutes} min, {stats.cardAgeText} age
                                    {stats.coverageText}{stats.costText}
                                </div>

                                {/* Dates summary */}
                                <div style={{
                                    padding: '4px 8px',
                                    marginBottom: 4,
                                    fontSize: 11,
                                    color: 'var(--rn-clr-content-secondary)',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: '2px'
                                }}>
                                    {stats.nextRepDate && (
                                        <div>
                                            <strong>Next repetition scheduled date:</strong> {stats.nextRepDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                                            <span style={{ color: 'var(--rn-clr-content-tertiary)' }}> ({formatTimeAgo(stats.nextRepDate.getTime(), Date.now())})</span>
                                        </div>
                                    )}
                                    {stats.lastPracticeDate && fsrs?.finalState?.s && (
                                        <div>
                                            <strong
                                                title="Based on the current FSRS memory models, this is the optimal date you should review things to achive 90% chance of recall. If it's different from the scheduled date, it's either because the original scheduler was not FSRS or had different weights set, or because of fuzz (randomness), load balancing, or RemNote's internal constraints."
                                                style={{ cursor: 'help', textDecoration: 'underline dotted', textUnderlineOffset: '2px' }}
                                            >Optimum Next repetition date:</strong> {new Date(stats.lastPracticeDate.getTime() + fsrs.finalState.s * 24 * 60 * 60 * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                                            <span style={{ color: 'var(--rn-clr-content-tertiary)' }}> ({formatTimeAgo(stats.lastPracticeDate.getTime() + fsrs.finalState.s * 24 * 60 * 60 * 1000, Date.now())})</span>
                                        </div>
                                    )}
                                    {stats.staleDate && (
                                        <div>
                                            <strong>Date at which becomes stale:</strong> {stats.staleDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                                            <span style={{ color: 'var(--rn-clr-content-tertiary)' }}> ({formatTimeAgo(stats.staleDate.getTime(), Date.now())})</span>
                                        </div>
                                    )}
                                    {stats.lastPracticeDate && (
                                        <div>
                                            <strong>Last practice date:</strong> {stats.lastPracticeDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                                            <span style={{ color: 'var(--rn-clr-content-tertiary)' }}> ({formatTimeAgo(stats.lastPracticeDate.getTime(), Date.now())})</span>
                                        </div>
                                    )}
                                    {stats.nextIntervalMs !== null && (
                                        <div>
                                            <strong>Current interval:</strong> {formatInterval(stats.nextIntervalMs)}
                                            {fsrs?.finalState?.s && (
                                                <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>
                                                    {' '}({Math.round((stats.nextIntervalMs / (1000 * 60 * 60 * 24)) / fsrs.finalState.s * 100)}% of predicted Stability)
                                                </span>
                                            )}
                                        </div>
                                    )}
                                </div>

                                {/* FSRS summary */}
                                {showFsrsDsr && fsrs?.finalState && (
                                    <div style={{
                                        padding: '4px 8px',
                                        marginBottom: 4,
                                        fontSize: 11,
                                        color: 'var(--rn-clr-content-secondary)',
                                    }}>
                                        <strong>D:</strong> {fsrs.finalState.d.toFixed(2)}
                                        {' · '}
                                        <strong>S:</strong> {fsrs.finalState.s.toFixed(1)}d{formatStabilityDays(fsrs.finalState.s) !== `${fsrs.finalState.s.toFixed(2)}d` ? ` (${formatStabilityDays(fsrs.finalState.s)})` : ''}
                                        {' · '}
                                        <strong>R:</strong>{' '}
                                        <span style={{ color: getRetrievabilityColor(fsrs.finalState.r) }}>
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

                                <AddRepetitionPanel
                                    cardId={card._id}
                                    finalState={fsrs?.finalState ?? null}
                                    onRecorded={() => setRefreshKey((k) => k + 1)}
                                />

                                {/* History table */}
                                {stats.sortedHistory.length === 0 ? (
                                    <div style={{ color: 'var(--rn-clr-content-tertiary)', paddingLeft: 8 }}>No repetition history.</div>
                                ) : (
                                    <div style={{ overflowX: 'auto' }}>
                                    <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 4, tableLayout: 'auto' }}>
                                        <thead>
                                            {/* Two header rows: the plain columns span both, the two
                                                comparison groups own the top one. */}
                                            <tr style={{ fontSize: 10, color: 'var(--rn-clr-content-tertiary)' }}>
                                                <th rowSpan={2} style={{ ...cellStyle, textAlign: 'left' }}>#</th>
                                                <th rowSpan={2} style={{ ...cellStyle, textAlign: 'left' }}>Rating</th>
                                                <th rowSpan={2} style={{ ...cellStyle, textAlign: 'right' }}>Time</th>
                                                <th rowSpan={2} style={{ ...cellStyle, textAlign: 'left' }}>Practice Date</th>
                                                <th
                                                    colSpan={2}
                                                    title="What RemNote actually scheduled this review for, and how far off the day you were."
                                                    style={{
                                                        ...cellStyle,
                                                        textAlign: 'center',
                                                        backgroundColor: SCHEDULED_TINT.head,
                                                        color: SCHEDULED_TINT.accent,
                                                        fontWeight: 700,
                                                        borderLeft: `2px solid ${SCHEDULED_TINT.edge}`,
                                                        borderRight: `2px solid ${SCHEDULED_TINT.edge}`,
                                                        cursor: 'help',
                                                    }}
                                                >
                                                    Scheduled
                                                </th>
                                                <th
                                                    colSpan={2}
                                                    title={
                                                        'Where FSRS would have put this review: the PREVIOUS review’s date ' +
                                                        'plus the stability it computed then — the day recall was predicted ' +
                                                        'to fall to 90%.\n\nComparing the two Delay columns says whether your ' +
                                                        'schedule is running ahead of the memory model (green here, so you are ' +
                                                        'reviewing sooner than needed) or behind it (red, so recall had already ' +
                                                        'decayed past the target).'
                                                    }
                                                    style={{
                                                        ...cellStyle,
                                                        textAlign: 'center',
                                                        backgroundColor: FSRS_TINT.head,
                                                        color: FSRS_TINT.accent,
                                                        fontWeight: 700,
                                                        borderLeft: `2px solid ${FSRS_TINT.edge}`,
                                                        borderRight: `2px solid ${FSRS_TINT.edge}`,
                                                        cursor: 'help',
                                                    }}
                                                >
                                                    FSRS Optimum
                                                </th>
                                                <th rowSpan={2} style={{ ...cellStyle, textAlign: 'left' }}>Next Int.</th>
                                                {showFsrsDsr && <th rowSpan={2} style={{ ...cellStyle, textAlign: 'right' }}>D</th>}
                                                {showFsrsDsr && <th rowSpan={2} style={{ ...cellStyle, textAlign: 'right' }}>S</th>}
                                                {showFsrsDsr && <th rowSpan={2} style={{ ...cellStyle, textAlign: 'right' }}>R</th>}
                                                {showFsrsDsr && <th rowSpan={2} style={{ ...cellStyle, textAlign: 'right' }}>SInc</th>}
                                            </tr>
                                            <tr style={{ borderBottom: '2px solid var(--rn-clr-border-primary)', fontSize: 10, color: 'var(--rn-clr-content-tertiary)' }}>
                                                <th style={{ ...cellStyle, textAlign: 'left', backgroundColor: SCHEDULED_TINT.head, borderLeft: `2px solid ${SCHEDULED_TINT.edge}` }}>Target</th>
                                                <th style={{ ...cellStyle, textAlign: 'right', backgroundColor: SCHEDULED_TINT.head, borderRight: `2px solid ${SCHEDULED_TINT.edge}` }}>Delay</th>
                                                <th style={{ ...cellStyle, textAlign: 'left', backgroundColor: FSRS_TINT.head, borderLeft: `2px solid ${FSRS_TINT.edge}` }}>Target</th>
                                                <th style={{ ...cellStyle, textAlign: 'right', backgroundColor: FSRS_TINT.head, borderRight: `2px solid ${FSRS_TINT.edge}` }}>Delay</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {stats.sortedHistory.map((rep: any, ri: number) => {
                                                const stepState = fsrs?.stepStates[ri];
                                                // Delay: practice date - scheduled date
                                                const delay = rep.scheduled ? rep.date - rep.scheduled : null;

                                                // The FSRS counterpart of `rep.scheduled`: the day the
                                                // PREVIOUS review's stability said recall would fall to
                                                // 90%. Same formula as the "Optimum Next repetition
                                                // date" line above, applied one step back instead of at
                                                // the end. Undefined for the first review (nothing
                                                // preceded it) and after a RESET, which zeroes stability.
                                                const prevState = ri > 0 ? fsrs?.stepStates[ri - 1] : undefined;
                                                const fsrsTarget =
                                                    prevState && prevState.s > 0
                                                        ? stats.sortedHistory[ri - 1].date + prevState.s * MS_PER_DAY
                                                        : null;
                                                const fsrsDelay = fsrsTarget !== null ? rep.date - fsrsTarget : null;

                                                // Next interval: next review's scheduled date - this review's date
                                                let nextInterval: number | null = null;
                                                if (ri < stats.sortedHistory.length - 1) {
                                                    const nextRep = stats.sortedHistory[ri + 1];
                                                    if (nextRep.scheduled) {
                                                        nextInterval = nextRep.scheduled - rep.date;
                                                    }
                                                } else if (card.nextRepetitionTime) {
                                                    nextInterval = card.nextRepetitionTime - rep.date;
                                                }

                                                const isLast = ri === stats.sortedHistory.length - 1;

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
                                                            {rep.responseTime != null ? `${(rep.responseTime / 1000).toFixed(0)}s` : '—'}
                                                        </td>
                                                        <td style={cellStyle} title={new Date(rep.date).toLocaleString()}>
                                                            {shortDate(rep.date)}
                                                        </td>

                                                        {/* ── Scheduled ── */}
                                                        <td
                                                            style={groupCell(SCHEDULED_TINT, 'left')}
                                                            title={rep.scheduled ? new Date(rep.scheduled).toLocaleString() : undefined}
                                                        >
                                                            {rep.scheduled ? shortDate(rep.scheduled) : '—'}
                                                        </td>
                                                        <td
                                                            style={{
                                                                ...groupCell(SCHEDULED_TINT, 'right'),
                                                                textAlign: 'right',
                                                                color: delay !== null ? delayColor(delay) : undefined,
                                                                fontWeight: 600,
                                                            }}
                                                            title={delay !== null ? formatDelay(delay) : undefined}
                                                        >
                                                            {delay !== null ? formatDelayCompact(delay) : '—'}
                                                        </td>

                                                        {/* ── FSRS Optimum ── */}
                                                        <td
                                                            style={groupCell(FSRS_TINT, 'left')}
                                                            title={
                                                                fsrsTarget !== null
                                                                    ? `${new Date(fsrsTarget).toLocaleString()}\n(previous review + ${formatStabilityDays(prevState!.s)} of stability)`
                                                                    : 'No preceding review to project from'
                                                            }
                                                        >
                                                            {fsrsTarget !== null ? shortDate(fsrsTarget) : '—'}
                                                        </td>
                                                        <td
                                                            style={{
                                                                ...groupCell(FSRS_TINT, 'right'),
                                                                textAlign: 'right',
                                                                color: fsrsDelay !== null ? delayColor(fsrsDelay) : undefined,
                                                                fontWeight: 600,
                                                            }}
                                                            title={fsrsDelay !== null ? formatDelay(fsrsDelay) : undefined}
                                                        >
                                                            {fsrsDelay !== null ? formatDelayCompact(fsrsDelay) : '—'}
                                                        </td>

                                                        <td
                                                            style={cellStyle}
                                                            title={
                                                                isLast && card.nextRepetitionTime
                                                                    ? formatInterval(card.nextRepetitionTime - rep.date)
                                                                    : nextInterval !== null
                                                                        ? formatInterval(nextInterval)
                                                                        : undefined
                                                            }
                                                        >
                                                            {isLast && card.nextRepetitionTime
                                                                ? formatIntervalCompact(card.nextRepetitionTime - rep.date)
                                                                : nextInterval !== null
                                                                    ? formatIntervalCompact(nextInterval)
                                                                    : '—'}
                                                        </td>
                                                        {showFsrsDsr && (
                                                            <td style={{ ...cellStyle, textAlign: 'right' }}>
                                                                {stepState ? stepState.d.toFixed(1) : '—'}
                                                            </td>
                                                        )}
                                                        {showFsrsDsr && (
                                                            <td
                                                                style={{ ...cellStyle, textAlign: 'right' }}
                                                                title={stepState ? `${stepState.s.toFixed(1)} days` : undefined}
                                                            >
                                                                {stepState ? formatStabilityDays(stepState.s) : '—'}
                                                            </td>
                                                        )}
                                                        {showFsrsDsr && (
                                                            <td style={{ ...cellStyle, textAlign: 'right' }}>
                                                                {stepState?.r != null ? (
                                                                    <span style={{ color: getRetrievabilityColor(stepState.r) }}>
                                                                        {(stepState.r * 100).toFixed(1)}%
                                                                    </span>
                                                                ) : '—'}
                                                            </td>
                                                        )}
                                                        {showFsrsDsr && (
                                                            <td style={{ ...cellStyle, textAlign: 'right' }}>
                                                                {stepState?.sInc != null ? `×${stepState.sInc.toFixed(2)}` : '—'}
                                                            </td>
                                                        )}
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                );
            })}

            <PriorityHistorySection entries={data.priorityHistory} />
        </div>
    );
}

renderWidget(FlashcardRepetitionHistory);
