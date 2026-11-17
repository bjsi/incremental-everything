#!/usr/bin/env python3
"""The FSRS port (fsrs.py) against the fixtures of src/lib/fsrs.test.ts, whose values
come from RemNote's own ts-fsrs run without fuzz on the same histories.

    python3 scripts/test_fsrs.py
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fsrs  # noqa: E402

HOUR = 3_600_000
DAY = 24 * HOUR
START = 1_768_046_400_000  # 2026-01-10 12:00 UTC

OPTIMIZED = [3.973, 13.618, 43.322, 100, 7.011, 0.46, 2.096, 0.15, 2.5, 0.27, 1.081, 1.601, 0.068, 0.504, 1.387,
             0.011, 3, 0.546, 0.08, 0.066, 0.118]
FSRS_DEFAULT = [0.212, 1.293, 2.306, 8.295, 6.413, 0.833, 3.019, 0.001, 1.872, 0.166, 0.796, 1.483, 0.061, 0.262,
                1.648, 0.601, 1.872, 0.542, 0.091, 0.065, 0.154]
FORGOT, PARTIAL, GOOD = 0, 0.5, 1

CASES = [
    ([(0, GOOD), (30 * DAY, GOOD), (120 * DAY, FORGOT), (120 * DAY + 3 * HOUR, GOOD)],
     (17.38658425, 6.52393365), (3.00280924, 7.38069874)),
    ([(0, GOOD), (30 * DAY, GOOD), (120 * DAY, FORGOT), (121 * DAY, GOOD)],
     (21.40823234, 6.52393365), (5.02841561, 7.38069874)),
    ([(0, GOOD), (100 * DAY, GOOD), (100 * DAY + 2 * HOUR, FORGOT), (100 * DAY + 4 * HOUR, PARTIAL)],
     (58.53482684, 7.12513192), (14.03768541, 8.25437854)),
    ([(0, GOOD), (11.5 * HOUR, GOOD), (12.5 * HOUR, GOOD)],
     (47.87963223, 5.09500249), (7.31902431, 2.10828659)),
]


def history(reps):
    return [{'date': START + offset, 'score': score} for offset, score in reps]


class FsrsTest(unittest.TestCase):
    def test_matches_ts_fsrs(self):
        self.assertEqual(START, 1_768_046_400_000)
        for reps, optimized, default in CASES:
            for weights, (s, d) in ((OPTIMIZED, optimized), (FSRS_DEFAULT, default)):
                out = fsrs.replay(history(reps), weights)
                self.assertLess(abs(out['s'] - s) / s, 1e-6, (reps, out['s'], s))
                self.assertLess(abs(out['d'] - d) / d, 1e-6, (reps, out['d'], d))

    def test_reset_and_partial_reps(self):
        reps = history([(0, GOOD), (10 * DAY, FORGOT)]) + [{'date': START + 20 * DAY, 'score': 3}]
        self.assertIsNone(fsrs.replay(reps))
        reps.append({'date': START + 21 * DAY, 'score': 1})
        self.assertEqual(fsrs.replay(reps)['reviews'], 1)
        partial = [{'date': START, 'score': 1}, {'date': START + DAY, 'score': 0, 'subCardScores': [0]}]
        self.assertEqual(fsrs.replay(partial)['reviews'], 1)

    def test_retrievability_and_interval(self):
        decay = fsrs.decay_of(FSRS_DEFAULT)
        self.assertAlmostEqual(fsrs.forgetting_curve(10, 10, decay), 0.9, places=9)
        self.assertAlmostEqual(fsrs.interval_factor(0.9, decay), 1.0, places=9)
        self.assertLess(fsrs.interval_factor(0.95, decay), 1.0)


if __name__ == '__main__':
    unittest.main()
