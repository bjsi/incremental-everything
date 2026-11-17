"""
FSRS memory state (difficulty D, stability S) from a card's history, for the search
helper (rem_index.py). A port of src/lib/fsrs.ts `computeFSRSState`, which agrees with
RemNote's own ts-fsrs within 0.001% on 38,056 cards (findings/MULTI_LINE_SUB_CARDS.md);
the same fixtures pin both (test_fsrs.py, src/lib/fsrs.test.ts).

RemNote computes these when its Bullet Information panel opens (module 440825: a
ts-fsrs replay with the card's own scheduler settings); nothing is stored. Rules kept
from fsrs.ts:
  - Forgot/Hard/Good/Easy are reviews; other entries (skip, manual date) are not;
  - a Reset starts the card over (as RemNote's scheduling does; its info panel
    replays the whole history instead, so it can differ for reset cards);
  - partial reps of list/set cards don't count for the main card;
  - elapsed time is in whole UTC days: a review on the same UTC day uses the
    short-term formula, a later one the long-term formulas;
  - 19 weights (FSRS-5) are padded with s-power 0 and decay 0.5.
"""
import math

DEFAULT_WEIGHTS = [
    0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796,
    1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
]
RATING = {0: 1, 0.5: 2, 1: 3, 1.5: 4}  # QueueInteractionScore → FSRS rating
AGAIN, HARD, GOOD, EASY = 1, 2, 3, 4
RESET = 3
DAY_MS = 86_400_000


def resolve_weights(weights):
    """(w, is21w) as fsrs.ts resolveWeights."""
    if isinstance(weights, list) and len(weights) == 21:
        return [float(x) for x in weights], True
    if isinstance(weights, list) and len(weights) == 19:
        return [float(x) for x in weights] + [0.0, 0.5], False
    return DEFAULT_WEIGHTS, True


def decay_of(weights):
    w, _ = resolve_weights(weights)
    return -w[20]


def _clamp_d(d):
    return min(max(d, 1.0), 10.0)


def _raw_init_d(w, rating):
    return w[4] - math.exp(w[5] * (rating - 1)) + 1


def _next_d(w, d, rating):
    delta = -w[6] * (rating - 3)
    nd = d + delta * (10 - d) / 9
    return _clamp_d(w[7] * _raw_init_d(w, EASY) + (1 - w[7]) * nd)


def forgetting_curve(elapsed_days, s, decay):
    factor = math.pow(0.9, 1 / decay) - 1
    return math.pow(1 + factor * elapsed_days / s, decay)


def _next_s(w, is21w, d, s, elapsed_days, rating):
    if elapsed_days == 0:  # short-term
        if is21w:
            sinc = math.exp(w[17] * (rating - 3 + w[18])) * math.pow(s, -w[19])
            if rating >= HARD:
                sinc = max(sinc, 1.0)
            return s * sinc
        return max(s * math.exp(w[17] * (rating - 3 + w[18])), 0.01)
    r = forgetting_curve(elapsed_days, s, -w[20])
    if rating == AGAIN:
        s_min = s / math.exp(w[17] * w[18])
        return min(w[11] * math.pow(d, -w[12]) * (math.pow(s + 1, w[13]) - 1) * math.exp((1 - r) * w[14]), s_min)
    hard = w[15] if rating == HARD else 1
    easy = w[16] if rating == EASY else 1
    return s * (1 + math.exp(w[8]) * (11 - d) * math.pow(s, -w[9]) * (math.exp((1 - r) * w[10]) - 1) * hard * easy)


def counts_for_main_card(rep):
    if rep.get('score') == RESET:
        return True
    if rep.get('isFullMultiLineRep') is not None:
        return bool(rep['isFullMultiLineRep'])
    return not rep.get('subCardScores')


def replay(history, weights=None):
    """{'d', 's', 'last', 'reviews'} after the history, or None when it has no review
    since the last Reset."""
    w, is21w = resolve_weights(weights)
    d = s = last = None
    reviews = 0
    for rep in sorted((r for r in history or [] if isinstance(r, dict) and isinstance(r.get('date'), (int, float))),
                      key=lambda r: r['date']):
        if rep.get('score') == RESET:
            d = s = last = None
            reviews = 0
            continue
        rating = RATING.get(rep.get('score'))
        if rating is None or not counts_for_main_card(rep):
            continue
        reviews += 1
        if d is None:
            d = _clamp_d(_raw_init_d(w, rating))
            s = max(w[rating - 1], 0.1)
        else:
            elapsed = math.floor(rep['date'] / DAY_MS) - math.floor(last / DAY_MS)
            d, s = _next_d(w, d, rating), _next_s(w, is21w, d, s, elapsed, rating)
        last = rep['date']
    if d is None:
        return None
    return {'d': d, 's': s, 'last': last, 'reviews': reviews}


def interval_factor(retention, decay):
    """Scheduled interval / stability at this target retention (1 at 90%)."""
    r = min(max(retention or 0.9, 0.5), 0.995)
    factor = math.pow(0.9, 1 / decay) - 1
    out = (math.pow(r, 1 / decay) - 1) / factor
    return out if math.isfinite(out) and out > 0 else 1.0
