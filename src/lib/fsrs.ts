/**
 * FSRS v6.1.1 — Pure TypeScript implementation for computing Difficulty, Stability, Retrievability.
 *
 * Ported from the reference scheduler:
 *   https://github.com/open-spaced-repetition/fsrs4anki/blob/main/fsrs4anki_scheduler.js
 *
 * This module does NOT schedule cards; it only replays a card's repetition history
 * to derive the current memory state (D, S, R).
 *
 * Uses an explicit state machine (New → Learning → Review ↔ Relearning) for accuracy,
 * matching the ts-fsrs reference implementation used by RemNote.
 */

import { QueueInteractionScore, RepetitionStatusInterface } from '@remnote/plugin-sdk';

// ---------------------------------------------------------------------------
// Default FSRS v6.1.1 weights (w0 … w20)
// ---------------------------------------------------------------------------
export const FSRS_DEFAULT_WEIGHTS: number[] = [
    0.212,   // w0  — initial stability for Again
    1.2931,  // w1  — initial stability for Hard
    2.3065,  // w2  — initial stability for Good
    8.2956,  // w3  — initial stability for Easy
    6.4133,  // w4  — initial difficulty center
    0.8334,  // w5  — initial difficulty scaling
    3.0194,  // w6  — difficulty delta scaling
    0.001,   // w7  — mean reversion weight
    1.8722,  // w8  — recall stability: base factor (exp)
    0.1666,  // w9  — recall stability: S power
    0.796,   // w10 — recall stability: R factor
    1.4835,  // w11 — forget stability: base
    0.0614,  // w12 — forget stability: D power
    0.2629,  // w13 — forget stability: S power
    1.6483,  // w14 — forget stability: R factor
    0.6014,  // w15 — hard penalty
    1.8729,  // w16 — easy bonus
    0.5425,  // w17 — short-term stability: base
    0.0912,  // w18 — short-term stability: offset
    0.0658,  // w19 — short-term stability: S power (v6 only)
    0.1542,  // w20 — DECAY parameter (v6 only)
];

// ---------------------------------------------------------------------------
// FSRS rating constants (1-based)
// ---------------------------------------------------------------------------
const RATINGS = { again: 1, hard: 2, good: 3, easy: 4 } as const;

// ---------------------------------------------------------------------------
// Card state machine
// ---------------------------------------------------------------------------
type CardState = 'new' | 'learning' | 'review' | 'relearning';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------
export interface FSRSState {
    d: number;         // Difficulty [1, 10]
    s: number;         // Stability (days)
    r: number;         // Retrievability [0, 1]
    reviewCount: number;
    /** Expected difficulty after grading with 1(again), 2(hard), 3(good), 4(easy) */
    nextD: { again: number; hard: number; good: number; easy: number };
    /** Stability Increase ratio (nextS / currentS) for each recall grade */
    sInc: { hard: number; good: number; easy: number };
    daysSinceLastReview: number;
}

export interface FSRSStepState {
    d: number;
    s: number;
    r: number | null;  // R at the moment of THIS review (null for first review)
    state: CardState;   // State the card was in WHEN this review happened
    sInc: number | null; // Stability increase ratio (newS / oldS), null for first review
}

// ---------------------------------------------------------------------------
// Map SDK scores to FSRS ratings
// ---------------------------------------------------------------------------
function fsrsRatingFromScore(score: QueueInteractionScore): number | null {
    switch (score) {
        case QueueInteractionScore.AGAIN: return RATINGS.again;
        case QueueInteractionScore.HARD: return RATINGS.hard;
        case QueueInteractionScore.GOOD: return RATINGS.good;
        case QueueInteractionScore.EASY: return RATINGS.easy;
        default: return null;
    }
}

// ---------------------------------------------------------------------------
// Core FSRS math helpers
// ---------------------------------------------------------------------------

function constrainDifficulty(difficulty: number): number {
    return Math.min(Math.max(difficulty, 1), 10);
}

function initDifficulty(w: number[], rating: number): number {
    return constrainDifficulty(w[4] - Math.exp(w[5] * (rating - 1)) + 1);
}

function initStability(w: number[], rating: number): number {
    return Math.max(w[rating - 1], 0.1);
}

function linearDamping(deltaD: number, oldD: number): number {
    return deltaD * (10 - oldD) / 9;
}

function meanReversion(w: number[], init: number, current: number): number {
    return w[7] * init + (1 - w[7]) * current;
}

function nextDifficulty(w: number[], d: number, rating: number): number {
    const deltaD = -w[6] * (rating - 3);
    const nextD = d + linearDamping(deltaD, d);
    return constrainDifficulty(meanReversion(w, initDifficulty(w, RATINGS.easy), nextD));
}

function forgettingCurve(elapsedDays: number, stability: number, decay: number, factor: number): number {
    return Math.pow(1 + factor * elapsedDays / stability, decay);
}

function nextRecallStability(w: number[], d: number, s: number, r: number, rating: number): number {
    const hardPenalty = rating === RATINGS.hard ? w[15] : 1;
    const easyBonus = rating === RATINGS.easy ? w[16] : 1;
    return s * (1 + Math.exp(w[8]) *
        (11 - d) *
        Math.pow(s, -w[9]) *
        (Math.exp((1 - r) * w[10]) - 1) *
        hardPenalty *
        easyBonus);
}

function nextForgetStability(w: number[], d: number, s: number, r: number): number {
    const sMin = s / Math.exp(w[17] * w[18]);
    return Math.min(w[11] *
        Math.pow(d, -w[12]) *
        (Math.pow(s + 1, w[13]) - 1) *
        Math.exp((1 - r) * w[14]), sMin);
}

function nextShortTermStability(w: number[], s: number, rating: number, is21w: boolean): number {
    if (is21w) {
        // FSRS v6 (21 weights): includes s^(-w19) and clamping
        let sinc = Math.exp(w[17] * (rating - 3 + w[18])) * Math.pow(s, -w[19]);
        if (rating >= 3) {
            sinc = Math.max(sinc, 1);
        }
        return s * sinc;
    } else {
        // FSRS v5 (19 weights): simpler formula
        return Math.max(s * Math.exp(w[17] * (rating - 3 + w[18])), 0.01);
    }
}

// ---------------------------------------------------------------------------
// State transition logic (matches ts-fsrs / RemNote behavior)
// ---------------------------------------------------------------------------
function nextState(currentState: CardState, rating: number): CardState {
    switch (currentState) {
        case 'new':
            return rating >= RATINGS.good ? 'review' : 'learning';
        case 'learning':
        case 'relearning':
            return rating >= RATINGS.good ? 'review' : currentState;
        case 'review':
            return rating === RATINGS.again ? 'relearning' : 'review';
        default:
            return 'review';
    }
}

// ---------------------------------------------------------------------------
// Resolve weights: accept 19 or 21 values
// ---------------------------------------------------------------------------
function resolveWeights(weights?: number[] | null): { w: number[]; is21w: boolean } {
    if (!weights) return { w: FSRS_DEFAULT_WEIGHTS, is21w: true };
    if (weights.length === 21) return { w: weights, is21w: true };
    if (weights.length === 19) {
        // FSRS v5: pad with v5-compatible defaults (no s-power, DECAY = -0.5)
        return { w: [...weights, 0.0, 0.5], is21w: false };
    }
    return { w: FSRS_DEFAULT_WEIGHTS, is21w: true };
}

// ---------------------------------------------------------------------------
// Main entry: replay history → current D, S, R
// ---------------------------------------------------------------------------
export function computeFSRSState(
    history: RepetitionStatusInterface[],
    weights?: number[] | null,
): FSRSState | null {
    const { w, is21w } = resolveWeights(weights);
    const DECAY = -w[20];
    const FACTOR = Math.pow(0.9, 1 / DECAY) - 1;

    const sorted = [...history].sort((a, b) => a.date - b.date);

    let d: number | null = null;
    let s: number | null = null;
    let lastReviewDate: number | null = null;
    let reviewCount = 0;
    let state: CardState = 'new';

    for (const rep of sorted) {
        if (rep.score === QueueInteractionScore.RESET) {
            d = null;
            s = null;
            lastReviewDate = null;
            reviewCount = 0;
            state = 'new';
            continue;
        }

        const rating = fsrsRatingFromScore(rep.score);
        if (rating === null) continue;

        reviewCount++;

        if (state === 'new') {
            d = initDifficulty(w, rating);
            s = initStability(w, rating);
            state = nextState(state, rating);
            lastReviewDate = rep.date;
            continue;
        }

        const elapsedDays = (rep.date - lastReviewDate!) / (1000 * 60 * 60 * 24);
        const oldD = d!;
        const oldS = s!;

        if (state === 'learning' || state === 'relearning') {
            d = nextDifficulty(w, oldD, rating);
            s = nextShortTermStability(w, oldS, rating, is21w);
        } else {
            // review state
            const r = forgettingCurve(elapsedDays, oldS, DECAY, FACTOR);
            d = nextDifficulty(w, oldD, rating);
            if (rating === RATINGS.again) {
                s = nextForgetStability(w, oldD, oldS, r);
            } else {
                s = nextRecallStability(w, oldD, oldS, r, rating);
            }
        }

        state = nextState(state, rating);
        lastReviewDate = rep.date;
    }

    if (d === null || s === null || lastReviewDate === null) {
        return null;
    }

    const daysSinceLastReview = (Date.now() - lastReviewDate) / (1000 * 60 * 60 * 24);
    const DECAY_VAL = -w[20];
    const FACTOR_VAL = Math.pow(0.9, 1 / DECAY_VAL) - 1;
    const r = forgettingCurve(daysSinceLastReview, s, DECAY_VAL, FACTOR_VAL);

    // Compute SInc (Stability Increase) for each recall grade
    const computeSInc = (rating: number): number => {
        if (state === 'learning' || state === 'relearning') {
            return nextShortTermStability(w, s, rating, is21w) / s;
        }
        // review state: use recall stability
        return nextRecallStability(w, d, s, r, rating) / s;
    };

    const sInc = {
        hard: computeSInc(RATINGS.hard),
        good: computeSInc(RATINGS.good),
        easy: computeSInc(RATINGS.easy),
    };

    const nextD = {
        again: nextDifficulty(w, d, RATINGS.again),
        hard: nextDifficulty(w, d, RATINGS.hard),
        good: nextDifficulty(w, d, RATINGS.good),
        easy: nextDifficulty(w, d, RATINGS.easy),
    };

    return { d, s, r, reviewCount, sInc, daysSinceLastReview, nextD };
}

// ---------------------------------------------------------------------------
// Per-review step states (for the history widget)
// ---------------------------------------------------------------------------
export function computeFSRSStatesPerReview(
    history: RepetitionStatusInterface[],
    weights?: number[] | null,
): FSRSStepState[] {
    const { w, is21w } = resolveWeights(weights);
    const DECAY = -w[20];
    const FACTOR = Math.pow(0.9, 1 / DECAY) - 1;

    const sorted = [...history].sort((a, b) => a.date - b.date);
    const result: FSRSStepState[] = [];

    let d: number | null = null;
    let s: number | null = null;
    let lastReviewDate: number | null = null;
    let state: CardState = 'new';

    for (const rep of sorted) {
        if (rep.score === QueueInteractionScore.RESET) {
            d = null;
            s = null;
            lastReviewDate = null;
            state = 'new';
            result.push({ d: 0, s: 0, r: null, state, sInc: null });
            continue;
        }

        const rating = fsrsRatingFromScore(rep.score);
        if (rating === null) {
            // Non-gradeable — pass through with null state
            result.push({ d: d ?? 0, s: s ?? 0, r: null, state, sInc: null });
            continue;
        }

        if (state === 'new') {
            d = initDifficulty(w, rating);
            s = initStability(w, rating);
            state = nextState(state, rating);
            lastReviewDate = rep.date;
            result.push({ d, s, r: null, state, sInc: null });
            continue;
        }

        const elapsedDays = (rep.date - lastReviewDate!) / (1000 * 60 * 60 * 24);
        const oldD = d!;
        const oldS = s!;
        let r: number | null = null;

        if (state === 'learning' || state === 'relearning') {
            d = nextDifficulty(w, oldD, rating);
            s = nextShortTermStability(w, oldS, rating, is21w);
        } else {
            r = forgettingCurve(elapsedDays, oldS, DECAY, FACTOR);
            d = nextDifficulty(w, oldD, rating);
            if (rating === RATINGS.again) {
                s = nextForgetStability(w, oldD, oldS, r);
            } else {
                s = nextRecallStability(w, oldD, oldS, r, rating);
            }
        }

        state = nextState(state, rating);
        lastReviewDate = rep.date;
        result.push({ d, s, r, state, sInc: oldS > 0 ? s / oldS : null });
    }

    return result;
}

// ---------------------------------------------------------------------------
// Parse weight string from plugin settings
// ---------------------------------------------------------------------------
export function parseWeightsString(raw: string | undefined | null): number[] | null {
    if (!raw || raw.trim() === '') return null;

    let cleaned = raw.trim();
    if (cleaned.startsWith('[')) cleaned = cleaned.slice(1);
    if (cleaned.endsWith(']')) cleaned = cleaned.slice(0, -1);

    const parts = cleaned.split(',').map(s => s.trim()).filter(s => s.length > 0);
    if (parts.length !== 19 && parts.length !== 21) return null;

    const nums = parts.map(Number);
    if (nums.some(isNaN)) return null;

    return nums;
}
