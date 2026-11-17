#!/usr/bin/env python3
"""
Search & Browse: a page of table rows for a query, every column read from the
helper's index and remnote.db in one call (served by ai_ocr_helper.py as POST
/search/browse). The plugin's Search & Browse popup only renders them, so a page
costs no bridge calls. Plan: plans/implemented/SEARCH_ENGINE_PLAN.md, phase 4.

    python3 scripts/rem_browse.py --kb <id> 'is:due card:cloze' --mode cards --sort due

Rows are Rems (`mode=rems`) or cards (`mode=cards`). In card mode the cards listed
are those of the matching Rems that meet the query's top-level card terms, as Anki's
Browser lists the cards a search matched: `is:due card:cloze` lists due cloze cards.

Sorting is over the whole result set before paging: relevance (the search's own
order), text, created, edited, due (earliest next time first, none last), priority
(card priority), incpriority, reps, lapses, ivl.
"""
import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rem_index  # noqa: E402
import rem_search as rs  # noqa: E402

SORTS = {'relevance', 'text', 'created', 'edited', 'due', 'priority', 'incpriority', 'reps', 'lapses', 'ivl',
         's', 'd', 'r'}
MAX_PAGE = 500
TEXT_CHARS = 300

# A value of a slot, keeping only the newest copy (see rem_index.py, props).
NEWEST_PROP = """(SELECT p.{col} FROM props p WHERE p.rem = {rem} AND p.owner = '{owner}' AND p.name = '{name}'
                  ORDER BY p.at DESC LIMIT 1)"""


def prop_expr(rem, owner, name, col='num'):
    return NEWEST_PROP.format(col=col, rem=rem, owner=owner, name=name)


# Sort keys per mode: SQL over the hit `h.id` (a Rem) or the card `c`. NULLs go last.
REM_SORT = {
    'text': "(SELECT lower(json_extract(s.doc, '$.r')) FROM remsSearchInfos s WHERE s.id = h.id AND s.aliasId = s.id)",
    'created': '(SELECT created FROM rems WHERE id = h.id)',
    'edited': '(SELECT edited FROM rems WHERE id = h.id)',
    'due': '(SELECT MIN(next) FROM cards WHERE rem = h.id)',
    'priority': f"COALESCE({prop_expr('h.id', 'cardpriority', 'priorityvalue')}, {prop_expr('h.id', 'cardpriority', 'priority')})",
    'incpriority': prop_expr('h.id', 'incremental', 'priority'),
    'reps': '(SELECT SUM(reps) FROM cards WHERE rem = h.id)',
    'lapses': '(SELECT SUM(lapses) FROM cards WHERE rem = h.id)',
    'ivl': '(SELECT MAX(ivl) FROM cards WHERE rem = h.id)',
}
# Retrievability now, for sorting (rem_search.R_SQL with the time bound in).
def r_sql(now_ms):
    return rs.R_SQL.replace(':now', str(int(now_ms)))


def rem_memory_sort(col):
    """Rem mode: the value of its card with the lowest R (its most at-risk card)."""
    return (f'(SELECT {col} FROM cards c WHERE c.rem = h.id AND c.mem_s IS NOT NULL '
            f'ORDER BY {{R}} ASC LIMIT 1)')


REM_SORT.update(s=rem_memory_sort('c.mem_s'), d=rem_memory_sort('c.mem_d'), r=rem_memory_sort('{R}'))
CARD_SORT = dict(REM_SORT, due='c.next', reps='c.reps', lapses='c.lapses', ivl='c.ivl',
                 text=REM_SORT['text'], created='c.created', s='c.mem_s', d='c.mem_d', r='{R}')


def top_card_terms(tree):
    """The card terms ANDed at the top of the query: they pick the cards to list."""
    nodes = tree.nodes if isinstance(tree, rs.And) else [tree]
    return [n for n in nodes if isinstance(n, rs.Term) and n.kind == 'card']


class Texts:
    """Display text of Rems, in their own capitals and accents, from remnote.db."""

    def __init__(self, db):
        self.db = db
        self.docs = {}

    def doc(self, rid):
        if rid not in self.docs:
            row = self.db.execute('SELECT doc FROM rn.quanta WHERE _id = ?', (rid,)).fetchone()
            self.docs[rid] = json.loads(row[0]) if row and row[0] else None
        return self.docs[rid]

    def name(self, rid, depth=0):
        d = self.doc(rid)
        if not d:
            return ''
        return self.render(d.get('key'), depth)

    def alias(self, ref):
        """The alias a reference shows: stored on its target as `al: [{aliasId, alias}]`
        since RemNote's storage overhaul, or an alias Rem from before it."""
        alias_id = ref.get('aliasId')
        if not alias_id:
            return ''
        for entry in (self.doc(ref.get('_id')) or {}).get('al') or []:
            if isinstance(entry, dict) and entry.get('aliasId') == alias_id:
                return self.render(entry.get('alias'))
        return self.name(alias_id)

    def render(self, rich, depth=0):
        if isinstance(rich, str):
            return rich
        out = []
        for el in rich or []:
            if isinstance(el, str):
                out.append(el)
            elif isinstance(el, dict):
                if el.get('i') == 'q' and not el.get('pin') and depth < 2:
                    out.append(self.alias(el) or self.name(el.get('_id'), depth + 1))
                elif isinstance(el.get('text'), str):
                    out.append(el['text'])
        return ' '.join(''.join(out).split())[:TEXT_CHARS]


def _hits_table(db, hits):
    db.execute('CREATE TEMP TABLE IF NOT EXISTS hits (id TEXT PRIMARY KEY, ord INTEGER, alias TEXT)')
    db.execute('DELETE FROM hits')
    db.executemany('INSERT OR IGNORE INTO hits VALUES (?, ?, ?)', [(rid, i, alias) for i, (rid, alias) in enumerate(hits)])


def browse(kb_id, query, mode='rems', sort='relevance', desc=False, offset=0, limit=100,
           db_path=None, index_file=None, wait=True):
    """{rows, total, ms}; raises rs.SearchError."""
    started = time.time()
    if mode not in ('rems', 'cards'):
        raise rs.SearchError('unknown-value', 'mode is rems or cards.')
    if sort not in SORTS:
        raise rs.SearchError('unknown-value', f'sort is one of {", ".join(sorted(SORTS))}.')
    tree = rs.parse(query)
    limit = max(1, min(int(limit or 100), MAX_PAGE))
    offset = max(0, int(offset or 0))
    db = rs.open_index_for_search(kb_id, db_path, index_file, wait)
    try:
        hits, _ = rs.match(db, tree)
        _hits_table(db, hits)
        direction = 'DESC' if desc else 'ASC'
        if mode == 'rems':
            key = 'h.ord' if sort == 'relevance' else REM_SORT[sort].replace('{R}', r_sql(time.time() * 1000))
            order = f'({key}) IS NULL, ({key}) {direction}, h.ord'
            total = len(hits)
            page = db.execute(f'SELECT h.id, h.alias FROM hits h ORDER BY {order} LIMIT ? OFFSET ?',
                              (limit, offset)).fetchall()
            texts = Texts(db)
            causes = card_causes_for(db, [rid for rid, _ in page])
            rows = [rem_row(db, rid, alias, texts, causes) for rid, alias in page]
        else:
            comp = rs.Compiler(db)
            conds, args = [], []
            for t in top_card_terms(tree):
                cond, cargs, _ = comp.card_cond(t)
                conds.append(cond)
                args += cargs
            where = ' AND '.join(conds) or '1'
            key = 'h.ord' if sort == 'relevance' else CARD_SORT[sort].replace('{R}', r_sql(time.time() * 1000))
            order = f'({key}) IS NULL, ({key}) {direction}, h.ord, c.id'
            base = f'FROM cards c JOIN hits h ON h.id = c.rem WHERE {where}'
            total = db.execute(f'SELECT COUNT(*) {base}', args).fetchone()[0]
            page = db.execute(f'SELECT c.id, c.rem {base} ORDER BY {order} LIMIT ? OFFSET ?',
                              [*args, limit, offset]).fetchall()
            texts = Texts(db)
            causes = card_causes_for(db, sorted({rid for _, rid in page}))
            rows = [card_row(db, cid, rid, texts, causes) for cid, rid in page]
        return {'rows': rows, 'total': total, 'ms': int((time.time() - started) * 1000)}
    finally:
        db.close()


def card_causes_for(db, rem_ids):
    """{cardId: cause} for the suppressed cards of these Rems (rs.CARD_CAUSE plus the
    paused and ancestor causes, as rs.card_causes)."""
    if not rem_ids:
        return {}
    comp = rs.Compiler(db)
    paused = comp.paused_sql()
    ancestor = comp.ancestor_disabled_sql()
    marks = ','.join('?' * len(rem_ids))
    sql = f"""SELECT id, cause FROM (
                SELECT c.id,
                  CASE WHEN r.id IS NULL THEN 'missing'
                       WHEN {paused} THEN 'paused'
                       WHEN c.next IS NULL AND {ancestor} THEN 'ancestor'
                       ELSE ({rs.CARD_CAUSE}) END AS cause
                FROM cards c
                LEFT JOIN rems r ON r.id = c.rem
                LEFT JOIN remsSearchInfos s ON s.id = c.rem AND s.aliasId = s.id
                WHERE c.rem IN ({marks}))
              WHERE cause IS NOT NULL"""
    return dict(db.execute(sql, [*comp.args, *rem_ids]).fetchall())


def _common(db, rid, texts):
    """The Rem columns shared by both modes."""
    d = texts.doc(rid) or {}
    info = db.execute("""SELECT s.ancestor_ids, json_extract(s.doc, '$.i'), json_extract(s.doc, '$.l')
                         FROM remsSearchInfos s WHERE s.id = ? AND s.aliasId = s.id""", (rid,)).fetchone()
    ancestors = (info[0] or '').split() if info else []
    rem = db.execute('SELECT type, created, edited FROM rems WHERE id = ?', (rid,)).fetchone() or (None, None, None)
    tags = [texts.name(t) for (t,) in db.execute('SELECT tag FROM rem_tags WHERE rem = ?', (rid,))]
    powerups = {c for (c,) in db.execute('SELECT code FROM rem_powerups WHERE rem = ?', (rid,))}
    today = rs.today_day()
    inc_due = db.execute('SELECT ' + prop_expr('?', 'incremental', 'nextrepdate', 'day'), (rid,)).fetchone()[0]
    return {
        'remId': rid,
        'text': texts.render(d.get('key')),
        'back': texts.render(d.get('value')),
        'path': [n for n in (texts.name(a) for a in ancestors) if n],
        'type': {1: 'concept', 2: 'descriptor', 6: 'portal'}.get(rem[0], ''),
        'isDocument': bool(info and (info[1] or info[2])),
        'created': rem[1],
        'edited': rem[2],
        'tags': [t for t in tags if t],
        'incremental': 'incremental' in powerups,
        'dismissed': 'dismissed' in powerups,
        # The hidden priorityValue slot, the visible priority as fallback (slot_access.ts).
        'priority': db.execute(f"SELECT COALESCE({prop_expr('?', 'cardpriority', 'priorityvalue')}, "
                               f"{prop_expr('?', 'cardpriority', 'priority')})", (rid, rid)).fetchone()[0],
        'incPriority': db.execute('SELECT ' + prop_expr('?', 'incremental', 'priority'), (rid,)).fetchone()[0],
        'incDue': (inc_due - today) if inc_due is not None else None,
    }


def rem_row(db, rid, alias, texts, causes):
    row = _common(db, rid, texts)
    if alias:
        row['aliasId'] = alias
    cards = db.execute('SELECT id, next_day, reps, lapses, ivl FROM cards WHERE rem = ?', (rid,)).fetchall()
    row.update(memory(db, f'c.rem = ? ORDER BY {r_sql(time.time() * 1000)} IS NULL, {r_sql(time.time() * 1000)} ASC',
                      rid))
    today = rs.today_day()
    due_days = [c[1] - today for c in cards if c[1] is not None]
    row.update(
        cards=len(cards),
        due=min(due_days) if due_days else None,
        reps=sum(c[2] or 0 for c in cards) if cards else None,
        lapses=sum(c[3] or 0 for c in cards) if cards else None,
        ivl=max((c[4] for c in cards if c[4] is not None), default=None),
        suppressed=sorted({causes[c[0]] for c in cards if c[0] in causes}),
    )
    return row


def memory(db, where, arg):
    """stability, difficulty, retrievability now and scheduler name of one card."""
    row = db.execute(
        f"""SELECT c.mem_s, c.mem_d, {r_sql(time.time() * 1000)},
                   (SELECT CASE WHEN x.id = (SELECT v FROM meta WHERE k = 'global_scheduler')
                                THEN 'Global Default' ELSE x.name END FROM schedulers x WHERE x.id = c.sched)
            FROM cards c WHERE {where} LIMIT 1""", (arg,)).fetchone()
    if not row:
        return {'stability': None, 'difficulty': None, 'retrievability': None, 'scheduler': None}
    return {'stability': row[0], 'difficulty': row[1], 'retrievability': row[2], 'scheduler': row[3]}


def card_row(db, cid, rid, texts, causes):
    row = _common(db, rid, texts)
    c = db.execute('SELECT kind, cloze, next_day, reps, lapses, ivl, ml, ny FROM cards WHERE id = ?', (cid,)).fetchone()
    cause = causes.get(cid)
    row.update(memory(db, 'c.id = ?', cid))
    row.update(
        cardId=cid,
        kind=c[0],
        due=(c[2] - rs.today_day()) if c[2] is not None else None,
        reps=c[3], lapses=c[4], ivl=c[5], ml=c[6], learnNew=bool(c[7]),
        suppressed=[cause] if cause else [],
    )
    return row


def main():
    ap = argparse.ArgumentParser(description='A page of Search & Browse rows for a query.')
    ap.add_argument('query')
    ap.add_argument('--kb', required=True)
    ap.add_argument('--mode', default='rems', choices=['rems', 'cards'])
    ap.add_argument('--sort', default='relevance', choices=sorted(SORTS))
    ap.add_argument('--desc', action='store_true')
    ap.add_argument('--limit', type=int, default=10)
    args = ap.parse_args()
    try:
        out = browse(args.kb, args.query, args.mode, args.sort, args.desc, 0, args.limit)
    except rs.SearchError as e:
        print(f'error ({e.kind}): {e.message}', file=sys.stderr)
        return 1
    print(json.dumps(out, ensure_ascii=False, indent=1))
    return 0


if __name__ == '__main__':
    sys.exit(main())
