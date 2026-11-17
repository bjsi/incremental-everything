#!/usr/bin/env python3
"""Check a sample of backfilled reps against today's KB: are they really gone?

    python3 -I scripts/history_backfill_verify.py --kb <id> [--n 400] [--seed 1] [--show 8]

history_backfill.py adds a rep only when its timestamp is nowhere in today's DB.
An import that kept the content but shifted the reps' timestamps would slip
past that test, and the dashboard would count those reviews twice. This takes a
random sample of the backfilled card reps, finds today's Rems with the same
text, and looks for the rep on their cards: a timestamp off by under 2 s, off by
whole hours (time zone), or the same response time and grade on another date.
It also searches the whole KB by timestamp and by (response time, grade).

A rep is confirmed lost when nothing matches. Matches are printed with details.
Measured on the main KB on 2026-11-10: 396 of 400 confirmed, 1 coincidence, and
a control showed imports keep rep timestamps exactly.
"""
import argparse
import random
import sqlite3
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import history_archive as ha  # noqa: E402
from history_backfill import norm  # noqa: E402

HOUR = 3_600_000


def day(ms):
    return datetime.fromtimestamp(ms / 1000).strftime('%Y-%m-%d %H:%M')


class Today:
    """Rem texts, parents and card histories of the KB's current remnote.db (with its trash)."""

    def __init__(self, db_path):
        src = ha.open_remnote(db_path)
        try:
            raw = {}
            for t in ('quanta', 'deleted_quanta'):
                for i, p, k in src.execute(f"SELECT _id, json_extract(doc,'$.parent'), json_extract(doc,'$.key') FROM {t}"):
                    raw[i] = (p, ha.json.loads(k) if k else [])
            names = {i: ha.plain_text(k, limit=80) for i, (_, k) in raw.items()}
            self.text = {i: ha.plain_text(k, names) for i, (_, k) in raw.items()}
            self.parent = {i: p for i, (p, _) in raw.items()}
            self.by_text = defaultdict(list)
            for i, t in self.text.items():
                if len(norm(t)) >= 3:
                    self.by_text[norm(t)].append(i)
            self.cards = defaultdict(list)  # rem → [(card id, [(date, score, responseTime)])]
            self.dates = {}
            self.fp = defaultdict(list)
            for t in ('cards', 'deleted_cards'):
                for cid, rid, h in src.execute(f"SELECT _id, json_extract(doc,'$.rId'), json_extract(doc,'$.h') FROM {t}"):
                    reps = [(int(r['date']), r.get('score'), r.get('responseTime'))
                            for r in ha.json.loads(h or '[]')
                            if isinstance(r, dict) and isinstance(r.get('date'), (int, float))]
                    self.cards[rid].append((cid, reps))
                    for d, s, rt in reps:
                        self.dates[d] = (cid, rid)
                        self.fp[(rt, s)].append((d, cid, rid))
        finally:
            src.close()

    def path(self, i, n=4):
        out, seen = [], set()
        while i and i not in seen and i in self.text and len(out) < n:
            seen.add(i)
            out.append(self.text[i][:30])
            i = self.parent.get(i)
        return ' › '.join(reversed(out))


def near(dd):
    return abs(dd) < 2000 or (abs(dd) % HOUR < 2000 and abs(dd) <= 24 * HOUR)


def verdict(date, score, rt, text, today):
    if date in today.dates:
        cid, rid = today.dates[date]
        return 'SAME TIMESTAMP today', f'card {cid}: {today.path(rid)}'
    twins = today.by_text.get(norm(text), [])
    for t in twins:
        for cid, reps in today.cards.get(t, []):
            for d, s, r in reps:
                dd = d - date
                if near(dd):
                    return 'TWIN holds it, timestamp shifted', f'{dd / HOUR:+.2f} h, card {cid}'
                if (r, s) == (rt, score):
                    return 'TWIN, same response time + grade on another date', f'{dd / 86_400_000:+.1f} days, card {cid}'
    for d, cid, rid in today.fp.get((rt, score), []):
        if near(d - date):
            return 'KB-WIDE: same response time + grade near the timestamp', f'{d - date} ms: {today.path(rid)}'
    if not twins:
        return 'confirmed lost (no same-text Rem today)', ''
    hist = [d for t in twins for _, reps in today.cards.get(t, []) for d, _, _ in reps]
    if not hist:
        return 'confirmed lost (same-text Rem today has no reps)', f'{len(twins)} twin(s)'
    return ('confirmed lost (twin history starts later)' if min(hist) > date
            else 'confirmed lost (twin history overlaps, rep absent)'), f'twin first rep {day(min(hist))}'


def main():
    p = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    p.add_argument('--kb', required=True)
    p.add_argument('--archive')
    p.add_argument('--db')
    p.add_argument('--n', type=int, default=400)
    p.add_argument('--seed', type=int, default=1)
    p.add_argument('--show', type=int, default=8, help='examples printed per verdict')
    a = p.parse_args()
    ha.check_kb_id(a.kb)
    arch = ha.open_archive(a.archive or ha.archive_path(a.kb))
    rows = arch.execute(
        "SELECT r.date_ms, r.score, r.time_ms, r.rem_id, COALESCE(m.text, ''), r.source FROM reps r "
        "LEFT JOIN rems m ON m.rem_id = r.rem_id WHERE r.source != 'live' AND r.kind = 'card' "
        "AND r.score IN (0, 0.5, 1, 1.5)").fetchall()
    arch.close()
    if not rows:
        print('No backfilled card reps in the archive.')
        return
    sample = random.Random(a.seed).sample(rows, min(a.n, len(rows)))
    print(f'Loading today\'s DB … (sample: {len(sample)} of {len(rows):,} backfilled card reps)', flush=True)
    today = Today(a.db or ha.remnote_db_path(a.kb))
    counts, examples = Counter(), defaultdict(list)
    for date, score, rt, rem, text, source in sample:
        v, detail = verdict(date, score, rt, text, today)
        counts[v] += 1
        examples[v].append(f'{day(date)}  "{text[:60]}"  {detail}  [{source}]')
    for k, n in counts.most_common():
        print(f'  {n:5}  {k}')
    for k, ex in examples.items():
        if a.show and not k.startswith('confirmed'):
            print(f'\n-- {k}')
            for e in ex[:a.show]:
                print('   ', e)


if __name__ == '__main__':
    sys.exit(main())
