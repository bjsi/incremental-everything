#!/usr/bin/env python3
"""Tests for history_backfill.py, on small fake remnote.db files.

    python3 scripts/test_history_backfill.py
"""
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import history_archive as ha  # noqa: E402
import history_backfill as hb  # noqa: E402
from test_history_archive import DAY, KB, T0, FakeKB, card, inc_rem, rem  # noqa: E402

SILENT = lambda *_: None  # noqa: E731


class BackfillTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.archive = self.tmp / 'archive.sqlite'
        # Today: the content was re-imported, so every id is new. "Fração" is back
        # as a twin whose card history starts later.
        self.today = FakeKB(self.tmp / 'today.db')
        for doc in (rem('S2', None, 'Suporte📕'), rem('M2', 'S2', 'Matemática'), rem('F2', 'M2', 'Fração'),
                    rem('K', None, 'Kept')):
            self.today.put('quanta', doc)
        self.today.put('cards', card('cF2', 'F2', [T0 + 900 * DAY]))
        self.today.put('cards', card('cK', 'K', [T0 + 5 * DAY]))
        ha.scan(KB, self.today.path, self.archive)
        # 2023: the old ids, with the history today's DB lost.
        self.old = FakeKB(self.tmp / 'RemNote_Backup_2023-10-02.db')
        for doc in (rem('S1', None, 'Suporte 📕'), rem('M1', 'S1', 'matemática'), rem('F1', 'M1', 'Fração'),
                    rem('G1', 'M1', 'Geometria'), rem('E1', 'G1', 'Elipse'), rem('K', None, 'Kept'),
                    rem('U1', 'K', 'Under kept'), rem('Z1', None, 'Gone for good')):
            self.old.put('quanta', doc)
        self.old.put('cards', card('cF1', 'F1', [T0 + DAY, T0 + 2 * DAY]))
        self.old.put('cards', card('cE1', 'E1', [T0 + 3 * DAY]))
        self.old.put('cards', card('cK', 'K', [T0 + 5 * DAY]))  # still in today's DB: skipped
        self.old.put('cards', card('cU1', 'U1', [T0 + 6 * DAY]))
        self.old.put('cards', card('cZ1', 'Z1', [T0 + 7 * DAY]))
        self.old.put('quanta', inc_rem('I1', 'M1', 'Read chapter', [T0 + 8 * DAY], secs=600))

    def run_backfill(self, **kw):
        return hb.backfill(KB, [str(self.old.path)], archive=self.archive, db_path=self.today.path,
                           log=SILENT, **kw)

    def test_adds_only_reps_the_archive_lacks_with_the_snapshot_as_source(self):
        out = self.run_backfill()
        self.assertEqual(out['totals']['reps'], 6)
        db = ha.open_archive(self.archive)
        sources = dict(db.execute("SELECT date_ms, source FROM reps WHERE source != 'live'").fetchall())
        self.assertEqual(set(sources.values()), {'RemNote_Backup_2023-10-02.db'})
        self.assertNotIn(T0 + 5 * DAY, sources)
        db.close()

    def test_ghosts_hang_under_todays_branch_by_text(self):
        self.run_backfill()
        g = ha.ghosts(KB, self.archive)
        by_rem = {r['rem'] for r in g['reps']}
        self.assertEqual(by_rem, {'F1', 'E1', 'U1', 'Z1', 'I1'})
        rems = g['rems']
        # Fração's old copy sits beside its twin, under today's Matemática.
        self.assertEqual(rems['F1']['parent'], 'M2')
        self.assertEqual(rems['M2']['state'], 'live')
        # A deleted subtree keeps its shape below the anchor.
        self.assertEqual(rems['E1']['parent'], 'G1')
        self.assertEqual(rems['G1']['parent'], 'M2')
        # An ancestor that kept its id anchors by id.
        self.assertEqual(rems['U1']['parent'], 'K')
        # Nothing matches: no live parent at all.
        self.assertIsNone(rems['Z1']['parent'])
        # IncRem history comes back too.
        inc = [r for r in g['reps'] if r['kind'] == 'inc']
        self.assertEqual([(r['rem'], r['time']) for r in inc], [('I1', 600_000)])

    def test_same_text_siblings_take_the_branch_that_matches_deepest(self):
        # An empty second "Suporte" sorts first; the old path still lands under Matemática.
        self.today.put('quanta', rem('S0', None, 'Suporte📕'))
        live = hb.LiveTree(self.today.path)
        live.children[None][hb.norm('Suporte📕')].sort()  # 'S0' before 'S2'
        self.assertEqual(live.match_path(['Suporte', 'Matemática', 'Geometria']), [(0, 'S2'), (1, 'M2')])

    def test_never_matches_the_rem_holding_the_reps(self):
        self.run_backfill()
        db = ha.open_archive(self.archive)
        anchored = {r for (r,) in db.execute('SELECT rem_id FROM anchors')}
        db.close()
        self.assertNotIn('F1', anchored)

    def test_excluded_kb_reps_are_left_out(self):
        orig = hb.other_kb_dates
        hb.other_kb_dates = lambda kbs: {T0 + DAY, T0 + 2 * DAY} if kbs else set()
        try:
            out = self.run_backfill(exclude_kbs=['ffffffffffffffffffffffff'])
        finally:
            hb.other_kb_dates = orig
        self.assertEqual(out['totals']['reps'], 4)

    def test_dry_run_writes_nothing(self):
        out = self.run_backfill(dry_run=True)
        self.assertEqual(out['totals']['reps'], 6)
        db = ha.open_archive(self.archive)
        self.assertEqual(db.execute("SELECT COUNT(*) FROM reps WHERE source != 'live'").fetchone()[0], 0)
        self.assertEqual(db.execute('SELECT COUNT(*) FROM anchors').fetchone()[0], 0)
        db.close()

    def test_running_twice_adds_nothing_more(self):
        self.run_backfill()
        self.assertEqual(self.run_backfill()['totals'].get('reps', 0), 0)

    def test_a_later_scan_keeps_the_backfill(self):
        self.run_backfill()
        ha.scan(KB, self.today.path, self.archive)
        self.assertEqual(len(ha.ghosts(KB, self.archive)['reps']), 5 + 1)

    def test_snapshot_skipped_when_it_is_another_kb(self):
        other = FakeKB(self.tmp / 'other.db')
        other.put('cards', {**card('c9', 'R9', [T0 + 50 * DAY]), 'owner': 'ffffffffffffffffffffffff'})
        out = hb.backfill(KB, [str(other.path)], archive=self.archive, db_path=self.today.path, log=SILENT)
        self.assertEqual(out['totals'].get('reps', 0), 0)


class SnapshotTimeTest(unittest.TestCase):
    def day(self, name):
        return time.strftime('%Y-%m-%d', time.localtime(hb.snapshot_time(name) / 1000))

    def test_names(self):
        self.assertEqual(self.day('RemNote_Backup_2023-04-17.db'), '2023-04-17')
        self.assertEqual(self.day('RemNote_Export_June_30th_2022_x@y.com_json.zip'), '2022-06-30')
        self.assertEqual(self.day('20210922 RemNote_Export_September_22nd_2021_x_json.zip'), '2021-09-22')
        self.assertEqual(self.day('RemNoteExport_hugo_json_2025-08-26_07-37.rem'), '2025-08-26')
        # RemNote's own cloud backups carry the exact time, in ms.
        self.assertEqual(hb.snapshot_time('backup-5fac17d5adaba1004507957e-1726358400000.zip'), 1726358400000)


if __name__ == '__main__':
    unittest.main()
