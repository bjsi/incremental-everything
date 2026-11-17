#!/usr/bin/env python3
"""Tests for rem_search.py and rem_index.py: the parser, and searches on a small fake
remnote.db shaped like RemNote's (the search index remsContents FTS5, remsSearchInfos,
remsSearchRanks, and the Rem documents in quanta).

    python3 scripts/test_rem_search.py
"""
import datetime
import json
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rem_index as ri  # noqa: E402
import rem_search as rs  # noqa: E402
import rem_browse as rb  # noqa: E402
import fsrs  # noqa: E402
from rem_search import And, Not, Or, SearchError, Term  # noqa: E402

KB = '0123456789abcdef01234567'


def ids(n):
    """A 17-character Rem id."""
    return f'{n:0>17}'


ROOT, BOOK, BOW, FLARE, MARGIN, OTHER, ARCHIVE, DUP1, DUP2 = (ids(f'R{i}') for i in range(9))
# One Rem per suppression cause (see suppressed:)
DISABLER, UNDER_U, TABLE, ROW, DIR, CLZ = (ids(f'S{i}') for i in range(6))
SUPPRESSION_FIXTURE = {DISABLER, UNDER_U, TABLE, ROW, DIR, CLZ}

# id, aliasId, parent, ancestors (root first), indexed text, raw text, is document
ROWS = [
    (ROOT, ROOT, None, [], 'pscpp', 'pscpp', True),
    (BOOK, BOOK, ROOT, [ROOT], 'wartsila encyclopedia of ship technology', 'wartsila encyclopedia of ship technology', True),
    (BOW, BOW, BOOK, [ROOT, BOOK], 'bow flare', 'bow flare', False),
    # A reference is indexed at the END: "[sea margin] becomes useless" → "… becomes useless … sea margin".
    (FLARE, FLARE, BOW, [ROOT, BOOK, BOW],
     'ships with an excessive bow flare are exposed to higher sea loads . becomes useless in heavy weather due to wave impact . sea margin',
     'ships with an excessive bow flare are exposed to higher sea loads. sea margin becomes useless in heavy weather due to wave impact.',
     False),
    (MARGIN, MARGIN, ROOT, [ROOT], 'service power margin margem de seguranca', 'service power margin', False),
    (MARGIN, ids('ALIAS'), ROOT, [ROOT], 'sea margin margem de seguranca', 'sea margin', False),
    (OTHER, OTHER, ROOT, [ROOT], 'the tug pushes the bow in heavy weather', 'the tug pushes the bow in heavy weather', False),
    (ARCHIVE, ARCHIVE, None, [], 'archive', 'archive', True),
    (DUP1, DUP1, ROOT, [ROOT], 'notes', 'notes', False),
    (DUP2, DUP2, ARCHIVE, [ARCHIVE], 'notes', 'notes', False),
    (DISABLER, DISABLER, ROOT, [ROOT], 'old deck', 'old deck', False),
    (UNDER_U, UNDER_U, DISABLER, [ROOT, DISABLER], 'card under it', 'card under it', False),
    (TABLE, TABLE, ROOT, [ROOT], 'a table', 'a table', False),
    (ROW, ROW, TABLE, [ROOT, TABLE], 'a row', 'a row', False),
    (DIR, DIR, ROOT, [ROOT], 'one way only', 'one way only', False),
    (CLZ, CLZ, ROOT, [ROOT], 'a cloze switched off', 'a cloze switched off', False),
]


NOW = int(datetime.datetime.now().timestamp() * 1000)
DAY = 86_400_000
TAG, PW_INC, PW_SRC, PROP_BOOK, PROP_NEXT, CHILD_BOOK, CHILD_NEXT, DAILY_OLD, DAILY_NEW = (
    ids(f'X{i}') for i in range(9))


def slot(text, at, rich=None):
    return {'v': {'v': rich if rich is not None else [text], 's': text}, ',u': at}


def date_name(days_from_today):
    d = datetime.date.today() + datetime.timedelta(days=days_from_today)
    return f"{d.strftime('%B')} {d.day}th, {d.year}"


# Rem documents (quanta), as RemNote stores them.
DOCS = {
    BOOK: {'key': ['Wärtsilä Encyclopedia of Ship Technology'], 'createdAt': NOW - 400 * DAY},
    BOW: {'key': ['Bow flare'], 'type': 1, 'createdAt': NOW - 300 * DAY,
          'tp': {TAG: {'t': True}}, 'src': 'VOCAB'},
    FLARE: {'key': ['Ships with … ', {'i': 'q', '_id': MARGIN, 'aliasId': ids('ALIAS')}, ' becomes useless'],
            'createdAt': NOW - 300 * DAY, 'key,u': NOW - 2 * 3600_000,
            'ps': {'os_os': slot('Wärtsilä Encyclopedia of Ship Technology', 1, [{'i': 'q', '_id': BOOK}])}},
    MARGIN: {'key': ['Service power margin'], 'type': 1, 'createdAt': NOW - 3600_000,
             # Card priority: the hidden slot (30) wins over the visible one (90).
             'bpc': {'cardPriority': {'priority': {'v': ['90'], 's': '90'}}},
             'al': [{'aliasId': ids('ALIAS'), 'alias': 'sea margin'}],
             'tp': {PW_INC: {'t': True}},
             # An old `ps` copy of the slot, and a newer one in a property child (below).
             'ps': {'cardPriority_priorityValue': slot('30', NOW - DAY),
                    'incremental_nextRepDate': slot(date_name(30), NOW - 100 * DAY),
                    'incremental_priority': slot('20', NOW - DAY)}},
    OTHER: {'key': ['The tug pushes the bow'], 'type': 2, 'createdAt': NOW - 500 * DAY, 'tp': {TAG: {'t': False}}},
    TAG: {'key': ['Anki Card'], 'createdAt': 1},
    PW_INC: {'key': ['Incremental'], 'rcrt': 'incremental', 'createdAt': 1},
    PROP_BOOK: {'key': ['Book'], 'parent': TAG, 'createdAt': 1},
    PROP_NEXT: {'key': ['Next Rep Date'], 'parent': PW_INC, 'createdAt': 1},
    CHILD_BOOK: {'key': [{'i': 'q', '_id': PROP_BOOK}], 'value': ['PNA Resistência'], 'ie': True, 'parent': BOW,
                 'createdAt': 1,
                 # A property child with a card priority of its own: it stays the child's.
                 'ps': {'cardPriority_priorityValue': slot('77', 1)}},
    CHILD_NEXT: {'key': [{'i': 'q', '_id': PROP_NEXT}], 'value': [{'i': 'q', '_id': DAILY_OLD}], 'ie': True,
                 'parent': MARGIN, 'createdAt': 1, 'value,u': NOW - 5 * DAY},
    DAILY_OLD: {'key': [date_name(-3)], 'createdAt': 1},
    DAILY_NEW: {'key': [date_name(10)], 'createdAt': 1},
}


# Cards: (card id, Rem, type, next time, last, history [(days ago, score)], extra fields)
C_DUE, C_NEW, C_CLOZE, C_OFF, C_GONE, C_PAUSED = (ids(f'C{i}') for i in range(6))


def hist(*entries):
    return [{'date': NOW - days * DAY, 'score': score} for days, score in entries]


CARDS = {
    C_DUE: dict(rId=BOW, c='f', a=NOW - 2 * DAY, l=NOW - 12 * DAY, ml='Growing',
                h=hist((40, 0), (30, 1), (12, 0), (0.1, 1.5))),
    C_NEW: dict(rId=BOW, c='b', a=NOW + 5 * DAY, l=None, ml='New', h=[]),
    C_CLOZE: dict(rId=FLARE, c='29128728391275505', a=NOW - DAY, l=NOW - 20 * DAY, ml='Retaining',
                  h=hist((60, 0), (50, 3), (20, 1))),  # a Reset clears the earlier Forgot
    C_OFF: dict(rId=OTHER, c='f', a=None, l=NOW - 99 * DAY, ml='Retaining', h=hist((99, 1)), ny=True),
    C_GONE: dict(rId=OTHER, c='123', a=None, l=None, ml='New', h=hist((5, 1)), b=True),
    C_PAUSED: dict(rId=DUP2, c='f', a=NOW - DAY, l=NOW - 9 * DAY, ml='Growing', h=hist((9, 1))),
}
CARDS.update({
    ids('C6'): dict(rId=UNDER_U, c='f', a=None, l=None, ml='New', h=[]),
    ids('C7'): dict(rId=ROW, c='f', a=None, l=None, ml='New', h=[]),
    ids('C8'): dict(rId=DIR, c='f', a=None, l=None, ml='New', h=[]),
    ids('C9'): dict(rId=DIR, c='b', a=NOW - DAY, l=None, ml='New', h=[]),  # its backward card is fine
    ids('CA'): dict(rId=CLZ, c='777', a=None, l=None, ml='New', h=[]),
    ids('CB'): dict(rId=CLZ, c='888', a=NOW - DAY, l=None, ml='New', h=[]),
})
DOCS.update({
    DISABLER: {'key': ['old deck'], 'createdAt': 1, 'apu': {'u': {'v': True}}},
    UNDER_U: {'key': ['card under it'], 'parent': DISABLER, 'createdAt': 1},
    TABLE: {'key': ['a table'], 'parent': ROOT, 'createdAt': 1, 'vt': 1},
    ROW: {'key': ['a row'], 'parent': TABLE, 'createdAt': 1, 'forget': True},
    DIR: {'key': ['one way only'], 'parent': ROOT, 'createdAt': 1, 'efc': True, 'enableBackSR': True},
    CLZ: {'key': ['a cloze switched off'], 'parent': ROOT, 'createdAt': 1, 'dci': ['777']},
    DUP2: {'key': ['notes'], 'parent': ARCHIVE, 'createdAt': 1},
    ROOT: {'key': ['PSCPP'], 'createdAt': 1},
})
# ARCHIVE is a paused deck: DUP2 (under it) is paused.
DOCS[ARCHIVE] = {'key': ['Archive'], 'createdAt': 1, 'ps': {'de_s': slot('Paused', 1)}, 'apu': {'de': {'v': True}},
                 'src': 'QS'}


OPTIMIZED = [3.973, 13.618, 43.322, 100, 7.011, 0.46, 2.096, 0.15, 2.5, 0.27, 1.081, 1.601, 0.068, 0.504, 1.387,
             0.011, 3, 0.546, 0.08, 0.066, 0.118]
# Schedulers: the Global Default (FSRS, optimised), Vocabulary (FSRS, default weights)
# on BOW's subtree, Questions (SM-2) on ARCHIVE's.
SCHEDULERS = {
    'GLOB': {'n': '', 'st': 'fsrs', 'w': OPTIMIZED, 'tr': 0.9},
    'VOCAB': {'n': 'Vocabulary', 'st': 'fsrs', 'tr': 0.9},
    'QS': {'n': 'Questions', 'st': 'sm2'},
}


def put_scheduler(db, sid, doc):
    db.execute('INSERT OR REPLACE INTO spaced_repetition_scheduler VALUES (?, ?)', (sid, json.dumps(doc)))


# Real Rem records carry their parent; take it from the search rows where missing.
for _rid, _alias, _parent, *_ in ROWS:
    if _rid == _alias and _rid in DOCS and _parent and 'parent' not in DOCS[_rid]:
        DOCS[_rid]['parent'] = _parent


def put_card(db, cid, card, y):
    db.execute('INSERT OR REPLACE INTO cards VALUES (?, ?, ?)', (cid, json.dumps({'_id': cid, 'y': y, **card}), 0))


def put_doc(db, rid, doc, y):
    db.execute('INSERT OR REPLACE INTO quanta VALUES (?, ?, ?)', (rid, json.dumps({'_id': rid, 'y': y, **doc}), 0))


def make_db(path):
    db = sqlite3.connect(path)
    db.executescript('''
        CREATE TABLE quanta (_id TEXT NOT NULL PRIMARY KEY, doc TEXT, x INTEGER);
        CREATE TABLE cards (_id TEXT NOT NULL PRIMARY KEY, doc TEXT, x INTEGER);
        CREATE TABLE spaced_repetition_scheduler (_id TEXT PRIMARY KEY, doc TEXT);
        CREATE TABLE knowledge_base_data (_id TEXT PRIMARY KEY, doc TEXT);
        CREATE VIRTUAL TABLE remsContents USING FTS5(data, tokenize = 'unicode61', prefix = '1 2 3');
        CREATE TABLE remsSearchInfos(ftsRowId INTEGER PRIMARY KEY AUTOINCREMENT, aliasId TEXT NOT NULL,
            id TEXT NOT NULL, doc TEXT NOT NULL, freqCounter REAL NOT NULL, freqTime REAL NOT NULL,
            ancestor_not_ref_text, ancestor_ref_text, ancestor_ids);
        CREATE TABLE remsSearchRanks(ftsRowId INTEGER PRIMARY KEY, rank REAL);
    ''')
    names = {r[0]: r[5] for r in ROWS if r[0] == r[1]}
    for n, (rid, alias, parent, anc, text, raw, is_doc) in enumerate(ROWS, start=1):
        doc = {'_id': rid, 'a': alias, 'p': parent, 'r': raw, 'i': is_doc, 'l': False}
        db.execute('INSERT INTO remsSearchInfos VALUES (?,?,?,?,0,0,?,?,?)',
                   (n, alias, rid, json.dumps(doc), '  ' + '  '.join(names[a] for a in anc), '',
                    ' ' + ''.join(f' {a}' for a in anc)))
        db.execute('INSERT INTO remsContents(rowid, data) VALUES (?, ?)', (n, text))
        db.execute('INSERT INTO remsSearchRanks VALUES (?, ?)', (n, n * 10))
    for rid, doc in DOCS.items():
        put_doc(db, rid, doc, NOW - 60_000)
    for cid, card in CARDS.items():
        put_card(db, cid, card, NOW - 60_000)
    for sid, doc in SCHEDULERS.items():
        put_scheduler(db, sid, doc)
    db.execute('INSERT INTO knowledge_base_data VALUES (?, ?)',
               ('k1', json.dumps({'key': 'spacedRepetitionSchedulerIdKb', 'value': 'GLOB'})))
    db.commit()
    db.close()


class ParserTest(unittest.TestCase):
    def test_implicit_and_and_precedence(self):
        tree = rs.parse('dog cat or mouse')
        self.assertIsInstance(tree, Or)
        self.assertIsInstance(tree.nodes[0], And)
        self.assertEqual([t.value for t in tree.nodes[0].nodes], ['dog', 'cat'])
        self.assertEqual(tree.nodes[1].value, 'mouse')

    def test_groups_negation_and_explicit_and(self):
        tree = rs.parse('dog AND -(cat or mouse)')
        self.assertIsInstance(tree, And)
        self.assertIsInstance(tree.nodes[1], Not)
        self.assertIsInstance(tree.nodes[1].node, Or)

    def test_terms(self):
        self.assertEqual(rs.parse('"bow flare"'), Term('text', 'bow flare', mode='phrase', at=0))
        self.assertEqual(rs.parse('w:bow').mode, 'word')
        self.assertTrue(rs.parse('alias:"sea margin"').alias_only)
        self.assertEqual(rs.parse('in:"Wärtsilä Encyclopedia"'), Term('in', 'Wärtsilä Encyclopedia', at=0))
        self.assertEqual(rs.parse('path:pscpp').kind, 'path')

    def test_unknown_key_is_text(self):
        self.assertEqual(rs.parse('3:30'), Term('text', '3:30', at=0))
        self.assertEqual(rs.parse('Note:').kind, 'text')

    def test_escapes(self):
        self.assertEqual(rs.parse(r'\-free').value, '-free')
        self.assertEqual(rs.parse(r'"a \"quoted\" word"').value, 'a "quoted" word')

    def test_errors(self):
        cases = {
            '': 'empty', 'bow (': 'unclosed-group', 'bow )': 'unopened-group', '()': 'empty-group',
            '"bow': 'unclosed-quote', 'or bow': 'misplaced-or', 'bow and': 'misplaced-and',
            '- bow': 'lone-minus', 'sort:due': 'not-yet', 'card:list': 'unknown-value', 'is:bogus': 'unknown-value',
            'ml:old': 'unknown-value', 'rated:0': 'bad-number', 'rated:7:great': 'unknown-value',
            'introduced:7:good': 'unknown-value', 'cid:x': 'bad-id',
            'prop:bogus<3': 'unknown-value', 'has:nothing': 'unknown-value', 'id:short': 'bad-id',
            'added:0': 'bad-number', 'in:': 'missing-value', '...': 'no-words', 'bow\\': 'unknown-escape',
        }
        for query, kind in cases.items():
            with self.subTest(query=query):
                with self.assertRaises(SearchError) as ctx:
                    rs.parse(query)
                self.assertEqual(ctx.exception.kind, kind)

    def test_error_position(self):
        with self.assertRaises(SearchError) as ctx:
            rs.parse('bow (wave')
        self.assertEqual(ctx.exception.at, 4)

    def test_index_terms(self):
        self.assertEqual(rs.parse('tag:"anki card"'), Term('tag', 'anki card', at=0))
        self.assertEqual(rs.parse('"tag:anki card"'), Term('tag', 'anki card', at=0))  # Anki's quoting
        t = rs.parse('incremental.priority<=20')
        self.assertEqual((t.kind, t.owner, t.name, t.op, t.num), ('field', 'incremental', 'priority', '<=', 20.0))
        t = rs.parse('"Anki Card.Book:pna*"')
        self.assertEqual((t.owner, t.name, t.value, t.op), ('ankicard', 'book', 'pna*', ''))
        t = rs.parse('prop:incdue<=0')
        self.assertEqual((t.owner, t.name, t.op, t.num), ('incremental', 'nextrepdate', '<=', 0.0))
        self.assertTrue(rs.needs_index(rs.parse('bow -(tag:x or is:concept)')))
        self.assertFalse(rs.needs_index(rs.parse('bow -(wave or in:x)')))
        self.assertEqual(rs.parse('6.4').kind, 'text')

    def test_fts_terms_are_quoted(self):
        self.assertEqual(rs.fts_term('Navegação', 'prefix'), '"navegacao"*')
        self.assertEqual(rs.fts_term('under-keel', 'prefix'), '"under keel"*')
        self.assertEqual(rs.fts_term('NEAR OR', 'phrase'), '"near or"')


class SearchTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.db = Path(cls.tmp.name) / 'remnote.db'
        cls.index = Path(cls.tmp.name) / 'index.sqlite'
        make_db(cls.db)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def find(self, query, **kw):
        out = rs.search(KB, query, db_path=self.db, index_file=self.index, **kw)
        return [(r['remId'], r.get('aliasId')) for r in out['results']]

    def rems(self, query):
        return {rid for rid, _ in self.find(query)}

    def test_and_finds_what_or_buries(self):
        self.assertEqual(self.rems('bow weather wave'), {FLARE})

    def test_words_around_a_reference(self):
        # The phrase is broken by the reference, but the words are all there.
        self.assertEqual(self.rems('sea margin becomes'), {FLARE})

    def test_or_not_groups(self):
        self.assertEqual(self.rems('bow weather'), {FLARE, OTHER})
        self.assertEqual(self.rems('bow weather -tug'), {FLARE})
        self.assertEqual(self.rems('tug or "service power"'), {OTHER, MARGIN})
        self.assertEqual(self.rems('heavy -(tug or wave)'), set())

    def test_prefix_phrase_word(self):
        self.assertEqual(self.rems('excess'), {FLARE})
        self.assertEqual(self.rems('w:excess'), set())
        self.assertEqual(self.rems('"bow flare"'), {BOW, FLARE})

    def test_alias(self):
        self.assertEqual(self.find('alias:"sea margin"'), [(MARGIN, ids('ALIAS'))])
        # Its own row wins over the alias row, so no aliasId then.
        self.assertIn((MARGIN, None), self.find('margem'))

    def test_scopes(self):
        self.assertEqual(self.rems('in:"Wärtsilä Encyclopedia of Ship Technology" bow'), {BOW, FLARE})
        self.assertEqual(self.rems(f'in:{BOOK} bow'), {BOW, FLARE})
        self.assertEqual(self.rems('bow -in:"Wartsila encyclopedia of ship technology"'), {OTHER})
        self.assertEqual(self.rems('parent:"bow flare"'), {FLARE})
        self.assertEqual(self.rems('path:wartsila sea'), {FLARE})

    def test_name_resolution(self):
        # A name shared by several Rems covers all of them.
        self.assertEqual(self.rems('in:notes'), {DUP1, DUP2})
        self.assertEqual(self.rems('in:*rtsila*'), {BOOK, BOW, FLARE})
        # Documents win over other Rems with a matching name: *a* names the Wärtsilä and
        # Archive documents, and also OTHER ("…heavy weather"), which is then left out.
        self.assertEqual(self.rems('in:*a* weather'), {FLARE})
        self.assertEqual(self.rems('in:*ote* -in:archive'), {DUP1})  # no document matches: any Rem
        self.assertEqual(self.rems('in:wart* -in:wartsila*'), set())
        self.assertEqual(self.rems('parent:"bow*"'), {FLARE})
        for query, kind in (('in:"no such thing"', 'not-found'), ('in:*nothing like it*', 'not-found'),
                            (f'in:{ids("NONE")}', 'not-found')):
            with self.subTest(query=query):
                with self.assertRaises(SearchError) as ctx:
                    rs.search(KB, query, db_path=self.db)
                self.assertEqual(ctx.exception.kind, kind)
                if '"' in query:
                    self.assertIn('*', ctx.exception.message)  # the hint to use a wildcard

    def test_relevance_then_rank(self):
        # Both match "bow"; the short title is the better text match.
        self.assertEqual(self.find('bow', limit=1)[0][0], BOW)

    def test_limit_and_total(self):
        out = rs.search(KB, 'bow', limit=1, db_path=self.db)
        self.assertEqual(len(out['results']), 1)
        self.assertEqual(out['total'], 3)

    def test_schema_change_is_reported(self):
        bad = Path(self.tmp.name) / 'bad.db'
        sqlite3.connect(bad).execute('CREATE TABLE remsSearchInfos(id TEXT)').connection.commit()
        with self.assertRaises(SearchError) as ctx:
            rs.search(KB, 'bow', db_path=bad)
        self.assertEqual(ctx.exception.kind, 'schema')



class IndexSearchTest(unittest.TestCase):
    """Terms answered by the helper's own index (rem_index.py)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / 'remnote.db'
        self.index = Path(self.tmp.name) / 'index.sqlite'
        make_db(self.db)

    def tearDown(self):
        self.tmp.cleanup()

    def rems(self, query):
        out = rs.search(KB, query, db_path=self.db, index_file=self.index)
        return {r['remId'] for r in out['results']}

    def card_rems(self, query):
        """Like rems(), leaving out the Rems made for test_suppression_causes."""
        return self.rems(query) - SUPPRESSION_FIXTURE

    def test_tags_and_powerups(self):
        self.assertEqual(self.rems('tag:"anki card"'), {BOW})  # OTHER's tag was removed (t: false)
        self.assertEqual(self.rems('tag:anki*'), {BOW})
        self.assertEqual(self.rems('tag:incremental'), {MARGIN})  # a powerup counts as a tag
        self.assertNotIn(BOW, self.rems('tag:none'))
        self.assertIn(OTHER, self.rems('tag:none'))
        self.assertEqual(self.rems('has:powerup:Incremental'), {MARGIN})

    def test_is_and_has(self):
        self.assertEqual(self.rems('is:concept'), {BOW, MARGIN})
        self.assertEqual(self.rems('is:descriptor'), {OTHER})
        self.assertEqual(self.rems('is:document bow'), set())
        self.assertIn(BOOK, self.rems('is:document'))
        self.assertEqual(self.rems('is:incremental'), {MARGIN})
        self.assertEqual(self.rems('has:alias'), {MARGIN})
        self.assertEqual(self.rems('has:source'), {FLARE})
        self.assertEqual(self.rems('has:tag'), {BOW})

    def test_references_and_ids(self):
        self.assertEqual(self.rems('source:"Wärtsilä Encyclopedia of Ship Technology"'), {FLARE})
        self.assertEqual(self.rems('source:*encyclopedia*'), {FLARE})
        self.assertEqual(self.rems(f'source:{BOOK}'), {FLARE})
        self.assertEqual(self.rems('refs:"service power margin"'), {FLARE})
        self.assertEqual(self.rems('refs:service*'), {FLARE})
        with self.assertRaises(SearchError) as ctx:
            rs.search(KB, 'source:*bow*', db_path=self.db, index_file=self.index)  # bow is no one's Source
        self.assertEqual(ctx.exception.kind, 'not-found')
        self.assertEqual(self.rems(f'id:{BOW},{OTHER}'), {BOW, OTHER})

    def test_dates(self):
        self.assertEqual(self.rems('added:1'), {MARGIN})
        self.assertEqual(self.rems('edited:1'), {FLARE})

    def test_properties(self):
        self.assertEqual(self.rems('"anki card.book:pna resistencia"'), {BOW})
        self.assertEqual(self.rems('ankicard.book:pna*'), {BOW})
        self.assertEqual(self.rems('*.book:p_a*'), {BOW})
        self.assertEqual(self.rems('ankicard.book:pna'), set())  # exact unless wildcards
        self.assertEqual(self.rems('ankicard.book:_*'), {BOW})
        self.assertEqual(self.rems('prop:incpriority<=20'), {MARGIN})
        self.assertEqual(self.rems('incremental.priority>20'), set())

    def test_card_priority_reads_the_hidden_slot(self):
        self.assertEqual(self.rems('prop:priority<=30'), {MARGIN})
        self.assertEqual(self.rems('prop:priority>50'), set())  # not the visible 90
        self.assertEqual(self.rems('cardpriority.priority=30'), {MARGIN})
        row = [r for r in rb.browse(KB, 'margin', db_path=self.db, index_file=self.index)['rows'] if r['remId'] == MARGIN][0]
        self.assertEqual(row['priority'], 30)
        db = ri.ready(KB, self.db, self.index)
        try:  # the property child's own priority is filed under the child, not BOW
            self.assertEqual(db.execute("SELECT rem FROM props WHERE name = 'priorityvalue' AND num = 77").fetchall(),
                             [(CHILD_BOOK,)])
        finally:
            db.close()

    def test_newest_copy_of_a_slot_wins(self):
        # ps says due in 30 days (written 100 days ago); the child says 3 days ago (5 days ago).
        self.assertEqual(self.rems('prop:incdue<=0'), {MARGIN})
        self.assertEqual(self.rems('prop:incdue>0'), set())

    def test_refresh_picks_up_changes(self):
        self.assertEqual(self.rems('prop:incdue<=0'), {MARGIN})
        db = sqlite3.connect(self.db)
        child = dict(DOCS[CHILD_NEXT], value=[{'i': 'q', '_id': DAILY_NEW}], **{'value,u': NOW})
        put_doc(db, CHILD_NEXT, child, NOW)
        put_doc(db, OTHER, dict(DOCS[OTHER], tp={TAG: {'t': True}}), NOW)
        db.commit()
        db.close()
        self.assertEqual(self.rems('prop:incdue>0'), {MARGIN})
        self.assertEqual(self.rems('tag:"anki card"'), {BOW, OTHER})

    def test_text_and_index_terms_together(self):
        self.assertEqual(self.rems('bow is:concept'), {BOW})
        self.assertEqual(self.rems('bow -tag:"anki card"'), {FLARE, OTHER})
        self.assertEqual(self.rems('heavy (tag:incremental or has:source)'), {FLARE})

    def test_rems_with_source(self):
        db = ri.ready(KB, self.db, self.index)
        try:
            self.assertEqual(ri.rems_with_source(db, BOOK), [FLARE])
            self.assertEqual(ri.rems_with_source(db, BOOK, incremental_only=True), [])
            self.assertEqual(ri.rems_with_source(db, BOW), [])
        finally:
            db.close()

    def test_card_states(self):
        self.assertEqual(self.card_rems('is:due'), {BOW, FLARE})  # DUP2's card is due but paused
        self.assertEqual(self.card_rems('is:paused'), {ARCHIVE, DUP2})
        self.assertEqual(self.card_rems('is:new'), {BOW})
        self.assertEqual(self.card_rems('is:review'), {BOW, FLARE, OTHER, DUP2})
        self.assertEqual(self.card_rems('is:disabled'), {OTHER})
        self.assertEqual(self.card_rems('is:suspended'), {OTHER})
        self.assertEqual(self.card_rems('is:not-generated'), {OTHER})
        self.assertEqual(self.card_rems('is:learn-new'), {OTHER})
        self.assertEqual(self.card_rems('card:cloze'), {FLARE, OTHER})
        self.assertEqual(self.card_rems('ml:growing'), {BOW, DUP2})

    def test_card_terms_hold_for_one_card(self):
        # BOW has a due forward card and a new backward card: no card is both.
        self.assertEqual(self.card_rems('is:due card:backward'), set())
        self.assertEqual(self.card_rems('is:due card:forward'), {BOW})
        self.assertEqual(self.card_rems('is:new card:backward bow'), {BOW})
        self.assertEqual(self.card_rems('-is:due card:forward'), {OTHER, DUP2})

    def test_card_numbers_and_history(self):
        self.assertEqual(self.card_rems('prop:lapses>=2'), {BOW})
        self.assertEqual(self.card_rems('prop:lapses=0 card:cloze'), {FLARE, OTHER})  # Reset cleared FLARE's
        self.assertEqual(self.card_rems('prop:reps>=4'), {BOW})
        self.assertEqual(self.card_rems('prop:due<=-2'), {BOW})
        self.assertEqual(self.card_rems('prop:due>0'), {BOW})  # the new card
        self.assertEqual(self.card_rems('prop:ivl>=19'), {FLARE})
        self.assertEqual(self.card_rems('rated:1'), {BOW})
        self.assertEqual(self.card_rems('rated:1:easy'), {BOW})
        self.assertEqual(self.card_rems('rated:1:4'), {BOW})
        self.assertEqual(self.card_rems('rated:15:forgot'), {BOW})
        self.assertEqual(self.card_rems('rated:7'), {BOW, OTHER})
        self.assertEqual(self.card_rems('introduced:10'), {OTHER, DUP2})
        self.assertEqual(self.card_rems(f'cid:{C_CLOZE}'), {FLARE})

    def test_suppression_causes(self):
        self.assertEqual(self.rems('suppressed:paused'), {DUP2})  # ARCHIVE itself has no card
        self.assertEqual(self.rems('suppressed:ancestor'), {UNDER_U})
        self.assertEqual(self.rems('suppressed:table'), {ROW})
        self.assertEqual(self.rems('suppressed:direction'), {DIR})
        self.assertEqual(self.rems('suppressed:cloze'), {CLZ})
        self.assertEqual(self.rems('suppressed:removed'), {OTHER})
        self.assertEqual(self.rems('suppressed:other'), {OTHER})  # its forward card: off for no stored reason
        self.assertEqual(self.rems('suppressed:rem'), set())
        self.assertEqual(self.rems('is:suppressed'), {DUP2, UNDER_U, ROW, DIR, CLZ, OTHER})
        self.assertEqual(self.rems('is:disabled -is:suppressed'), set())
        # A Rem with Disable Descendant Cards on itself is "off on the Rem", not "ancestor".
        db = sqlite3.connect(self.db)
        put_doc(db, ROW, dict(DOCS[ROW], forget=False), NOW)
        put_card(db, ids('CC'), dict(rId=DISABLER, c='f', a=None, l=None, ml='New', h=[]), NOW)
        db.commit()
        db.close()
        self.assertEqual(self.rems('suppressed:rem'), {DISABLER})
        self.assertEqual(self.rems('suppressed:table'), set())

    def test_card_causes(self):
        out = rs.card_causes(KB, self.db, self.index)
        self.assertEqual(out['causes'], {
            C_PAUSED: 'paused', ids('C6'): 'ancestor', ids('C7'): 'table', ids('C8'): 'direction',
            ids('CA'): 'cloze', C_GONE: 'removed', C_OFF: 'other'})
        self.assertEqual(out['inTable'], [ROW])
        # A card whose Rem is gone is reported as such.
        db = sqlite3.connect(self.db)
        put_card(db, ids('CD'), dict(rId=ids('GONE'), c='f', a=None, l=None, ml='New', h=[]), NOW)
        db.commit()
        db.close()
        self.assertEqual(rs.card_causes(KB, self.db, self.index)['causes'][ids('CD')], 'missing')

    def test_browse_rems(self):
        out = rb.browse(KB, 'bow', db_path=self.db, index_file=self.index)
        self.assertEqual(out['total'], 3)
        by_id = {r['remId']: r for r in out['rows']}
        flare = by_id[FLARE]
        self.assertEqual(flare['path'], ['PSCPP', 'Wärtsilä Encyclopedia of Ship Technology', 'Bow flare'])
        self.assertTrue(flare['text'].startswith('Ships with'))
        self.assertIn('sea margin becomes', flare['text'])  # the reference shows its alias
        self.assertEqual(by_id[BOW]['tags'], ['Anki Card'])
        self.assertEqual(by_id[BOW]['cards'], 2)
        self.assertEqual(by_id[BOW]['due'], -2)
        self.assertEqual(by_id[BOW]['type'], 'concept')

    def test_browse_sort_and_page(self):
        out = rb.browse(KB, 'bow', sort='text', db_path=self.db, index_file=self.index)
        texts = [r['text'].lower() for r in out['rows']]
        self.assertEqual(texts, sorted(texts))
        page = rb.browse(KB, 'bow', sort='text', offset=1, limit=1, db_path=self.db, index_file=self.index)
        self.assertEqual(page['rows'][0]['remId'], out['rows'][1]['remId'])
        due = rb.browse(KB, 'is:review', sort='due', db_path=self.db, index_file=self.index)
        self.assertEqual(due['rows'][0]['remId'], BOW)  # earliest next time first, no time last

    def test_browse_memory(self):
        out = rb.browse(KB, 'is:fsrs', mode='cards', sort='r', db_path=self.db, index_file=self.index)
        rs_ = [r['retrievability'] for r in out['rows']]
        known = [x for x in rs_ if x is not None]
        self.assertEqual(rs_[:len(known)], sorted(known))  # lowest R first; never-reviewed cards (no R) last
        self.assertTrue(all(x is None for x in rs_[len(known):]))
        due = [r for r in out['rows'] if r.get('cardId') == C_DUE][0]
        self.assertEqual(due['scheduler'], 'Vocabulary')
        self.assertAlmostEqual(due['stability'], fsrs.replay(CARDS[C_DUE]['h'], None)['s'], places=9)
        other = [r for r in out['rows'] if r.get('cardId') == C_OFF][0]
        self.assertEqual(other['scheduler'], 'Global Default')
        sm2 = rb.browse(KB, 'is:sm2', mode='cards', db_path=self.db, index_file=self.index)['rows'][0]
        self.assertEqual((sm2['scheduler'], sm2['stability']), ('Questions', None))

    def test_browse_cards(self):
        out = rb.browse(KB, 'is:due card:forward', mode='cards', db_path=self.db, index_file=self.index)
        self.assertEqual([r['cardId'] for r in out['rows']], [C_DUE])  # not BOW's backward card
        self.assertEqual(out['rows'][0]['lapses'], 2)
        sup = rb.browse(KB, 'suppressed:cloze', mode='cards', db_path=self.db, index_file=self.index)
        self.assertIn('cloze', {c for r in sup['rows'] for c in r['suppressed']})
        with self.assertRaises(SearchError):
            rb.browse(KB, 'bow', mode='notes', db_path=self.db, index_file=self.index)

    def test_memory_state_uses_each_cards_scheduler(self):
        db = ri.ready(KB, self.db, self.index)
        try:
            mem = dict(((cid), (sched, s, d)) for cid, sched, s, d in db.execute('SELECT id, sched, mem_s, mem_d FROM cards'))
        finally:
            db.close()
        # BOW (and FLARE below it) on Vocabulary: default weights.
        expected = fsrs.replay(CARDS[C_DUE]['h'], None)
        self.assertEqual(mem[C_DUE][0], 'VOCAB')
        self.assertAlmostEqual(mem[C_DUE][1], expected['s'], places=9)
        self.assertAlmostEqual(mem[C_DUE][2], expected['d'], places=9)
        self.assertEqual(mem[C_CLOZE][0], 'VOCAB')  # FLARE inherits from BOW
        # OTHER on the Global Default: its optimised weights.
        self.assertEqual(mem[C_OFF][0], 'GLOB')
        self.assertAlmostEqual(mem[C_OFF][1], fsrs.replay(CARDS[C_OFF]['h'], OPTIMIZED)['s'], places=9)
        # DUP2 under Questions (SM-2): no memory state.
        self.assertEqual(mem[C_PAUSED], ('QS', None, None))

    def test_memory_keys(self):
        self.assertEqual(self.card_rems('scheduler:vocabulary'), {BOW, FLARE})
        self.assertEqual(self.card_rems('scheduler:vocab'), {BOW, FLARE})  # from the start of the name
        self.assertEqual(self.card_rems('scheduler:*abul*'), {BOW, FLARE})
        self.assertEqual(self.card_rems('scheduler:global'), {OTHER})
        self.assertEqual(self.card_rems('is:sm2'), {DUP2})
        self.assertEqual(self.card_rems('is:fsrs card:cloze'), {FLARE, OTHER})
        s_due = fsrs.replay(CARDS[C_DUE]['h'], None)['s']
        self.assertEqual(self.card_rems(f'prop:s>={s_due - 0.001} prop:s<={s_due + 0.001}'), {BOW})
        self.assertEqual(self.card_rems('prop:r>1'), set())
        self.assertEqual(self.card_rems('prop:r>=0 is:sm2'), set())  # SM-2: no R
        # R of C_DUE: last review 0.1 day ago → still high; C_CLOZE: 20 days ago → lower.
        r_due = fsrs.forgetting_curve(0.1, s_due, fsrs.decay_of(None))
        self.assertIn(BOW, self.card_rems(f'prop:r>{r_due - 0.01}'))

    def test_scheduler_changes_recompute(self):
        self.assertEqual(self.card_rems('scheduler:vocabulary'), {BOW, FLARE})
        db = sqlite3.connect(self.db)
        put_doc(db, BOW, {k: v for k, v in DOCS[BOW].items() if k != 'src'}, NOW)  # back to the Global Default
        db.commit()
        db.close()
        self.assertEqual(self.card_rems('scheduler:vocabulary'), set())
        self.assertEqual(self.card_rems('scheduler:global'), {BOW, FLARE, OTHER})
        idx = ri.ready(KB, self.db, self.index)
        try:
            s_now = idx.execute('SELECT mem_s FROM cards WHERE id = ?', (C_DUE,)).fetchone()[0]
        finally:
            idx.close()
        self.assertAlmostEqual(s_now, fsrs.replay(CARDS[C_DUE]['h'], OPTIMIZED)['s'], places=9)
        # New weights on a scheduler: every card is recomputed.
        db = sqlite3.connect(self.db)
        put_scheduler(db, 'GLOB', dict(SCHEDULERS['GLOB'], w=None))
        db.commit()
        db.close()
        idx = ri.ready(KB, self.db, self.index)
        try:
            s_now = idx.execute('SELECT mem_s FROM cards WHERE id = ?', (C_DUE,)).fetchone()[0]
        finally:
            idx.close()
        self.assertAlmostEqual(s_now, fsrs.replay(CARDS[C_DUE]['h'], None)['s'], places=9)

    def test_card_refresh(self):
        self.assertEqual(self.card_rems('is:disabled'), {OTHER})
        db = sqlite3.connect(self.db)
        put_card(db, C_OFF, dict(CARDS[C_OFF], a=NOW - DAY), NOW)
        db.commit()
        db.close()
        self.assertEqual(self.card_rems('is:disabled'), set())
        self.assertIn(OTHER, self.card_rems('is:due'))

    def test_an_older_index_is_rebuilt_not_opened(self):
        # An index from before a schema change lacks columns the new schema indexes.
        old = sqlite3.connect(self.index)
        old.executescript("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT); INSERT INTO meta VALUES ('schema', '1');"
                          "CREATE TABLE cards (id TEXT PRIMARY KEY, rem TEXT);")
        old.commit()
        old.close()
        self.assertTrue(ri.needs_build(KB, self.index))
        self.assertEqual(self.rems('is:concept'), {BOW, MARGIN})

    def test_helper_never_waits_for_a_build(self):
        with self.assertRaises(SearchError) as ctx:
            rs.search(KB, 'is:concept', db_path=self.db, index_file=self.index, wait=False)
        self.assertEqual(ctx.exception.kind, 'index-building')
        # Text-only searches don't need the index and answer meanwhile.
        self.assertEqual(rs.search(KB, 'bow weather', db_path=self.db, index_file=self.index, wait=False)['total'], 2)
        for _ in range(200):
            if not ri.is_building(KB):
                break
            time.sleep(0.05)
        out = rs.search(KB, 'is:concept', db_path=self.db, index_file=self.index, wait=False)
        self.assertEqual({r['remId'] for r in out['results']}, {BOW, MARGIN})

    def test_index_rebuilds_on_format_change(self):
        self.rems('is:concept')
        db = ri.open_index(KB, self.index)
        ri.set_meta(db, 'schema', 'old')
        db.commit()
        db.close()
        self.assertEqual(self.rems('is:concept'), {BOW, MARGIN})


if __name__ == '__main__':
    unittest.main()
