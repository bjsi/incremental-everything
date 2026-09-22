/**
 * The forgetting curve for one card, wired to the plugin's data and settings.
 *
 * `ForgettingCurveChart` is deliberately dumb — it renders a prebuilt series.
 * This is the piece that knows where a card's history comes from and which FSRS
 * settings to replay it with. Both the Queue Dashboard (the card on screen right
 * now) and the Flashcard Repetition History popup (each card of a Rem) mount it.
 *
 * Two ways in, because its two callers hold their data differently: pass
 * `cardId` and it looks the card up reactively, or pass `history` directly when
 * the caller has already loaded it.
 *
 * The weights and target retention come from the plugin's own FSRS settings,
 * because the plugin API exposes no way to read the scheduler a card is really
 * on. The chart is therefore this model's picture of the card, which is the
 * card's own only where the two agree — a caveat that belongs in the docs and
 * in the FSRS settings group, not in a per-card banner: the one signal cheap
 * enough to compute (RemNote's last scheduled interval against today's model)
 * disagrees for entirely ordinary reasons — optimised weights, interval fuzz,
 * the maximum-interval cap, a manually set due date — and a warning that cries
 * wolf on healthy cards is worse than no warning at all.
 */
import {
    RepetitionStatusInterface,
    useLocalStorageState,
    useTrackerPlugin,
} from '@remnote/plugin-sdk';
import React, { useMemo } from 'react';
import { forgettingCurveScaleKey, fsrsRequestedRetentionId, fsrsWeightsId } from '../lib/consts';
import { CurveScale, buildForgettingCurveSeries } from '../lib/forgetting_curve';
import { parseWeightsString } from '../lib/fsrs';
import { useIESetting } from '../lib/settings';
import { ForgettingCurveChart } from './ForgettingCurveChart';

export interface CardForgettingCurveProps {
    /** Look the card up by id. Ignored when `history` is supplied. */
    cardId?: string | null;
    /** Supply the history directly when the caller already has it loaded. */
    history?: RepetitionStatusInterface[] | null;
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
            return card ? card.repetitionHistory ?? [] : null;
        },
        [cardId, direct],
    );

    const history = direct ? providedHistory ?? [] : fetched ?? null;

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
            scale={series.scale}
            onScaleChange={setScale}
            title={title}
            headerRight={headerRight}
        />
    );
}

export default CardForgettingCurve;
