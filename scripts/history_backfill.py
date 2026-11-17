#!/usr/bin/env python3
"""Backfill a KB's review-history archive from old snapshots of it.

    python3 -I scripts/history_backfill.py --kb <id> [--exclude-kb <id> …] [--dry-run]
        (--list snapshots.txt | snapshot …)

The helper's archive (history_archive.py) only knows reps it has seen since it
started scanning. Reviews of Rems deleted before that are still in old backups.
This reads each snapshot, newest first, and archives every rep whose timestamp
the archive doesn't have yet, with `source` = the snapshot's file name. The
Study Dashboard then counts them as deleted Rems (plans/implemented/HISTORY_ARCHIVE_PLAN.md).

A snapshot is a RemNote .db, a folder holding remnote.db (+ -wal), a .zip with a
.db inside (RemNote's own backups), or a JSON export (.zip/.rem holding rem.json
and cards.json). Snapshots of other KBs are skipped.

Placing old Rems. Their ids are often gone for good: an export/import gives every
Rem a new id. So each recovered Rem's chain is tied to a live Rem today
(`anchors` table), in this order:
  1. the nearest ancestor whose id still exists;
  2. else the deepest ancestor whose path matches a live path by text, top-down
     ("Suporte › Matemática" in 2023 → today's "Suporte › Matemática");
  3. else nothing: the dashboard shows it under "Deleted Rems with no surviving
     ancestor".
The Rem holding the reps is never matched itself, so a re-imported twin keeps
its own (fresh) history and the old reps show as a deleted sibling of it.

--exclude-kb drops reps whose timestamps exist in another KB: history that came
in with an import of someone else's cards and isn't the user's (§3b of the plan).
"""
import argparse
import json
import re
import shutil
import sqlite3
import sys
import tempfile
import time
import unicodedata
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import history_archive as ha  # noqa: E402

MONTHS = {m: i for i, m in enumerate(
    ('january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
     'october', 'november', 'december'), 1)}


# ---------------------------------------------------------------------------
# Snapshots
# ---------------------------------------------------------------------------

def snapshot_time(path):
    """When a snapshot was taken, in ms: from its name when it has a date, else its mtime."""
    name = Path(path).name
    m = re.search(r'(20\d\d)-(\d\d)-(\d\d)', name) or re.search(r'(?<!\d)(20\d\d)(\d\d)(\d\d)(?!\d)', name)
    if m:
        y, mo, d = map(int, m.groups())
        return int(time.mktime((y, mo, d, 12, 0, 0, 0, 0, -1)) * 1000)
    m = re.search(r'_([A-Za-z]+)_(\d{1,2})(?:st|nd|rd|th)_(20\d\d)', name)  # RemNote_Export_June_30th_2022
    if m and m.group(1).lower() in MONTHS:
        return int(time.mktime((int(m.group(3)), MONTHS[m.group(1).lower()], int(m.group(2)),
                                12, 0, 0, 0, 0, -1)) * 1000)
    m = re.search(r'-(1[67]\d{11})\.zip$', name)  # backup-<kb>-<ms>.zip
    if m:
        return int(m.group(1))
    return int(Path(path).stat().st_mtime * 1000)


def _json_export_to_db(zf, members, out):
    db = sqlite3.connect(out)
    for t in ('quanta', 'deleted_quanta', 'cards', 'deleted_cards'):
        db.execute(f'CREATE TABLE {t} (_id TEXT PRIMARY KEY, doc TEXT)')
    owner = None
    for m in members:
        if not m.endswith('.json'):
            continue
        with zf.open(m) as f:
            data = json.load(f)
        if isinstance(data, dict):
            owner = owner or data.get('knowledgebaseId') or data.get('userId')
            docs = data.get('docs')
        else:
            docs = data
        if not isinstance(docs, list):
            continue
        for d in docs:
            if not isinstance(d, dict) or '_id' not in d:
                continue
            table = 'cards' if 'rId' in d and ('h' in d or 'c' in d) and 'key' not in d else 'quanta'
            db.execute(f'INSERT OR REPLACE INTO {table} VALUES (?,?)', (d['_id'], json.dumps(d)))
    db.commit()
    db.close()
    return owner


def prepare(path, work):
    """Make a snapshot readable as SQLite. → (db path, immutable?, owner hint)."""
    p = Path(path)
    if p.is_dir():
        src = p / 'remnote.db'
        for suffix in ('', '-wal'):
            f = Path(str(src) + suffix)
            if f.exists():
                shutil.copy(f, work / ('snap.db' + suffix))
        return work / 'snap.db', False, None
    if p.suffix == '.db':
        wal = Path(str(p) + '-wal')
        if wal.exists() and wal.stat().st_size > 0:
            shutil.copy(p, work / 'snap.db')
            shutil.copy(wal, work / 'snap.db-wal')
            return work / 'snap.db', False, None
        return p, True, None
    with zipfile.ZipFile(p) as zf:
        names = zf.namelist()
        dbs = [n for n in names if n.endswith('.db')]
        if dbs:
            with zf.open(dbs[0]) as f, open(work / 'snap.db', 'wb') as out:
                shutil.copyfileobj(f, out, 1 << 22)
            return work / 'snap.db', True, None
        return work / 'snap.db', True, _json_export_to_db(zf, names, work / 'snap.db')


def _owner(db):
    for table in ('cards', 'quanta'):
        try:
            for (doc,) in db.execute(f'SELECT doc FROM {table} LIMIT 50'):
                o = json.loads(doc).get('owner')
                if o:
                    return o
        except sqlite3.Error:
            pass
    return None


def _ensure_trash_tables(dbp, src):
    """Old exports have no trash tables; read_snapshot expects them."""
    for t in ('deleted_quanta', 'deleted_cards'):
        try:
            src.execute(f'SELECT 1 FROM {t} LIMIT 1')
        except sqlite3.Error:
            src.close()
            w = sqlite3.connect(dbp)
            w.execute(f'CREATE TABLE IF NOT EXISTS {t} (_id TEXT PRIMARY KEY, doc TEXT)')
            w.commit()
            w.close()
            src = ha.open_remnote(dbp, immutable=False)
    return src


def read(path, kb_id, work_root=None):
    """→ (copies, rem_rows) of one snapshot, or None when it belongs to another KB."""
    work = Path(tempfile.mkdtemp(dir=work_root))
    try:
        dbp, immutable, owner_hint = prepare(path, work)
        src = ha.open_remnote(dbp, immutable=immutable)
        try:
            owner = _owner(src) or owner_hint
            if owner and owner != kb_id:
                return None
            src = _ensure_trash_tables(dbp, src)
            return ha.read_snapshot(src)
        finally:
            src.close()
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ---------------------------------------------------------------------------
# Today's tree, for placing old Rems
# ---------------------------------------------------------------------------

def norm(text):
    s = unicodedata.normalize('NFKC', text or '').casefold()
    return ' '.join(re.sub(r'[^\w]+', ' ', s).split())


class LiveTree:
    """Live Rems of the KB's current remnote.db: ids, and children by normalized text."""

    def __init__(self, db_path):
        src = ha.open_remnote(db_path)
        try:
            rows = [(i, p, json.loads(k) if k else [])
                    for i, p, k in src.execute("SELECT _id, json_extract(doc,'$.parent'), "
                                               "json_extract(doc,'$.key') FROM quanta")]
        finally:
            src.close()
        names = {i: ha.plain_text(k, limit=80) for i, _, k in rows}
        self.ids = {i for i, _, _ in rows}
        self.text = {}
        self.children = defaultdict(lambda: defaultdict(list))  # parent → norm text → [id]
        for i, p, k in rows:
            t = ha.plain_text(k, names)
            self.text[i] = t
            n = norm(t)
            if n:
                self.children[p][n].append(i)

    def match_path(self, texts):
        """Top-down texts of an old chain → [(index, live id)] for the longest matching prefix."""
        keys = [norm(t) for t in texts]

        # Same-text siblings are common (two "Suporte" top-level Rems, say), so try
        # every candidate at each level and keep the deepest match.
        def best(level, parent):
            if level == len(keys) or not keys[level]:
                return []
            found = []
            for cand in self.children.get(parent, {}).get(keys[level], [])[:20]:
                path = [(level, cand)] + best(level + 1, cand)
                if len(path) > len(found):
                    found = path
                    if level + len(found) == len(keys):
                        break
            return found

        return best(0, None)


def anchor_for(rid, rem_rows, live):
    """(ancestor id from the snapshot, live id, how) for a recovered Rem, or None."""
    chain, cur, guard = [], rem_rows.get(rid, {}).get('parent'), set()
    while cur and cur not in guard:
        guard.add(cur)
        if cur in live.ids:
            return cur, cur, 'id'
        chain.append(cur)
        cur = (rem_rows.get(cur) or {}).get('parent')
    if not chain:
        return None
    top_down = list(reversed(chain))
    texts = [(rem_rows.get(c) or {}).get('text') or '' for c in top_down]
    matched = live.match_path(texts)
    if not matched:
        return None
    idx, live_id = matched[-1]
    return top_down[idx], live_id, 'text'


# ---------------------------------------------------------------------------
# Backfill
# ---------------------------------------------------------------------------

def other_kb_dates(kb_ids):
    dates = set()
    for kb in kb_ids:
        src = ha.open_remnote(ha.remnote_db_path(ha.check_kb_id(kb)))
        try:
            copies, _ = ha.read_snapshot(src)
        finally:
            src.close()
        dates.update(r['date'] for c in copies for r in c[5])
    return dates


def backfill(kb_id, snapshots, exclude_kbs=(), dry_run=False, archive=None, db_path=None,
             work_root=None, log=print):
    ha.check_kb_id(kb_id)
    db = ha.open_archive(archive or ha.archive_path(kb_id))
    have = {d for (d,) in db.execute('SELECT date_ms FROM reps')}
    excluded = other_kb_dates(exclude_kbs)
    log(f'archive: {len(have):,} rep timestamps; {len(excluded):,} to exclude from {len(exclude_kbs)} other KB(s)')
    live = LiveTree(db_path or ha.remnote_db_path(kb_id))
    log(f'today: {len(live.ids):,} live Rems')

    totals = Counter()
    by_source = {}
    db.isolation_level = None  # explicit transactions: one short one per snapshot
    try:
        for path in sorted(snapshots, key=snapshot_time, reverse=True):
            name = Path(path).name
            at = snapshot_time(path)
            started = time.time()
            try:
                got = read(path, kb_id, work_root)
            except Exception as e:  # noqa: BLE001 — one unreadable snapshot mustn't stop the rest
                log(f'  {name}: unreadable ({e!r})')
                totals['unreadable'] += 1
                continue
            if got is None:
                log(f'  {name}: another KB, skipped')
                continue
            copies, rem_rows = got
            # Read first, write after, in a short transaction: the helper's own scans
            # write this archive too and must not wait on a slow snapshot.
            db.execute('BEGIN IMMEDIATE')
            new_reps, counted, counted_ms, new_rems = 0, 0, 0, set()
            for kind, item, rem, state, deleted_at, reps in copies:
                fresh = [r for r in reps if r['date'] not in have and r['date'] not in excluded]
                if not fresh:
                    continue
                db.executemany(
                    'INSERT OR IGNORE INTO reps (kind, date_ms, item_id, rem_id, score, time_ms, event_type, '
                    'first_seen, source) VALUES (?,?,?,?,?,?,?,?,?)',
                    ((kind, r['date'], item, rem, r['score'], r['time'], r['event'], at, name) for r in fresh))
                db.execute(
                    'INSERT OR IGNORE INTO items (kind, item_id, rem_id, state, last_seen_live, deleted_at, gone_at) '
                    "VALUES (?,?,?,'gone',?,?,NULL)",
                    (kind, item, rem, at if state == 'live' else None, deleted_at if state == 'trash' else None))
                for r in fresh:
                    have.add(r['date'])
                    if ha.counts({'kind': kind, 'score': r['score'], 'event': r['event']}):
                        counted += 1
                        t = r['time'] or 0
                        counted_ms += min(t, ha.DEFAULT_CARD_CAP_MS) if kind == 'card' else t
                new_reps += len(fresh)
                if rem:
                    new_rems.add(rem)

            # The recovered Rems and their ancestors, as the snapshot had them.
            chain_ids = set()
            for rid in new_rems:
                cur, guard = rid, set()
                while cur and cur not in guard and cur in rem_rows:
                    guard.add(cur)
                    chain_ids.add(cur)
                    cur = rem_rows[cur]['parent']
            for rid in chain_ids:
                r = rem_rows[rid]
                db.execute(
                    'INSERT OR IGNORE INTO rems (rem_id, parent_id, text, state, deleted_at, last_seen, gone_at) '
                    'VALUES (?,?,?,?,?,?,NULL)',
                    (rid, r['parent'], r['text'], 'live' if rid in live.ids else 'gone', r['deletedAt'], at))
            placed = Counter()
            for rid in new_rems:
                a = anchor_for(rid, rem_rows, live)
                if a:
                    db.execute('INSERT OR IGNORE INTO anchors (rem_id, live_id, how) VALUES (?,?,?)', a)
                placed[a[2] if a else 'none'] += 1

            db.execute('ROLLBACK' if dry_run else 'COMMIT')
            by_source[name] = (new_reps, counted, counted_ms)
            totals.update(reps=new_reps, counted=counted, ms=counted_ms, rems=len(new_rems), **placed)
            log(f'  {name}: {new_reps:,} new reps ({counted:,} counted, {counted_ms / 3_600_000:.1f} h) on '
                f'{len(new_rems):,} Rems — placed by id {placed["id"]}, by text {placed["text"]}, '
                f'nowhere {placed["none"]} — {time.time() - started:.0f}s')
    except BaseException:
        if db.in_transaction:
            db.execute('ROLLBACK')
        raise
    finally:
        db.close()
    log(f'{"DRY RUN — nothing written. " if dry_run else ""}Total: {totals["reps"]:,} reps '
        f'({totals["counted"]:,} counted, {totals["ms"] / 3_600_000:.1f} h) on {totals["rems"]:,} Rems; '
        f'placed by id {totals["id"]}, by text {totals["text"]}, nowhere {totals["none"]}')
    return {'totals': dict(totals), 'bySource': by_source}


def main():
    p = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    p.add_argument('--kb', required=True)
    p.add_argument('--exclude-kb', action='append', default=[],
                   help="a KB whose reps aren't the user's (repeatable)")
    p.add_argument('--list', help='file with one snapshot path per line')
    p.add_argument('--dry-run', action='store_true', help='report what would be added, write nothing')
    p.add_argument('--archive', help='archive file (default: the KB\'s)')
    p.add_argument('--db', help='today\'s remnote.db (default: the KB\'s)')
    p.add_argument('--work', help='folder for extracted snapshots (default: the system temp folder)')
    p.add_argument('snapshots', nargs='*')
    a = p.parse_args()
    snaps = list(a.snapshots)
    if a.list:
        snaps += [l.strip() for l in Path(a.list).read_text().splitlines() if l.strip()]
    if not snaps:
        p.error('no snapshots given')
    backfill(a.kb, snaps, a.exclude_kb, a.dry_run, a.archive, a.db, a.work)


if __name__ == '__main__':
    sys.exit(main())
