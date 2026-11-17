#!/usr/bin/env python3
"""
Review history archive for Incremental RemNote.

RemNote keeps a card's repetitions only inside the card's own record, and an
Incremental Rem's only in its `repHist` slot. Deleting a Rem moves both to the
trash (`deleted_cards`, `deleted_quanta`), where the plugin can't see them, and
RemNote empties the trash after two weeks. This module copies every repetition
it finds in a knowledge base's `remnote.db`, live or in the trash, into an
archive of its own, together with where each Rem sat in the tree. The Study
Dashboard can then keep counting the reps of Rems that no longer exist.

It only ever READS remnote.db (`?mode=ro`, in one read transaction so a card
moving to the trash mid-scan is seen exactly once).

The archive keeps every copy of a rep. Identity is the rep's timestamp, across
kinds: Preserve history & remove, Dismiss and Transfer to parent all copy reps
with their original `date`, sometimes changing the kind (a card rep becomes an
`importedRep` on a tombstone's Dismissed history). A "ghost" rep is one whose
only copies are on items that are no longer live; among those, the copy whose
item was live most recently wins. See plans/implemented/HISTORY_ARCHIVE_PLAN.md.

    python3 scripts/history_archive.py --kb <kbId> scan     # copy into the archive
    python3 scripts/history_archive.py --kb <kbId> report   # what deleted Rems hold
    python3 scripts/history_archive.py --kb <kbId> status

Archive: ~/.incremental-remnote/history-archive/<kbId>.sqlite
"""
import argparse
import json
import re
import sqlite3
import sys
import threading
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path

REMNOTE_DATA = Path.home() / 'remnote'
ARCHIVE_DIR = Path.home() / '.incremental-remnote' / 'history-archive'
KNOWN_KBS_FILE = ARCHIVE_DIR / 'kbs.json'

KB_ID_RE = re.compile(r'^[0-9a-f]{24}$')

# kind → (powerup code, slot code), as in src/lib/consts.ts
SLOTS = {'inc': ('incremental', 'repHist'), 'dism': ('dismissed', 'dismissedHistory')}

# What counts as a review, as in the plugin: isRealCardScore
# (authoritative_aggregates.ts) and repCountsForStats (incremental_rem/types.ts).
REAL_CARD_SCORES = {0, 0.5, 1, 1.5}
REAL_INC_EVENTS = {None, 'rep', 'executeRepetition', 'rescheduledInQueue', 'importedRep', 'externalRep'}
# Default of the flashcard_response_time_limit setting (seconds), for the report only:
# the plugin applies the user's own value.
DEFAULT_CARD_CAP_MS = 180_000

# When two dead copies of a rep were last live at the same time, prefer the original.
KIND_ORDER = {'card': 0, 'inc': 1, 'dism': 2}

SCHEMA = """
CREATE TABLE IF NOT EXISTS reps (
    kind TEXT NOT NULL,           -- 'card' | 'inc' | 'dism'
    date_ms INTEGER NOT NULL,     -- the rep's timestamp: its identity, across kinds
    item_id TEXT NOT NULL,        -- card id, or the Rem id for inc/dism
    rem_id TEXT,
    score REAL,                   -- cards: QueueInteractionScore
    time_ms INTEGER,              -- card responseTime, or reviewTimeSeconds * 1000 (uncapped)
    event_type TEXT,              -- inc/dism eventType
    first_seen INTEGER NOT NULL,
    removed_live INTEGER,         -- removed from a still-live item (history edit): never a ghost
    source TEXT NOT NULL DEFAULT 'live',
    PRIMARY KEY (date_ms, kind, item_id)
);
CREATE INDEX IF NOT EXISTS reps_item ON reps(kind, item_id);

CREATE TABLE IF NOT EXISTS items (
    kind TEXT NOT NULL,
    item_id TEXT NOT NULL,
    rem_id TEXT,
    state TEXT NOT NULL,          -- 'live' | 'trash' | 'gone'
    last_seen_live INTEGER,       -- last scan that found this history outside the trash
    deleted_at INTEGER,           -- RemNote's deletedAt, from the trash copy
    gone_at INTEGER,              -- first scan that found it nowhere
    PRIMARY KEY (kind, item_id)
);

CREATE TABLE IF NOT EXISTS rems (
    rem_id TEXT PRIMARY KEY,
    parent_id TEXT,
    text TEXT,
    state TEXT NOT NULL,          -- 'live' | 'trash' | 'gone'
    deleted_at INTEGER,
    last_seen INTEGER,
    gone_at INTEGER
);

-- Where a Rem known only from an old snapshot sits today: its id is gone (deleted,
-- or re-created by an import), so history_backfill.py ties one of its ancestors to a
-- live Rem, by the same id if that one survived, else by the path's text.
CREATE TABLE IF NOT EXISTS anchors (
    rem_id TEXT PRIMARY KEY,      -- an ancestor from the snapshot
    live_id TEXT NOT NULL,        -- the live Rem standing in for it
    how TEXT NOT NULL             -- 'id' | 'text'
);

CREATE TABLE IF NOT EXISTS scans (
    at INTEGER NOT NULL,
    source TEXT NOT NULL,
    ms INTEGER,
    copies INTEGER,
    new_reps INTEGER,
    rems INTEGER,
    trash_items INTEGER,
    oldest_trash INTEGER
);
"""

_locks = defaultdict(threading.Lock)
_known_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

def check_kb_id(kb_id):
    if not isinstance(kb_id, str) or not KB_ID_RE.match(kb_id):
        raise ValueError(f'not a knowledge base id: {kb_id!r}')
    return kb_id


def remnote_db_path(kb_id):
    return REMNOTE_DATA / f'remnote-{check_kb_id(kb_id)}' / 'remnote.db'


def archive_path(kb_id):
    return ARCHIVE_DIR / f'{check_kb_id(kb_id)}.sqlite'


def open_archive(path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=30)
    db.execute('PRAGMA journal_mode=WAL')
    db.executescript(SCHEMA)
    return db


def open_remnote(path, immutable=False):
    """Read-only. `immutable` for a snapshot nobody writes (a backup), which `mode=ro`
    can't open without its -shm file."""
    mode = 'immutable=1' if immutable else 'mode=ro'
    db = sqlite3.connect(f'file:{Path(path)}?{mode}', uri=True, timeout=30)
    db.isolation_level = None  # explicit BEGIN: one consistent read across tables
    return db


# ---------------------------------------------------------------------------
# Known knowledge bases: the ones the plugin has talked to the helper from
# ---------------------------------------------------------------------------

def known_kbs():
    try:
        return [k for k in json.loads(KNOWN_KBS_FILE.read_text()) if KB_ID_RE.match(k)]
    except (OSError, ValueError):
        return []


def register_kb(kb_id):
    """Remember a KB for the background scans. Cheap when it's already known."""
    if not isinstance(kb_id, str) or not KB_ID_RE.match(kb_id):
        return False
    with _known_lock:
        kbs = known_kbs()
        if kb_id in kbs:
            return False
        if not remnote_db_path(kb_id).exists():
            return False
        try:  # called on every helper request: never let it fail one
            ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
            KNOWN_KBS_FILE.write_text(json.dumps(sorted(kbs + [kb_id])))
        except OSError:
            return False
        return True


# ---------------------------------------------------------------------------
# Reading RemNote records
# ---------------------------------------------------------------------------

def _slot_value_text(value):
    """A slot value's JSON string: the strings of its rich text, else its `s` copy."""
    if not isinstance(value, dict):
        return None
    rich = value.get('v')
    if isinstance(rich, list):
        joined = ''.join(x for x in rich if isinstance(x, str))
        if joined:
            return joined
    s = value.get('s')
    return s if isinstance(s, str) and s else None


def slot_history(doc, kind):
    """The history list in a Rem record's inc/dism slot, from either storage layout:
    newer `ps["<code>_<slot>"].v` (preferred) or legacy inline `bpc.<code>.<slot>`."""
    code, slot = SLOTS[kind]
    raw = None
    ps = (doc.get('ps') or {}).get(f'{code}_{slot}')
    if isinstance(ps, dict):
        raw = _slot_value_text(ps.get('v'))
    if raw is None:
        raw = _slot_value_text(((doc.get('bpc') or {}).get(code) or {}).get(slot))
    if raw is None:
        return None
    try:
        history = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(history, list):
        return None
    return [h for h in history if isinstance(h, dict) and isinstance(h.get('date'), (int, float))]


def card_rep(rep):
    t = rep.get('responseTime')
    return {'date': int(rep['date']), 'score': rep.get('score'),
            'time': int(t) if isinstance(t, (int, float)) and t >= 0 else None, 'event': None}


def inc_rep(rep):
    t = rep.get('reviewTimeSeconds')
    return {'date': int(rep['date']), 'score': None,
            'time': int(round(t * 1000)) if isinstance(t, (int, float)) and t >= 0 else None,
            'event': rep.get('eventType')}


def plain_text(key, names=None, limit=200):
    """A Rem's rich text as one line. References use `names` (id → text) when known."""
    parts = []
    for el in key if isinstance(key, list) else []:
        if isinstance(el, str):
            parts.append(el)
        elif isinstance(el, dict):
            i = el.get('i')
            if i == 'q':
                if el.get('pin'):
                    continue  # source pins: not part of what the Rem says
                parts.append((names or {}).get(el.get('_id')) or '[ref]')
            elif i == 'i':
                parts.append('[image]')
            elif isinstance(el.get('text'), str):
                parts.append(el['text'])
    text = re.sub(r'\s+', ' ', ''.join(parts)).strip()
    return text[:limit - 1] + '…' if len(text) > limit else text


def _chunks(seq, n=800):
    seq = list(seq)
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def _fetch_rems(src, ids):
    """id → {parent, key, deletedAt, state} from quanta, then deleted_quanta."""
    found = {}
    for table, state in (('quanta', 'live'), ('deleted_quanta', 'trash')):
        missing = [i for i in ids if i not in found]
        for chunk in _chunks(missing):
            q = (f"SELECT _id, json_extract(doc,'$.parent'), json_extract(doc,'$.key'), "
                 f"json_extract(doc,'$.deletedAt') FROM {table} WHERE _id IN ({','.join('?' * len(chunk))})")
            for rid, parent, key, deleted_at in src.execute(q, chunk):
                try:
                    key = json.loads(key) if key else []
                except ValueError:
                    key = []
                found[rid] = {'parent': parent, 'key': key, 'deletedAt': deleted_at, 'state': state}
    return found


def read_snapshot(src):
    """Every rep copy in a RemNote DB, plus the Rems that hold them and their
    ancestors, all from one read transaction."""
    src.execute('BEGIN')
    try:
        copies = []  # (kind, item_id, rem_id, state, deleted_at, [rep])
        for table, state in (('cards', 'live'), ('deleted_cards', 'trash')):
            for (doc,) in src.execute(f'SELECT doc FROM {table}'):
                d = json.loads(doc)
                reps = [card_rep(r) for r in d.get('h') or []
                        if isinstance(r, dict) and isinstance(r.get('date'), (int, float))]
                if reps:
                    copies.append(('card', d['_id'], d.get('rId'), state, d.get('deletedAt'), reps))
        for table, state in (('quanta', 'live'), ('deleted_quanta', 'trash')):
            q = (f"SELECT doc FROM {table} WHERE doc LIKE '%repHist%' OR doc LIKE '%dismissedHistory%'")
            for (doc,) in src.execute(q):
                d = json.loads(doc)
                for kind in SLOTS:
                    history = slot_history(d, kind)
                    if history:
                        copies.append((kind, d['_id'], d['_id'], state, d.get('deletedAt'),
                                       [inc_rep(r) for r in history]))

        # The Rems holding reps, then their ancestors, level by level.
        rems = {}
        pending = {c[2] for c in copies if c[2]}
        while pending:
            got = _fetch_rems(src, pending)
            rems.update(got)
            for rid in pending - got.keys():
                rems.setdefault(rid, None)  # not in this DB any more
            pending = {r['parent'] for r in got.values() if r and r['parent']} - rems.keys()

        # Names of the Rems that the texts reference, one level deep.
        ref_ids = {el.get('_id') for r in rems.values() if r for el in r['key']
                   if isinstance(el, dict) and el.get('i') == 'q' and not el.get('pin')}
        ref_ids.discard(None)
        refs = _fetch_rems(src, ref_ids - {k for k, v in rems.items() if v})
        names = {rid: plain_text(r['key'], limit=80) for rid, r in {**refs, **rems}.items() if r}
    finally:
        src.execute('COMMIT')

    rem_rows = {rid: {'parent': r['parent'], 'text': plain_text(r['key'], names), 'state': r['state'],
                      'deletedAt': r['deletedAt']}
                for rid, r in rems.items() if r}
    return copies, rem_rows


# ---------------------------------------------------------------------------
# Scanning into the archive
# ---------------------------------------------------------------------------

def scan(kb_id, db_path=None, archive=None):
    """Copy every rep of the KB's live remnote.db into its archive. Returns a summary."""
    with _locks[kb_id]:
        started = time.time()
        src = open_remnote(db_path or remnote_db_path(kb_id))
        try:
            copies, rem_rows = read_snapshot(src)
        finally:
            src.close()
        db = open_archive(archive or archive_path(kb_id))
        try:
            summary = _write_scan(db, copies, rem_rows, int(time.time() * 1000))
        finally:
            db.close()
        summary['ms'] = int((time.time() - started) * 1000)
        return summary


def _write_scan(db, copies, rem_rows, now):
    with db:
        before = db.total_changes
        db.executemany(
            'INSERT OR IGNORE INTO reps (kind, date_ms, item_id, rem_id, score, time_ms, event_type, first_seen) '
            'VALUES (?,?,?,?,?,?,?,?)',
            ((kind, r['date'], item, rem, r['score'], r['time'], r['event'], now)
             for kind, item, rem, _, _, reps in copies for r in reps))
        new_reps = db.total_changes - before

        # A rep that vanished from an item that's still live was edited away on purpose
        # (history edit), so it must not come back as a ghost later.
        live_dates = defaultdict(set)
        for kind, item, _, state, _, reps in copies:
            if state == 'live':
                live_dates[(kind, item)].update(r['date'] for r in reps)
        removed = [(now, kind, item, date)
                   for kind, item, date in db.execute('SELECT kind, item_id, date_ms FROM reps WHERE removed_live IS NULL')
                   if (kind, item) in live_dates and date not in live_dates[(kind, item)]]
        db.executemany('UPDATE reps SET removed_live=? WHERE kind=? AND item_id=? AND date_ms=?', removed)

        seen = set()
        for kind, item, rem, state, deleted_at, _ in copies:
            if (kind, item) in seen and state == 'trash':
                continue  # a live copy wins (shouldn't happen inside one transaction)
            seen.add((kind, item))
            db.execute(
                'INSERT INTO items (kind, item_id, rem_id, state, last_seen_live, deleted_at, gone_at) '
                'VALUES (?,?,?,?,?,?,NULL) ON CONFLICT(kind, item_id) DO UPDATE SET '
                'rem_id=excluded.rem_id, state=excluded.state, gone_at=NULL, '
                'last_seen_live=COALESCE(excluded.last_seen_live, items.last_seen_live), '
                'deleted_at=COALESCE(excluded.deleted_at, items.deleted_at)',
                (kind, item, rem, state, now if state == 'live' else None,
                 deleted_at if state == 'trash' else None))
        db.execute('CREATE TEMP TABLE IF NOT EXISTS seen_items (kind TEXT, item_id TEXT)')
        db.execute('DELETE FROM seen_items')
        db.executemany('INSERT INTO seen_items VALUES (?,?)', seen)
        db.execute("UPDATE items SET state='gone', gone_at=? WHERE state!='gone' AND "
                   "(kind, item_id) NOT IN (SELECT kind, item_id FROM seen_items)", (now,))

        for rid, r in rem_rows.items():
            db.execute(
                'INSERT INTO rems (rem_id, parent_id, text, state, deleted_at, last_seen, gone_at) '
                'VALUES (?,?,?,?,?,?,NULL) ON CONFLICT(rem_id) DO UPDATE SET parent_id=excluded.parent_id, '
                'text=excluded.text, state=excluded.state, deleted_at=excluded.deleted_at, '
                'last_seen=excluded.last_seen, gone_at=NULL',
                (rid, r['parent'], r['text'], r['state'], r['deletedAt'], now))
        db.execute('CREATE TEMP TABLE IF NOT EXISTS seen_rems (rem_id TEXT PRIMARY KEY)')
        db.execute('DELETE FROM seen_rems')
        db.executemany('INSERT INTO seen_rems VALUES (?)', ((rid,) for rid in rem_rows))
        db.execute("UPDATE rems SET state='gone', gone_at=? WHERE state!='gone' AND "
                   "rem_id NOT IN (SELECT rem_id FROM seen_rems)", (now,))

        trash = [c[4] for c in copies if c[3] == 'trash' and c[4]]
        summary = {'at': now, 'copies': len(copies), 'newReps': new_reps, 'rems': len(rem_rows),
                   'trashItems': sum(1 for c in copies if c[3] == 'trash'),
                   'oldestTrash': min(trash) if trash else None,
                   'removedWhileLive': len(removed)}
        db.execute('INSERT INTO scans (at, source, copies, new_reps, rems, trash_items, oldest_trash) '
                   'VALUES (?,?,?,?,?,?,?)',
                   (now, 'live', summary['copies'], new_reps, summary['rems'],
                    summary['trashItems'], summary['oldestTrash']))
    return summary


# ---------------------------------------------------------------------------
# Ghosts: reps whose every copy is on an item that's no longer live
# ---------------------------------------------------------------------------

def ghost_reps(db):
    """One row per ghost rep (deduplicated by timestamp), most-recently-live copy first."""
    live = {d for (d,) in db.execute(
        "SELECT r.date_ms FROM reps r JOIN items i ON i.kind=r.kind AND i.item_id=r.item_id "
        "WHERE i.state='live' AND r.removed_live IS NULL")}
    best = {}
    q = ("SELECT r.date_ms, r.kind, r.item_id, r.rem_id, r.score, r.time_ms, r.event_type, "
         "i.state, i.last_seen_live, i.deleted_at FROM reps r JOIN items i "
         "ON i.kind=r.kind AND i.item_id=r.item_id WHERE i.state!='live' AND r.removed_live IS NULL")
    for date, kind, item, rem, score, t, event, state, last_live, deleted_at in db.execute(q):
        if date in live:
            continue
        row = {'date': date, 'kind': kind, 'item': item, 'rem': rem, 'score': score, 'time': t,
               'event': event, 'state': state, 'lastLive': last_live, 'deletedAt': deleted_at}
        cur = best.get(date)
        if cur is None or _rank(row) < _rank(cur):
            best[date] = row
    return sorted(best.values(), key=lambda r: r['date'])


def _rank(row):
    return (-(row['lastLive'] or 0), KIND_ORDER[row['kind']])


def counts(rep):
    """Whether the plugin's statistics count this rep."""
    if rep['kind'] == 'card':
        return rep['score'] in REAL_CARD_SCORES
    return rep['event'] in REAL_INC_EVENTS


def rem_chains(db, rem_ids):
    """rem id → [{id, text, state}] from the Rem itself up to (and including) its
    nearest live ancestor, or to the top when none is live."""
    cache = {}

    def row(rid):
        if rid not in cache:
            cache[rid] = db.execute('SELECT parent_id, text, state, deleted_at FROM rems WHERE rem_id=?',
                                    (rid,)).fetchone()
        return cache[rid]

    anchors = dict(((a, (b, c)) for a, b, c in db.execute('SELECT rem_id, live_id, how FROM anchors')))

    chains = {}
    for rid in rem_ids:
        chain, cur, guard = [], rid, set()
        while cur and cur not in guard:
            guard.add(cur)
            r = row(cur)
            # An ancestor known only from a backup stands for a live Rem today. Never
            # the Rem holding the reps itself: it stays a deleted node.
            if cur != rid and (not r or r[2] != 'live') and cur in anchors:
                live_id, _how = anchors[cur]
                lr = row(live_id)
                chain.append({'id': live_id, 'text': lr[1] if lr else None, 'state': 'live', 'deletedAt': None})
                break
            if not r:
                chain.append({'id': cur, 'text': None, 'state': 'unknown'})
                break
            chain.append({'id': cur, 'text': r[1], 'state': r[2], 'deletedAt': r[3]})
            if r[2] == 'live':
                break
            cur = r[0]
        chains[rid] = chain
    return chains


def ghosts(kb_id, archive=None):
    """The /history/ghosts payload: ghost reps plus every Rem on their chains."""
    db = open_archive(archive or archive_path(kb_id))
    try:
        reps = ghost_reps(db)
        chains = rem_chains(db, {r['rem'] for r in reps if r['rem']})
        rems = {}
        for chain in chains.values():
            for i, link in enumerate(chain):
                rems.setdefault(link['id'], {**link, 'parent': chain[i + 1]['id'] if i + 1 < len(chain) else None})
        return {'reps': [{k: r[k] for k in ('date', 'kind', 'item', 'rem', 'score', 'time', 'event', 'deletedAt')}
                         for r in reps],
                'rems': rems}
    finally:
        db.close()


def status(kb_id, archive=None):
    path = archive or archive_path(kb_id)
    if not Path(path).exists():
        return {'archive': False}
    db = open_archive(path)
    try:
        last = db.execute('SELECT at, copies, new_reps, rems, trash_items, oldest_trash FROM scans '
                          'ORDER BY at DESC LIMIT 1').fetchone()
        items = dict(db.execute('SELECT state, COUNT(*) FROM items GROUP BY state').fetchall())
        return {'archive': True, 'bytes': Path(path).stat().st_size,
                'reps': db.execute('SELECT COUNT(*) FROM reps').fetchone()[0],
                'items': items,
                'lastScan': dict(zip(('at', 'copies', 'newReps', 'rems', 'trashItems', 'oldestTrash'), last))
                if last else None}
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Background scans, for the helper
# ---------------------------------------------------------------------------

SCAN_EVERY_S = 6 * 3600


def start_background_scans(log=print, first_delay_s=60):
    """Scan every known KB shortly after start, then every six hours. RemNote empties
    its trash after two weeks, so this leaves a wide margin."""
    def loop():
        time.sleep(first_delay_s)
        while True:
            for kb_id in known_kbs():
                try:
                    s = scan(kb_id)
                    log(f'[history] {kb_id[:8]}… scanned in {s["ms"]} ms: {s["newReps"]} new reps, '
                        f'{s["trashItems"]} items in the trash')
                except Exception as e:  # noqa: BLE001 — one KB failing mustn't stop the others
                    log(f'[history] {kb_id[:8]}… scan failed: {e}')
            time.sleep(SCAN_EVERY_S)
    threading.Thread(target=loop, name='history-archive', daemon=True).start()


# ---------------------------------------------------------------------------
# Report (CLI)
# ---------------------------------------------------------------------------

def _fmt_ms(ms):
    s = int(ms // 1000)
    h, m = divmod(s // 60, 60)
    return f'{h}h{m:02d}m' if h else f'{m}m{s % 60:02d}s'


def _day(ms):
    return datetime.fromtimestamp(ms / 1000).strftime('%Y-%m-%d') if ms else '?'


def report(kb_id, archive=None, top=15, card_cap_ms=DEFAULT_CARD_CAP_MS):
    """What deleted Rems hold: totals by kind and year, and the deleted subtrees with
    the most time, each under its nearest live ancestor."""
    def t(r):
        return min(r['time'] or 0, card_cap_ms) if r['kind'] == 'card' else (r['time'] or 0)

    db = open_archive(archive or archive_path(kb_id))
    try:
        reps = [r for r in ghost_reps(db) if counts(r)]
        chains = rem_chains(db, {r['rem'] for r in reps if r['rem']})

        def path_to_top(rid):
            parts, cur, guard = [], rid, set()
            while cur and cur not in guard and len(parts) < 8:
                guard.add(cur)
                r = db.execute('SELECT parent_id, text FROM rems WHERE rem_id=?', (cur,)).fetchone()
                if not r:
                    break
                parts.append((r[1] or '?')[:40])
                cur = r[0]
            return ' › '.join(reversed(parts))

        # Group by the deleted subtree each rep came from: the top-most non-live Rem of its chain.
        groups = {}
        for r in reps:
            chain = chains.get(r['rem']) or [{'id': r['rem'], 'text': None, 'state': 'unknown'}]
            dead = [c for c in chain if c['state'] != 'live']
            root = dead[-1] if dead else chain[0]
            g = groups.setdefault(root['id'], {'reps': 0, 'ms': 0, 'rems': set(), 'root': root,
                                               'anchor': chain[-1] if chain[-1]['state'] == 'live' else None,
                                               'deleted': root.get('deletedAt') or r['deletedAt']})
            g['reps'] += 1
            g['ms'] += t(r)
            g['rems'].add(r['rem'])
        ranked = sorted(groups.values(), key=lambda g: -g['ms'])[:top]
        for g in ranked:
            g['where'] = path_to_top(g['anchor']['id']) if g['anchor'] else '(no live ancestor known)'
    finally:
        db.close()

    out = []
    st = status(kb_id, archive)
    out.append(f"Archive: {st.get('reps', 0):,} rep copies; items {st.get('items')}")
    if st.get('lastScan'):
        ls = st['lastScan']
        out.append(f"Last scan {_day(ls['at'])}: {ls['trashItems']} items in RemNote's trash, "
                   f"oldest deleted {_day(ls['oldestTrash'])}")
    out.append('')
    out.append(f'Reps that only deleted Rems hold (card time capped at {card_cap_ms // 1000}s):')
    by_kind = defaultdict(lambda: [0, 0])
    by_year = defaultdict(lambda: [0, 0])
    for r in reps:
        for bucket in (by_kind[r['kind']], by_year[datetime.fromtimestamp(r['date'] / 1000).year]):
            bucket[0] += 1
            bucket[1] += t(r)
    for kind in ('card', 'inc', 'dism'):
        n, ms = by_kind.get(kind, (0, 0))
        out.append(f'  {kind:5} {n:7,} reps  {_fmt_ms(ms):>9}')
    out.append(f"  total {len(reps):7,} reps  {_fmt_ms(sum(t(r) for r in reps)):>9}")
    if by_year:
        out.append('  by year: ' + ', '.join(f'{y}: {n:,} / {_fmt_ms(ms)}' for y, (n, ms) in sorted(by_year.items())))
    out.append('')
    out.append(f'{len(groups):,} deleted subtrees hold them. Top {len(ranked)} by time:')
    for g in ranked:
        out.append(f"  {_fmt_ms(g['ms']):>9} {g['reps']:6,} reps  {len(g['rems']):4} Rems  "
                   f"deleted {_day(g['deleted'])}  [{g['root']['state']}]")
        out.append(f"      {(g['root']['text'] or '?')[:90]}")
        out.append(f"      under: {g['where'][:140]}")
    return '\n'.join(out)


def main():
    p = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    p.add_argument('--kb', required=True, help='knowledge base id (the remnote-<id> folder)')
    p.add_argument('--db', help='remnote.db to read (default: the KB\'s live one)')
    p.add_argument('--archive', help='archive file (default: ~/.incremental-remnote/history-archive/<kb>.sqlite)')
    p.add_argument('--top', type=int, default=15)
    p.add_argument('command', choices=['scan', 'report', 'status', 'ghosts'])
    a = p.parse_args()
    check_kb_id(a.kb)
    if a.command == 'scan':
        if not a.db and not a.archive:
            register_kb(a.kb)  # the helper's background scans take it from here
        print(json.dumps(scan(a.kb, a.db, a.archive), indent=1))
    elif a.command == 'status':
        print(json.dumps(status(a.kb, a.archive), indent=1))
    elif a.command == 'ghosts':
        g = ghosts(a.kb, a.archive)
        print(json.dumps({'reps': len(g['reps']), 'rems': len(g['rems'])}, indent=1))
    else:
        print(report(a.kb, a.archive, a.top))


if __name__ == '__main__':
    sys.exit(main())
