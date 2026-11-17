#!/usr/bin/env python3
"""Tests for history_archive.py, on small fake remnote.db files.

    python3 scripts/test_history_archive.py
"""
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import history_archive as ha  # noqa: E402

KB = '0123456789abcdef01234567'
DAY = 86_400_000
T0 = 1_780_000_000_000


def card(cid, rem, dates, score=1, rt=5000, **extra):
    return {'_id': cid, 'rId': rem, 'c': 'x', 'h': [{'date': d, 'score': score, 'responseTime': rt} for d in dates],
            **extra}


def rem(rid, parent, text, **extra):
    return {'_id': rid, 'parent': parent, 'key': [text], **extra}


def history_slot(entries):
    raw = json.dumps(entries)
    return {'v': {'v': [raw], 's': raw}}


def inc_rem(rid, parent, text, dates, kind='inc', event='rep', secs=60, layout='ps'):
    code, slot = ha.SLOTS[kind]
    entries = [{'date': d, 'eventType': event, 'reviewTimeSeconds': secs} for d in dates]
    doc = rem(rid, parent, text)
    if layout == 'ps':
        doc['ps'] = {f'{code}_{slot}': history_slot(entries)}
    else:
        raw = json.dumps(entries)
        doc['bpc'] = {code: {slot: {'v': [raw], 's': raw}}}
    return doc


class FakeKB:
    """A remnote.db with the four tables the archive reads."""

    def __init__(self, path):
        self.path = path
        db = sqlite3.connect(path)
        for t in ('quanta', 'deleted_quanta', 'cards', 'deleted_cards'):
            db.execute(f'CREATE TABLE {t} (_id TEXT PRIMARY KEY, doc TEXT)')
        db.commit()
        db.close()

    def put(self, table, doc):
        db = sqlite3.connect(self.path)
        db.execute(f'INSERT OR REPLACE INTO {table} VALUES (?,?)', (doc['_id'], json.dumps(doc)))
        db.commit()
        db.close()

    def get(self, table, _id):
        db = sqlite3.connect(self.path)
        row = db.execute(f'SELECT doc FROM {table} WHERE _id=?', (_id,)).fetchone()
        db.close()
        return json.loads(row[0]) if row else None

    def drop(self, table, _id):
        db = sqlite3.connect(self.path)
        db.execute(f'DELETE FROM {table} WHERE _id=?', (_id,))
        db.commit()
        db.close()

    def trash(self, live, dead, _id, at=T0 + 30 * DAY):
        doc = self.get(live, _id)
        self.drop(live, _id)
        self.put(dead, {**doc, 'deletedAt': at})

    def restore(self, live, dead, _id):
        doc = self.get(dead, _id)
        doc.pop('deletedAt', None)
        self.drop(dead, _id)
        self.put(live, doc)


class ArchiveTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = Path(self.tmp.name)
        self.kb = FakeKB(d / 'remnote.db')
        self.archive = d / 'archive.sqlite'
        # A live tree: Top > Doc > (cards and IncRems go here)
        self.kb.put('quanta', rem('top', None, 'Top'))
        self.kb.put('quanta', rem('doc', 'top', 'Doc'))

    def tearDown(self):
        self.tmp.cleanup()

    def scan(self):
        return ha.scan(KB, db_path=self.kb.path, archive=self.archive)

    def ghosts(self):
        return ha.ghosts(KB, archive=self.archive)

    def ghost_dates(self):
        return sorted(r['date'] for r in self.ghosts()['reps'])

    # --- cards -------------------------------------------------------------

    def test_live_card_is_not_a_ghost(self):
        self.kb.put('quanta', rem('r1', 'doc', 'Fact'))
        self.kb.put('cards', card('c1', 'r1', [T0, T0 + DAY]))
        s = self.scan()
        self.assertEqual(s['newReps'], 2)
        self.assertEqual(self.ghost_dates(), [])

    def test_deleted_card_becomes_ghost_with_chain_to_live_ancestor(self):
        self.kb.put('quanta', rem('r1', 'doc', 'Fact'))
        self.kb.put('cards', card('c1', 'r1', [T0, T0 + DAY]))
        self.scan()
        self.kb.trash('quanta', 'deleted_quanta', 'r1')
        self.kb.trash('cards', 'deleted_cards', 'c1')
        self.scan()
        g = self.ghosts()
        self.assertEqual([r['date'] for r in g['reps']], [T0, T0 + DAY])
        self.assertEqual(g['rems']['r1']['state'], 'trash')
        self.assertEqual(g['rems']['r1']['parent'], 'doc')
        self.assertEqual(g['rems']['doc']['state'], 'live')
        self.assertNotIn('top', g['rems'])  # the chain stops at the nearest live ancestor

    def test_purged_trash_keeps_ghost_and_last_known_place(self):
        self.kb.put('quanta', rem('r1', 'doc', 'Fact'))
        self.kb.put('cards', card('c1', 'r1', [T0]))
        self.scan()
        self.kb.drop('quanta', 'r1')  # "Clear Trash" between two scans
        self.kb.drop('cards', 'c1')
        self.scan()
        g = self.ghosts()
        self.assertEqual([r['date'] for r in g['reps']], [T0])
        self.assertEqual(g['rems']['r1']['state'], 'gone')
        self.assertEqual(g['rems']['r1']['text'], 'Fact')
        self.assertEqual(g['rems']['r1']['parent'], 'doc')

    def test_restored_card_is_not_a_ghost(self):
        self.kb.put('quanta', rem('r1', 'doc', 'Fact'))
        self.kb.put('cards', card('c1', 'r1', [T0]))
        self.scan()
        self.kb.trash('cards', 'deleted_cards', 'c1')
        self.scan()
        self.assertEqual(self.ghost_dates(), [T0])
        self.kb.restore('cards', 'deleted_cards', 'c1')
        self.scan()
        self.assertEqual(self.ghost_dates(), [])

    def test_deleted_subtree_chain_passes_through_deleted_parent(self):
        self.kb.put('quanta', rem('sec', 'doc', 'Section'))
        self.kb.put('quanta', rem('r1', 'sec', 'Fact'))
        self.kb.put('cards', card('c1', 'r1', [T0]))
        self.scan()
        for table, rid in (('quanta', 'sec'), ('quanta', 'r1')):
            self.kb.trash(table, 'deleted_' + table, rid)
        self.kb.trash('cards', 'deleted_cards', 'c1')
        self.scan()
        rems = self.ghosts()['rems']
        self.assertEqual(rems['r1']['parent'], 'sec')
        self.assertEqual(rems['sec']['state'], 'trash')
        self.assertEqual(rems['sec']['parent'], 'doc')
        self.assertEqual(rems['doc']['state'], 'live')

    def test_first_seen_already_in_trash(self):
        self.kb.put('deleted_quanta', rem('r1', 'doc', 'Fact', deletedAt=T0))
        self.kb.put('deleted_cards', card('c1', 'r1', [T0 - DAY], deletedAt=T0))
        self.scan()
        self.assertEqual(self.ghost_dates(), [T0 - DAY])

    def test_rep_edited_out_of_a_live_card_never_returns(self):
        self.kb.put('quanta', rem('r1', 'doc', 'Fact'))
        self.kb.put('cards', card('c1', 'r1', [T0, T0 + DAY]))
        self.scan()
        self.kb.put('cards', card('c1', 'r1', [T0 + DAY]))  # history edit removed T0
        self.scan()
        self.kb.trash('cards', 'deleted_cards', 'c1')
        self.scan()
        self.assertEqual(self.ghost_dates(), [T0 + DAY])

    # --- IncRems -----------------------------------------------------------

    def test_deleted_increm_both_layouts(self):
        self.kb.put('quanta', inc_rem('i1', 'doc', 'New layout', [T0], layout='ps'))
        self.kb.put('quanta', inc_rem('i2', 'doc', 'Old layout', [T0 + 1], layout='bpc'))
        self.scan()
        self.assertEqual(self.ghost_dates(), [])
        self.kb.trash('quanta', 'deleted_quanta', 'i1')
        self.kb.trash('quanta', 'deleted_quanta', 'i2')
        self.scan()
        g = self.ghosts()
        self.assertEqual([(r['date'], r['kind'], r['time']) for r in g['reps']],
                         [(T0, 'inc', 60_000), (T0 + 1, 'inc', 60_000)])

    def test_dismiss_moves_history_without_ghosts(self):
        self.kb.put('quanta', inc_rem('i1', 'doc', 'Read me', [T0]))
        self.scan()
        self.kb.put('quanta', inc_rem('i1', 'doc', 'Read me', [T0], kind='dism'))  # repHist → dismissedHistory
        self.scan()
        self.assertEqual(self.ghost_dates(), [])

    # --- Preserve history & remove ------------------------------------------

    def preserve(self):
        """r1 (card c1) and IncRem i1 under 'sub' are consolidated onto tombstone 'sub'."""
        self.kb.put('quanta', rem('sub', 'doc', 'Chapter'))
        self.kb.put('quanta', rem('r1', 'sub', 'Fact'))
        self.kb.put('cards', card('c1', 'r1', [T0, T0 + DAY]))
        self.kb.put('quanta', inc_rem('i1', 'sub', 'Passage', [T0 + 2 * DAY]))
        self.scan()
        merged = [{'date': d, 'eventType': 'importedRep', 'reviewTimeSeconds': 5} for d in (T0, T0 + DAY)]
        merged.append({'date': T0 + 2 * DAY, 'eventType': 'rep', 'reviewTimeSeconds': 60})
        merged.append({'date': T0 + 40 * DAY, 'eventType': 'dismissed'})
        tomb = rem('sub', 'doc', '')
        tomb['ps'] = {'dismissed_dismissedHistory': history_slot(merged)}
        self.kb.put('quanta', tomb)
        self.kb.trash('cards', 'deleted_cards', 'c1')
        self.kb.trash('quanta', 'deleted_quanta', 'r1')
        self.kb.trash('quanta', 'deleted_quanta', 'i1')
        self.scan()

    def test_preserve_history_counts_each_rep_once(self):
        self.preserve()
        self.assertEqual(self.ghost_dates(), [])

    def test_deleted_tombstone_keeps_its_own_copies(self):
        self.preserve()
        self.kb.trash('quanta', 'deleted_quanta', 'sub', at=T0 + 50 * DAY)
        self.scan()
        reps = self.ghosts()['reps']
        real = [r for r in reps if ha.counts(r)]
        self.assertEqual([r['date'] for r in real], [T0, T0 + DAY, T0 + 2 * DAY])
        # The tombstone was live last, so its copies win over the original card and IncRem.
        self.assertEqual({r['kind'] for r in real}, {'dism'})
        self.assertEqual({r['item'] for r in real}, {'sub'})

    # --- text ----------------------------------------------------------------

    def test_plain_text_resolves_references_and_skips_pins(self):
        self.kb.put('quanta', rem('target', 'doc', 'hydrodynamic lift'))
        self.kb.put('quanta', {'_id': 'r1', 'parent': 'doc',
                               'key': ['The ', {'i': 'q', '_id': 'target'}, ' is ',
                                       {'i': 'm', 'text': 'fully developed', 'cId': '1'},
                                       {'i': 'q', '_id': 'src', 'pin': True}]})
        self.kb.put('cards', card('c1', 'r1', [T0]))
        self.scan()
        self.kb.trash('cards', 'deleted_cards', 'c1')
        self.kb.trash('quanta', 'deleted_quanta', 'r1')
        self.scan()
        self.assertEqual(self.ghosts()['rems']['r1']['text'], 'The hydrodynamic lift is fully developed')

    def test_report_runs(self):
        self.kb.put('quanta', rem('r1', 'doc', 'Fact'))
        self.kb.put('cards', card('c1', 'r1', [T0], rt=500_000))
        self.scan()
        self.kb.trash('cards', 'deleted_cards', 'c1')
        self.kb.trash('quanta', 'deleted_quanta', 'r1')
        self.scan()
        text = ha.report(KB, archive=self.archive)
        self.assertIn('card        1 reps      3m00s', text)  # capped at 180 s
        self.assertIn('under: Top › Doc', text)


if __name__ == '__main__':
    unittest.main()
