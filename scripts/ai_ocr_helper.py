#!/usr/bin/env python3
"""
AI transcription helper for Incremental RemNote PDF highlights (prototype).

A RemNote plugin runs in a sandboxed iframe and cannot start programs, so it
POSTs a highlight's geometry here. This helper renders exactly that region of
the PDF, hands the image to the user's own `claude` CLI (their subscription —
no API key involved) and returns KaTeX/markdown-ish markup for the plugin to
write back as rich text.

It also locates quotes in a PDF (`/locate`), so the plugin can pin a passage's
source highlight without the user selecting it.

    python3 scripts/ai_ocr_helper.py          # listens on 127.0.0.1:3457

Requires PyMuPDF (`pip install pymupdf`) and a logged-in `claude` CLI.

Environment:
    IR_AI_PORT      port (default 3457)
    IR_AI_MODEL     claude model alias (default sonnet)
    IR_AI_ORIGINS   comma-separated allowed Origin headers; unset = allow all
                    (and log each Origin so it can be pinned)

Files live in ~/.incremental-remnote/ai-ocr/:
    prompt.md       the transcription instructions — edit freely, re-read per request
    requests.log    one JSON line per request (includes the raw highlight Data)
    crops/          the last image sent for each highlight
    pdf-cache/      downloaded PDFs
"""
import base64
import difflib
import hashlib
import json
import os
import re
import shutil
import ssl
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pymupdf

PORT = int(os.environ.get('IR_AI_PORT', '3457'))
MODEL = os.environ.get('IR_AI_MODEL', 'sonnet')
ALLOWED_ORIGINS = {o.strip() for o in os.environ.get('IR_AI_ORIGINS', '').split(',') if o.strip()}

HOME = Path.home() / '.incremental-remnote' / 'ai-ocr'
PDF_CACHE = HOME / 'pdf-cache'
CROPS = HOME / 'crops'
LOG = HOME / 'requests.log'
PROMPT_FILE = HOME / 'prompt.md'

DPI = 220
# PDF points of margin around the highlight box. Vertical is larger: a line's
# selection box stops at the text baseline area, while fraction denominators and
# subscripts of display formulae hang below it.
PAD_X, PAD_Y = 6, 14

DEFAULT_PROMPT = r"""Extract text from the images I provide. Do not acknowledge the request, do not comment, and do not ask questions: output the transcription, marked up as below, and nothing else.

The output goes into a single RemNote rem. Never break lines inside a paragraph; separate paragraphs, and set each display formula apart, with one blank line.

Formulae, in KaTeX:
- inline (inside a sentence): $x$
- display (on its own line in the image): $$x$$
- numbered equations use \tag with the number shown in the image
- ALWAYS write a formula containing \tag as display ($$...$$). KaTeX renders \tag only in display mode; written inline it fails and shows the raw source in red.
- words inside formulae are enclosed in \text{} for better rendering.

Lists: keep each item's own marker exactly as printed (•, –, 1., a), …), one item per line, separated by a single line break — no blank line between items. Never use markdown list syntax (* or - as a bullet): write the printed marker itself, e.g. "• geometrical similarity;".

Emphasis — the reader skims these Rems later, so mark what matters:
- Put the passage's key terms and key concepts in **bold**, even when the page does not emphasise them: usually one to three per paragraph, each a word or a short phrase, never a whole sentence.
- Keep the emphasis the page itself prints: italics as *italic*, bold as **bold**.
- An emphasised phrase may contain a formula (**state variables $x_i$**), but never put ** or * inside a formula's $...$.

Use no other markup: no headings, no code, no links.

If part of the image is illegible, transcribe what you can and mark the gap inline as [illegible].
"""


def log(entry):
    with open(LOG, 'a') as f:
        f.write(json.dumps(entry, ensure_ascii=False) + '\n')


def prompt():
    if not PROMPT_FILE.exists():
        PROMPT_FILE.write_text(DEFAULT_PROMPT)
    return PROMPT_FILE.read_text()


def find_claude():
    # launchd and GUI launches carry a minimal PATH, so check the usual install spots too.
    found = shutil.which('claude')
    for candidate in [found, Path.home() / '.local/bin/claude', '/opt/homebrew/bin/claude', '/usr/local/bin/claude']:
        if candidate and Path(candidate).exists():
            return str(candidate)
    return None


def ssl_context():
    """python.org builds of Python ship without trusted certificates until their
    "Install Certificates" step is run, so HTTPS downloads fail. Use certifi's
    bundle when it is installed; otherwise the default context."""
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


LOCAL_FILE = '%LOCAL_FILE%'
REMNOTE_FILES_URL = 'https://remnote-user-data.s3.amazonaws.com/'
REMNOTE_DATA = Path.home() / 'remnote'
# The knowledge base the current request comes from, set per request thread in
# do_POST. Local copies are looked up only in that KB's folder: another KB's
# folder is not the user's current collection, and vanishes when it is deleted.
REQUEST = threading.local()


def fetch(url, suffix):
    """Local path for a file:// URL, else a cached download. The cache key drops
    the query string so re-signed URLs for the same file hit the cache.

    RemNote stores uploads as `%LOCAL_FILE%<name>`, a placeholder for its S3
    prefix; the desktop app keeps the file itself in ~/remnote/remnote-<kbId>/files/,
    one folder per knowledge base."""
    # A PDF's Text Reader HTML is referenced by its full storage URL instead of
    # the placeholder, but the desktop app keeps a local copy under the same name.
    name = None
    if url.startswith(LOCAL_FILE):
        name = url[len(LOCAL_FILE):]
    elif url.startswith(REMNOTE_FILES_URL):
        name = urllib.parse.urlsplit(url).path.lstrip('/')
    if name:
        kb_id = getattr(REQUEST, 'kb_id', None)
        if kb_id and re.fullmatch(r'[0-9A-Za-z]+', kb_id) and re.fullmatch(r'[\w.-]+', name):
            local = REMNOTE_DATA / f'remnote-{kb_id}' / 'files' / name
            if local.exists():
                return local
        url = REMNOTE_FILES_URL + name
    if url.startswith('file://'):
        return Path(urllib.parse.unquote(urllib.parse.urlsplit(url).path))
    parts = urllib.parse.urlsplit(url)
    key = hashlib.sha1(f'{parts.netloc}{parts.path}'.encode()).hexdigest()
    path = PDF_CACHE / f'{key}{suffix}'
    if not path.exists():
        tmp = path.with_suffix('.part')
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=120, context=ssl_context()) as resp, open(tmp, 'wb') as out:
            shutil.copyfileobj(resp, out)
        tmp.rename(path)
    return path


# ---------------------------------------------------------------------------
# /ocr — transcribe a highlight's region
# ---------------------------------------------------------------------------

def page_boxes(data):
    """Highlight Data -> [(pageNumber, (x1, y1, x2, y2) as page fractions)].

    RemNote stores each rect in the coordinates of a page viewport whose size is
    saved alongside it (width/height), so dividing by that size gives fractions
    that are independent of the zoom the highlight was made at. `rects` holds one
    box per line and may span pages; `boundingRect` is the fallback."""
    pos = data.get('position') or {}
    rects = [r for r in (pos.get('rects') or []) if r] or [pos.get('boundingRect')]
    boxes = {}
    for r in rects:
        if not r:
            continue
        page = r.get('pageNumber') or pos.get('pageNumber')
        w, h = r.get('width'), r.get('height')
        if not page or not w or not h:
            continue
        box = (r['x1'] / w, r['y1'] / h, r['x2'] / w, r['y2'] / h)
        prev = boxes.get(page)
        boxes[page] = box if not prev else (
            min(prev[0], box[0]), min(prev[1], box[1]), max(prev[2], box[2]), max(prev[3], box[3]))
    return sorted(boxes.items())


def render_crops(pdf_path, boxes, rem_id):
    doc = pymupdf.open(pdf_path)
    images = []
    for page_number, (fx1, fy1, fx2, fy2) in boxes:
        page = doc[page_number - 1]
        size = page.rect
        clip = pymupdf.Rect(fx1 * size.width - PAD_X, fy1 * size.height - PAD_Y,
                            fx2 * size.width + PAD_X, fy2 * size.height + PAD_Y) & size
        png = page.get_pixmap(clip=clip, dpi=DPI).tobytes('png')
        (CROPS / f'{rem_id}-p{page_number}.png').write_bytes(png)
        images.append(png)
    return images


def bullets_to_markers(text):
    """A markdown `* ` bullet would reach the rich-text converter as the opening
    of an italic run, so write it as the printed bullet character instead."""
    lines = []
    for line in text.split('\n'):
        body = line.lstrip()
        if body.startswith('* '):
            line = line[:len(line) - len(body)] + '• ' + body[2:]
        lines.append(line)
    return '\n'.join(lines)


def transcribe(images, raw_text):
    content = [{'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/png',
                                            'data': base64.b64encode(img).decode()}} for img in images]
    if raw_text.strip():
        instruction = (
            'The image shows the region of a PDF page around one highlight. The PDF viewer extracted '
            'this text for the highlight — its spacing and formulae are garbled, but its words mark '
            'exactly where the highlight starts and ends:\n<raw>\n' + raw_text.strip() + '\n</raw>\n'
            'Transcribe only that passage: drop anything in the image before its first words or after its last words.')
    else:
        instruction = 'Transcribe the image.'
    content.append({'type': 'text', 'text': instruction})
    message = json.dumps({'type': 'user', 'message': {'role': 'user', 'content': content}})

    claude = find_claude()
    if not claude:
        raise RuntimeError('claude CLI not found')
    # No --bare: it only accepts ANTHROPIC_API_KEY, never the subscription login.
    # Instead strip everything a transcription does not need: tools, MCP servers,
    # settings files (and so hooks) and session persistence.
    cmd = [claude, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
           '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence',
           '--model', MODEL, '--system-prompt', prompt()]
    proc = subprocess.run(cmd, input=message + '\n', capture_output=True, text=True, timeout=240, cwd=HOME)
    model = None  # the model the CLI actually resolved the alias to, reported in its init event
    for line in proc.stdout.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get('type') == 'system' and event.get('subtype') == 'init':
            model = event.get('model')
        if event.get('type') == 'result':
            if event.get('is_error'):
                raise RuntimeError(event.get('result') or 'claude reported an error')
            return bullets_to_markers(event.get('result', '').strip()), model
    raise RuntimeError(f'claude exited {proc.returncode}: {proc.stderr.strip()[-400:]}')


# ---------------------------------------------------------------------------
# /locate — find a quote's words on the page
# ---------------------------------------------------------------------------

MIN_SCORE = 0.6       # share of the quote's words that must match
MAX_GAP_TOKENS = 6    # unmatched page words tolerated inside one match
EDGE_TOKENS = 3       # unmatched words at either end of a quote taken back into the match
EDGE_SIMILARITY = 0.5 # ...only when each resembles the quote word it stands for ("5e20" ~ "520")
# Line-end hyphens that split a word across lines: ASCII, soft hyphen (the one
# typeset PDFs usually carry, "pros­" + "seguir"), Unicode hyphen, non-breaking hyphen.
LINE_HYPHENS = ('-', '­', '‐', '‑')
PDF_LOCK = threading.Lock()  # a PyMuPDF document is not safe across threads
_open_pdfs = {}       # path -> (mtime, document, {page index: (words, tokens)})


def open_pdf(path):
    mtime = path.stat().st_mtime
    cached = _open_pdfs.get(str(path))
    if cached and cached[0] == mtime:
        return cached
    entry = (mtime, pymupdf.open(path), {})
    _open_pdfs[str(path)] = entry
    return entry


def norm_token(text):
    return re.sub(r'\W', '', unicodedata.normalize('NFKC', text).lower())


def page_tokens(entry, index):
    """The page's words (x0, y0, x1, y1, text, block, line, word) plus matchable
    tokens, each mapped to the word indices it came from. A word hyphenated
    across a line break becomes one token, so "tur-" + "bulence" matches."""
    cache = entry[2]
    if index not in cache:
        words = entry[1][index].get_text('words')
        tokens = []
        i = 0
        while i < len(words):
            word = words[i]
            text, indices = word[4], [i]
            following = words[i + 1] if i + 1 < len(words) else None
            if text.endswith(LINE_HYPHENS) and following and (following[5], following[6]) != (word[5], word[6]):
                text, indices = text[:-1] + following[4], [i, i + 1]
            token = norm_token(text)
            if token:
                tokens.append((token, indices))
            i += len(indices)
        cache[index] = (words, tokens)
    return cache[index]


def best_span(tokens, quote):
    """(first token, last token, score, matched) of the best match of `quote` in
    `tokens`. Exact first; otherwise the densest cluster of matching blocks, scored
    by the share of quote words matched over the longer of quote and span.

    `matched` is how many of the quote's OWN words matched. It is what to compare
    candidates by: a fuzzy span can stretch over unrelated words to reach a few
    that recur further down, which inflates the span but not `matched`."""
    seq = [t for t, _ in tokens]
    n = len(quote)
    for start in range(len(seq) - n + 1):
        if seq[start:start + n] == quote:
            return start, start + n - 1, 1.0, n
    blocks = [b for b in difflib.SequenceMatcher(None, seq, quote, autojunk=False).get_matching_blocks() if b.size]
    if not blocks:
        return None
    clusters, current = [], [blocks[0]]
    for block in blocks[1:]:
        last = current[-1]
        if block.a - (last.a + last.size) <= MAX_GAP_TOKENS:
            current.append(block)
        else:
            clusters.append(current)
            current = [block]
    clusters.append(current)
    cluster = max(clusters, key=lambda c: sum(b.size for b in c))
    start, end = cluster[0].a, cluster[-1].a + cluster[-1].size - 1
    matched = sum(b.size for b in cluster)
    score = matched / max(n, end - start + 1)
    # The text layer often garbles a quote's first or last token ("5–20%" reads
    # "5e20%"), which leaves it out of the match. Take unmatched edge words back
    # in — but only while each resembles the quote word it stands for. A leading
    # "3." that the source renders as list numbering, not text, must not pull in
    # the last word of the passage before it.
    lead = cluster[0].b
    k = 1
    while k <= min(lead, EDGE_TOKENS) and start > 0 and similar_tokens(seq[start - 1], quote[lead - k]):
        start -= 1
        k += 1
    trail = n - (cluster[-1].b + cluster[-1].size)
    k = 0
    while k < min(trail, EDGE_TOKENS) and end + 1 < len(seq) and similar_tokens(seq[end + 1], quote[n - trail + k]):
        end += 1
        k += 1
    return start, end, score, matched


def similar_tokens(a, b):
    return difflib.SequenceMatcher(None, a, b, autojunk=False).ratio() >= EDGE_SIMILARITY


def locate_quote(entry, quote, page_hint):
    page_count = entry[1].page_count
    wanted = [t for t in (norm_token(w) for w in quote.split()) if t]
    if not wanted:
        return {'found': False, 'reason': 'empty quote'}
    def search(pages, best=None):
        for page_number in pages:
            if not 1 <= page_number <= page_count:
                continue
            words, tokens = page_tokens(entry, page_number - 1)
            span = best_span(tokens, wanted)
            if span and (best is None or span[2] > best[0][2]):
                best = (span, page_number, words, tokens)
                if span[2] == 1.0:
                    break
        return best

    all_pages = range(1, page_count + 1)
    if page_hint:
        # A cited page can be off (printed page labels, a model's slip): search
        # around it first, then the whole document if that finds nothing good.
        best = search([page_hint + d for d in (0, 1, -1, 2, -2)])
        if not best or best[0][2] < MIN_SCORE:
            best = search(all_pages, best)
    else:
        best = search(all_pages)
    if not best or best[0][2] < MIN_SCORE:
        return {'found': False, 'score': round(best[0][2], 3) if best else 0}

    (start, end, score, matched), page_number, words, tokens = best
    first, last = tokens[start][1][0], tokens[end][1][-1]
    page = entry[1][page_number - 1]
    span_words = [{'i': k, 'x1': words[k][0], 'y1': words[k][1], 'x2': words[k][2], 'y2': words[k][3],
                   'line': f'{words[k][5]}-{words[k][6]}', 'text': words[k][4]} for k in range(first, last + 1)]
    return {'found': True, 'page': page_number, 'score': round(score, 3), 'matched': matched,
            'pageWidth': page.rect.width, 'pageHeight': page.rect.height,
            'words': span_words, 'text': ' '.join(w['text'] for w in span_words)}


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

def handle_ocr(req, entry):
    rem_id = req.get('remId') or 'unknown'
    data = req.get('data')
    data = json.loads(data) if isinstance(data, str) else (data or {})
    raw_text = req.get('rawText') or ''
    entry.update(remId=rem_id, pdfUrl=req.get('pdfUrl'), data=data, rawText=raw_text[:300])

    image_url = (data.get('content') or {}).get('imageUrl')
    if image_url:
        # Area highlight: RemNote already stored the snapshot.
        images = [fetch(image_url, '.img').read_bytes()]
        raw_text = ''
    else:
        boxes = page_boxes(data)
        if not boxes:
            raise RuntimeError('highlight Data has no usable position')
        if not req.get('pdfUrl'):
            raise RuntimeError('no PDF URL')
        images = render_crops(fetch(req['pdfUrl'], '.pdf'), boxes, rem_id)
        entry['boxes'] = boxes

    markup, model = transcribe(images, raw_text)
    entry.update(model=model, markup=markup)
    return {'markup': markup}


def handle_locate(req, entry):
    if not req.get('pdfUrl'):
        raise RuntimeError('no PDF URL')
    quotes = req.get('quotes') or []
    path = fetch(req['pdfUrl'], '.pdf')
    with PDF_LOCK:
        pdf = open_pdf(path)
        results = [locate_quote(pdf, q.get('quote') or '', q.get('page')) for q in quotes]
        page_count = pdf[1].page_count
    entry.update(pdfUrl=req['pdfUrl'], quotes=[{'quote': (q.get('quote') or '')[:120], 'page': q.get('page')} for q in quotes],
                 results=[{k: r.get(k) for k in ('found', 'page', 'score', 'matched')} for r in results])
    return {'pageCount': page_count, 'results': results}


def handle_source(req, entry):
    """Text of a source file (a saved web article's HTML), resolving RemNote's
    %LOCAL_FILE% placeholder like the PDF routes do."""
    url = req.get('url')
    if not url:
        raise RuntimeError('no url')
    entry['url'] = url
    return {'text': fetch(url, '.html').read_text(encoding='utf-8', errors='replace')}


def handle_match(req, entry):
    """Match quotes against a word list the plugin extracted from a source it
    parses itself (an HTML article's DOM). Returns word-index spans, using the
    same matcher as /locate so PDF and HTML sources behave alike."""
    words = req.get('words') or []
    quotes = req.get('quotes') or []
    tokens = [(token, [i]) for i, token in ((i, norm_token(w)) for i, w in enumerate(words)) if token]
    results = []
    for q in quotes:
        wanted = [t for t in (norm_token(w) for w in (q.get('quote') or '').split()) if t]
        span = best_span(tokens, wanted) if wanted and tokens else None
        if not span or span[2] < MIN_SCORE:
            results.append({'found': False, 'score': round(span[2], 3) if span else 0})
        else:
            start, end, score, matched = span
            results.append({'found': True, 'start': tokens[start][1][0], 'end': tokens[end][1][-1],
                            'score': round(score, 3), 'matched': matched})
    entry.update(words=len(words), quotes=[(q.get('quote') or '')[:120] for q in quotes],
                 results=[{k: r.get(k) for k in ('found', 'score', 'matched')} for r in results])
    return {'results': results}


ROUTES = {'/ocr': handle_ocr, '/locate': handle_locate, '/source': handle_source, '/match': handle_match}


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        # Chromium's Private Network Access preflight for requests into localhost.
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_json(204, {})

    def do_GET(self):
        if self.path == '/':
            return self.send_json(200, {'ok': True, 'claude': find_claude(), 'model': MODEL})
        self.send_json(404, {'ok': False, 'error': 'POST /ocr or /locate'})

    def do_POST(self):
        route = ROUTES.get(self.path)
        if not route:
            return self.send_json(404, {'ok': False, 'error': 'POST /ocr or /locate'})
        origin = self.headers.get('Origin')
        if ALLOWED_ORIGINS and origin not in ALLOWED_ORIGINS:
            log({'at': time.time(), 'route': self.path, 'origin': origin, 'rejected': True})
            return self.send_json(403, {'ok': False, 'error': f'origin not allowed: {origin}'})

        started = time.time()
        entry = {'at': started, 'route': self.path, 'origin': origin}
        try:
            req = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
            # One thread per request: fetch() reads the knowledge base from here.
            REQUEST.kb_id = req.get('kbId')
            entry['kbId'] = REQUEST.kb_id
            payload = route(req, entry)
            ms = int((time.time() - started) * 1000)
            entry.update(ok=True, ms=ms)
            print(f'[ai-ocr] {self.path} ok in {ms} ms', flush=True)
            self.send_json(200, {'ok': True, 'ms': ms, **payload})
        except Exception as e:  # noqa: BLE001 — every failure goes back to the plugin as a toast
            entry.update(ok=False, error=str(e))
            print(f'[ai-ocr] {self.path} error: {e}', file=sys.stderr, flush=True)
            self.send_json(500, {'ok': False, 'error': str(e)})
        finally:
            log(entry)

    def log_message(self, *args):
        pass


def main():
    for d in (HOME, PDF_CACHE, CROPS):
        d.mkdir(parents=True, exist_ok=True)
    prompt()
    print(f'AI OCR helper on http://127.0.0.1:{PORT}  (claude: {find_claude()}, model: {MODEL})', flush=True)
    print(f'Prompt: {PROMPT_FILE}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()


if __name__ == '__main__':
    main()
