#!/usr/bin/env python3
"""
List the cards that RemNote schedules with something other than the Global
Default Scheduler, as a JSON file for the plugin's "Import Other-Scheduler Cards
List" command.

The plugin cannot find this out by itself: the bridge sends neither a Rem's
scheduler nor its settings. This script reads them straight from the local
database, which it opens read-only, so it is safe to run while RemNote is open.

    python3 scripts/export_scheduler_cards.py                 # your main KB
    python3 scripts/export_scheduler_cards.py --kb <kbId>     # a specific KB
    python3 scripts/export_scheduler_cards.py --list          # show the KBs and stop

How a card's scheduler is resolved (findings/MULTI_LINE_SUB_CARDS.md):
  - a Rem's `src` field holds a scheduler id;
  - a card uses the `src` of its Rem or of its nearest ancestor that has one;
  - an id that no longer exists, or no `src` at all, means the Global Default.

Only exceptions are listed, so the file stays small. Run it again after moving
documents between schedulers, or after creating many cards under a non-Global one.
"""
import argparse
import json
import sqlite3
import sys
import time
from pathlib import Path

REMNOTE_DIR = Path.home() / "remnote"
GLOBAL_SCHEDULER_KEY = "spacedRepetitionSchedulerIdKb"
MAX_ANCESTOR_DEPTH = 1000


def open_db(kb_dir):
    return sqlite3.connect(f"file:{kb_dir / 'remnote.db'}?mode=ro", uri=True)


def card_count(kb_dir):
    try:
        with open_db(kb_dir) as db:
            return db.execute("select count(*) from cards").fetchone()[0]
    except sqlite3.Error:
        return 0


def find_kbs():
    kbs = []
    for kb_dir in sorted(REMNOTE_DIR.glob("remnote-*")):
        if (kb_dir / "remnote.db").exists():
            kbs.append((kb_dir.name.removeprefix("remnote-"), kb_dir, card_count(kb_dir)))
    return kbs


def is_main_kb(kb_id, kb_dir):
    """RemNote's rule: the main KB's id is the user's id. Only its database owns user data."""
    try:
        with open_db(kb_dir) as db:
            row = db.execute(
                "select 1 from user_data where json_extract(doc,'$.owner') = ? limit 1", (kb_id,)
            ).fetchone()
            return row is not None
    except sqlite3.Error:
        return False


def find_main_kb(kbs):
    main = [kb for kb in kbs if is_main_kb(kb[0], kb[1])]
    if len(main) == 1:
        return main[0]
    if main:
        ids = ", ".join(kb[0] for kb in main)
        sys.exit(f"Found more than one main knowledge base ({ids}). Choose one with --kb.")
    sys.exit("Could not find your main knowledge base. Use --list to see them, and choose one with --kb.")


def global_scheduler_id(db):
    for (doc,) in db.execute("select doc from knowledge_base_data"):
        entry = json.loads(doc)
        if entry.get("key") == GLOBAL_SCHEDULER_KEY:
            return entry.get("value")
    return None


def load_schedulers(db):
    schedulers = {}
    for scheduler_id, name, scheduler_type in db.execute(
        "select _id, json_extract(doc,'$.n'), json_extract(doc,'$.st') from spaced_repetition_scheduler"
    ):
        schedulers[scheduler_id] = {"name": name or "Unnamed scheduler", "type": scheduler_type or "unknown"}
    return schedulers


def make_resolver(db):
    """Returns remId -> the scheduler id of its nearest ancestor with `src`, or None."""
    parents = {}
    own = {}
    for rem_id, parent, scheduler_id in db.execute(
        "select _id, json_extract(doc,'$.parent'), json_extract(doc,'$.src') from quanta"
    ):
        parents[rem_id] = parent
        if scheduler_id:
            own[rem_id] = scheduler_id

    known = {}

    def resolve(rem_id):
        path = []
        current = rem_id
        result = None
        while current and len(path) < MAX_ANCESTOR_DEPTH:
            if current in known:
                result = known[current]
                break
            path.append(current)
            if current in own:
                result = own[current]
                break
            current = parents.get(current)
        for visited in path:
            known[visited] = result
        return result

    return resolve


def build_export(kb_id, kb_dir):
    with open_db(kb_dir) as db:
        global_id = global_scheduler_id(db)
        if not global_id:
            sys.exit(f"Could not find the Global Default Scheduler in {kb_dir / 'remnote.db'}.")
        schedulers = load_schedulers(db)
        resolve = make_resolver(db)

        cards_by_scheduler = {}
        total = 0
        for card_id, rem_id in db.execute("select _id, json_extract(doc,'$.rId') from cards"):
            total += 1
            scheduler_id = resolve(rem_id)
            if scheduler_id and scheduler_id != global_id and scheduler_id in schedulers:
                cards_by_scheduler.setdefault(scheduler_id, []).append(card_id)

    return {
        "kind": "incremental-remnote-scheduler-cards",
        "version": 1,
        "kbId": kb_id,
        "generatedAt": int(time.time() * 1000),
        "totalCards": total,
        "schedulers": [
            {"id": scheduler_id, **schedulers[scheduler_id], "cards": sorted(cards)}
            for scheduler_id, cards in sorted(cards_by_scheduler.items(), key=lambda item: -len(item[1]))
        ],
    }


def main():
    parser = argparse.ArgumentParser(description="List the cards not on the Global Default Scheduler.")
    parser.add_argument("--kb", help="knowledge base id (default: your main one)")
    parser.add_argument("--output", type=Path, help="output file (default: ~/Downloads/scheduler-cards-<kbId>.json)")
    parser.add_argument("--list", action="store_true", help="list the knowledge bases and stop")
    args = parser.parse_args()

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

    export = build_export(kb_id, kb_dir)
    output = args.output or Path.home() / "Downloads" / f"scheduler-cards-{kb_id}.json"
    output.write_text(json.dumps(export, ensure_ascii=False), encoding="utf-8")

    listed = sum(len(s["cards"]) for s in export["schedulers"])
    print(f"Knowledge base {kb_id}: {export['totalCards']:,} cards, {listed:,} on other schedulers.")
    for scheduler in export["schedulers"]:
        print(f"  {scheduler['name']} ({scheduler['type']}): {len(scheduler['cards']):,}")
    print(f"Wrote {output}")
    print('Next, in RemNote, run the command "Import Other-Scheduler Cards List" and pick this file.')


if __name__ == "__main__":
    main()
