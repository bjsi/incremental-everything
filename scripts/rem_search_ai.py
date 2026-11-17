"""
Plain language → a Search Engine query, with Claude (the AI helper's `claude -p`, on
the user's own subscription). Served by ai_ocr_helper.py as POST /search/ai, for the
✨ AI button of Search & Browse.

The instructions are ~/.incremental-remnote/ai-ocr/search-prompt.md, written from
DEFAULT_PROMPT the first time and re-read on every request, so they can be edited.
With the request go a few names from the knowledge base, so "the biology folder" can
become a real in: — its schedulers, its most-used tags, and its top documents and
folders — and nothing else. The answer is checked with the search's own parser; a query
that doesn't parse goes back to Claude once, with the error.
"""
import json
import re
from pathlib import Path

import rem_index
import rem_search

MAX_REQUEST_CHARS = 1000
MAX_TAGS = 60
MAX_DOCUMENTS = 150

DEFAULT_PROMPT = """You turn a request, written in plain language and in any language, into ONE query for the search engine of a RemNote knowledge base. Its syntax is Anki's.

Answer with JSON only, no prose, no code fence: {"query": "...", "mode": "rems" or "cards"}.
Use mode "cards" when the request is about cards (due, interval, lapses, ratings, stability…) and lists them one by one; otherwise "rems".

SYNTAX
- Words: all must match; each matches from its start (bow → bowsprit). Accents and capitals never matter.
- or, -word (not), (groups), "words side by side". AND binds tighter than OR: a b or c = (a b) or c.
- Quote a value with spaces: in:"Ship Handling", tag:"anki card".
- `*` = any part of a name in tag:, in:, parent:, source:, refs:, scheduler:, and in slot values.

KEYS
Where: in:<document or folder name> (it and everything under it; prefer in:*word* when unsure of the exact name), parent:<name> (direct children), path:<word> (word in an ancestor's name).
What: tag:<name>, tag:none, is:concept, is:descriptor, is:portal, is:document, is:folder, is:flashcard, is:image, is:pdf, is:website, is:incremental, is:dismissed, is:pdf-highlight, is:html-highlight, has:tag, has:alias, has:source, has:powerup:<name>.
Links: source:<name> (has it among its Sources), refs:<name> (its text references it), alias:<text>.
Dates: added:N (created in the last N days, 1 = today), edited:N (text written in the last N days).
Card state (a Rem matches when one of its cards does; card terms written together hold for the same card):
  is:due (next review time passed; overdue = is:due), is:new (never answered), is:review (answered), is:learn-new, is:disabled (= is:suspended), is:not-generated, is:paused (in a paused deck), is:suppressed (RemNote won't show it), suppressed:paused|ancestor|rem|table|direction|cloze|removed|other,
  card:forward|backward|cloze, ml:new|acquiring|growing|solidifying|retaining|notyetlearned,
  is:fsrs, is:sm2, scheduler:<name> (scheduler:global for the Global Default).
Card numbers (comparisons <, <=, >, >=, =, !=):
  prop:due (days from today to the next review: prop:due<=-30 = overdue by a month or more), prop:ivl (interval, days), prop:reps (answers), prop:lapses (times forgotten; "rated Again/Forgot at least once" = prop:lapses>=1), prop:s (FSRS stability, days), prop:d (difficulty 1-10), prop:r (retrievability now, 0-1).
History: rated:N (answered in the last N days), rated:N:forgot|hard|good|easy, introduced:N (first answered in the last N days).
Slots and properties: prop:priority (card priority 0-100, lower = more important), prop:incpriority, prop:incdue (IncRem next date, days from today); any other: owner.name:value or owner.name<number, where owner is a powerup or the tag that has the property (spaces don't matter), e.g. ankicard.book:pna*, *.chapter:3.

Convert units: 1 year = 365 days, 1 month = 30, 1 week = 7. Translate the request's conditions into keys; don't copy them as words.
A subject ("about squat", "de rebocadores") is WORDS to find, written in the singular so the prefix match also finds the plural (rebocador → rebocadores). Use in: only when the request names a folder, document, deck or book to search under. Use the NAMES list below to pick real tag, document and scheduler names; when the request names a place that is not listed, use in:*word*.

EXAMPLES
overdue cards with interval greater than 1 year, rated again at least once, in the biology folder → {"query": "is:due prop:ivl>365 prop:lapses>=1 in:*biology*", "mode": "cards"}
conceitos sem tag criados esta semana → {"query": "is:concept tag:none added:7", "mode": "rems"}
cloze cards I forgot this month about squat → {"query": "squat card:cloze rated:30:forgot", "mode": "cards"}
IncRems due today with priority better than 10 → {"query": "is:incremental prop:incdue<=0 prop:incpriority<10", "mode": "rems"}
cards hidden because they were switched off on purpose → {"query": "suppressed:rem", "mode": "cards"}
cartões sobre rebocadores que esqueci mais de duas vezes → {"query": "rebocador prop:lapses>2", "mode": "cards"}
"""


def prompt_file(home):
    return Path(home) / 'search-prompt.md'


def load_prompt(home):
    path = prompt_file(home)
    try:
        text = path.read_text()
        if text.strip():
            return text
    except OSError:
        pass
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(DEFAULT_PROMPT)
    return DEFAULT_PROMPT


def names(kb_id):
    """The names that let Claude point at real places: schedulers, most-used tags, top
    documents and folders (the first two levels)."""
    if rem_index.needs_build(kb_id):
        return {}
    db = rem_index.ready(kb_id)
    try:
        global_id = rem_index.meta(db, 'global_scheduler')
        schedulers = ['Global Default' if sid == global_id else (name or 'Unnamed scheduler')
                      for sid, name in db.execute('SELECT id, name FROM schedulers')]
        tags = [n for (n,) in db.execute(
            '''SELECT n.name FROM rem_tags t JOIN names n ON n.id = t.tag WHERE n.name <> ''
               GROUP BY t.tag ORDER BY COUNT(*) DESC LIMIT ?''', (MAX_TAGS,))]
        docs = [n for (n,) in db.execute(
            '''SELECT json_extract(doc, '$.r') FROM remsSearchInfos
               WHERE aliasId = id AND (json_extract(doc, '$.i') = 1 OR json_extract(doc, '$.l') = 1)
                 AND length(trim(ancestor_ids)) <= 17
               ORDER BY IFNULL((SELECT rank FROM remsSearchRanks r WHERE r.ftsRowId = remsSearchInfos.ftsRowId), 1e9)
               LIMIT ?''', (MAX_DOCUMENTS,)) if n]
        return {'schedulers': schedulers, 'tags': tags, 'documents': docs}
    finally:
        db.close()


def _parse_answer(reply):
    """(query, mode) from Claude's reply: JSON, possibly fenced; else the first line."""
    text = re.sub(r'^```[a-z]*\s*|\s*```$', '', reply.strip())
    match = re.search(r'\{.*\}', text, re.S)
    if match:
        try:
            data = json.loads(match.group(0))
            query = str(data.get('query') or '').strip()
            mode = data.get('mode') if data.get('mode') in ('rems', 'cards') else None
            if query:
                return query, mode
        except ValueError:
            pass
    line = next((ln.strip() for ln in text.splitlines() if ln.strip()), '')
    return line.strip('`'), None


def translate(kb_id, request, run_claude, home):
    """{'query', 'mode', 'model', 'valid', 'error'?} for a plain-language request."""
    request = (request or '').strip()
    if not request:
        raise ValueError('Write what you are looking for.')
    if len(request) > MAX_REQUEST_CHARS:
        raise ValueError(f'Keep the request under {MAX_REQUEST_CHARS} characters.')
    system = load_prompt(home)
    context = names(kb_id)
    lines = []
    if context:
        lines.append('NAMES in this knowledge base:')
        lines.append('Schedulers: ' + '; '.join(context.get('schedulers') or []))
        lines.append('Most-used tags: ' + '; '.join(context.get('tags') or []))
        lines.append('Top documents and folders: ' + '; '.join(context.get('documents') or []))
        lines.append('')
    lines.append('REQUEST: ' + request)
    reply, model = run_claude([{'type': 'text', 'text': '\n'.join(lines)}], system)
    query, mode = _parse_answer(reply)
    try:
        rem_search.parse(query)
        return {'query': query, 'mode': mode, 'model': model, 'valid': True}
    except rem_search.SearchError as e:
        retry = '\n'.join(lines + ['', f'Your query was: {query}',
                                   f'It does not parse: {e.message} Answer again with a corrected query.'])
        reply, model = run_claude([{'type': 'text', 'text': retry}], system)
        query2, mode2 = _parse_answer(reply)
        try:
            rem_search.parse(query2)
            return {'query': query2, 'mode': mode2 or mode, 'model': model, 'valid': True}
        except rem_search.SearchError as e2:
            return {'query': query2 or query, 'mode': mode2 or mode, 'model': model, 'valid': False, 'error': e2.message}
