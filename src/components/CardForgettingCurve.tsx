/**
 * The forgetting curve for one card, wired to the plugin's data and settings.
 *
 * `ForgettingCurveChart` is deliberately dumb — it renders a prebuilt series.
 * This is the piece that knows where a card's history comes from, which FSRS
 * settings to replay it with, and when the result is too uncertain to show
 * without a caveat. Both the Queue Dashboard (the card on screen right now) and
 * the Flashcard Repetition History popup (each card of a Rem) mount it.
 *
 * Two ways in, because its two callers hold their data differently: pass
 * `cardId` and it looks the card up reactively, or pass `history` directly when
 * the caller has already loaded it.
 *
 * The weights and target retention come from the plugin's own FSRS settings,
 * because the plugin API exposes no way to read the scheduler a card is
 * actually on. `describeCurveMismatch` is the guard against quietly drawing a
 * confident FSRS picture of a card RemNote schedules with Anki SM-2: when the
 * interval RemNote gave is nowhere near the one these settings imply, the chart
 * says so rather than pretending.
 */
import {
    RepetitionStatusInterface,
    useLocalStorageState,
    useTrackerPlugin,
} from '@remnote/plugin-sdk';
import React, { useMemo } from 'react';
import { forgettingCurveScaleKey, fsrsRequestedRetentionId, fsrsWeightsId } from '../lib/consts';
import {
    CurveScale,
    buildForgettingCurveSeries,
    describeCurveMismatch,
} from '../lib/forgetting_curve';
import { parseWeightsString } from '../lib/fsrs';
import { useIESetting } from '../lib/settings';
import { ForgettingCurveChart } from './ForgettingCurveChart';

export interface CardForgettingCurveProps {
    /** Look the card up by id. Ignored when `history` is supplied. */
    cardId?: string | null;
    /** Supply the history directly when the caller already has it loaded. */
    history?: RepetitionStatusInterface[] | null;
    lastRepetitionTime?: number | null;
    nextRepetitionTime?: number | null;
    height?: number;
    showStability?: boolean;
    title?: string;
    /** Shown in place of the chart when there is no history to replay. Null hides it entirely. */
    emptyMessage?: string | null;
    headerRight?: React.ReactNode;
}

export function CardForgettingCurve({
    cardId,
    history: providedHistory,
    lastRepetitionTime: providedLastRep,
    nextRepetitionTime: providedNextRep,
    height = 220,
    showStability = true,
    title = 'Forgetting Curve',
    emptyMessage = 'No repetition history yet — there is no memory state to plot until this card is first practised.',
    headerRight,
}: CardForgettingCurveProps) {
    const direct = providedHistory !== undefined;

    const fetched = useTrackerPlugin(
        async (rp) => {
            if (direct || !cardId) return null;
            const card = await rp.card.findOne(cardId);
            if (!card) return null;
            return {
                history: card.repetitionHistory ?? [],
                lastRepetitionTime: card.lastRepetitionTime ?? null,
                nextRepetitionTime: card.nextRepetitionTime ?? null,
            };
        },
        [cardId, direct],
    );

    const history = direct ? providedHistory ?? [] : fetched?.history ?? null;
    const lastRepetitionTime = direct ? providedLastRep ?? null : fetched?.lastRepetitionTime ?? null;
    const nextRepetitionTime = direct ? providedNextRep ?? null : fetched?.nextRepetitionTime ?? null;

    const weightsRaw = useIESetting(fsrsWeightsId);
    const retentionPct = useIESetting(fsrsRequestedRetentionId);
    const [scale, setScale] = useLocalStorageState<CurveScale>(forgettingCurveScaleKey, 'log');

    const weights = useMemo(() => parseWeightsString(weightsRaw), [weightsRaw]);
    const targetRetention = useMemo(() => {
        const pct = typeof retentionPct === 'number' ? retentionPct : 90;
        return Math.min(Math.max(pct, 50), 99.5) / 100;
    }, [retentionPct]);

    const series = useMemo(
        () =>
            history
                ? buildForgettingCurveSeries(history, {
                      weights,
                      targetRetention,
                      scale: scale === 'linear' ? 'linear' : 'log',
                  })
                : null,
        [history, weights, targetRetention, scale],
    );

    const warning = useMemo(
        () =>
            series ? describeCurveMismatch(series.state, lastRepetitionTime, nextRepetitionTime) : null,
        [series, lastRepetitionTime, nextRepetitionTime],
    );

    // Nothing asked for, or the lookup has not landed yet.
    if (!direct && !cardId) return null;
    if (history === null) return null;

    if (!series) {
        if (!emptyMessage) return null;
        return (
            <div className="w-full">
                <h3 className="text-sm font-bold uppercase rn-clr-content-tertiary tracking-wider mb-1">
                    {title}
                </h3>
                <div className="text-xs rn-clr-content-tertiary">{emptyMessage}</div>
            </div>
        );
    }

    return (
        <ForgettingCurveChart
            series={series}
            height={height}
            showStability={showStability}
            warning={warning}
            scale={series.scale}
            onScaleChange={setScale}
            title={title}
            headerRight={headerRight}
        />
    );
}

export default CardForgettingCurve;
