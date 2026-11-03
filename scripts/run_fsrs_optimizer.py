#!/usr/bin/env python3
"""
Run `python3 -m fsrs_optimizer` with one fix, taking the same arguments:

    python3 scripts/run_fsrs_optimizer.py ~/Downloads/revlog-<kbId>.csv

fsrs_optimizer 6.5.0 compares FSRS with SM-2 after printing the weights. Its SM-2
replay grows the interval x2.5 on every pass with no ceiling, so a card with a
long run of passes (100+ reviews) reaches a 20-digit number of days. That no
longer fits a 64-bit integer, pandas stores the column as objects, np.exp fails,
and the run dies before writing its evaluation summary. The weights printed
before the crash are complete either way.

This caps the SM-2 interval at 36,500 days (the optimizer's own maximum
interval) for that comparison only. FSRS training is untouched.
"""
import runpy
import sys

import fsrs_optimizer.fsrs_optimizer as core

MAX_SM2_INTERVAL_DAYS = 36500
_sm2 = core.sm2
core.sm2 = lambda history: min(_sm2(history), MAX_SM2_INTERVAL_DAYS)

sys.argv[0] = "fsrs_optimizer"
runpy.run_module("fsrs_optimizer", run_name="__main__", alter_sys=True)
