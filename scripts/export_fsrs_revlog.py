#!/usr/bin/env python3
"""
Export a knowledge base's review history as a revlog.csv for an external FSRS
optimizer (`python3 -m fsrs_optimizer revlog.csv`), straight from the local
database (opened read-only, so it is safe while RemNote is open).

    python3 scripts/export_fsrs_revlog.py                       # your main KB
    python3 scripts/export_fsrs_revlog.py --kb <kbId>           # a specific KB
    python3 scripts/export_fsrs_revlog.py --list                # show the KBs and stop
    python3 scripts/export_fsrs_revlog.py --remnote-compatible  # same rows as RemNote's button
    python3 scripts/export_fsrs_revlog.py --since 2021-01-01    # only cards first reviewed after this date

It applies the same filters as RemNote's "Download revlog.csv" button (which also
feeds its "Optimize Weights" buttons), read from the app bundle in Nov 2026:

  1. only the history after a card's last "Reset card" counts;
  2. reviews of only some items of a multi-line card are left out;
  3. cards reviewed on only one (local, midnight-to-midnight) day are left out.

It differs on purpose in three ways:

  - Same-day reviews are kept. RemNote keeps only the first entry of each local
    calendar day, which leaves the short-term weights (w17-w19) nothing real to
    learn from.
  - Entries that are not ratings (too early, viewed as leech, manual date, manual
    ease) are dropped before anything else. In RemNote they could take a day's
    slot and hide that day's real rating.
  - review_state is the card's real phase, not its position: 0 for the first
    day's reviews (learning), 2 for reviews after a "Forgot" until the card
    leaves that day (relearning), 1 otherwise. RemNote numbers rows 0, 1, 2, 2...
    counting dropped entries too, so some cards had no state-0 row, and the Python
    optimizer silently drops a card whose first row is not state 0.

Columns: card_id (RemNote's card number + 1, as RemNote writes it), review_time
(ms), review_rating (1 Forgot .. 4 Easy), review_state, review_duration (ms).

Day boundaries use this computer's timezone, as RemNote does. A history stored
out of date order is sorted (RemNote uses it as stored).

--since follows fsrs_optimizer's "date at which before reviews will be ignored":
a card is left out entirely when its first exported review is not after midnight
(local time) of that date. Cutting off only the older reviews instead would leave
cards with no learning step, which the optimizer drops anyway.
"""
import argparse
import collections
import datetime as dt
import json
import sys
from pathlib import Path

from export_scheduler_cards import REMNOTE_DIR, find_kbs, find_main_kb, is_main_kb, open_db

# RemNote's repetition scores (the `score` field of a history entry).
RESET = 3
RATING_BY_SCORE = {0: 1, 0.5: 2, 1: 3, 1.5: 4}  # Again, Hard, Good, Easy -> FSRS ratings
AGAIN = 1

LEARNING, REVIEW, RELEARNING = 0, 1, 2

HEADER = "card_id,review_time,review_rating,review_state,review_duration"


def local_day(ms):
    return dt.datetime.fromtimestamp(ms / 1000).date()


def is_full_rep(entry):
    """RemNote's rule: a multi-line rep counts for the card only if it covered every item."""
    if "isFullMultiLineRep" in entry and entry["isFullMultiLineRep"] is not None:
        return bool(entry["isFullMultiLineRep"])
    return not entry.get("subCardScores")


def after_last_reset(history):
    last = max((i for i, e in enumerate(history) if e.get("score") == RESET), default=-1)
    return history[last + 1:]


def duration(entry):
    return max(0, entry.get("responseTime") or 0)


def rows_corrected(card_id, history, stats):
    history = sorted(history, key=lambda e: e.get("date") or 0)
    history = [e for e in after_last_reset(history) if is_full_rep(e)]
    reviews = [e for e in history if e.get("score") in RATING_BY_SCORE and e.get("date") is not None]
    if len({local_day(e["date"]) for e in reviews}) <= 1:
        stats["cards_one_day"] += 1
        return []

    rows = []
    first_day = local_day(reviews[0]["date"])
    prev = None  # (day, rating, state)
    for e in reviews:
        day, rating = local_day(e["date"]), RATING_BY_SCORE[e["score"]]
        if day == first_day:
            state = LEARNING
        elif prev and (prev[1] == AGAIN or (prev[2] == RELEARNING and prev[0] == day)):
            state = RELEARNING
        else:
            state = REVIEW
        if prev and prev[0] == day:
            stats["same_day_reviews"] += 1
        rows.append((card_id, e["date"], rating, state, duration(e)))
        prev = (day, rating, state)
    return rows


def rows_remnote(card_id, history, stats):
    """Exactly what RemNote's button writes (for checking this script against it)."""
    history = [e for e in after_last_reset(history or []) if is_full_rep(e)]
    seen, days = set(), []
    for e in history:
        key = local_day(e["date"]) if e.get("date") is not None else None
        if key not in seen:
            seen.add(key)
            days.append(e)
    if len(days) <= 1:
        stats["cards_one_day"] += 1
        return []
    rows = []
    for i, e in enumerate(days):
        if e.get("score") in RATING_BY_SCORE and e.get("date") is not None:
            rows.append((card_id, e["date"], RATING_BY_SCORE[e["score"]], min(i, 2), duration(e)))
    return rows


def export(kb_dir, remnote_compatible, since_ms=None):
    stats = collections.Counter()
    build = rows_remnote if remnote_compatible else rows_corrected
    rows = []
    with open_db(kb_dir) as db:
        query = "select json_extract(doc,'$.x'), json_extract(doc,'$.h') from cards"
        for number, history in db.execute(query):
            if number is None or not history:
                continue
            stats["cards_with_history"] += 1
            card_stats = collections.Counter()
            card_rows = build(number + 1, json.loads(history), card_stats)
            stats["cards_one_day"] += card_stats.pop("cards_one_day", 0)
            if card_rows and since_ms is not None and min(r[1] for r in card_rows) <= since_ms:
                stats["cards_before_since"] += 1
                card_rows = []
            if card_rows:
                stats["cards_exported"] += 1
                stats.update(card_stats)
            rows.extend(card_rows)
    rows.sort(key=lambda r: (r[0], r[1]))
    return rows, stats


def main():
    parser = argparse.ArgumentParser(description="Export a revlog.csv for an external FSRS optimizer.")
    parser.add_argument("--kb", help="knowledge base id (default: your main one)")
    parser.add_argument("--output", type=Path, help="output file (default: ~/Downloads/revlog-<kbId>.csv)")
    parser.add_argument("--list", action="store_true", help="list the knowledge bases and stop")
    parser.add_argument(
        "--remnote-compatible",
        action="store_true",
        help="write exactly what RemNote's 'Download revlog.csv' writes (one entry per day, positional states)",
    )
    parser.add_argument(
        "--since",
        metavar="YYYY-MM-DD",
        help="leave out cards first reviewed before this date (fsrs_optimizer's revlog start date)",
    )
    args = parser.parse_args()

    since_ms = None
    if args.since:
        try:
            since_ms = dt.datetime.strptime(args.since, "%Y-%m-%d").timestamp() * 1000
        except ValueError:
            sys.exit(f"--since must be a date like 2021-01-01, not {args.since!r}.")

    kbs = find_kbs()
    if not kbs:
        sys.exit(f"No knowledge bases found in {REMNOTE_DIR}.")
    if args.list:
        for kb_id, kb_dir, cards in sorted(kbs, key=lambda kb: -kb[2]):
            print(f"{kb_id}  {cards:>8,} cards{'  (main)' if is_main_kb(kb_id, kb_dir) else ''}")
        return
    if args.kb:
        match = [kb for kb in kbs if kb[0] == args.kb]
        if not match:
            sys.exit(f"Knowledge base {args.kb} not found. Use --list to see them.")
        kb_id, kb_dir, _ = match[0]
    else:
        kb_id, kb_dir, _ = find_main_kb(kbs)

    rows, stats = export(kb_dir, args.remnote_compatible, since_ms)
    suffix = ("-remnote" if args.remnote_compatible else "") + (f"-since-{args.since}" if args.since else "")
    output = args.output or Path.home() / "Downloads" / f"revlog-{kb_id}{suffix}.csv"
    with open(output, "w", encoding="utf-8", newline="") as f:
        f.write(HEADER + "\n")
        f.writelines(",".join(map(str, row)) + "\n" for row in rows)

    states = collections.Counter(r[3] for r in rows)
    print(f"Knowledge base {kb_id}: {stats['cards_with_history']:,} cards with history.")
    print(f"  exported {len(rows):,} reviews of {stats['cards_exported']:,} cards")
    print(f"  left out {stats['cards_one_day']:,} cards reviewed on a single day")
    if args.since:
        print(f"  left out {stats['cards_before_since']:,} cards first reviewed before {args.since}")
    if not args.remnote_compatible:
        print(f"  {stats['same_day_reviews']:,} reviews are same-day (RemNote's export drops these)")
        print(
            f"  states: {states[LEARNING]:,} learning, {states[REVIEW]:,} review, "
            f"{states[RELEARNING]:,} relearning"
        )
    print(f"Wrote {output}")
    print("When fsrs_optimizer asks, enable the short-term component and enter your own timezone.")
    if args.since:
        print("Its start date can stay at the default: these cards are already filtered.")


if __name__ == "__main__":
    main()
