#!/usr/bin/env python3
"""
The search helper's own index of a knowledge base: the Rem facts RemNote's search
index doesn't hold, in plain indexed tables, so rem_search.py can filter by tag,
powerup, slot or property value, reference, type and date in milliseconds.

    ~/.incremental-remnote/search/<kbId>.sqlite

Built from remnote.db (read-only) in one pass, then kept current before each search
by reading only the Rems whose `y` (RemNote's indexed "last local write" stamp) is
newer than the last one seen. Measured 2026-11-14: `y` is set by local edits and by
edits arriving through sync, and the lookup costs ~0 ms (it has an index).

What it records, per Rem (field names from RemNote 1.30.2-beta's bundle):
    rems         type (1 concept, 2 descriptor, 6 portal), createdAt, text edit time
                 (`key,u`/`value,u`), parent, and what decides whether its cards are
                 shown: `forget` (cards off), `efc` (forward off), `enableBackSR`
                 (backward on), `dci` (disabled clozes), `vt` (1 = table) and whether
                 the Rem is in a table (itself or an ancestor; computed at build and
                 for each re-read Rem, so a Rem turned into a table later only reaches
                 its descendants at the next rebuild)
    rem_tags     `tp` entries whose target is an ordinary Rem
    rem_powerups `tp` entries whose target represents a powerup (`rcrt`), plus `apu`
    props        every value with a name: powerup slots (`ps` "<code>_<slot>", legacy
                 `bpc`) and user properties (hidden child Rems, `ie: true`, whose key
                 is a single reference to the property Rem under its tag). Text, plus a
                 number when the text is one and a day when it is a date. A powerup slot
                 can be in both places: visible slots (IncRem Priority, Next Rep Date)
                 are written to the child while an older `ps` copy stays behind, which
                 was so for 5,063 IncRems (Nov 2026, the child newer in every case). The
                 child is filed under the powerup's code so the two pair up, and
                 rem_search keeps only the most recently written (`at`).
    refs         references in the key and back text ('text'), in the Sources slot
                 (`os_os`: 'source'), and in other slot and property values ('value')
    cards        one row per card (`cards` table): its Rem, kind (forward, backward,
                 cloze), next due time (`a`, null when RemNote won't show it), last
                 review, mastery level, Learn New (`ny`), no longer generated (`b`),
                 and the answers since the last Reset (reps, Forgots), as RemNote's
                 own FSRS counts them (src/lib/fsrs.ts)
                 For a card on an FSRS scheduler, its memory state too: stability and
                 difficulty from a replay with ITS scheduler's weights (fsrs.py), the
                 scheduler's decay and the last review's time, so retrievability is
                 computed when searching. The scheduler is the `src` of the card's Rem
                 or of its nearest ancestor that has one, else the Global Default
                 (`knowledge_base_data` spacedRepetitionSchedulerIdKb), as RemNote's
                 own Bullet Information panel resolves it.
    schedulers   RemNote's schedulers (`spaced_repetition_scheduler`: n, st, w, tr)
    reps         every history entry (card, date, score) for rated:
    names        the name of every Rem used as a tag, property or powerup, and of
                 every Rem referenced in text or listed as a Source (so source:*x* and
                 refs:*x* match names in ms instead of scanning every Rem)

    python3 scripts/rem_index.py --kb <id> build      # rebuild from scratch
    python3 scripts/rem_index.py --kb <id> status
"""
import argparse
import datetime
import json
import os
import re
import sqlite3
import sys
import threading
import time
import unicodedata
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import history_archive  # noqa: E402  (KB paths, read-only open)
import fsrs  # noqa: E402  (memory state of FSRS cards)

INDEX_DIR = Path.home() / '.incremental-remnote' / 'search'
SCHEMA_VERSION = '10'
# Re-read Rems written up to this long before the last stamp seen: commits and
# clocks need not arrive in stamp order. Re-reading is idempotent.
OVERLAP_MS = 10_000
# Look for deleted Rems at most this often (a full id diff, ~0.3 s).
DELETION_SWEEP_S = 600
# Slot values longer than this are JSON (review histories, highlight geometry) that
# nobody searches by; keeping them whole made the index 192 MB instead of ~60.
MAX_TEXT = 300
SOURCES = ('os', 'os')  # the Sources powerup slot, as (owner, name)

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS rems (
    id TEXT PRIMARY KEY, parent TEXT, type INTEGER, created INTEGER, edited INTEGER,
    forget INTEGER, efc INTEGER, back_sr INTEGER, dci TEXT, vt INTEGER, in_table INTEGER, src TEXT);
CREATE INDEX IF NOT EXISTS rems_parent ON rems(parent);
CREATE INDEX IF NOT EXISTS rems_type ON rems(type);
CREATE INDEX IF NOT EXISTS rems_created ON rems(created);
CREATE INDEX IF NOT EXISTS rems_edited ON rems(edited);
CREATE TABLE IF NOT EXISTS rem_tags (rem TEXT NOT NULL, tag TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS rem_tags_tag ON rem_tags(tag);
CREATE INDEX IF NOT EXISTS rem_tags_rem ON rem_tags(rem);
CREATE TABLE IF NOT EXISTS rem_powerups (rem TEXT NOT NULL, code TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS rem_powerups_code ON rem_powerups(code);
CREATE INDEX IF NOT EXISTS rem_powerups_rem ON rem_powerups(rem);
CREATE TABLE IF NOT EXISTS powerups (code TEXT PRIMARY KEY, rem TEXT, name TEXT);
CREATE TABLE IF NOT EXISTS props (
    rem TEXT NOT NULL,     -- the Rem the value belongs to
    src TEXT NOT NULL,     -- the Rem whose document holds it (a property child, or rem)
    owner TEXT NOT NULL,   -- squashed powerup code, or the property's tag name
    name TEXT NOT NULL,    -- squashed slot code or property name
    prop TEXT,             -- the property Rem (user properties)
    text TEXT,             -- folded
    num REAL,
    day INTEGER,           -- days since 1970-01-01, local calendar
    at INTEGER);           -- when it was written: the newest of a Rem's copies wins
CREATE INDEX IF NOT EXISTS props_name ON props(name, owner);
CREATE INDEX IF NOT EXISTS props_rem ON props(rem);
CREATE INDEX IF NOT EXISTS props_src ON props(src);
CREATE TABLE IF NOT EXISTS refs (rem TEXT NOT NULL, src TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS refs_target ON refs(target, kind);
CREATE INDEX IF NOT EXISTS refs_src ON refs(src);
CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY, rem TEXT, kind TEXT, cloze TEXT, next INTEGER, next_day INTEGER, last INTEGER,
    ivl INTEGER, ml TEXT, ny INTEGER, nogen INTEGER, created INTEGER, reps INTEGER,
    lapses INTEGER, first_rep INTEGER,
    sched TEXT, mem_s REAL, mem_d REAL, decay REAL, mem_last INTEGER);
CREATE INDEX IF NOT EXISTS cards_sched ON cards(sched);
CREATE TABLE IF NOT EXISTS schedulers (id TEXT PRIMARY KEY, name TEXT, type TEXT, weights TEXT, tr REAL);
CREATE INDEX IF NOT EXISTS cards_rem ON cards(rem);
CREATE INDEX IF NOT EXISTS cards_next ON cards(next);
CREATE TABLE IF NOT EXISTS reps (card TEXT NOT NULL, rem TEXT, date INTEGER, score REAL);
CREATE INDEX IF NOT EXISTS reps_date ON reps(date);
CREATE INDEX IF NOT EXISTS reps_card ON reps(card);
CREATE TABLE IF NOT EXISTS names (id TEXT PRIMARY KEY, name TEXT);
CREATE INDEX IF NOT EXISTS names_name ON names(name);
"""

_locks = defaultdict(threading.Lock)
_last_sweep = {}


# ---------------------------------------------------------------------------
# Text
# ---------------------------------------------------------------------------

def fold(text):
    """Lower-case, accents removed (ä → a, ç → c), whitespace collapsed."""
    decomposed = unicodedata.normalize('NFKD', text or '')
    stripped = ''.join(ch for ch in decomposed if not unicodedata.combining(ch))
    return re.sub(r'\s+', ' ', stripped.lower()).strip()


def squash(text):
    """A name for matching keys: "Next Rep Date" = "nextRepDate" = "next-rep-date"."""
    return re.sub(r'[^0-9a-z]', '', fold(text))


def plain(rich, names=None):
    """Rich text → plain text. References become the referenced Rem's name when
    `names` knows it, otherwise nothing."""
    if isinstance(rich, str):
        return rich
    out = []
    for el in rich or []:
        if isinstance(el, str):
            out.append(el)
        elif isinstance(el, dict):
            if el.get('i') == 'q':
                if names is not None:
                    out.append(names.get(el.get('_id'), ''))
            elif isinstance(el.get('text'), str):
                out.append(el['text'])
    return ''.join(out)


def ref_ids(rich):
    out = []
    if isinstance(rich, list):
        for el in rich:
            if isinstance(el, dict):
                if el.get('i') == 'q' and isinstance(el.get('_id'), str):
                    out.append(el['_id'])
                elif isinstance(el.get('qId'), str):  # inline link
                    out.append(el['qId'])
    return out


NUMBER_RE = re.compile(r'^-?\d+(?:\.\d+)?$')
DATE_RE = re.compile(r'^([A-Za-z]+) (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$')  # "August 1st, 2026"
MONTHS = {m: i for i, m in enumerate(['january', 'february', 'march', 'april', 'may', 'june', 'july',
                                       'august', 'september', 'october', 'november', 'december'], 1)}
EPOCH = datetime.date(1970, 1, 1)


def epoch_day(date):
    return (date - EPOCH).days


def day_of_ms(ms):
    return epoch_day(datetime.datetime.fromtimestamp(ms / 1000).date())


def number_and_day(text):
    """(num, day) for a slot or property value. A date is a daily document's name
    ("August 1st, 2026") or an ISO date; a 13-digit number is a time in ms."""
    t = (text or '').strip()
    num = day = None
    if NUMBER_RE.match(t):
        num = float(t)
        if 1e12 <= num < 1e13:
            day = day_of_ms(num)
        return num, day
    m = DATE_RE.match(t)
    if m and m.group(1).lower() in MONTHS:
        try:
            return None, epoch_day(datetime.date(int(m.group(3)), MONTHS[m.group(1).lower()], int(m.group(2))))
        except ValueError:
            return None, None
    m = re.match(r'^(\d{4})-(\d{2})-(\d{2})', t)
    if m:
        try:
            return None, epoch_day(datetime.date(int(m.group(1)), int(m.group(2)), int(m.group(3))))
        except ValueError:
            pass
    return None, None


# ---------------------------------------------------------------------------
# Paths and connections
# ---------------------------------------------------------------------------

def index_path(kb_id):
    return INDEX_DIR / f'{history_archive.check_kb_id(kb_id)}.sqlite'


def open_index(kb_id, index_file=None):
    path = Path(index_file) if index_file else index_path(kb_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    new = not path.exists()
    # uri=True so remnote.db can be ATTACHed read-only by URI (attach_remnote).
    db = sqlite3.connect(f'file:{path}', uri=True, timeout=30, check_same_thread=False)
    if new:
        path.chmod(0o600)  # it holds note text
    db.execute('PRAGMA journal_mode=WAL')
    db.executescript(SCHEMA)
    return db


def attach_remnote(db, remnote_path):
    """remnote.db as schema `rn`, read-only, on the index's connection."""
    uri = f'file:{Path(remnote_path)}?mode=ro'
    db.execute('ATTACH DATABASE ? AS rn', (uri,))


def meta(db, key, default=None):
    row = db.execute('SELECT v FROM meta WHERE k = ?', (key,)).fetchone()
    return row[0] if row else default


def set_meta(db, key, value):
    db.execute('INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)', (key, str(value)))


# ---------------------------------------------------------------------------
# Reading one Rem
# ---------------------------------------------------------------------------

class Reader:
    """Turns RemNote Rem documents into index rows. Needs to know which Rems are
    powerups (their `rcrt` code), and the names of property Rems and their tags."""

    def __init__(self, src, powerup_of=None):
        self.src = src
        self._docs = {}
        if powerup_of is not None:  # a refresh: the index already knows them
            self.powerup_of = dict(powerup_of)
            return
        self.powerup_of = {}  # powerup Rem id → code
        # `> ''`, not IS NOT NULL: only a range lets SQLite use RemNote's index on
        # rcrt (0 ms instead of a 0.8 s scan of every Rem).
        for rid, code in src.execute(
                "SELECT _id, json_extract(doc, '$.rcrt') FROM quanta WHERE json_extract(doc, '$.rcrt') > ''"):
            if isinstance(code, str):
                self.powerup_of[rid] = code

    def doc(self, rid):
        if rid not in self._docs:
            row = self.src.execute('SELECT doc FROM quanta WHERE _id = ?', (rid,)).fetchone()
            self._docs[rid] = json.loads(row[0]) if row and row[0] else None
        return self._docs[rid]

    def name(self, rid):
        d = self.doc(rid)
        return plain(d.get('key')).strip() if d else ''

    def rows(self, rid, d):
        """Every index row for Rem `rid`; `names` collects Rems whose name must be kept."""
        # props/refs belong to this Rem; host_props/host_refs to the Rem this one is a
        # property value of (its parent), when it is a hidden property child. A child
        # can have slots of its own (card priority on a property child), which stay its.
        out = {'rem': None, 'tags': [], 'powerups': set(), 'props': [], 'refs': [], 'names': {},
               'host_props': [], 'host_refs': []}
        if not d:
            return out
        if isinstance(d.get('rcrt'), str):  # a powerup Rem, new or renamed
            self.powerup_of[rid] = d['rcrt']
        key, value = d.get('key'), d.get('value')
        edited = max([v for v in (d.get('key,u'), d.get('value,u')) if isinstance(v, (int, float))] or [0]) or None
        dci = d.get('dci')
        out['rem'] = (rid, d.get('parent'), d.get('type'), d.get('createdAt'), edited,
                      int(bool(d.get('forget'))), int(bool(d.get('efc'))), int(bool(d.get('enableBackSR'))),
                      json.dumps([str(x) for x in dci]) if isinstance(dci, list) and dci else None,
                      d.get('vt') if isinstance(d.get('vt'), int) else None, 0,
                      d.get('src') if isinstance(d.get('src'), str) else None)

        for tag, entry in (d.get('tp') or {}).items():
            if not (isinstance(entry, dict) and entry.get('t')):
                continue
            if tag in self.powerup_of:
                out['powerups'].add(self.powerup_of[tag])
            else:
                out['tags'].append(tag)
                out['names'][tag] = None
        for code in (d.get('apu') or {}):
            out['powerups'].add(code)

        for target in ref_ids(key) + ref_ids(value):
            out['refs'].append((target, 'text'))
            out['names'][target] = None

        for slot_key, entry in (d.get('ps') or {}).items():
            code, _, slot = slot_key.partition('_')
            val = (entry or {}).get('v') if isinstance(entry, dict) else None
            if not isinstance(val, dict) or not slot:
                continue
            self._prop(out, code, slot, None, val.get('s'), val.get('v'), entry.get(',u'))
        for code, slots in (d.get('bpc') or {}).items():
            if not isinstance(slots, dict):
                continue
            for slot, val in slots.items():
                if isinstance(val, dict) and (val.get('s') is not None or val.get('v') is not None):
                    if any(p[0] == squash(code) and p[1] == squash(slot) for p in out['props']):
                        continue  # the new storage already gave it
                    self._prop(out, code, slot, None, val.get('s'), val.get('v'), d.get('bpc,u'))

        # A user property: a hidden child whose key is one reference to the property Rem.
        if d.get('ie') and isinstance(key, list) and len(key) == 1 and isinstance(key[0], dict) \
                and key[0].get('i') == 'q' and d.get('parent'):
            prop_id = key[0].get('_id')
            prop_doc = self.doc(prop_id)
            if prop_doc is not None:
                tag = prop_doc.get('parent')
                # A powerup's property child: filed under the powerup's code, so it pairs
                # with any `ps` copy of the same slot; the newer one counts (rem_search).
                tag_name = self.powerup_of.get(tag) or (self.name(tag) if tag else '')
                out['host'] = d['parent']
                out['names'][prop_id] = None
                self._prop(out, tag_name, self.name(prop_id), prop_id, None, value, d.get('value,u') or d.get('u'),
                           host=True)
        return out

    def _prop(self, out, owner, name, prop_id, text, rich, at=None, host=False):
        targets = ref_ids(rich)
        if text is None:
            text = plain(rich, {t: self.name(t) for t in targets})
        text = fold(str(text))[:MAX_TEXT]
        num, day = number_and_day(text)
        owner, name = squash(owner), squash(name)
        out['host_props' if host else 'props'].append(
            (owner, name, prop_id, text, num, day, at if isinstance(at, (int, float)) else 0))
        kind = 'source' if (owner, name) == SOURCES else 'value'
        for t in targets:
            out['host_refs' if host else 'refs'].append((t, kind))
            if kind == 'source':
                out['names'][t] = None


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------

def _forget(db, ids):
    """Drop every row the documents of `ids` produced."""
    for chunk in range(0, len(ids), 500):
        part = ids[chunk:chunk + 500]
        marks = ','.join('?' * len(part))
        for table, col in (('rems', 'id'), ('rem_tags', 'rem'), ('rem_powerups', 'rem'), ('props', 'src'), ('refs', 'src')):
            db.execute(f'DELETE FROM {table} WHERE {col} IN ({marks})', part)


def _write(db, reader, docs, fresh=False):
    """Index (id, doc) pairs, replacing the rows their documents produced before. A
    user property's value is filed under the Rem it belongs to (the child's parent)."""
    ids = [rid for rid, _ in docs]
    if not fresh:
        _forget(db, ids)
    names = {}
    for rid, d in docs:
        rows = reader.rows(rid, d)
        if rows['rem']:
            db.execute('INSERT OR REPLACE INTO rems VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', rows['rem'])
        host = rows.get('host')
        db.executemany('INSERT INTO rem_tags VALUES (?, ?)', [(rid, t) for t in rows['tags']])
        db.executemany('INSERT INTO rem_powerups VALUES (?, ?)', [(rid, c) for c in rows['powerups']])
        db.executemany('INSERT INTO props VALUES (?,?,?,?,?,?,?,?,?)',
                       [(rid, rid, *p) for p in rows['props']] + [(host, rid, *p) for p in rows['host_props']])
        db.executemany('INSERT INTO refs VALUES (?,?,?,?)',
                       [(rid, rid, t, k) for t, k in rows['refs']] + [(host, rid, t, k) for t, k in rows['host_refs']])
        names.update(rows['names'])
    # Names of tags and properties, and of any already-named Rem that changed (a rename).
    renamed = set()
    if not fresh:
        for chunk in range(0, len(ids), 500):
            part = ids[chunk:chunk + 500]
            renamed.update(r[0] for r in db.execute(f'SELECT id FROM names WHERE id IN ({",".join("?" * len(part))})', part))
    for rid in set(names) | renamed:
        db.execute('INSERT OR REPLACE INTO names VALUES (?, ?)', (rid, fold(reader.name(rid))))


BUILD_BATCH = 5000


def mark_tables_all(db):
    """in_table for every Rem: it is a table (vt = 1) or sits under one."""
    parent, table = {}, set()
    for rid, par, vt in db.execute('SELECT id, parent, vt FROM rems'):
        parent[rid] = par
        if vt == 1:
            table.add(rid)
    memo = {}

    def inside(rid):
        chain = []
        while rid is not None and rid not in memo and len(chain) < 200:
            if rid in table:
                memo[rid] = True
                break
            chain.append(rid)
            rid = parent.get(rid)
        result = memo.get(rid, False) if rid is not None else False
        for r in chain:
            memo[r] = result
        return result

    hits = [rid for rid in parent if inside(rid)]
    db.execute('UPDATE rems SET in_table = 0')
    for chunk in range(0, len(hits), 500):
        part = hits[chunk:chunk + 500]
        db.execute(f'UPDATE rems SET in_table = 1 WHERE id IN ({",".join("?" * len(part))})', part)
    return len(hits)


def mark_tables(db, ids):
    """in_table for re-read Rems, walking up through the index's parents."""
    for rid in ids:
        cur, inside, hops = rid, 0, 0
        while cur is not None and hops < 200:
            row = db.execute('SELECT parent, vt FROM rems WHERE id = ?', (cur,)).fetchone()
            if not row:
                break
            if row[1] == 1:
                inside = 1
                break
            cur, hops = row[0], hops + 1
        db.execute('UPDATE rems SET in_table = ? WHERE id = ?', (inside, rid))

# RemNote's QueueInteractionScore (bundle enum, 1.30.2-beta).
ANSWERS = {0: 'forgot', 0.5: 'hard', 1: 'good', 1.5: 'easy'}
RESET = 3
DAY_MS = 86_400_000


def counts_for_main_card(rep):
    """As src/lib/fsrs.ts: a partial list/set rep doesn't count for the main card."""
    if rep.get('score') == RESET:
        return True
    if rep.get('isFullMultiLineRep') is not None:
        return bool(rep['isFullMultiLineRep'])
    return not rep.get('subCardScores')


def card_rows(cid, d, sched=None):
    """(card row, [rep rows]) for one card document. `sched` is (scheduler id, type,
    weights) of the card's scheduler; an FSRS one gets the memory state."""
    history = sorted((r for r in (d.get('h') or []) if isinstance(r, dict) and isinstance(r.get('date'), (int, float))),
                     key=lambda r: r['date'])
    reps = lapses = 0
    first = None
    for r in history:
        score = r.get('score')
        if score == RESET:
            reps = lapses = 0
            continue
        if score in ANSWERS and counts_for_main_card(r):
            reps += 1
            lapses += score == 0
            first = r['date'] if first is None else first
    c = d.get('c')
    kind = 'forward' if c == 'f' else 'backward' if c == 'b' else 'cloze'
    nxt = d.get('a') if isinstance(d.get('a'), (int, float)) else None
    last = d.get('l') if isinstance(d.get('l'), (int, float)) else None
    ivl = round((nxt - last) / DAY_MS) if nxt is not None and last is not None else None
    sid, stype, weights = sched or (None, None, None)
    mem = fsrs.replay(history, weights) if stype == 'fsrs' else None
    row = (cid, d.get('rId'), kind, None if kind != 'cloze' else str(c), nxt, day_of_ms(nxt) if nxt is not None else None, last, ivl, d.get('ml'),
           int(bool(d.get('ny'))), int(bool(d.get('b'))), d.get('e'), reps, lapses, first,
           sid, mem['s'] if mem else None, mem['d'] if mem else None,
           fsrs.decay_of(weights) if mem else None, mem['last'] if mem else None)
    rep_rows = [(cid, d.get('rId'), r['date'], r.get('score')) for r in history]
    return row, rep_rows


class Schedulers:
    """Each card's scheduler: the `src` of its Rem or nearest ancestor, else the Global
    Default. `parent_src(rid)` gives (parent, src) of a Rem; resolutions are memoised."""

    def __init__(self, table, global_id, parent_src):
        self.table = table  # id → (type, weights)
        self.global_id = global_id
        self.parent_src = parent_src
        self.memo = {}

    def of_rem(self, rid):
        path, current, found = [], rid, None
        while current and len(path) < 1000:
            if current in self.memo:
                found = self.memo[current]
                break
            path.append(current)
            parent, src = self.parent_src(current)
            if src:
                found = src
                break
            current = parent
        for p in path:
            self.memo[p] = found
        sid = found if found in self.table else self.global_id
        stype, weights = self.table.get(sid, (None, None))
        return sid, stype, weights


GLOBAL_SCHEDULER_KEY = 'spacedRepetitionSchedulerIdKb'


def read_schedulers(src):
    """({id: (type, weights)}, global id, rows for the schedulers table, a hash)."""
    table, rows = {}, []
    try:
        scheduler_rows = src.execute('SELECT _id, doc FROM spaced_repetition_scheduler').fetchall()
        kb_rows = src.execute('SELECT doc FROM knowledge_base_data').fetchall()
    except sqlite3.OperationalError:  # a database without them: no memory state
        scheduler_rows, kb_rows = [], []
    for sid, doc in scheduler_rows:
        d = json.loads(doc) if doc else {}
        weights = d.get('w') if isinstance(d.get('w'), list) else None
        table[sid] = (d.get('st'), weights)
        rows.append((sid, d.get('n') or '', d.get('st'), json.dumps(weights) if weights else None, d.get('tr')))
    global_id = None
    for (doc,) in kb_rows:
        entry = json.loads(doc) if doc else {}
        if entry.get('key') == GLOBAL_SCHEDULER_KEY:
            global_id = entry.get('value')
    digest = json.dumps([sorted(rows), global_id], sort_keys=True)
    return table, global_id, rows, digest


def _store_schedulers(db, rows, global_id, digest):
    db.execute('DELETE FROM schedulers')
    db.executemany('INSERT INTO schedulers VALUES (?,?,?,?,?)', rows)
    set_meta(db, 'global_scheduler', global_id or '')
    set_meta(db, 'scheduler_hash', digest)


def _index_parent_src(db):
    def lookup(rid):
        row = db.execute('SELECT parent, src FROM rems WHERE id = ?', (rid,)).fetchone()
        return (row[0], row[1]) if row else (None, None)
    return lookup


def _recompute_cards(db, src, sched, rem_ids=None):
    """Re-read and rewrite cards (all, or those of `rem_ids`), e.g. after their
    scheduler changed."""
    if rem_ids is None:
        rows = src.execute('SELECT _id, doc FROM cards').fetchall()
    else:
        rows = []
        ids = list(rem_ids)
        for chunk in range(0, len(ids), 500):
            part = ids[chunk:chunk + 500]
            rows += src.execute(f"SELECT _id, doc FROM cards WHERE json_extract(doc, '$.rId') IN "
                                f"({','.join('?' * len(part))})", part).fetchall()
    _write_cards(db, [(cid, json.loads(doc) if doc else None) for cid, doc in rows], sched=sched)
    return len(rows)


def _write_cards(db, docs, fresh=False, sched=None):
    if not fresh:
        ids = [cid for cid, _ in docs]
        for chunk in range(0, len(ids), 500):
            part = ids[chunk:chunk + 500]
            marks = ','.join('?' * len(part))
            db.execute(f'DELETE FROM cards WHERE id IN ({marks})', part)
            db.execute(f'DELETE FROM reps WHERE card IN ({marks})', part)
    for cid, d in docs:
        if not d:
            continue
        row, rep_rows = card_rows(cid, d, sched.of_rem(d.get('rId')) if sched else None)
        db.execute('INSERT OR REPLACE INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', row)
        db.executemany('INSERT INTO reps VALUES (?,?,?,?)', rep_rows)


def build(kb_id, db_path=None, index_file=None):
    """Rebuild the index from scratch, in one read transaction, into a new file that
    replaces the old one only when complete (a format change needs new tables, and a
    search must never see half an index). Returns a summary."""
    started = time.time()
    src_path = Path(db_path) if db_path else history_archive.remnote_db_path(kb_id)
    path = Path(index_file) if index_file else index_path(kb_id)
    tmp = path.with_name(path.name + '.building')
    src = history_archive.open_remnote(src_path)
    with _locks[kb_id]:
        for leftover in (tmp, Path(f'{tmp}-wal'), Path(f'{tmp}-shm')):
            leftover.unlink(missing_ok=True)
        db = open_index(kb_id, tmp)
        try:
            src.execute('BEGIN')
            reader = Reader(src)
            db.execute('BEGIN')
            high = 0
            batch, total = [], 0
            for rid, doc, y in src.execute("SELECT _id, doc, json_extract(doc, '$.y') FROM quanta"):
                if not doc:
                    continue
                batch.append((rid, json.loads(doc)))
                if isinstance(y, (int, float)):
                    high = max(high, y)
                if len(batch) >= BUILD_BATCH:
                    _write(db, reader, batch, fresh=True)
                    total += len(batch)
                    batch = []
            _write(db, reader, batch, fresh=True)
            total += len(batch)
            mark_tables_all(db)
            table, global_id, sched_rows, digest = read_schedulers(src)
            _store_schedulers(db, sched_rows, global_id, digest)
            parent_src = {rid: (par, sid) for rid, par, sid in db.execute('SELECT id, parent, src FROM rems')}
            sched = Schedulers(table, global_id, lambda rid: parent_src.get(rid, (None, None)))
            card_high, cards = 0, []
            for cid, doc, y in src.execute("SELECT _id, doc, json_extract(doc, '$.y') FROM cards"):
                if doc:
                    cards.append((cid, json.loads(doc)))
                    if isinstance(y, (int, float)):
                        card_high = max(card_high, y)
                if len(cards) >= BUILD_BATCH:
                    _write_cards(db, cards, fresh=True, sched=sched)
                    cards = []
            _write_cards(db, cards, fresh=True, sched=sched)
            set_meta(db, 'card_watermark', int(card_high))
            for rid, code in reader.powerup_of.items():
                db.execute('INSERT OR REPLACE INTO powerups VALUES (?, ?, ?)', (code, rid, fold(reader.name(rid))))
            set_meta(db, 'schema', SCHEMA_VERSION)
            set_meta(db, 'watermark', int(high))
            set_meta(db, 'built_at', int(time.time() * 1000))
            db.execute('COMMIT')
            src.execute('COMMIT')
            db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            db.close()
            db = None
            for stale in (Path(f'{path}-wal'), Path(f'{path}-shm')):
                stale.unlink(missing_ok=True)
            os.replace(tmp, path)
            Path(f'{tmp}-wal').unlink(missing_ok=True)
            Path(f'{tmp}-shm').unlink(missing_ok=True)
            _last_sweep[kb_id] = time.time()
            return {'rems': total, 'ms': int((time.time() - started) * 1000)}
        finally:
            if db is not None:
                db.close()
            src.close()


def _subtree(db, rem_ids):
    """The Rems and every Rem below them, from the index's parents."""
    ids = list(rem_ids)
    if not ids:
        return set()
    marks = ','.join('?' * len(ids))
    return {r[0] for r in db.execute(
        f"""WITH RECURSIVE sub(id) AS (SELECT id FROM rems WHERE id IN ({marks})
                UNION SELECT r.id FROM rems r JOIN sub ON r.parent = sub.id)
            SELECT id FROM sub""", ids)}


def refresh(db, kb_id, src):
    """Bring an open index up to date from the given remnote.db connection `src`.

    Order matters for the cards' schedulers: Rems first (a moved Rem, or one given
    another scheduler, changes the scheduler of every card below it), then the cards
    that changed, then the cards below such Rems; a change to a scheduler itself (new
    weights) recomputes every card (~1.4 s, rare)."""
    with _locks[kb_id]:
        mark = int(meta(db, 'watermark', '0') or 0)
        changed = src.execute(
            "SELECT _id, doc, json_extract(doc, '$.y') FROM quanta WHERE json_extract(doc, '$.y') > ?",
            (mark - OVERLAP_MS,)).fetchall()
        card_mark = int(meta(db, 'card_watermark', '0') or 0)
        changed_cards = src.execute(
            "SELECT _id, doc, json_extract(doc, '$.y') FROM cards WHERE json_extract(doc, '$.y') > ?",
            (card_mark - OVERLAP_MS,)).fetchall()
        table, global_id, sched_rows, digest = read_schedulers(src)
        schedulers_changed = digest != meta(db, 'scheduler_hash')

        db.execute('BEGIN')
        moved = set()
        if changed:
            ids = [rid for rid, _, _ in changed]
            before = {}
            for chunk in range(0, len(ids), 500):
                part = ids[chunk:chunk + 500]
                for rid, par, sid in db.execute(
                        f'SELECT id, parent, src FROM rems WHERE id IN ({",".join("?" * len(part))})', part):
                    before[rid] = (par, sid)
            reader = Reader(src, {rid: code for code, rid in db.execute('SELECT code, rem FROM powerups')})
            docs, high = [], mark
            for rid, doc, y in changed:
                d = json.loads(doc) if doc else None
                docs.append((rid, d))
                if isinstance(y, (int, float)):
                    high = max(high, int(y))
                if d:
                    now = (d.get('parent'), d.get('src') if isinstance(d.get('src'), str) else None)
                    if rid in before and before[rid] != now:
                        moved.add(rid)
            _write(db, reader, docs)
            mark_tables(db, [rid for rid, d in docs if d])
            for rid, code in reader.powerup_of.items():
                db.execute('INSERT OR REPLACE INTO powerups VALUES (?, ?, ?)', (code, rid, fold(reader.name(rid))))
            set_meta(db, 'watermark', high)

        if schedulers_changed:
            _store_schedulers(db, sched_rows, global_id, digest)
        sched = Schedulers(table, global_id, _index_parent_src(db))
        if changed_cards:
            docs, high = [], card_mark
            for cid, doc, y in changed_cards:
                docs.append((cid, json.loads(doc) if doc else None))
                if isinstance(y, (int, float)):
                    high = max(high, int(y))
            _write_cards(db, docs, sched=sched)
            set_meta(db, 'card_watermark', high)
        recomputed = 0
        if schedulers_changed:
            recomputed = _recompute_cards(db, src, sched)
        elif moved:
            recomputed = _recompute_cards(db, src, sched, _subtree(db, moved))
        db.execute('COMMIT')

        swept = 0
        if time.time() - _last_sweep.get(kb_id, 0) > DELETION_SWEEP_S:
            live = {r[0] for r in src.execute('SELECT _id FROM quanta')}
            gone = [r[0] for r in db.execute('SELECT id FROM rems') if r[0] not in live]
            live_cards = {r[0] for r in src.execute('SELECT _id FROM cards')}
            gone_cards = [r[0] for r in db.execute('SELECT id FROM cards') if r[0] not in live_cards]
            if gone or gone_cards:
                db.execute('BEGIN')
                _forget(db, gone)
                _write_cards(db, [(cid, None) for cid in gone_cards])
                db.execute('COMMIT')
            swept = len(gone) + len(gone_cards)
            _last_sweep[kb_id] = time.time()
        return {'changed': len(changed) + len(changed_cards), 'recomputed': recomputed, 'deleted': swept}


_building = set()
_building_lock = threading.Lock()


def needs_build(kb_id, index_file=None):
    path = Path(index_file) if index_file else index_path(kb_id)
    if not path.exists():
        return True
    # Read only the version: running the schema on an older index can fail (an
    # index on a column that file doesn't have yet), and the file is rebuilt anyway.
    try:
        probe = sqlite3.connect(f'file:{path}?mode=ro', uri=True, timeout=30)
        try:
            row = probe.execute("SELECT v FROM meta WHERE k = 'schema'").fetchone()
        finally:
            probe.close()
    except sqlite3.Error:
        return True
    return not row or row[0] != SCHEMA_VERSION


def build_in_background(kb_id, db_path=None, index_file=None, log=print):
    """Start a build unless one is running for this KB. Returns True if it started."""
    with _building_lock:
        if kb_id in _building:
            return False
        _building.add(kb_id)

    def run():
        try:
            out = build(kb_id, db_path, index_file)
            log(f'[search] index of {kb_id[:8]}… built: {out["rems"]} Rems in {out["ms"]} ms')
        except Exception as e:  # noqa: BLE001 — a failed build is retried by the next search
            log(f'[search] index of {kb_id[:8]}… failed: {e}')
        finally:
            with _building_lock:
                _building.discard(kb_id)

    threading.Thread(target=run, name=f'rem-index-{kb_id[:8]}', daemon=True).start()
    return True


def is_building(kb_id):
    with _building_lock:
        return kb_id in _building


def warm_known_kbs(log=print, delay_s=90):
    """Build, in the background, the index of every KB the helper has heard from and
    that has none (or an outdated one), so the first search doesn't wait for it."""
    def run():
        time.sleep(delay_s)
        for kb_id in history_archive.known_kbs():
            try:
                if history_archive.remnote_db_path(kb_id).exists() and needs_build(kb_id):
                    build_in_background(kb_id, log=log)
            except Exception as e:  # noqa: BLE001
                log(f'[search] could not check the index of {kb_id[:8]}…: {e}')

    threading.Thread(target=run, name='rem-index-warm', daemon=True).start()


def ready(kb_id, db_path=None, index_file=None):
    """An index connection, built if missing, refreshed, with remnote.db attached as `rn`."""
    src_path = Path(db_path) if db_path else history_archive.remnote_db_path(kb_id)
    path = Path(index_file) if index_file else index_path(kb_id)
    if needs_build(kb_id, path):
        build(kb_id, src_path, path)
    db = open_index(kb_id, path)
    attach_remnote(db, src_path)
    src = history_archive.open_remnote(src_path)
    try:
        refresh(db, kb_id, src)
    finally:
        src.close()
    return db


def rems_with_source(db, source_id, incremental_only=False):
    """Rems whose Sources slot lists `source_id`, from an open, refreshed index. Unlike
    a search it doesn't go through RemNote's search index, which lags behind new Rems."""
    sql = "SELECT DISTINCT rem FROM refs WHERE target = ? AND kind = 'source'"
    if incremental_only:
        sql += " AND rem IN (SELECT rem FROM rem_powerups WHERE code = 'incremental')"
    return [r[0] for r in db.execute(sql, (source_id,))]


def status(kb_id, index_file=None):
    path = Path(index_file) if index_file else index_path(kb_id)
    if not path.exists():
        return {'built': False}
    db = open_index(kb_id, path)
    try:
        counts = {t: db.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0]
                  for t in ('rems', 'rem_tags', 'rem_powerups', 'props', 'refs', 'names', 'cards', 'reps')}
        return {'built': True, 'builtAt': int(meta(db, 'built_at', 0)), 'watermark': int(meta(db, 'watermark', 0)),
                'bytes': path.stat().st_size, **counts}
    finally:
        db.close()


def main():
    ap = argparse.ArgumentParser(description='The search helper\'s index of a RemNote knowledge base.')
    ap.add_argument('--kb', required=True)
    ap.add_argument('--db', help='a remnote.db to read instead of the KB\'s own')
    ap.add_argument('command', choices=['build', 'status'])
    args = ap.parse_args()
    out = build(args.kb, args.db) if args.command == 'build' else status(args.kb)
    print(json.dumps(out, indent=2))


if __name__ == '__main__':
    main()
