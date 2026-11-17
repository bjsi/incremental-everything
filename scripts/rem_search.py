#!/usr/bin/env python3
"""
Search a knowledge base with an Anki-style query, read-only, straight from remnote.db.

Served by ai_ocr_helper.py as POST /search; also a command line for tests:

    python3 scripts/rem_search.py --kb <knowledge base id> 'bow weather wave'
    python3 scripts/rem_search.py --kb <id> 'bow (wave or sea) -tug in:"Wärtsilä Encyclopedia"' --json

Why it exists: the plugin can only search through RemNote, whose worker always ORs the
words and keeps the best 1,000 by a rank that ignores the query, so a Rem holding every
word you typed can be dropped before the plugin sees it. See plans/implemented/SEARCH_ENGINE_PLAN.md.

The grammar is Anki's (docs-site/manual/searching.mdx, rslib/src/search/parser.rs):
spaces mean AND, `or`, `-` excludes, brackets group, "…" is a phrase, `key:value` and
`key:"…"`, `\\` escapes. AND binds tighter than OR: `a b or c` = `(a b) or c`.

Terms (plans/implemented/SEARCH_ENGINE_PLAN.md §4):
    word            a word starting with it (RemNote's index is word-based)
    "two words"     the words side by side
    w:word          that whole word
    alias:text      only through one of the Rem's aliases
    in:<name|id>    the Rem and everything under it; a name matches every Rem named so,
                    and `*` matches part of a name (in:*M23*): the documents and folders
                    it matches, or, when there are none, any Rem (up to 200)
    parent:<name|id> their direct children (names as for in:)
    path:text       text in the names of the ancestors
  needing the helper's own index (rem_index.py):
    tag:name        tagged with it (`*` wildcards; tag:none = no tag); a powerup's
                    name or code counts too, as RemNote shows powerups as tags
    is:concept|descriptor|portal|document|folder|flashcard|image|pdf|incremental|
       dismissed|pdf-highlight|html-highlight
    has:alias|source|tag|powerup:<code or name>
    source:<name|id>  has that Rem among its Sources (names as for in:, `*` matched
                    among the Rems that are someone's Source)
    refs:<name|id>  its text references that Rem (`*` among referenced Rems)
    id:a,b,c        these Rems
    added:N, edited:N  created / text edited in the last N days (1 = today)
    owner.name:text   a slot or property value: owner is a powerup's code or name, or
                    the property's tag, `*` for any; text is exact (folded) with `*` and
                    `_` wildcards; `owner.name:` empty, `owner.name:_*` not empty
    owner.name<5    numeric (<, <=, >, >=, =, !=); a date value compares in days from
                    today (`incremental.nextrepdate<=0` = due)
    prop:priority<20, prop:incpriority, prop:incdue  shortcuts for the plugin's slots
  cards (a Rem matches when one of its cards does; card terms ANDed together must
  hold for the same card, so `is:due card:cloze` is a due cloze card):
    card:forward|backward|cloze
    is:due (next time passed, not in a paused deck), is:new (no answer since the
       last Reset), is:review, is:learn-new, is:disabled (= is:suspended: RemNote
       won't show it), is:not-generated (its cloze or back is gone, history kept)
    is:paused       under a paused deck (the nearest deck above decides)
    is:suppressed   a card RemNote won't put in a queue, for any reason
    suppressed:paused|ancestor|rem|table|direction|cloze|removed|other  why, one
                    cause per card, decided in the order of the Weighted Shield's
                    Suppressed Cards tab: paused deck, an ancestor's Disable
                    Descendant Cards, cards off on the Rem (table rows and cells
                    apart), direction off, cloze switched off (`dci`), text removed
    ml:new|acquiring|growing|solidifying|retaining|notyetlearned
    prop:due<=-7    days from today to the next time; prop:ivl, prop:reps, prop:lapses
    prop:s>21, prop:d>7, prop:r<0.8  FSRS stability (days), difficulty (1-10) and
                    retrievability now (0-1), from a replay with the card's own
                    scheduler (rem_index.py, fsrs.py); none for SM-2 cards
    scheduler:vocabulary, scheduler:global, is:fsrs, is:sm2  the card's scheduler (a name
                    matches from its start; `*` for any part)
    rated:7, rated:7:forgot|hard|good|easy (or 1-4, Anki's buttons), rated:7:skip
    introduced:30   first answered in the last 30 days
    cid:a,b         these cards
Any other `x:y` is plain text, so "3:30" or a pasted "Note: …" still search as words.

The text index (remsContents) is RemNote's own: lower-case, accents and clozes removed,
references appended at the END of a Rem's text, and one row per alias.
"""
import argparse
import datetime
import json
import re
import sqlite3
import sys
import time
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import history_archive  # noqa: E402  (KB paths, read-only open)
import rem_index  # noqa: E402  (the helper's own index, for structural terms)

DEFAULT_LIMIT = 200
MAX_LIMIT = 2000
REM_ID_RE = re.compile(r'^[A-Za-z0-9]{17}$')

# Keys that belong to a later phase: a clear error rather than a silent text search.
LATER_KEYS = {'sort'}
NAME_KEYS = {'in', 'parent'}
INDEX_KEYS = {'tag', 'is', 'has', 'source', 'refs', 'id', 'added', 'edited', 'field', 'card', 'scheduler'}

# is: values. Read from RemNote's search record (s.doc), the Rem's type, or a powerup.
IS_DOC_FLAGS = {'document': 'i', 'folder': 'l', 'flashcard': 'fl', 'image': 'g', 'pdf': 'd', 'website': 'w'}
IS_TYPES = {'concept': 1, 'descriptor': 2, 'portal': 6}
IS_POWERUPS = {'incremental': ['incremental'], 'dismissed': ['dismissed'], 'pdf-highlight': ['n'],
               'html-highlight': ['hh', 'vh'], 'web-highlight': ['p']}
# is: values about cards: (SQL over the card `c`, whether due cards in paused decks are left out)
IS_CARD = {
    'due': ('c.next IS NOT NULL AND c.next <= :now', True),
    'new': ('c.reps = 0 AND c.nogen = 0', False),
    'review': ('c.reps > 0 AND c.nogen = 0', False),
    'learn-new': ('c.ny = 1', False),
    'disabled': ('c.next IS NULL AND c.nogen = 0', False),
    'suspended': ('c.next IS NULL AND c.nogen = 0', False),
    'not-generated': ('c.nogen = 1', False),
    'fsrs': ("c.sched IN (SELECT id FROM schedulers WHERE type = 'fsrs')", False),
    'sm2': ("c.sched IN (SELECT id FROM schedulers WHERE type = 'sm2')", False),
}
IS_ALL = sorted([*IS_DOC_FLAGS, *IS_TYPES, *IS_POWERUPS, *IS_CARD, 'paused', 'suppressed'])
SUPPRESSED = ['paused', 'ancestor', 'rem', 'table', 'direction', 'cloze', 'removed', 'other']
# A card's cause once paused decks and disabling ancestors are ruled out (card `c`, its
# Rem `r`); `c.next IS NULL` is RemNote's mark of a card it won't show.
CARD_CAUSE = """CASE
    WHEN c.next IS NOT NULL THEN NULL
    WHEN r.forget = 1 OR c.rem IN (SELECT rem FROM rem_powerups WHERE code = 'u')
        THEN CASE WHEN r.in_table = 1 THEN 'table' ELSE 'rem' END
    WHEN (c.kind = 'forward' AND r.efc = 1) OR (c.kind = 'backward' AND IFNULL(r.back_sr, 0) = 0)
        THEN 'direction'
    WHEN c.kind = 'cloze' AND instr(IFNULL(r.dci, ''), '"' || c.cloze || '"') > 0 THEN 'cloze'
    WHEN c.nogen = 1 THEN 'removed'
    ELSE 'other' END"""
CARD_KINDS = {'forward', 'backward', 'cloze'}
MASTERY = {'new', 'acquiring', 'growing', 'solidifying', 'retaining', 'notyetlearned'}
# Retrievability now, from the card's FSRS memory state (rem_index: mem_s, decay,
# mem_last): R = (1 + factor · t / S)^decay, factor = 0.9^(1/decay) − 1, t in days.
R_SQL = ('(CASE WHEN c.mem_s IS NULL OR c.mem_s <= 0 THEN NULL ELSE '
         'pow(1 + (pow(0.9, 1.0 / c.decay) - 1) * ((:now - c.mem_last) / 86400000.0) / c.mem_s, c.decay) END)')
CARD_PROPS = {'due': 'c.next_day - :today', 'ivl': 'c.ivl', 'reps': 'c.reps', 'lapses': 'c.lapses',
              's': 'c.mem_s', 'd': 'c.mem_d', 'r': R_SQL}
RATINGS = {'forgot': 0, 'again': 0, '1': 0, 'hard': 0.5, '2': 0.5, 'good': 1, '3': 1, 'easy': 1.5, '4': 1.5,
           'skip': 0.01}

# prop: shortcuts → (owner, name) in the index's squashed form.
CARD_PRIORITY_NEWEST = ("(SELECT p.num FROM props p WHERE p.rem = {rem} AND p.owner = 'cardpriority'"
                        " AND p.name = '{name}' ORDER BY p.at DESC LIMIT 1)")
NUMBER_RE = re.compile(r'^-?\d+(?:\.\d+)?$')
PROP_ALIASES = {'priority': ('cardpriority', 'priority'), 'incpriority': ('incremental', 'priority'),
                'incdue': ('incremental', 'nextrepdate')}
COMPARE_RE = re.compile(r'^(.+?)(<=|>=|!=|<|>|=)(-?\d+(?:\.\d+)?)$')


class SearchError(Exception):
    """A query that can't be run. `kind` is stable for the plugin; `at` is the character
    offset in the query where the problem starts, when there is one."""

    def __init__(self, kind, message, at=None):
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.at = at

    def to_json(self):
        out = {'kind': self.kind, 'message': self.message}
        if self.at is not None:
            out['at'] = self.at
        return out


# ---------------------------------------------------------------------------
# Text normalization: the same folding RemNote's index applies
# ---------------------------------------------------------------------------

def fold(text):
    """Lower-case, accents removed (ä → a, ç → c), whitespace collapsed."""
    decomposed = unicodedata.normalize('NFKD', text)
    stripped = ''.join(ch for ch in decomposed if not unicodedata.combining(ch))
    return re.sub(r'\s+', ' ', stripped.lower()).strip()


def words(text):
    """The index's tokens: runs of letters and digits."""
    return re.findall(r'[^\W_]+', fold(text))


def fts_term(text, mode):
    """One FTS5 expression. Every token is double-quoted, so nothing typed can act as an
    FTS operator. `prefix`: the last word may continue (`bow` → bowsprit); `phrase`:
    exact words side by side; `word`: exact words."""
    toks = words(text)
    if not toks:
        return None
    quoted = '"' + ' '.join(toks) + '"'
    return quoted + '*' if mode == 'prefix' else quoted


# ---------------------------------------------------------------------------
# Parser (after Anki's parser.rs)
# ---------------------------------------------------------------------------

@dataclass
class Term:
    kind: str           # 'text' | 'in' | 'parent' | 'path' | INDEX_KEYS
    value: str
    mode: str = 'prefix'  # text: 'prefix' | 'phrase' | 'word'
    alias_only: bool = False
    at: int = 0
    owner: str = ''     # field: squashed owner, '*' for any
    name: str = ''      # field: squashed slot or property name
    op: str = ''        # field: '' for a text match, else a comparison
    num: float = 0.0


@dataclass
class Not:
    node: object


@dataclass
class And:
    nodes: list = field(default_factory=list)


@dataclass
class Or:
    nodes: list = field(default_factory=list)


AND, OR = object(), object()
SPACES = ' 　'


class Parser:
    def __init__(self, query):
        self.q = re.sub(r'\s', ' ', query)
        self.i = 0

    def fail(self, kind, message, at=None):
        raise SearchError(kind, message, self.i if at is None else at)

    def skip_ws(self):
        while self.i < len(self.q) and self.q[self.i] in SPACES:
            self.i += 1

    def parse(self):
        self.skip_ws()
        if self.i >= len(self.q):
            raise SearchError('empty', 'Type something to search for.')
        node = self.group_inner()
        self.skip_ws()
        if self.i < len(self.q):  # only an unmatched ')' is left unconsumed
            self.fail('unopened-group', 'This ")" has no "(" before it.')
        return node

    def group_inner(self):
        """Nodes up to a ')' or the end, with implicit ANDs; returns one tree node."""
        items = []
        while True:
            self.skip_ws()
            if self.i >= len(self.q) or self.q[self.i] == ')':
                break
            start = self.i
            item = self.node()
            if len(items) % 2 == 0:
                if item is AND:
                    self.fail('misplaced-and', '"and" needs a search term on each side.', start)
                if item is OR:
                    self.fail('misplaced-or', '"or" needs a search term on each side.', start)
            elif item is not AND and item is not OR:
                items.append(AND)
            items.append(item)
        if items and (items[-1] is AND or items[-1] is OR):
            self.fail('misplaced-and' if items[-1] is AND else 'misplaced-or',
                      f'"{"and" if items[-1] is AND else "or"}" needs a search term on each side.')
        # AND binds tighter than OR, as in Anki's SQL.
        groups, current = [], []
        for item in items:
            if item is OR:
                groups.append(current)
                current = []
            elif item is not AND:
                current.append(item)
        groups.append(current)
        ands = [g[0] if len(g) == 1 else And(g) for g in groups if g]
        if not ands:
            return None
        return ands[0] if len(ands) == 1 else Or(ands)

    def node(self):
        c = self.q[self.i]
        if c == '-':
            self.i += 1
            if self.i >= len(self.q) or self.q[self.i] in SPACES:
                self.fail('lone-minus', 'Put the word to leave out right after "-".')
            inner = self.group() if self.q[self.i] == '(' else self.text()
            if inner is AND or inner is OR:
                self.fail('lone-minus', 'Put the word to leave out right after "-".')
            return Not(inner)
        if c == '(':
            return self.group()
        return self.text()

    def group(self):
        start = self.i
        self.i += 1  # '('
        inner = self.group_inner()
        if self.i >= len(self.q) or self.q[self.i] != ')':
            self.fail('unclosed-group', 'This "(" is never closed.', start)
        self.i += 1
        if inner is None:
            self.fail('empty-group', 'These brackets are empty.', start)
        return inner

    def quoted(self):
        """A "…" string at self.i; returns its unescaped content."""
        start = self.i
        self.i += 1
        out = []
        while self.i < len(self.q):
            c = self.q[self.i]
            if c == '\\' and self.i + 1 < len(self.q):
                out.append(self.q[self.i + 1])
                self.i += 2
                continue
            if c == '"':
                self.i += 1
                if not out:
                    self.fail('empty-quote', 'These quotes are empty.', start)
                return ''.join(out)
            out.append(c)
            self.i += 1
        self.fail('unclosed-quote', 'This quote is never closed.', start)

    def text(self):
        start = self.i
        if self.q[self.i] == '"':
            return self.term_for(self.quoted(), start, quoted=True)
        raw, key_end = [], None
        while self.i < len(self.q):
            c = self.q[self.i]
            if c in SPACES or c in '()':
                break
            if c == '"':
                # key:"value with spaces"
                if key_end is not None and key_end == len(raw):
                    value = self.quoted()
                    return self.keyed(''.join(raw[:key_end - 1]), value, start, quoted=True)
                break
            if c == '\\':
                if self.i + 1 >= len(self.q):
                    self.fail('unknown-escape', 'A "\\" at the end has nothing to escape.')
                raw.append(self.q[self.i + 1])
                self.i += 2
                continue
            if c == ':' and key_end is None:
                key_end = len(raw) + 1
            raw.append(c)
            self.i += 1
        word = ''.join(raw)
        if not word:
            self.fail('parse', 'Unexpected character.')
        if word.lower() == 'and':
            return AND
        if word.lower() == 'or':
            return OR
        if key_end is not None:
            return self.keyed(word[:key_end - 1], word[key_end:], start, quoted=False)
        return self.term_for(word, start, quoted=False)

    def term_for(self, text, at, quoted):
        # As in Anki, a quoted term can still be a search key: "tag:anki card".
        if quoted:
            key, sep, value = text.partition(':')
            if sep and key and (key.lower() in INDEX_KEYS | NAME_KEYS | {'w', 'alias', 'path', 'prop'} or '.' in key):
                return self.keyed(key, value, at, quoted=True)
            compare = COMPARE_RE.match(text)
            if compare and '.' in compare.group(1):
                return self.field_compare(compare, at)
        elif ':' not in text:
            compare = COMPARE_RE.match(text)
            if compare and '.' in compare.group(1):
                return self.field_compare(compare, at)
        if not words(text):
            self.fail('no-words', f'"{text}" has no letters or digits to search for.', at)
        # A quoted term is a phrase; an unquoted one with inner punctuation
        # ("under-keel", "6.4") is its words side by side, the last one a prefix.
        return Term('text', text, mode='phrase' if quoted else 'prefix', at=at)

    def keyed(self, key, value, at, quoted):
        k = key.lower()
        if k == 'w':
            if not words(value):
                self.fail('no-words', 'Put a word after "w:".', at)
            return Term('text', value, mode='word', at=at)
        if k == 'alias':
            if not words(value):
                self.fail('no-words', 'Put the alias text after "alias:".', at)
            return Term('text', value, mode='phrase' if quoted else 'prefix', alias_only=True, at=at)
        if k in NAME_KEYS:
            if not value.strip():
                self.fail('missing-value', f'Put a Rem name or id after "{k}:".', at)
            return Term(k, value.strip(), at=at)
        if k == 'path':
            if not words(value):
                self.fail('no-words', 'Put a word after "path:".', at)
            return Term('path', value, at=at)
        if k == 'tag':
            if not value.strip():
                self.fail('missing-value', 'Put a tag name after "tag:" (or tag:none).', at)
            return Term('tag', value.strip(), at=at)
        if k == 'is':
            v = value.strip().lower()
            if v in IS_CARD:
                return Term('card', v, at=at, name='is')
            if v not in IS_DOC_FLAGS and v not in IS_TYPES and v not in IS_POWERUPS and v not in ('paused', 'suppressed'):
                self.fail('unknown-value', f'"is:{value}" is not known. Try is:{", is:".join(IS_ALL)}.', at)
            return Term('is', v, at=at)
        if k == 'suppressed':
            v = value.strip().lower()
            if v not in SUPPRESSED:
                self.fail('unknown-value', f'Try suppressed:{", suppressed:".join(SUPPRESSED)}, or is:suppressed.', at)
            return Term('is', 'suppressed:' + v, at=at)
        if k == 'card':
            v = value.strip().lower()
            if v not in CARD_KINDS:
                self.fail('unknown-value', 'Try card:forward, card:backward or card:cloze.', at)
            return Term('card', v, at=at, name='kind')
        if k == 'ml':
            v = value.strip().lower().replace(' ', '').replace('-', '')
            if v not in MASTERY:
                self.fail('unknown-value', f'Try ml:{", ml:".join(sorted(MASTERY))}.', at)
            return Term('card', v, at=at, name='ml')
        if k in ('rated', 'introduced'):
            days, _, rating = value.strip().partition(':')
            if not re.fullmatch(r'\d{1,5}', days) or int(days) < 1:
                self.fail('bad-number', f'{k}: takes a number of days, 1 for today, as in {k}:7.', at)
            if rating and (k == 'introduced' or rating.lower() not in RATINGS):
                self.fail('unknown-value', 'Try rated:7:forgot, rated:7:hard, rated:7:good, rated:7:easy '
                          '(or 1 to 4, as Anki\'s buttons) or rated:7:skip.', at)
            return Term('card', rating.lower(), at=at, name=k, num=float(days))
        if k == 'scheduler':
            if not value.strip():
                self.fail('missing-value', 'Put a scheduler name after "scheduler:" (or scheduler:global).', at)
            return Term('card', value.strip(), at=at, name='scheduler')
        if k == 'cid':
            ids = [i for i in re.split(r'[,\s]+', value.strip()) if i]
            if not ids or not all(REM_ID_RE.match(i) for i in ids):
                self.fail('bad-id', 'cid: takes card ids separated by commas.', at)
            return Term('card', ','.join(ids), at=at, name='cid')
        if k == 'has':
            v = value.strip()
            if v.lower() in ('alias', 'source', 'tag'):
                return Term('has', v.lower(), at=at)
            if v.lower().startswith('powerup:') and v[8:].strip():
                return Term('has', 'powerup', at=at, owner=v[8:].strip())
            self.fail('unknown-value', 'Try has:alias, has:source, has:tag or has:powerup:<name or code>.', at)
        if k in ('source', 'refs'):
            if not value.strip():
                self.fail('missing-value', f'Put a Rem name or id after "{k}:".', at)
            return Term(k, value.strip(), at=at)
        if k == 'id':
            ids = [i for i in re.split(r'[,\s]+', value.strip()) if i]
            if not ids or not all(REM_ID_RE.match(i) for i in ids):
                self.fail('bad-id', 'id: takes Rem ids separated by commas.', at)
            return Term('id', ','.join(ids), at=at)
        if k in ('added', 'edited'):
            if not re.fullmatch(r'\d{1,5}', value.strip()) or int(value) < 1:
                self.fail('bad-number', f'{k}: takes a number of days, 1 for today.', at)
            return Term(k, value.strip(), at=at, num=float(value))
        if k == 'prop':
            compare = COMPARE_RE.match(value.strip())
            if compare and compare.group(1).strip().lower() in CARD_PROPS:
                return Term('card', compare.group(1).strip().lower(), at=at, name='prop', op=compare.group(2),
                            num=float(compare.group(3)))
            alias = PROP_ALIASES.get((compare.group(1) if compare else value.split(':')[0]).strip().lower())
            if not compare or not alias:
                self.fail('unknown-value', 'Try prop:due, prop:ivl, prop:reps, prop:lapses, prop:s, prop:d, prop:r '
                          '(cards), prop:priority, '
                          'prop:incpriority or prop:incdue (the plugin\'s slots), as in prop:due<=0; '
                          'for any other slot or property, write owner.name<5 or owner.name:text.', at)
            return Term('field', value, at=at, owner=alias[0], name=alias[1], op=compare.group(2),
                        num=float(compare.group(3)))
        if k in LATER_KEYS:
            self.fail('not-yet', f'"{key}:" is planned but not available yet.', at)
        if '.' in k:
            owner, _, name = key.rpartition('.')
            if not owner or not rem_index.squash(name):
                self.fail('missing-value', f'"{key}:" needs owner.name, like incremental.priority:20.', at)
            return Term('field', value, at=at, owner='*' if owner.strip() == '*' else rem_index.squash(owner),
                        name=rem_index.squash(name))
        # Not a search key: the whole thing is text ("3:30", "Note: …").
        return self.term_for(f'{key}:{value}', at, quoted)


    def field_compare(self, compare, at):
        owner, _, name = compare.group(1).rpartition('.')
        if not owner or not rem_index.squash(name):
            self.fail('missing-value', f'"{compare.group(1)}" needs owner.name, like incremental.priority<20.', at)
        return Term('field', compare.group(0), at=at, owner='*' if owner.strip() == '*' else rem_index.squash(owner),
                    name=rem_index.squash(name), op=compare.group(2), num=float(compare.group(3)))


def needs_index(node):
    if isinstance(node, (And, Or)):
        return any(needs_index(n) for n in node.nodes)
    if isinstance(node, Not):
        return needs_index(node.node)
    return node.kind in INDEX_KEYS


def parse(query):
    if not isinstance(query, str):
        raise SearchError('empty', 'Type something to search for.')
    return Parser(query).parse()


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

REQUIRED = {
    'remsContents': set(),  # FTS5: pragma table_info lists only `data`
    'remsSearchInfos': {'ftsRowId', 'aliasId', 'id', 'doc', 'ancestor_ids', 'ancestor_not_ref_text'},
    'remsSearchRanks': {'ftsRowId', 'rank'},
}


def open_kb(kb_id, db_path=None):
    path = Path(db_path) if db_path else history_archive.remnote_db_path(kb_id)
    if not path.exists():
        raise SearchError('no-database', f'No RemNote database for knowledge base {kb_id}.')
    db = history_archive.open_remnote(path)
    check_schema(db)
    return db


def check_schema(db):
    """RemNote changed its storage before; fail clearly instead of returning nonsense."""
    for table, cols in REQUIRED.items():
        have = {row[1] for row in db.execute(f'PRAGMA table_info({table})')}
        if not have:
            raise SearchError('schema', f'RemNote\'s search index has changed (no table {table}).')
        missing = cols - have
        if missing:
            raise SearchError('schema', f'RemNote\'s search index has changed ({table} lacks {", ".join(sorted(missing))}).')


MAX_SCOPES = 200       # in:/parent: with a wildcard: Rems whose subtrees are ORed
MAX_TARGETS = 2000     # source:/refs: with a wildcard


def resolve_rems(db, key, value, at, indexed=False):
    """{Rem id: its ancestor_ids} for `key:value`: one id, every Rem named exactly
    `value` (folded), or, with `*` in `value`, every Rem whose name matches it. For
    source: and refs: on the helper's index (`indexed`), names are matched among the
    Rems that are a Source or are referenced, which the index keeps (ms); otherwise
    among every Rem's name in RemNote's search index (~0.3 s)."""
    if REM_ID_RE.match(value):
        row = db.execute('SELECT ancestor_ids FROM remsSearchInfos WHERE id = ? LIMIT 1', (value,)).fetchone()
        if row or key in ('source', 'refs'):
            return {value: (row[0] if row else '') or ''}
        raise SearchError('not-found', f'No Rem has the id {value}.', at)
    name = fold(value)
    if '*' in name:
        _, pattern = like_or_equal(name)
        if indexed and key in ('source', 'refs'):
            rows = db.execute(
                """SELECT DISTINCT id, '' FROM names WHERE name LIKE ? ESCAPE '\\'
                   AND id IN (SELECT target FROM refs WHERE kind = ?)""",
                (pattern, 'source' if key == 'source' else 'text')).fetchall()
        else:
            # Documents and folders first, as they are what one searches under (Anki's
            # decks): *miguens* names 53 of them and 1,074 Rems in all. Any Rem only
            # when no document matches.
            scan = """SELECT DISTINCT id, ancestor_ids FROM remsSearchInfos
                      WHERE json_extract(doc, '$.r') LIKE ? ESCAPE '\\'"""
            rows = db.execute(scan + " AND (json_extract(doc, '$.i') = 1 OR json_extract(doc, '$.l') = 1)",
                              (pattern,)).fetchall()
            if not rows:
                rows = db.execute(scan, (pattern,)).fetchall()
        found = {rid: anc or '' for rid, anc in rows}
        if not found:
            raise SearchError('not-found', f'No Rem name matches "{value}".', at)
        cap = MAX_TARGETS if key in ('source', 'refs') else MAX_SCOPES
        if len(found) > cap:
            raise SearchError('too-many', f'{key}:{value} matches {len(found):,} Rems; make the name more '
                              f'precise (at most {cap}).', at)
        return found
    expr = fts_term(value, 'phrase')
    found = {}
    if expr:
        for rid, anc, raw in db.execute(
                """SELECT s.id, s.ancestor_ids, json_extract(s.doc, '$.r') FROM remsSearchInfos s
                   WHERE s.ftsRowId IN (SELECT rowid FROM remsContents WHERE remsContents MATCH ?)""", (expr,)):
            if fold(raw or '') == name:
                found.setdefault(rid, anc or '')
    if not found:
        raise SearchError('not-found', f'No Rem is named exactly "{value}". For part of a name, use * '
                          f'({key}:*{value}*).', at)
    return found


# ---------------------------------------------------------------------------
# Compiler: tree → one SQL condition over remsSearchInfos s (after Anki's sqlwriter.rs)
# ---------------------------------------------------------------------------

FTS_IN = 's.ftsRowId IN (SELECT rowid FROM remsContents WHERE remsContents MATCH ?)'


class Compiler:
    def __init__(self, db):
        self.db = db
        self.args = []
        self.rank_terms = []  # positive text terms, for relevance

    def compile(self, node, negated=False):
        if isinstance(node, And):
            return self.compile_and(node.nodes, negated)
        if isinstance(node, Or):
            return '(' + ' OR '.join(self.compile(n, negated) for n in node.nodes) + ')'
        if isinstance(node, Not):
            return f'NOT ({self.compile(node.node, not negated)})'
        return self.leaf(node, negated)

    def compile_and(self, nodes, negated):
        # Card terms ANDed together must hold for the same card: one subquery.
        cards = [n for n in nodes if isinstance(n, Term) and n.kind == 'card']
        if len(cards) > 1:
            others = [n for n in nodes if not (isinstance(n, Term) and n.kind == 'card')]
            card_sql = self.card_terms(cards)
            if not others:
                return card_sql
            nodes = others
            parts_prefix = [card_sql]
        else:
            parts_prefix = []
        # Plain text terms ANDed together become ONE MATCH: FTS intersects them itself,
        # much faster than one IN (…) per word.
        merged = [n for n in nodes if isinstance(n, Term) and n.kind == 'text' and not n.alias_only]
        rest = [n for n in nodes if n not in merged]
        parts = []
        if len(merged) > 1:
            exprs = [fts_term(n.value, n.mode) for n in merged]
            self.args.append(' AND '.join(exprs))
            if not negated:
                self.rank_terms.extend(exprs)
            parts.append(FTS_IN)
        else:
            rest = nodes
        parts += [self.compile(n, negated) for n in rest]
        return '(' + ' AND '.join(parts_prefix + parts) + ')'

    def leaf(self, term, negated):
        if term.kind == 'text':
            expr = fts_term(term.value, term.mode)
            self.args.append(expr)
            if not negated:
                self.rank_terms.append(expr)
            return f'({FTS_IN} AND s.aliasId <> s.id)' if term.alias_only else FTS_IN
        if term.kind == 'in':
            # Every Rem the name matches, with everything under each of them: one
            # indexed range of ancestor_ids per scope, UNIONed. ORing the ranges in
            # the WHERE instead keeps SQLite off the index (1.9 s for 11 scopes).
            scopes = resolve_rems(self.db, 'in', term.value, term.at)
            ranges = []
            for rid, anc in scopes.items():
                prefix = f'{anc} {rid}'
                self.args += [prefix, prefix + '~']
                ranges.append('SELECT ftsRowId FROM remsSearchInfos WHERE ancestor_ids >= ? AND ancestor_ids < ?')
            ids = list(scopes)
            self.args += ids
            return (f"(s.ftsRowId IN ({' UNION ALL '.join(ranges)})"
                    f" OR s.id IN ({','.join('?' * len(ids))}))")
        if term.kind == 'parent':
            ids = list(resolve_rems(self.db, 'parent', term.value, term.at))
            self.args += ids
            return f"json_extract(s.doc, '$.p') IN ({','.join('?' * len(ids))})"
        if term.kind == 'path':
            conds = []
            for tok in words(term.value):
                self.args.append(f'% {tok}%')
                conds.append("(' ' || IFNULL(s.ancestor_not_ref_text, '')) LIKE ?")
            return '(' + ' AND '.join(conds) + ')'
        return self.index_leaf(term)

    # --- terms answered by the helper's index (rem_index.py) -------------------

    def card_terms(self, terms):
        """Rems with one card meeting every term, minus paused decks for is:due."""
        conds, skip_paused = [], False
        for t in terms:
            cond, args, paused = self.card_cond(t)
            conds.append(cond)
            self.args += args
            skip_paused = skip_paused or paused
        sql = f"s.id IN (SELECT c.rem FROM cards c WHERE {' AND '.join(conds)})"
        if skip_paused:
            sql = f'({sql} AND NOT {self.paused_sql()})'
        return sql

    def card_cond(self, t):
        """(SQL over the card `c`, its arguments, whether paused decks are left out)."""
        named = {':now': int(time.time() * 1000), ':today': today_day()}

        def bind(sql):
            args = []
            for name in re.findall(r':now|:today', sql):
                args.append(named[name])
            return re.sub(r':now|:today', '?', sql), args

        if t.name == 'is':
            sql, paused = IS_CARD[t.value]
            sql, args = bind(sql)
            return f'({sql})', args, paused
        if t.name == 'kind':
            return 'c.kind = ?', [t.value], False
        if t.name == 'ml':
            return "replace(lower(c.ml), ' ', '') = ?", [t.value], False
        if t.name == 'prop':
            expr, args = bind(CARD_PROPS[t.value])
            return f'({expr}) {t.op} ?', [*args, t.num], False
        if t.name == 'rated':
            start = days_ago_ms(int(t.num))
            if t.value:
                return ('c.id IN (SELECT card FROM reps WHERE date >= ? AND score = ?)',
                        [start, RATINGS[t.value]], False)
            return ('c.id IN (SELECT card FROM reps WHERE date >= ? AND score IN (0, 0.5, 1, 1.5))',
                    [start], False)
        if t.name == 'introduced':
            return 'c.first_rep >= ?', [days_ago_ms(int(t.num))], False
        if t.name == 'cid':
            ids = t.value.split(',')
            return f'c.id IN ({",".join("?" * len(ids))})', ids, False
        if t.name == 'scheduler':
            name = fold(t.value)
            if name in ('global', 'default', 'global default'):
                return "c.sched = (SELECT v FROM meta WHERE k = 'global_scheduler')", [], False
            # A name matches from its start: scheduler:vocabulary is "Vocabulary (FSRS default)".
            cmp, pattern = like_or_equal(name if '*' in name else name + '*')
            return (f'c.sched IN (SELECT id FROM schedulers WHERE lower(name) {cmp} OR id = ?)',
                    [pattern, t.value], False)
        raise SearchError('parse', f'Unknown card term {t.name}.')

    def paused_sql(self):
        """Rems whose nearest deck is paused (findings/CARD_STATE_REFERENCE.md): inside a
        paused deck's subtree, minus the subtrees of decks that aren't paused and sit
        directly below it."""
        if getattr(self, '_paused', None) is None:
            decks = {}  # deck id → (paused?, ancestor_ids)
            for rid in [r[0] for r in self.db.execute("SELECT rem FROM rem_powerups WHERE code = 'de'")]:
                row = self.db.execute('SELECT ancestor_ids FROM remsSearchInfos WHERE id = ? LIMIT 1',
                                      (rid,)).fetchone()
                decks[rid] = [False, (row[0] if row else '') or '']
            for (rid,) in self.db.execute(
                    """SELECT p.rem FROM props p WHERE p.owner = 'de' AND p.name = 's' AND p.text = 'paused'
                       AND NOT EXISTS (SELECT 1 FROM props q WHERE q.rem = p.rem AND q.owner = p.owner
                                       AND q.name = p.name AND q.at > p.at)"""):
                if rid in decks:
                    decks[rid][0] = True
            clauses, args = [], []
            for pid, (paused, anc) in decks.items():
                if not paused:
                    continue
                prefix = f'{anc} {pid}'
                holes = []
                for aid, (a_paused, a_anc) in decks.items():
                    if a_paused or pid not in a_anc.split():
                        continue
                    nearest = next((x for x in reversed(a_anc.split()) if x in decks), None)
                    if nearest == pid:
                        holes.append(f'{a_anc} {aid}')
                clause = '((s.id = ? OR (s.ancestor_ids >= ? AND s.ancestor_ids < ?))'
                args += [pid, prefix, prefix + '~']
                for h in holes:
                    clause += ' AND NOT (s.ancestor_ids >= ? AND s.ancestor_ids < ?) AND s.id <> ?'
                    args += [h, h + '~', h.split()[-1]]
                clauses.append(clause + ')')
            self._paused = ('(' + ' OR '.join(clauses) + ')' if clauses else '(0)', args)
        sql, args = self._paused
        self.args += args
        return sql

    def ancestor_disabled_sql(self):
        """Rems strictly below a Rem with Disable Descendant Cards (powerup `u`)."""
        ranges, args = [], []
        for (rid,) in self.db.execute("SELECT rem FROM rem_powerups WHERE code = 'u'"):
            row = self.db.execute('SELECT ancestor_ids FROM remsSearchInfos WHERE id = ? LIMIT 1', (rid,)).fetchone()
            prefix = f"{(row[0] if row else '') or ''} {rid}"
            ranges.append('SELECT ftsRowId FROM remsSearchInfos WHERE ancestor_ids >= ? AND ancestor_ids < ?')
            args += [prefix, prefix + '~']
        if not ranges:
            return '(0)'
        self.args += args
        return f"(s.ftsRowId IN ({' UNION ALL '.join(ranges)}))"

    def suppressed_sql(self, cause):
        """is:suppressed (cause '') or suppressed:<cause>: one cause per card, in the
        Suppressed Cards tab's order (lib/card_analytics_export.ts classifyUnscheduled)."""
        has_card = 's.id IN (SELECT rem FROM cards)'
        hidden = 's.id IN (SELECT c.rem FROM cards c WHERE c.next IS NULL)'
        if cause == '':
            return f'(({self.paused_sql()} AND {has_card}) OR {hidden})'
        if cause == 'paused':
            return f'({self.paused_sql()} AND {has_card})'
        not_paused = f'NOT {self.paused_sql()}'
        if cause == 'ancestor':
            return f'({not_paused} AND {self.ancestor_disabled_sql()} AND {hidden})'
        not_ancestor = f'NOT {self.ancestor_disabled_sql()}'
        self.args.append(cause)
        return (f'({not_paused} AND {not_ancestor} AND s.id IN (SELECT c.rem FROM cards c '
                f'JOIN rems r ON r.id = c.rem WHERE ({CARD_CAUSE}) = ?))')

    def card_priority_sql(self, term):
        """Card priority as the plugin reads it (src/lib/card_priority/slot_access.ts):
        the hidden `priorityValue` slot, the visible `priority` as fallback. 1,913 Rems
        hold different values in the two (Nov 2026); the hidden one is the priority."""
        value = f"COALESCE({CARD_PRIORITY_NEWEST.format(rem='r.rem', name='priorityvalue')}, " \
                f"{CARD_PRIORITY_NEWEST.format(rem='r.rem', name='priority')})"
        if term.op:
            cond, args = f'{value} {term.op} ?', [term.num]
        elif term.value == '':
            cond, args = f'{value} IS NULL', []
        elif term.value == '*':
            cond, args = '1', []
        else:
            cond, args = f'{value} = ?', [float(term.value) if NUMBER_RE.match(term.value) else term.value]
        self.args += args
        return ("s.id IN (SELECT r.rem FROM (SELECT DISTINCT rem FROM props WHERE owner = 'cardpriority'"
                f" AND name IN ('priorityvalue', 'priority')) r WHERE {cond})")

    def index_leaf(self, term):
        k = term.kind
        if k == 'card':
            return self.card_terms([term])
        if k == 'tag':
            if term.value.lower() == 'none':
                return 's.id NOT IN (SELECT rem FROM rem_tags)'
            cmp, pattern = like_or_equal(fold(term.value))
            self.args += [pattern, pattern, pattern.replace(' ', '')]
            return (f'(s.id IN (SELECT rem FROM rem_tags WHERE tag IN (SELECT id FROM names WHERE name {cmp}))'
                    f' OR s.id IN (SELECT rem FROM rem_powerups WHERE code IN'
                    f' (SELECT code FROM powerups WHERE name {cmp} OR lower(code) {cmp})))')
        if k == 'is':
            v = term.value
            if v == 'paused':
                return self.paused_sql()
            if v == 'suppressed' or v.startswith('suppressed:'):
                return self.suppressed_sql(v.partition(':')[2])
            if v in IS_DOC_FLAGS:
                return f"json_extract(s.doc, '$.{IS_DOC_FLAGS[v]}') = 1"
            if v in IS_TYPES:
                self.args.append(IS_TYPES[v])
                return 's.id IN (SELECT id FROM rems WHERE type = ?)'
            codes = IS_POWERUPS[v]
            self.args += codes
            return f's.id IN (SELECT rem FROM rem_powerups WHERE code IN ({",".join("?" * len(codes))}))'
        if k == 'has':
            if term.value == 'alias':
                return 'EXISTS (SELECT 1 FROM remsSearchInfos a WHERE a.id = s.id AND a.aliasId <> a.id)'
            if term.value == 'source':
                self.args += list(rem_index.SOURCES)
                return 's.id IN (SELECT rem FROM props WHERE owner = ? AND name = ?)'
            if term.value == 'tag':
                return 's.id IN (SELECT rem FROM rem_tags)'
            name = fold(term.owner)
            self.args += [name, name.replace(' ', '')]
            return ('s.id IN (SELECT rem FROM rem_powerups WHERE code IN'
                    ' (SELECT code FROM powerups WHERE name = ? OR lower(code) = ?))')
        if k in ('source', 'refs'):
            ids = list(resolve_rems(self.db, k, term.value, term.at, indexed=True))
            self.args += [*ids, 'source' if k == 'source' else 'text']
            return f's.id IN (SELECT rem FROM refs WHERE target IN ({",".join("?" * len(ids))}) AND kind = ?)'
        if k == 'id':
            ids = term.value.split(',')
            self.args += ids
            return f's.id IN ({",".join("?" * len(ids))})'
        if k in ('added', 'edited'):
            self.args.append(days_ago_ms(int(term.num)))
            col = 'created' if k == 'added' else 'edited'
            return f's.id IN (SELECT id FROM rems WHERE {col} >= ?)'
        if k == 'field' and term.owner == 'cardpriority' and term.name == 'priority':
            return self.card_priority_sql(term)
        if k == 'field':
            owner_sql = ''
            if term.owner != '*':
                # The owner as written, or a powerup whose name squashes to it.
                owner_sql = (' AND (p.owner = ? OR p.owner IN (SELECT lower(code) FROM powerups'
                             " WHERE replace(replace(name, ' ', ''), '-', '') = ?))")
            if term.op:
                cond = f'(CASE WHEN p.day IS NOT NULL THEN p.day - ? ELSE p.num END) {term.op} ?'
                args = [today_day(), term.num]
            else:
                raw = term.value
                if raw == '':
                    cond, args = "IFNULL(p.text, '') = ''", []
                elif raw == '*':
                    cond, args = '1', []
                else:
                    cmp, pattern = like_or_equal(fold(raw), underscore=True)
                    cond, args = f'p.text {cmp}', [pattern]
            self.args.append(term.name)
            if owner_sql:
                self.args += [term.owner, term.owner]
            self.args += args
            # A slot kept in two places (`ps` and a property child) counts once: the
            # copy written last (see rem_index.py, props).
            current = ('NOT EXISTS (SELECT 1 FROM props q WHERE q.rem = p.rem'
                       ' AND q.owner = p.owner AND q.name = p.name AND q.at > p.at)')
            return f"s.id IN (SELECT p.rem FROM props p WHERE p.name = ?{owner_sql} AND {cond} AND {current})"
        raise SearchError('parse', f'Unknown term {k}.')


def like_or_equal(text, underscore=False):
    """('= ?', text), or a LIKE with its pattern when `text` has `*` (any run) or, for
    slot values as in Anki, `_` (one character). Literal % and \\ are escaped."""
    wild = '*' in text or (underscore and '_' in text)
    if not wild:
        return '= ?', text
    pattern = text.replace('\\', '\\\\').replace('%', '\\%').replace('*', '%')
    if not underscore:
        pattern = pattern.replace('_', '\\_')
    return "LIKE ? ESCAPE '\\'", pattern


def today_day():
    return rem_index.epoch_day(datetime.date.today())


def days_ago_ms(days):
    """Local midnight `days - 1` days ago, in ms: 1 = since this morning."""
    start = datetime.datetime.combine(datetime.date.today() - datetime.timedelta(days=days - 1), datetime.time())
    return int(start.timestamp() * 1000)


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------

def open_index_for_search(kb_id, db_path=None, index_file=None, wait=True):
    """The helper's index, current, with remnote.db attached: RemNote's tables resolve
    by name in the attached database, so the same SQL runs on either connection.
    `wait=False` (the helper): a missing or outdated index is built in the background
    and this search is answered with `index-building`, since a build takes ~20 s."""
    path = Path(db_path) if db_path else history_archive.remnote_db_path(kb_id)
    if not path.exists():
        raise SearchError('no-database', f'No RemNote database for knowledge base {kb_id}.')
    if not wait and (rem_index.is_building(kb_id) or rem_index.needs_build(kb_id, index_file)):
        rem_index.build_in_background(kb_id, path, index_file)
        raise SearchError('index-building', 'The helper is indexing this knowledge base for tag:, is:, prop: '
                          'and the other keys (about 20 seconds, once). Try again in a moment.')
    try:
        db = rem_index.ready(kb_id, path, index_file)
    except sqlite3.Error as e:
        raise SearchError('index', f'The search index could not be read: {e}.') from e
    check_schema(db)
    return db


def match(db, tree):
    """Every Rem the query tree matches, best first: [(remId, aliasId or None)], plus
    the Compiler (its card terms are what browse lists in card mode)."""
    compiler = Compiler(db)
    where = compiler.compile(tree)
    try:
        rows = db.execute(
            f'''SELECT s.id, s.aliasId, s.ftsRowId, IFNULL(r.rank, 1e9)
                FROM remsSearchInfos s LEFT JOIN remsSearchRanks r ON r.ftsRowId = s.ftsRowId
                WHERE {where}''',
            compiler.args).fetchall()
    except sqlite3.OperationalError as e:
        raise SearchError('query', f'The search could not run: {e}.') from e

    # One result per Rem. Its own row wins over an alias row; an alias-only match
    # reports which alias, so a reference can be made to show it.
    by_rem = {}
    for rid, alias_id, fts_row, static in rows:
        own = alias_id == rid
        prev = by_rem.get(rid)
        if prev is None or (own and not prev['own']) or (own == prev['own'] and static < prev['static']):
            by_rem[rid] = {'own': own, 'alias': None if own else alias_id, 'row': fts_row, 'static': static}

    # Relevance: score every row the positive words match and keep the result rows.
    # Asking FTS for scores of a list of rowids is ~300× slower than this (measured:
    # 600 ms vs 2 ms for 505 rows; a one-letter word scores 159k rows in 92 ms).
    relevance = {}
    if compiler.rank_terms and rows:
        match_expr = ' OR '.join(dict.fromkeys(compiler.rank_terms))
        wanted = {v['row'] for v in by_rem.values()}
        for row_id, score in db.execute(
                'SELECT rowid, bm25(remsContents) FROM remsContents WHERE remsContents MATCH ?', (match_expr,)):
            if row_id in wanted:
                relevance[row_id] = score
    ordered = sorted(by_rem.items(), key=lambda kv: (relevance.get(kv[1]['row'], 0.0), kv[1]['static']))
    return [(rid, v['alias']) for rid, v in ordered], compiler


def search(kb_id, query, limit=DEFAULT_LIMIT, db_path=None, index_file=None, wait=True):
    """{results: [{remId, aliasId?}], total, ms}; raises SearchError."""
    started = time.time()
    tree = parse(query)
    limit = max(1, min(int(limit or DEFAULT_LIMIT), MAX_LIMIT))
    if needs_index(tree):
        db = open_index_for_search(kb_id, db_path, index_file, wait)
    else:
        db = open_kb(kb_id, db_path)
    try:
        hits, _ = match(db, tree)
        results = []
        for rid, alias in hits[:limit]:
            item = {'remId': rid}
            if alias:
                item['aliasId'] = alias
            results.append(item)
        return {'results': results, 'total': len(hits), 'ms': int((time.time() - started) * 1000)}
    finally:
        db.close()


def card_causes(kb_id, db_path=None, index_file=None, wait=True):
    """Every card RemNote won't put in a queue, with its cause: {cardId: cause} where
    cause is one of SUPPRESSED, or 'missing' when the card's Rem is gone. Also the Rems
    in a table among them. For the Weighted Shield's Suppressed Cards tab, which
    otherwise infers the causes Rem by Rem through the plugin bridge."""
    db = open_index_for_search(kb_id, db_path, index_file, wait)
    try:
        comp = Compiler(db)
        paused = comp.paused_sql()
        ancestor = comp.ancestor_disabled_sql()
        sql = f"""SELECT id, rem, cause, in_table FROM (
                    SELECT c.id, c.rem, r.in_table,
                      CASE WHEN r.id IS NULL THEN 'missing'
                           WHEN {paused} THEN 'paused'
                           WHEN c.next IS NULL AND {ancestor} THEN 'ancestor'
                           ELSE ({CARD_CAUSE}) END AS cause
                    FROM cards c
                    LEFT JOIN rems r ON r.id = c.rem
                    LEFT JOIN remsSearchInfos s ON s.id = c.rem AND s.aliasId = s.id)
                  WHERE cause IS NOT NULL"""
        causes, in_table = {}, set()
        for cid, rem, cause, tab in db.execute(sql, comp.args):
            causes[cid] = cause
            if tab:
                in_table.add(rem)
        return {'causes': causes, 'inTable': sorted(in_table)}
    finally:
        db.close()


def main():
    ap = argparse.ArgumentParser(description='Search a RemNote knowledge base with an Anki-style query.')
    ap.add_argument('query')
    ap.add_argument('--kb', required=True, help='knowledge base id (the remnote-<id> folder)')
    ap.add_argument('--db', help='a remnote.db to read instead of the KB\'s own')
    ap.add_argument('--limit', type=int, default=20)
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()
    try:
        out = search(args.kb, args.query, args.limit, args.db)
    except SearchError as e:
        print(json.dumps({'error': e.to_json()}) if args.json else f'error ({e.kind}): {e.message}', file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(out, ensure_ascii=False))
        return 0
    db = open_kb(args.kb, args.db)
    for item in out['results']:
        row = db.execute("SELECT json_extract(doc, '$.r') FROM remsSearchInfos WHERE id = ? AND aliasId = ?",
                         (item['remId'], item.get('aliasId') or item['remId'])).fetchone()
        text = (row[0] if row else '') or ''
        print(f"{item['remId']}{' (alias)' if item.get('aliasId') else ''}  {text[:100]}")
    print(f"{out['total']} Rems in {out['ms']} ms")
    return 0


if __name__ == '__main__':
    sys.exit(main())
