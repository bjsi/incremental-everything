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

For YouTube videos it grabs the exact frame at a given time (`/video-frame`,
with yt-dlp and ffmpeg: the plugin's player can't be captured from inside
RemNote) and transcribes a grabbed frame into an outline (`/video-transcribe`).
It also fetches a video's captions (`/video-transcript`, with yt-dlp), which
the plugin turns into transcript Rems for a whole video or an extract. When a
video has no captions, or on request, it transcribes the audio itself with
whisper.cpp, on this Mac. YouTube's automatic captions can be tidied up by
Claude (`/transcript-tidy`): punctuation, sentences, key terms in bold.

    python3 scripts/ai_ocr_helper.py          # listens on 127.0.0.1:3457

Requires PyMuPDF (`pip install pymupdf`) and a logged-in `claude` CLI; video
frames also need `brew install yt-dlp ffmpeg`. Transcribing audio needs
`brew install whisper-cpp` and a model in ~/.incremental-remnote/ai-ocr/whisper/
(see WHISPER_MODEL below).

Environment:
    IR_AI_PORT      port (default 3457)
    IR_AI_MODEL     claude model alias (default sonnet)
    IR_AI_ORIGINS   comma-separated allowed Origin headers; unset = allow all
                    (and log each Origin so it can be pinned)
    IR_WHISPER_MODEL  path of the whisper.cpp model (default whisper/ggml-large-v3-turbo-q5_0.bin)

Files live in ~/.incremental-remnote/ai-ocr/:
    prompt.md       the transcription instructions — edit freely, re-read per request
    video-prompt.md the same for video frames
    transcript-prompt.md  how Claude tidies YouTube's automatic captions
    video-transcripts/    fetched captions and audio transcripts, per video
    video-audio/          downloaded audio, kept for a week
    whisper/        the whisper.cpp model, and the optional VAD model that skips silence
    requests.log    one JSON line per request (includes the raw highlight Data)
    crops/          the last image sent for each highlight
    pdf-cache/      downloaded PDFs
    video-frames/   grabbed video frames
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
import tempfile
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
VIDEO_PROMPT_FILE = HOME / 'video-prompt.md'
VIDEO_FRAMES = HOME / 'video-frames'
VIDEO_TRANSCRIPTS = HOME / 'video-transcripts'
VIDEO_AUDIO = HOME / 'video-audio'
TRANSCRIPT_PROMPT_FILE = HOME / 'transcript-prompt.md'
WHISPER_DIR = HOME / 'whisper'
# large-v3-turbo, 5-bit: 574 MB, close to large-v3's accuracy at several times
# its speed. https://huggingface.co/ggerganov/whisper.cpp
WHISPER_MODEL = Path(os.environ.get('IR_WHISPER_MODEL') or WHISPER_DIR / 'ggml-large-v3-turbo-q5_0.bin')
# Silero voice activity detection: skips silence and music, where Whisper
# otherwise makes words up, and halves the time. Used when present.
# https://huggingface.co/ggml-org/whisper-vad
WHISPER_VAD_MODEL = WHISPER_DIR / 'ggml-silero-v5.1.2.bin'

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


DEFAULT_VIDEO_PROMPT = r"""Extract the text shown in a frame of a video: a lecture slide, a document or screen being shown, a whiteboard, a diagram. Do not acknowledge the request, do not comment, and do not ask questions: output the outline described below and nothing else.

The output becomes a RemNote outline, one rem per line:
- Start every line with "- ".
- Nest a line under the one it belongs to by indenting it two spaces per level: a slide's title at the top level, its bullets one level down, their sub-bullets one more. Follow the structure the frame shows; do not invent hierarchy.
- One line per paragraph or list item; never break a line inside a sentence.
- Keep the frame's own numbering and lettering (1., a), …) as part of the line's text.
- Tables: a line naming the table, then one nested line per row, cells separated by " | ".
- Diagrams and charts: transcribe their labels; when the labels alone would not make sense, add one line in *italics* saying what the figure shows.

Leave out what is not content: logos, watermarks, the video player's controls, subtitles burnt into the picture.

Formulae, in KaTeX:
- inline: $x$
- a formula set on its own line in the frame: its own outline line, written $$x$$
- numbered equations use \tag with the number shown, and are always written as $$...$$
- words inside formulae are enclosed in \text{}.

Emphasis, since the reader skims these rems later:
- Put the key terms and concepts in **bold**, even when the frame does not emphasise them: one to three per line at most, each a word or a short phrase, never a whole sentence.
- Keep the frame's own emphasis: italics as *italic*, bold as **bold**.
- Never put ** or * inside a formula's $...$.

Use no other markup: no headings, no code, no links.

If part of the frame is illegible, transcribe what you can and mark the gap as [illegible]. If the frame shows no text at all, output exactly: [no text]
"""


DEFAULT_TRANSCRIPT_PROMPT = r"""Clean up passages of a speech transcript made by YouTube's automatic speech recognition. The input is a JSON array of consecutive passages. Do not acknowledge the request, do not comment, and do not ask questions: output a JSON array of strings and nothing else.

- Return exactly as many strings as you received, in the same order: the cleaned version of each passage at the same position. Never merge, split, move or drop passages, even when a sentence runs on from one passage into the next.
- Add punctuation and capitalisation, and split run-on speech into sentences.
- Correct a word only when the recognition clearly got it wrong and the context makes the intended word certain (names, technical terms). Otherwise keep the speaker's own words, in their language: never translate, summarise or rephrase.
- Drop filler sounds that carry no meaning.
- Keep a time marker at the start of a passage, such as [12:34], exactly as it is.
- Each passage stays one paragraph: no line breaks. Where YouTube marks a change of speaker with ">>", start the new speaker's words with an em dash (—) instead.
- Put the passage's key terms and concepts in **bold**: one to three per passage at most, each a word or a short phrase, never a whole sentence. Use no other markup.
"""


def log(entry):
    with open(LOG, 'a') as f:
        f.write(json.dumps(entry, ensure_ascii=False) + '\n')


def prompt():
    if not PROMPT_FILE.exists():
        PROMPT_FILE.write_text(DEFAULT_PROMPT)
    return PROMPT_FILE.read_text()


def video_prompt():
    if not VIDEO_PROMPT_FILE.exists():
        VIDEO_PROMPT_FILE.write_text(DEFAULT_VIDEO_PROMPT)
    return VIDEO_PROMPT_FILE.read_text()


def transcript_prompt():
    if not TRANSCRIPT_PROMPT_FILE.exists():
        TRANSCRIPT_PROMPT_FILE.write_text(DEFAULT_TRANSCRIPT_PROMPT)
    return TRANSCRIPT_PROMPT_FILE.read_text()


def find_tool(name):
    # launchd and GUI launches carry a minimal PATH, so check Homebrew's spots too.
    for candidate in [shutil.which(name), f'/opt/homebrew/bin/{name}', f'/usr/local/bin/{name}']:
        if candidate and Path(candidate).exists():
            return str(candidate)
    return None


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
    elif url.startswith('local://'):
        # Newer desktop builds (seen Sep 2026) hand over the local copy's absolute
        # path instead: local://%2FUsers%2F…%2Fremnote-<kbId>%2Ffiles%2F<name>.
        # Only the name is used, so the lookup stays in the requesting KB's folder
        # (falling back to the download) rather than opening a path from the request.
        name = Path(urllib.parse.unquote(url[len('local://'):])).name
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


def render_crops(pdf_path, boxes, rem_id, extend=None):
    """`extend` names the side where a merged area box ends the highlight: the user
    drew that box, margin included, so no padding there — the image edge is the end."""
    doc = pymupdf.open(pdf_path)
    images = []
    pad_top = 0 if extend == 'above' else PAD_Y
    pad_bottom = 0 if extend == 'below' else PAD_Y
    for page_number, (fx1, fy1, fx2, fy2) in boxes:
        page = doc[page_number - 1]
        size = page.rect
        clip = pymupdf.Rect(fx1 * size.width - PAD_X, fy1 * size.height - pad_top,
                            fx2 * size.width + PAD_X, fy2 * size.height + pad_bottom) & size
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


def transcribe(images, raw_text, extend=None):
    content = [{'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/png',
                                            'data': base64.b64encode(img).decode()}} for img in images]
    if raw_text.strip() and extend in ('below', 'above'):
        # A text highlight extended by an area box over what the text layer missed.
        start, end = (('its first words', 'the bottom of the image') if extend == 'below'
                      else ('the top of the image', 'its last words'))
        instruction = (
            'The image shows the region of a PDF page around one highlight. The PDF viewer extracted '
            'this text for part of it — its spacing and formulae are garbled, and it misses content '
            'the page\'s text layer does not cover (formulae set as pictures, for instance):\n<raw>\n'
            + raw_text.strip() + '\n</raw>\n'
            f'The highlight runs from {start} to {end}. Transcribe all of it, including everything '
            'the extracted text leaves out.')
    elif raw_text.strip():
        instruction = (
            'The image shows the region of a PDF page around one highlight. The PDF viewer extracted '
            'this text for the highlight — its spacing and formulae are garbled, but its words mark '
            'exactly where the highlight starts and ends:\n<raw>\n' + raw_text.strip() + '\n</raw>\n'
            'Transcribe only that passage: drop anything in the image before its first words or after its last words.')
    else:
        instruction = 'Transcribe the image.'
    content.append({'type': 'text', 'text': instruction})
    markup, model = run_claude(content, prompt())
    return bullets_to_markers(markup), model


def run_claude(content, system_prompt):
    """One `claude -p` turn on `content` (message content blocks); returns the
    reply text and the model that answered."""
    message = json.dumps({'type': 'user', 'message': {'role': 'user', 'content': content}})

    claude = find_claude()
    if not claude:
        raise RuntimeError('claude CLI not found')
    # No --bare: it only accepts ANTHROPIC_API_KEY, never the subscription login.
    # Instead strip everything a transcription does not need: tools, MCP servers,
    # settings files (and so hooks) and session persistence.
    cmd = [claude, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
           '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence',
           '--model', MODEL, '--system-prompt', system_prompt]
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
            return event.get('result', '').strip(), model
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
    extend = req.get('extend')  # 'below' / 'above': a merged area box ends the highlight on that side
    entry.update(remId=rem_id, pdfUrl=req.get('pdfUrl'), data=data, rawText=raw_text[:300], extend=extend)

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
        images = render_crops(fetch(req['pdfUrl'], '.pdf'), boxes, rem_id, extend)
        entry['boxes'] = boxes

    markup, model = transcribe(images, raw_text, extend)
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


# ---------------------------------------------------------------------------
# /video-frame, /video-transcribe — YouTube frames
# ---------------------------------------------------------------------------

VIDEO_ID = re.compile(r'^[A-Za-z0-9_-]{11}$')
FRAME_ID = re.compile(r'^[A-Za-z0-9_-]{11}-\d+\.jpg$')
# The best stream up to 1080p, H.264 first: every ffmpeg build decodes it.
VIDEO_FORMAT = 'bv*[height<=1080][vcodec^=avc1]/bv*[height<=1080]/b[height<=1080]/b'
STREAM_TTL = 3600     # googlevideo URLs last ~6 h; refetch well before that
_streams = {}         # video id -> (fetched at, stream URL)


def stream_url(video_id, fresh=False):
    cached = _streams.get(video_id)
    if cached and not fresh and time.time() - cached[0] < STREAM_TTL:
        return cached[1]
    ytdlp = find_tool('yt-dlp')
    if not ytdlp:
        raise RuntimeError('yt-dlp not found (brew install yt-dlp)')
    proc = subprocess.run([ytdlp, '-g', '--no-playlist', '--no-warnings', '-f', VIDEO_FORMAT,
                           f'https://www.youtube.com/watch?v={video_id}'],
                          capture_output=True, text=True, timeout=90)
    url = next((line for line in proc.stdout.splitlines() if line.startswith('http')), None)
    if not url:
        raise RuntimeError(f'yt-dlp found no stream: {proc.stderr.strip()[-400:]}')
    _streams[video_id] = (time.time(), url)
    return url


def grab_frame(video_id, seconds, file=None):
    """The frame at `seconds`, as a JPEG file. Seeking before -i jumps to the
    keyframe and decodes forward from there, so the frame is exact. `file` is a
    local video, which `video_id` (its local_key) then only names."""
    ffmpeg = find_tool('ffmpeg')
    if not ffmpeg:
        raise RuntimeError('ffmpeg not found (brew install ffmpeg)')
    path = VIDEO_FRAMES / f'{video_id}-{int(round(seconds * 1000))}.jpg'
    if path.exists():
        return path
    # A cached stream URL may have expired, so a YouTube grab gets a second try.
    inputs = [lambda: str(file)] if file else [lambda: stream_url(video_id), lambda: stream_url(video_id, True)]
    for source in inputs:
        cmd = [ffmpeg, '-hide_banner', '-loglevel', 'error', '-ss', f'{seconds:.3f}',
               '-i', source(), '-frames:v', '1', '-q:v', '2', '-y', str(path)]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
        if proc.returncode == 0 and path.exists() and path.stat().st_size:
            return path
    raise RuntimeError(f'ffmpeg could not grab the frame: {proc.stderr.strip()[-400:]}')


def handle_video_frame(req, entry):
    """A YouTube video by `videoId`, or a local one by `file: {library, path}`."""
    seconds = req.get('seconds')
    if not isinstance(seconds, (int, float)) or seconds < 0:
        raise RuntimeError('need seconds >= 0')
    file = local_video_file(req['file']) if req.get('file') else None
    video_id = local_key(file) if file else req.get('videoId') or ''
    if not VIDEO_ID.match(video_id):
        raise RuntimeError('need a YouTube videoId or a local file')
    entry.update(videoId=video_id, file=str(file) if file else None, seconds=seconds)
    path = grab_frame(video_id, float(seconds), file)
    return {'frameId': path.name, 'mime': 'image/jpeg',
            'image': base64.b64encode(path.read_bytes()).decode()}


def handle_video_transcribe(req, entry):
    frame_id = req.get('frameId') or ''
    if not FRAME_ID.match(frame_id) or not (VIDEO_FRAMES / frame_id).exists():
        raise RuntimeError('unknown frame; grab it with /video-frame first')
    entry['frameId'] = frame_id
    content = [
        {'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/jpeg',
                                     'data': base64.b64encode((VIDEO_FRAMES / frame_id).read_bytes()).decode()}},
        {'type': 'text', 'text': 'Transcribe this video frame.'},
    ]
    markup, model = run_claude(content, video_prompt())
    entry.update(model=model, markup=markup)
    return {'markup': markup}


# ---------------------------------------------------------------------------
# /video-transcript — a YouTube video's captions
# ---------------------------------------------------------------------------
#
# YouTube refuses the old Innertube ANDROID request the plugin's first proxy
# (yt-local-proxy.js) made, with 400 FAILED_PRECONDITION. yt-dlp keeps up with
# YouTube's changes, so it lists the caption tracks here. See
# findings/VIDEO_PLAYBACK.md, "Transcripts".

TRANSCRIPT_TTL = 30 * 24 * 3600   # captions rarely change; refetch now and then


def caption_track(info):
    """The track to use: hand-made captions in the video's language, else
    YouTube's automatic captions of the spoken language (`<lang>-orig`), else
    any hand-made track. Never an automatic translation: YouTube answers those
    with 429 Too Many Requests."""
    def json3(formats):
        return next((f.get('url') for f in formats or [] if f.get('ext') == 'json3'), None)

    def base(code):
        return code.split('-')[0].lower()

    language = info.get('language') or ''
    manual = {code: fmts for code, fmts in (info.get('subtitles') or {}).items() if code != 'live_chat'}
    auto = info.get('automatic_captions') or {}
    if language:
        for code, fmts in manual.items():
            if base(code) == base(language) and json3(fmts):
                return code, 'manual', json3(fmts)
    for code, fmts in auto.items():
        if code.endswith('-orig') and json3(fmts):
            return code[:-len('-orig')], 'auto', json3(fmts)
    for code, fmts in manual.items():
        if json3(fmts):
            return code, 'manual', json3(fmts)
    return None


def parse_json3(body):
    """Caption lines as {offset, duration, text}, in seconds."""
    segments = []
    for event in json.loads(body).get('events') or []:
        text = ''.join(seg.get('utf8', '') for seg in event.get('segs') or []).replace('\n', ' ').strip()
        if text:
            segments.append({'offset': event.get('tStartMs', 0) / 1000,
                             'duration': event.get('dDurationMs', 0) / 1000,
                             'text': text})
    return segments


class NoCaptions(RuntimeError):
    pass


def caption_transcript(video_id, refresh=False):
    path = VIDEO_TRANSCRIPTS / f'{video_id}.json'
    if path.exists() and not refresh and time.time() - path.stat().st_mtime < TRANSCRIPT_TTL:
        return {**json.loads(path.read_text()), 'cached': True}
    ytdlp = find_tool('yt-dlp')
    if not ytdlp:
        raise RuntimeError('yt-dlp not found (brew install yt-dlp)')
    proc = subprocess.run([ytdlp, '-J', '--skip-download', '--no-playlist', '--no-warnings',
                           f'https://www.youtube.com/watch?v={video_id}'],
                          capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        raise RuntimeError(f'yt-dlp could not read the video: {proc.stderr.strip()[-400:]}')
    track = caption_track(json.loads(proc.stdout))
    if not track:
        raise NoCaptions('this video has no captions in its own language')
    language, kind, url = track
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=60, context=ssl_context()) as resp:
        segments = parse_json3(resp.read())
    if not segments:
        raise NoCaptions(f'the {language} captions came back empty')
    result = {'videoId': video_id, 'language': language, 'kind': kind, 'segments': segments}
    path.write_text(json.dumps(result))
    return {**result, 'cached': False}


# --- the audio, transcribed here by whisper.cpp ------------------------------

AUDIO_TTL = 7 * 24 * 3600
WHISPER_LOCK = threading.Lock()  # one transcription at a time: they share the GPU


def whisper_ready():
    return bool(find_tool('whisper-cli') and find_tool('ffmpeg') and WHISPER_MODEL.exists())


def video_audio(video_id):
    """The video's audio, downloaded whole once: yt-dlp fetches it in chunks in
    seconds, while cutting a range straight from YouTube's stream is throttled
    to near real time. Ranges are then cut locally."""
    for path in VIDEO_AUDIO.glob(f'{video_id}.*'):
        if path.suffix != '.part' and time.time() - path.stat().st_mtime < AUDIO_TTL:
            return path
    ytdlp = find_tool('yt-dlp')
    if not ytdlp:
        raise RuntimeError('yt-dlp not found (brew install yt-dlp)')
    proc = subprocess.run([ytdlp, '-f', 'bestaudio[ext=m4a]/bestaudio', '--no-playlist', '--no-warnings',
                           '--no-progress', '-o', str(VIDEO_AUDIO / f'{video_id}.%(ext)s'),
                           f'https://www.youtube.com/watch?v={video_id}'],
                          capture_output=True, text=True, timeout=900)
    found = [p for p in VIDEO_AUDIO.glob(f'{video_id}.*') if p.suffix != '.part']
    if proc.returncode != 0 or not found:
        raise RuntimeError(f'yt-dlp could not download the audio: {proc.stderr.strip()[-400:]}')
    return found[0]


def transcribe_audio(path, start=None, end=None):
    """Whisper on the audio file between `start` and `end` (seconds; the whole
    file without them). Returns (language, segments), offsets in the file's time.
    Takes a local file, so a local video can use it as it is."""
    if not whisper_ready():
        raise RuntimeError('Whisper is not set up: brew install whisper-cpp, and put the model at '
                           f'{WHISPER_MODEL}')
    with tempfile.TemporaryDirectory(dir=VIDEO_AUDIO) as tmp:
        wav, out = Path(tmp) / 'clip.wav', Path(tmp) / 'out'
        cmd = [find_tool('ffmpeg'), '-hide_banner', '-loglevel', 'error']
        if start:
            cmd += ['-ss', f'{start:.3f}']
        if end is not None:
            cmd += ['-to', f'{end:.3f}']
        cmd += ['-i', str(path), '-ac', '1', '-ar', '16000', '-y', str(wav)]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if proc.returncode != 0:
            raise RuntimeError(f'ffmpeg could not cut the audio: {proc.stderr.strip()[-400:]}')
        cmd = [find_tool('whisper-cli'), '-m', str(WHISPER_MODEL), '-f', str(wav), '-l', 'auto',
               '-sns', '-t', str(min(8, os.cpu_count() or 4)), '-oj', '-of', str(out), '-np']
        if WHISPER_VAD_MODEL.exists():
            cmd += ['--vad', '-vm', str(WHISPER_VAD_MODEL)]
        with WHISPER_LOCK:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=3 * 3600)
        result = Path(f'{out}.json')
        if proc.returncode != 0 or not result.exists():
            raise RuntimeError(f'whisper failed: {proc.stderr.strip()[-400:]}')
        data = json.loads(result.read_text(errors='replace'))
    offset = start or 0
    segments = []
    for line in data.get('transcription') or []:
        text = (line.get('text') or '').strip()
        if text:
            begin, finish = line['offsets']['from'] / 1000, line['offsets']['to'] / 1000
            segments.append({'offset': offset + begin, 'duration': finish - begin, 'text': text})
    return (data.get('result') or {}).get('language') or '', segments


def audio_transcript(video_id, start=None, end=None, refresh=False, file=None):
    """The audio's transcript: the whole video's is cached, and a range is cut
    from it when there is one; otherwise only the range is transcribed. `file`
    is a local video, read as it is; `video_id` (its local_key) then names the cache."""
    path = VIDEO_TRANSCRIPTS / f'{video_id}.audio.json'
    whole = start is None and end is None
    if path.exists() and not refresh:
        result = json.loads(path.read_text())
        if not whole:
            result['segments'] = [s for s in result['segments']
                                  if s['offset'] + s['duration'] > (start or 0)
                                  and (end is None or s['offset'] < end)]
        return {**result, 'cached': True}
    language, segments = transcribe_audio(file or video_audio(video_id), start, end)
    if not segments:
        raise RuntimeError('Whisper heard no speech' + ('' if whole else ' in this range'))
    result = {'videoId': video_id, 'language': language, 'kind': 'whisper', 'segments': segments}
    if whole:
        path.write_text(json.dumps(result))
    return {**result, 'cached': False}


def handle_video_transcript(req, entry):
    """source: 'captions' (the default), 'audio' (Whisper), or 'auto' (captions,
    else Whisper when it is set up). start / end (seconds) limit what Whisper
    transcribes; captions always come whole, cached, for the plugin to cut."""
    start, end = req.get('start'), req.get('end')
    for value in (start, end):
        if value is not None and (not isinstance(value, (int, float)) or value < 0):
            raise RuntimeError('start and end are seconds >= 0')
    refresh = bool(req.get('refresh'))
    source = req.get('source') or 'captions'
    if req.get('file'):
        # A local video has no captions: always its audio.
        file = local_video_file(req['file'])
        result = audio_transcript(local_key(file), start, end, refresh, file)
        entry.update(file=str(file), language=result['language'], segments=len(result['segments']),
                     cached=result['cached'])
        return result
    video_id = req.get('videoId') or ''
    if not VIDEO_ID.match(video_id):
        raise RuntimeError('need a YouTube videoId or a local file')
    if source == 'audio':
        result = audio_transcript(video_id, start, end, refresh)
    else:
        try:
            result = caption_transcript(video_id, refresh)
        except NoCaptions as e:
            if source != 'auto':
                raise
            if not whisper_ready():
                raise NoCaptions(f'{e}, and Whisper is not set up to transcribe its audio') from e
            result = audio_transcript(video_id, start, end, refresh)
    # The segments themselves would swamp the request log.
    entry.update(videoId=video_id, source=source, language=result['language'], kind=result['kind'],
                 segments=len(result['segments']), cached=result['cached'])
    return result


# ---------------------------------------------------------------------------
# /transcript-tidy — Claude cleans up automatic captions
# ---------------------------------------------------------------------------

MAX_TIDY_BLOCKS = 40
MAX_TIDY_CHARS = 30000


def handle_transcript_tidy(req, entry):
    """Blocks of YouTube's automatic captions in, the same blocks cleaned up out:
    punctuation, sentences, key terms in bold. The reply must keep the count,
    so each block goes back to its own Rem."""
    blocks = req.get('blocks')
    if (not isinstance(blocks, list) or not blocks or len(blocks) > MAX_TIDY_BLOCKS
            or not all(isinstance(b, str) for b in blocks) or sum(map(len, blocks)) > MAX_TIDY_CHARS):
        raise RuntimeError(f'need 1 to {MAX_TIDY_BLOCKS} text blocks, {MAX_TIDY_CHARS} characters at most')
    language = req.get('language') or 'unknown'
    content = [{'type': 'text', 'text': f'Language: {language}\n\n' + json.dumps(blocks, ensure_ascii=False)}]
    reply, model = run_claude(content, transcript_prompt())
    try:
        tidied = json.loads(reply[reply.index('['):reply.rindex(']') + 1])
    except ValueError:
        raise RuntimeError('Claude did not answer with a list of passages')
    if not isinstance(tidied, list) or len(tidied) != len(blocks) or not all(isinstance(b, str) for b in tidied):
        raise RuntimeError(f'Claude returned {len(tidied) if isinstance(tidied, list) else "no"} passages '
                           f'for {len(blocks)}')
    # Each block is one Rem's text: line breaks (Claude likes one before each
    # speaker's dash, whatever the prompt says) become spaces.
    tidied = [re.sub(r'\s*\n\s*', ' ', block).strip() for block in tidied]
    entry.update(model=model, blocks=len(blocks))
    return {'blocks': tidied}


# ---------------------------------------------------------------------------
# Local videos: libraries, the macOS file dialogs, scanning, serving
# ---------------------------------------------------------------------------
#
# A library is a named folder the user picked in a dialog. A Rem stores its
# video as library name + path relative to the library, so a folder that moves
# (an external disk mounted elsewhere) is fixed once, by re-pointing the
# library. Only video files inside libraries are ever served or read.

VIDEO_LIBRARIES_FILE = HOME / 'video-libraries.json'
VIDEO_TYPES = {'.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm'}
LIBRARY_LOCK = threading.Lock()
DIALOG_LOCK = threading.Lock()  # one file dialog at a time


def load_libraries():
    try:
        return json.loads(VIDEO_LIBRARIES_FILE.read_text())
    except (OSError, ValueError):
        return {}


def save_libraries(libraries):
    VIDEO_LIBRARIES_FILE.write_text(json.dumps(libraries, indent=2, ensure_ascii=False))


def is_video(path):
    return path.suffix.lower() in VIDEO_TYPES and not path.name.startswith('.')


def library_for(path):
    """(library name, path relative to it) for a picked file or folder: the
    innermost library holding it, else a new library at the folder itself (or
    the file's folder), named after it."""
    path = path.resolve()
    with LIBRARY_LOCK:
        libraries = load_libraries()
        holders = [(name, Path(root)) for name, root in libraries.items()
                   if path == Path(root) or Path(root) in path.parents]
        if holders:
            name, root = max(holders, key=lambda h: len(str(h[1])))
            return name, '' if path == root else path.relative_to(root).as_posix()
        root = path if path.is_dir() else path.parent
        name, n = root.name or 'Videos', 2
        while name in libraries:
            name, n = f'{root.name} {n}', n + 1
        libraries[name] = str(root)
        save_libraries(libraries)
        return name, '' if path == root else path.relative_to(root).as_posix()


def library_root(name):
    root = load_libraries().get(name)
    if not root:
        raise RuntimeError(f'unknown video library "{name}"')
    root = Path(root)
    if not root.is_dir():
        raise RuntimeError(f'the folder of the video library "{name}" is not available: {root} '
                           '(an external disk not connected?)')
    return root


def local_path(library, rel):
    """A path inside a library; never outside it, whatever `rel` says."""
    root = library_root(library).resolve()
    path = (root / rel).resolve() if rel else root
    if path != root and root not in path.parents:
        raise RuntimeError('path outside the library')
    return path


def local_video_file(spec):
    if not isinstance(spec, dict) or not spec.get('library') or not spec.get('path'):
        raise RuntimeError('need file: {library, path}')
    path = local_path(spec['library'], spec['path'])
    if not is_video(path) or not path.is_file():
        raise RuntimeError(f'video not found: {spec["path"]} in the library "{spec["library"]}"')
    return path


def local_key(path):
    """An 11-character id for a local file, in the YouTube id's place (frame and
    transcript caches); it changes when the file does."""
    stat = path.stat()
    return hashlib.sha1(f'{path}|{stat.st_size}|{stat.st_mtime_ns}'.encode()).hexdigest()[:11]


def choose_in_dialog(kind, prompt):
    """The macOS folder or file dialog, in front of RemNote. None if cancelled."""
    prompt = prompt.replace('"', "'")
    picker = (f'choose folder with prompt "{prompt}"' if kind == 'folder'
              else f'choose file with prompt "{prompt}" of type {{"public.movie"}}')
    with DIALOG_LOCK:
        proc = subprocess.run(['osascript', '-e', 'activate', '-e', f'POSIX path of ({picker})'],
                              capture_output=True, text=True, timeout=900)
    if proc.returncode != 0:
        if '-128' in proc.stderr:  # User canceled.
            return None
        raise RuntimeError(f'the file dialog failed: {proc.stderr.strip()[-300:]}')
    return Path(proc.stdout.strip())


def handle_video_choose(req, entry):
    """kind 'folder' or 'file': the user picks one; it is placed in a library."""
    kind = 'file' if req.get('kind') == 'file' else 'folder'
    picked = choose_in_dialog(kind, req.get('prompt') or
                              ('Choose a folder of videos' if kind == 'folder' else 'Choose a video'))
    if not picked:
        return {'cancelled': True}
    if kind == 'file' and not is_video(picked):
        raise RuntimeError(f'not a video the player can open (mp4, m4v, mov, webm): {picked.name}')
    library, rel = library_for(picked)
    entry.update(kind=kind, library=library, path=rel)
    return {'cancelled': False, 'library': library, 'root': load_libraries()[library], 'path': rel}


def handle_video_libraries(req, entry):
    return {'libraries': [{'name': name, 'root': root, 'available': Path(root).is_dir()}
                          for name, root in load_libraries().items()]}


def handle_video_library_relink(req, entry):
    """Points a library at another folder (the disk mounted elsewhere, the
    folder moved), chosen in the dialog."""
    name = req.get('library') or ''
    with LIBRARY_LOCK:
        if name not in load_libraries():
            raise RuntimeError(f'unknown video library "{name}"')
    picked = choose_in_dialog('folder', f'Where is the video library "{name}" now?')
    if not picked:
        return {'cancelled': True}
    with LIBRARY_LOCK:
        libraries = load_libraries()
        libraries[name] = str(picked.resolve())
        save_libraries(libraries)
    entry.update(library=name, root=libraries[name])
    return {'cancelled': False, 'library': name, 'root': libraries[name]}


def natural_key(name):
    """'Aula 2' before 'Aula 10'."""
    return [(0, int(part), '') if part.isdigit() else (1, 0, part.lower())
            for part in re.split(r'(\d+)', name)]


def scan_folder(root, path):
    folder = {'name': path.name, 'path': path.relative_to(root).as_posix() if path != root else '',
              'videos': [], 'folders': []}
    try:
        entries = sorted(path.iterdir(), key=lambda p: natural_key(p.name))
    except OSError:
        return folder
    for child in entries:
        if child.name.startswith('.'):
            continue
        if child.is_dir():
            sub = scan_folder(root, child)
            if sub['videos'] or sub['folders']:
                folder['folders'].append(sub)
        elif is_video(child):
            folder['videos'].append({'name': child.stem, 'path': child.relative_to(root).as_posix()})
    return folder


def handle_video_scan(req, entry):
    """The videos under a library folder, in natural order, nested by subfolder."""
    library = req.get('library') or ''
    root = library_root(library).resolve()
    tree = scan_folder(root, local_path(library, req.get('path') or ''))
    entry.update(library=library, path=req.get('path') or '')
    return {'library': library, 'tree': tree}


def handle_video_file(req, entry):
    """Whether a library's video is there, for a player that couldn't load it
    (the media route answers without CORS, so the plugin can't read its errors)."""
    path = local_video_file(req.get('file'))
    return {'size': path.stat().st_size}


MEDIA_PREFIX = '/media/'
MEDIA_CHUNK = 1 << 20

ROUTES = {'/ocr': handle_ocr, '/locate': handle_locate, '/source': handle_source, '/match': handle_match,
          '/video-frame': handle_video_frame, '/video-transcribe': handle_video_transcribe,
          '/video-transcript': handle_video_transcript, '/transcript-tidy': handle_transcript_tidy,
          '/video-choose': handle_video_choose, '/video-libraries': handle_video_libraries,
          '/video-library-relink': handle_video_library_relink, '/video-scan': handle_video_scan,
          '/video-file': handle_video_file}


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
            return self.send_json(200, {'ok': True, 'claude': find_claude(), 'model': MODEL,
                                        'ytDlp': find_tool('yt-dlp'), 'ffmpeg': find_tool('ffmpeg'),
                                        'transcripts': True, 'whisper': whisper_ready(), 'localVideo': True})
        if self.path.startswith(MEDIA_PREFIX):
            return self.send_media()
        self.send_json(404, {'ok': False, 'error': 'POST /ocr or /locate'})

    def send_media(self):
        """GET /media/<library>/<path>: a library's video file, with Range, for
        a <video> element. No CORS header: playing needs none, and without it
        no page can read the files through the helper."""
        try:
            library, _, rel = urllib.parse.unquote(self.path[len(MEDIA_PREFIX):].split('?')[0]).partition('/')
            path = local_video_file({'library': library, 'path': rel})
        except RuntimeError as e:
            self.send_response(404)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.end_headers()
            self.wfile.write(str(e).encode())
            return
        size = path.stat().st_size
        start, end = 0, size - 1
        match = re.match(r'bytes=(\d*)-(\d*)', self.headers.get('Range') or '')
        if match and (match.group(1) or match.group(2)):
            if match.group(1):
                start = int(match.group(1))
                end = min(int(match.group(2)), size - 1) if match.group(2) else size - 1
            else:  # the last N bytes
                start = max(0, size - int(match.group(2)))
            if start > end or start >= size:
                self.send_response(416)
                self.send_header('Content-Range', f'bytes */{size}')
                self.end_headers()
                return
            self.send_response(206)
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        else:
            self.send_response(200)
        self.send_header('Content-Type', VIDEO_TYPES[path.suffix.lower()])
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Length', str(end - start + 1))
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        try:
            with open(path, 'rb') as f:
                f.seek(start)
                left = end - start + 1
                while left > 0:
                    chunk = f.read(min(MEDIA_CHUNK, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the player seeks by dropping a request and starting another

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
    for d in (HOME, PDF_CACHE, CROPS, VIDEO_FRAMES, VIDEO_TRANSCRIPTS, VIDEO_AUDIO, WHISPER_DIR):
        d.mkdir(parents=True, exist_ok=True)
    prompt()
    video_prompt()
    transcript_prompt()
    # Downloaded audio is only a cache: clear what's past its week.
    for old in VIDEO_AUDIO.glob('*'):
        if old.is_file() and time.time() - old.stat().st_mtime > AUDIO_TTL:
            old.unlink(missing_ok=True)
    print(f'AI OCR helper on http://127.0.0.1:{PORT}  (claude: {find_claude()}, model: {MODEL})', flush=True)
    print(f'Prompt: {PROMPT_FILE}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()


if __name__ == '__main__':
    main()
