#!/usr/bin/env python3
"""rem_search_ai.py with a stand-in for Claude.

    python3 scripts/test_rem_search_ai.py
"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rem_search_ai as ai  # noqa: E402

KB = '0123456789abcdef01234567'  # no index for it: no NAMES are sent


class Claude:
    def __init__(self, *replies):
        self.replies = list(replies)
        self.calls = []

    def __call__(self, content, system):
        self.calls.append((content[0]['text'], system))
        return self.replies.pop(0), 'claude-sonnet-test'


class SearchAiTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()

    def test_reply_shapes(self):
        self.assertEqual(ai._parse_answer('{"query": "is:due", "mode": "cards"}'), ('is:due', 'cards'))
        self.assertEqual(ai._parse_answer('```json\n{"query": "tag:x"}\n```'), ('tag:x', None))
        self.assertEqual(ai._parse_answer('`is:new card:cloze`'), ('is:new card:cloze', None))

    def test_translates_and_writes_the_prompt_file(self):
        claude = Claude('{"query": "is:due prop:ivl>365 prop:lapses>=1 in:*biology*", "mode": "cards"}')
        out = ai.translate(KB, 'overdue cards, interval over a year, forgotten at least once, in biology', claude, self.home)
        self.assertEqual(out, {'query': 'is:due prop:ivl>365 prop:lapses>=1 in:*biology*', 'mode': 'cards',
                               'model': 'claude-sonnet-test', 'valid': True})
        self.assertIn('REQUEST: overdue cards', claude.calls[0][0])
        self.assertTrue(ai.prompt_file(self.home).exists())
        self.assertEqual(claude.calls[0][1], ai.DEFAULT_PROMPT)

    def test_an_edited_prompt_is_used(self):
        ai.prompt_file(self.home).write_text('MY RULES')
        claude = Claude('{"query": "bow"}')
        ai.translate(KB, 'bow', claude, self.home)
        self.assertEqual(claude.calls[0][1], 'MY RULES')

    def test_an_invalid_query_goes_back_once(self):
        claude = Claude('{"query": "bow ("}', '{"query": "bow"}')
        out = ai.translate(KB, 'bow', claude, self.home)
        self.assertEqual((out['query'], out['valid']), ('bow', True))
        self.assertIn('does not parse', claude.calls[1][0])
        claude = Claude('{"query": "bow ("}', '{"query": "(bow"}')
        out = ai.translate(KB, 'bow', claude, self.home)
        self.assertFalse(out['valid'])
        self.assertIn('never closed', out['error'])

    def test_requests_are_checked(self):
        with self.assertRaises(ValueError):
            ai.translate(KB, '  ', Claude(), self.home)
        with self.assertRaises(ValueError):
            ai.translate(KB, 'x' * 2000, Claude(), self.home)


if __name__ == '__main__':
    unittest.main()
