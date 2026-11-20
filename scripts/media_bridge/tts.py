#!/usr/bin/env python3
"""Text to speech for spoken scripts: the engine behind the media-bridge helper's /tts
endpoint (the plugin's "Read aloud" command) and the author's audio skills.

Engines, chosen by ear on notes that mix English and Portuguese:
  - Gemini TTS (default): ONE CALL PER LANGUAGE BLOCK, because speechConfig.languageCode
    takes a single code (a list or "en-US,pt-BR" is rejected, and without a code
    Portuguese comes out Spanish). Voice drawn from an approved list. Never put style
    instructions in the text: Gemini reads them aloud.
    Gemini TTS is generative: a call can add invented sentences, loop or skip words. So
    calls are short (GEMINI_CALL_CHARS) and each one is transcribed with a local
    whisper.cpp (whisper-cli + model, see verify_speech) and redone up to
    VERIFY_ATTEMPTS times when the transcript does not match; without whisper only the
    duration is checked. What still does not match comes back in "warnings".
  - Azure en-US-AndrewMultilingualNeural, when the script has >= 3 Portuguese terms
    marked inside English lines: the only engine that switches language mid-sentence.
    Gemini reads English terms inside a Portuguese line well, but Portuguese terms inside
    an English line come out Spanish or English, so only those count (2026-11-18). Each language run goes in its
    own <voice> (inside a single <voice>, word-level <lang> is ignored).
  - ElevenLabs (eleven_multilingual_v2 by default), offered for users who have its key;
    like Gemini, one call per language block (no word-level language switch: the
    author's tests had it read Portuguese terms as English, or Portuguese as Spanish).
    Voices are the account's own (GET /v2/voices, cached), shown by first name.
  - Gemini TTS on Google Cloud (Vertex AI generateContent, same model and voices), with
    an API key: billed to a Google Cloud billing account (and its credits) instead of
    the Gemini API's; preferred over the Gemini API when both keys are set. One call per
    language block with its languageCode, as with Gemini (without one, a short
    Portuguese line came out European Portuguese).
Only engines whose keys are set are offered; "auto" suggests one of them, and any
available engine may be picked instead. The script keeps its marks either way: Azure
switches language on them, Gemini drops them and reads the term in the line's language.

Script format (plain text, one idea per line):
  [pt] / [en] at the start of a line   the line's language (default en)
  <pt>termo</pt> / <en>term</en>       a foreign TERM inside a line; names and acronyms
                                       are never marked (spoken in the line's language)
  [pause] / [pausa] alone on a line     answer gap before the next line:
                                       max(5 s, 2 s + 0.5 s per word of that line)
  [pause N]                            N seconds

Keys: GEMINI_API_KEY, GOOGLE_CLOUD_API_KEY (+ optional GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION),
AZURE_SPEECH_KEY, AZURE_SPEECH_REGION, ELEVENLABS_API_KEY, from the environment or
from the .env file named by "envFile" in ~/.remnote-media-bridge/tts.json (or
~/.remnote-media-bridge/.env). They are never printed.

tts.json (optional): {"envFile": "...", "audioHome": "...", "geminiVoices": [...],
"geminiModel": "...", "azureVoices": [...], "elevenModel": "...", "elevenUsdPerMChars": N,
"pronunciationHome": "..." (default <audioHome>/pronunciations),
"spokenAs": {"pt": {"IMO": "Imo"}} (acronyms said as a word in that language; see SPOKEN_AS)}
("azureVoice": "..." is still read)

CLI:
  tts.py script.txt --plan              engine, calls, estimate; no API call
  tts.py script.txt [--out x.mp3] [--engine auto|gemini|azure] [--voice NAME]
Standard library only (certifi is used when present, for python.org builds).
"""
from __future__ import annotations

import argparse
import base64
import difflib
import json
import os
import random
import re
import shutil
import ssl
import subprocess
import sys
import tempfile
import time
import unicodedata
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable
from xml.sax.saxutils import escape

BRIDGE_HOME = Path(os.environ.get("REMNOTE_MEDIA_BRIDGE_HOME", Path.home() / ".remnote-media-bridge"))
CONFIG_FILE = BRIDGE_HOME / "tts.json"

GEMINI_MODEL = "gemini-3.8-flash-tts"
GEMINI_VOICES = ["Kore", "Sadaltager", "Charon", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe",
                 "Autonoe", "Enceladus", "Umbriel", "Despina", "Gacrux", "Sulafat"]
AZURE_VOICE = "en-US-AndrewMultilingualNeural"
LOCALE = {"en": "en-US", "pt": "pt-BR"}

INLINE_LIMIT = 3          # <pt> terms in English lines from which "auto" picks Azure
MAX_CALL_CHARS = 1500     # characters per API call (~2 min of speech): Azure, ElevenLabs
# Gemini TTS is a generative model: on long calls it sometimes keeps talking past the
# text (invented sentences), loops on a phrase or skips words (found 2026-11-16 on a
# 1,420-character call: 40 s of made-up content). Short calls go wrong far less often,
# and every Gemini call is checked by transcription (verify_speech) and redone if needed.
GEMINI_CALL_CHARS = 600
CALL_CHARS = {"vertex": GEMINI_CALL_CHARS, "gemini": GEMINI_CALL_CHARS}
VERIFY_ATTEMPTS = 3       # tries per Gemini call when the transcript does not match
# A call fails the check when more words than max(VERIFY_MIN_WORDS, VERIFY_SHARE x words)
# are added or missing in its transcript (names and acronyms alone cost a few: whisper
# hears "Nayak" as "NIAC"), or when it lasts far longer or shorter than the text warrants.
VERIFY_SHARE = 0.15
VERIFY_MIN_WORDS = 6
# ...or when 5+ consecutive words are added (invented text, a loop) or missing (a dropped
# clause): a misheard name or number costs 1-3, a real slip more.
VERIFY_RUN = 5
VERIFY_LONG = (1.4, 3.0)   # fails when seconds > expected x 1.4 + 3
VERIFY_SHORT = (0.6, 2.0)  # fails when seconds < expected x 0.6 - 2
WHISPER_MODEL = Path.home() / ".incremental-remnote" / "ai-ocr" / "whisper" / "ggml-large-v3-turbo-q5_0.bin"
# Voice activity detection keeps whisper from inventing words in silences, and no carried
# context keeps it from looping ("clark clark clark…") on a long recording.
WHISPER_VAD = WHISPER_MODEL.with_name("ggml-silero-v5.1.2.bin")
GAP_S = 0.7               # silence between calls
MIN_ANSWER_PAUSE_S = 5.0
RATE = 24000              # Hz, what both engines return
TIMEOUT_S = 180
ATTEMPTS = 6

# Estimates. Speech rate in WORDS per minute of speech (pauses and gaps excluded), which
# holds across languages where characters per second do not (Portuguese words are longer:
# 6.6 characters against 5.6). Measured 2026-11-13: Gemini 144 (Portuguese note, 65 s)
# and 142 (mixed 9-minute script); Azure Andrew ~126 (one 25 s mixed clip); ElevenLabs
# ~159 (one 6 s clip, rounded down). Prices are list prices, checked 2026-11-13: check them again.
# Gemini 3.8 Flash TTS bills audio output at 25 tokens per second of speech (pauses are
# silence the helper adds, not billed): US$9 per million tokens through 2026-12-31,
# US$18 from 2027-01-01 (ai.google.dev/gemini-api/docs/pricing; the 3.1 preview was
# US$20). "geminiUsdPerMTokens" in tts.json overrides the schedule.
WORDS_PER_MIN = {"vertex": 143.0, "gemini": 143.0, "azure": 126.0, "elevenlabs": 150.0}
AZURE_LINE_BREAK_S = 0.75  # the <break/> between lines inside one Azure call
GEMINI_TOKENS_PER_S = 25.0
GEMINI_PRICE_SCHEDULE = [("2027-01-01", 18.0), ("0000-00-00", 9.0)]  # (from date, US$ per M tokens), newest first
AZURE_USD_PER_M_CHARS = 15.0
ELEVEN_MODEL = "eleven_multilingual_v2"
# ElevenLabs bills credits (1 per character on multilingual v2, 0.5 on flash/turbo) from a
# monthly plan, so a dollar figure is only indicative: ~US$0.20 per 1,000 characters.
ELEVEN_USD_PER_M_CHARS = 200.0
ELEVEN_LANGUAGE_MODELS = ("eleven_flash_v2_5", "eleven_turbo_v2_5")  # accept language_code
ELEVEN_FALLBACK_VOICES = {"George": "JBFqnCBsd6RMkjVDRZzb", "Alice": "Xb7hH8MSUJpSbSDYk0k2",
                          "Brian": "nPczCjzI2devNBz1zQrb", "Eric": "cjVigY5qzO86Huf0OWal",
                          "Matilda": "XrExE9yKIg1WjnnlVkGX", "Daniel": "onwK4e9ZLuTAKqWW03F9"}
VOICE_CACHE_S = 600

# Acronyms said as a word in one language but spelled letter by letter in another. Gemini
# pt-BR spells an all-caps "IMO" (I-eme-ó, ~0.4 s longer each time, 3 voices, 2026-11-19),
# while Brazilians say "Imo" as a word; in English I-M-O is right, so only the pt text
# changes. Whole word, case-sensitive, applied to the text sent to the engine (the script
# and the plan keep the acronym). tts.json "spokenAs": {"pt": {"ABC": "Abc"}} adds to it.
SPOKEN_AS = {"pt": {"IMO": "Imo"}}


def spoken_as(lang: str) -> dict[str, str]:
    table = dict(SPOKEN_AS.get(lang, {}))
    table.update((config().get("spokenAs") or {}).get(lang, {}))
    return table


def respell(lang: str, text: str) -> str:
    """The text as the engine should get it in this language (see SPOKEN_AS)."""
    for word, said in spoken_as(lang).items():
        text = re.sub(rf"(?<![\w-]){re.escape(word)}(?![\w-])", said, text)
    return text


INLINE = re.compile(r"<(pt|en)>(.*?)</\1>", re.S)
LANG_PREFIX = re.compile(r"^\[(pt|en)\]\s*")
PAUSE = re.compile(r"^\[(?:pause|pausa)(?:\s+(\d+(?:[.,]\d+)?))?\]$", re.I)


class TTSError(RuntimeError):
    pass


# --- configuration -------------------------------------------------------------------

def config() -> dict:
    try:
        return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _read_env_file(path: Path) -> dict:
    out = {}
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip().removeprefix("export ").strip()] = v.strip().strip('"').strip("'")
    except OSError:
        pass
    return out


def keys() -> dict:
    """The TTS keys and ANTHROPIC_API_KEY (whatever is set)."""
    names = ("GEMINI_API_KEY", "GOOGLE_CLOUD_API_KEY", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION",
             "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION", "ELEVENLABS_API_KEY",
             "ANTHROPIC_API_KEY")
    found = {}
    env_file = config().get("envFile")
    for source in (dict(os.environ),
                   _read_env_file(Path(os.path.expanduser(env_file))) if env_file else {},
                   _read_env_file(BRIDGE_HOME / ".env")):
        for n in names:
            if n not in found and source.get(n):
                found[n] = source[n]
    return found


def audio_home() -> Path:
    return Path(os.path.expanduser(config().get("audioHome") or BRIDGE_HOME / "audio"))


def pronunciation_home() -> Path:
    """Where "Add pronunciation" copies go: apart from the Read aloud audios."""
    custom = config().get("pronunciationHome")
    return Path(os.path.expanduser(custom)) if custom else audio_home() / "pronunciations"


def _tool(name: str) -> str:
    path = os.pathsep.join([os.environ.get("PATH", ""), "/opt/homebrew/bin", "/usr/local/bin"])
    exe = shutil.which(name, path=path)
    if not exe:
        raise TTSError(f"{name} not found (brew install ffmpeg)")
    return exe


def _ssl_context() -> ssl.SSLContext:
    try:
        import certifi  # python.org builds ship without system certificates
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


# --- script ----------------------------------------------------------------------------

@dataclass
class Line:
    lang: str
    text: str            # with inline marks


@dataclass
class Pause:
    seconds: float


def plain(text: str) -> str:
    return INLINE.sub(lambda m: m.group(2), text)


def parse(script: str) -> list[Line | Pause]:
    items: list[Line | Pause] = []
    lines = [l.strip() for l in script.splitlines() if l.strip()]
    for i, line in enumerate(lines):
        p = PAUSE.match(line)
        if p:
            if p.group(1):
                sec = float(p.group(1).replace(",", "."))
            else:
                nxt = LANG_PREFIX.sub("", lines[i + 1]) if i + 1 < len(lines) else ""
                sec = max(MIN_ANSWER_PAUSE_S, 2 + 0.5 * len(plain(nxt).split()))
            items.append(Pause(round(sec, 1)))
            continue
        m = LANG_PREFIX.match(line)
        items.append(Line(m.group(1) if m else "en", line[m.end():] if m else line))
    return items


def runs(lang: str, text: str) -> list[tuple[str, str]]:
    """A line -> flat [(lang, text)] runs following its inline marks."""
    out, pos = [], 0
    for m in INLINE.finditer(text):
        if m.start() > pos:
            out.append((lang, text[pos:m.start()]))
        out.append((m.group(1), m.group(2)))
        pos = m.end()
    if pos < len(text):
        out.append((lang, text[pos:]))
    return [(g, t) for g, t in out if t.strip()]


FORBIDDEN = [
    (re.compile(r"\\[\(\[]|\$"), "LaTeX: say the formula in words"),
    (re.compile(r"\*\*|__|^#|^- |^> ", re.M), "markdown: the script is plain text"),
    (re.compile(r"\[\[|\]\(|https?://|/doc/"), "reference or link: say only the name"),
    (re.compile(r"\bPDF p\.|\bp\. ?\d"), "page number: not read aloud"),
    (re.compile(r"\[…\]|\[\.\.\.\]"), "elision […]: remove it"),
    (re.compile(r"[🤖🔊📌⇒⇐⇔→←]"), "emoji or arrow: remove it"),
    (re.compile(r"\[(?!pt\]|en\]|pause|pausa)[^\]]*\]"), "brackets would be read aloud (only [pt], [en], [pause])"),
]


def check(script: str) -> list[str]:
    """Things the engine would read aloud, or broken marks."""
    errors = []
    for n, line in enumerate(script.splitlines(), 1):
        body = line.strip()
        if PAUSE.match(body):
            continue
        body = LANG_PREFIX.sub("", body)
        for pattern, why in FORBIDDEN:
            if pattern.search(body):
                errors.append(f"line {n}: {why}: {body[:70]}")
        if re.search(r"</?(pt|en)>", INLINE.sub("", body)):
            errors.append(f"line {n}: unbalanced <pt>/<en> mark: {body[:70]}")
    return errors


def inline_count(items) -> int:
    return sum(len(INLINE.findall(i.text)) for i in items if isinstance(i, Line))


def azure_terms(items) -> int:
    """Portuguese terms marked inside English lines: what Gemini mispronounces (Spanish or
    English), and so what sends "auto" to Azure. English terms in Portuguese lines do not
    count: Gemini reads them well."""
    return sum(1 for i in items if isinstance(i, Line) and i.lang == "en"
               for m in INLINE.finditer(i.text) if m.group(1) == "pt")


ENGINES = {
    "vertex": {"label": "Gemini TTS (Google Cloud)", "needs": ("GOOGLE_CLOUD_API_KEY",), "mixes": False},
    "gemini": {"label": "Gemini TTS", "needs": ("GEMINI_API_KEY",), "mixes": False},
    "azure": {"label": "Azure multilingual", "needs": ("AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION"),
              "mixes": True},
    "elevenlabs": {"label": "ElevenLabs", "needs": ("ELEVENLABS_API_KEY",), "mixes": False},
}
# Engines that make one call per language block (the line's language for every word).
BLOCK_ENGINES = ("vertex", "gemini", "elevenlabs")
# Engines billed per audio token (Gemini TTS); the others per character.
TOKEN_ENGINES = ("vertex", "gemini")

_eleven_voices: dict = {"at": 0.0, "voices": {}}


def eleven_voices(key: str | None = None) -> dict[str, str]:
    """First name -> voice id: the account's voices (cached), else a few stock ones."""
    key = key or keys().get("ELEVENLABS_API_KEY")
    if key and time.time() - _eleven_voices["at"] > VOICE_CACHE_S:
        _eleven_voices["at"] = time.time()
        try:
            req = urllib.request.Request("https://api.elevenlabs.io/v2/voices?page_size=100",
                                         headers={"xi-api-key": key})
            with urllib.request.urlopen(req, timeout=15, context=_ssl_context()) as res:
                found = {}
                for v in json.loads(res.read()).get("voices", []):
                    name = re.split(r"\s+-\s+", v.get("name") or "", maxsplit=1)[0].strip()
                    if name and v.get("voice_id"):
                        found.setdefault(name, v["voice_id"])
                _eleven_voices["voices"] = found
        except (OSError, ValueError):
            pass  # keep the last list (or the stock voices)
    return _eleven_voices["voices"] or ELEVEN_FALLBACK_VOICES


def engine_voices(engine: str) -> list[str]:
    cfg = config()
    if engine == "azure":
        return cfg.get("azureVoices") or [cfg.get("azureVoice") or AZURE_VOICE]
    if engine == "elevenlabs":
        return list(eleven_voices())
    return cfg.get("geminiVoices") or GEMINI_VOICES


def missing_keys(engine: str, key_set: dict) -> list[str]:
    return [n for n in ENGINES[engine]["needs"] if not key_set.get(n)]


def suggest_engine(n_pt_in_en: int, available: list[str]) -> str | None:
    """Azure for many Portuguese terms inside English lines (only it switches mid-sentence,
    see azure_terms), else Gemini; among the available."""
    order = (["azure", "vertex", "gemini"] if n_pt_in_en >= INLINE_LIMIT
             else ["vertex", "gemini", "azure"]) + ["elevenlabs"]
    return next((e for e in order if e in available), None)


def choose_engine(requested: str, n_pt_in_en: int, available: list[str] | None = None) -> str | None:
    if requested and requested != "auto":
        return requested
    return suggest_engine(n_pt_in_en, list(ENGINES) if available is None else available)


def engine_note(engine: str, n_inline: int) -> str:
    """How the engine treats the script's <pt>/<en> marks."""
    if not n_inline:
        return ""
    terms = f"{n_inline} marked term{'s' if n_inline != 1 else ''}"
    if ENGINES[engine]["mixes"]:
        return f"{terms} switch language mid-sentence"
    return f"{terms} read in the line's language ({ENGINES[engine]['label']} cannot switch mid-sentence)"


def _repeats(line: str, block: str) -> bool:
    """Does `line` (8+ words) repeat, word for word, a stretch already in `block`?"""
    a = " ".join(re.sub(r"[^\w]+", " ", line.lower()).split())
    b = " ".join(re.sub(r"[^\w]+", " ", block.lower()).split())
    words = a.split()
    if len(words) < 8:
        return bool(a) and len(words) >= 4 and a in b
    return any(" ".join(words[i:i + 8]) in b for i in range(0, len(words) - 7, 4))


def _pieces(text: str, limit: int) -> list[str]:
    """A line longer than `limit`, cut at sentence ends (or, failing that, at spaces)."""
    if len(text) <= limit:
        return [text]
    out, cur = [], ""
    for sent in re.split(r"(?<=[.!?;:])\s+", text):
        while len(sent) > limit:
            cut = sent.rfind(" ", 0, limit)
            cut = cut if cut > 0 else limit
            if cur:
                out.append(cur)
                cur = ""
            out.append(sent[:cut])
            sent = sent[cut:].lstrip()
        if cur and len(cur) + 1 + len(sent) > limit:
            out.append(cur)
            cur = sent
        else:
            cur = f"{cur} {sent}".strip()
    if cur:
        out.append(cur)
    return out


def build_calls(items, engine: str) -> list:
    """Calls and pauses, in order.
    Gemini, ElevenLabs: (engine, lang, text)  consecutive lines of one language, no pause between.
    Azure:  ("azure", [Line, ...])  consecutive lines, no pause between.
    GAP_S goes between consecutive calls; a [pause] takes its place."""
    calls: list = []
    for it in items:
        if isinstance(it, Pause):
            calls.append(("pause", it.seconds))
            continue
        last = calls[-1] if calls else None
        if engine in BLOCK_ENGINES:
            limit = CALL_CHARS.get(engine, MAX_CALL_CHARS)
            for txt in _pieces(respell(it.lang, plain(it.text)), limit):
                last = calls[-1] if calls else None
                # Gemini TTS tends to loop when one call repeats a passage (forum report,
                # gemini-3.8-flash-tts): a line already in the call starts a new one
                repeat = (engine in TOKEN_ENGINES and last and last[0] == engine
                          and _repeats(txt, last[2]))
                if (last and last[0] == engine and last[1] == it.lang and not repeat
                        and len(last[2]) + len(txt) <= limit):
                    calls[-1] = (engine, it.lang, last[2] + "\n\n" + txt)
                else:
                    calls.append((engine, it.lang, txt))
        else:
            if last and last[0] == "azure" and sum(len(f.text) for f in last[1]) + len(it.text) <= MAX_CALL_CHARS:
                last[1].append(it)
            else:
                calls.append(("azure", [it]))
    return calls


def gemini_usd_per_m_tokens() -> float:
    override = config().get("geminiUsdPerMTokens")
    if override:
        return float(override)
    today = time.strftime("%Y-%m-%d")
    return next(price for start, price in GEMINI_PRICE_SCHEDULE if today >= start)


def usd_per_m_chars(engine: str) -> float:
    if engine == "elevenlabs":
        return float(config().get("elevenUsdPerMChars") or ELEVEN_USD_PER_M_CHARS)
    return AZURE_USD_PER_M_CHARS


def voice_label(voice: str) -> str:
    """en-US-AndrewMultilingualNeural -> Andrew; Kore -> Kore."""
    m = re.match(r"^[a-z]{2}-[A-Z]{2}-(.+?)(?:Multilingual)?Neural$", voice)
    return m.group(1) if m else voice


_UNBILLED_TAGS = re.compile(r"</?(?:speak|voice)\b[^>]*>")


def azure_billed_chars(calls) -> int:
    """Azure bills every SSML character except the <speak> and <voice> tags, so the
    <lang> and <break> marks around each run count (learn.microsoft.com, Speech quotas)."""
    return sum(len(_UNBILLED_TAGS.sub("", ssml(c[1], AZURE_VOICE))) for c in calls if c[0] == "azure")


def _estimate(items, lines, engine: str) -> dict:
    calls = build_calls(items, engine)
    n_calls = sum(1 for c in calls if c[0] != "pause")
    pauses = [c[1] for c in calls if c[0] == "pause"]
    chars = sum(len(plain(l.text)) for l in lines)
    words = sum(len(plain(l.text).split()) for l in lines)
    speech = words / WORDS_PER_MIN[engine] * 60
    seconds = speech + sum(pauses) + GAP_S * max(0, n_calls - 1)
    if engine == "azure":
        seconds += AZURE_LINE_BREAK_S * max(0, len(lines) - n_calls)
    billed = azure_billed_chars(calls) if engine == "azure" else chars
    cost = (speech * GEMINI_TOKENS_PER_S * gemini_usd_per_m_tokens() / 1e6 if engine in TOKEN_ENGINES
            else billed * usd_per_m_chars(engine) / 1e6)
    return {"calls": n_calls, "answerPauses": pauses, "characters": chars, "billedCharacters": billed,
            "wordsPerMinute": WORDS_PER_MIN[engine],
            "estSeconds": round(seconds), "estCostUsd": round(cost, 3)}


def plan(script: str, engine: str = "auto", voice: str | None = None,
         key_set: dict | None = None) -> dict:
    """What a run would do and cost. No API call.
    `engines` lists every engine with its availability (keys set), voices, note on the
    marks and estimate; `suggested` is the one "auto" picks; `engine` the one planned."""
    errors = check(script)
    items = parse(script) if not errors else []
    lines = [i for i in items if isinstance(i, Line)]
    if not errors and not lines:
        errors = ["the script is empty"]
    if errors:
        return {"ok": False, "errors": errors}
    ks = keys() if key_set is None else key_set
    n_inline = inline_count(items)
    n_azure = azure_terms(items)
    available = [e for e in ENGINES if not missing_keys(e, ks)]
    suggested = suggest_engine(n_azure, available)
    engines = [{"id": e, "label": ENGINES[e]["label"], "available": e in available,
                "missing": missing_keys(e, ks), "voices": engine_voices(e),
                "note": engine_note(e, n_inline), **_estimate(items, lines, e)} for e in ENGINES]
    eng = choose_engine(engine, n_azure, available)
    if eng is None:
        return {"ok": False, "engines": engines, "errors": [
            "no TTS key found: set GEMINI_API_KEY, or AZURE_SPEECH_KEY and AZURE_SPEECH_REGION, "
            f"in the environment or the envFile named in {CONFIG_FILE}"]}
    chosen = next(e for e in engines if e["id"] == eng)
    voices = chosen["voices"]
    return {
        "ok": True, "engine": eng, "suggested": suggested, "engines": engines,
        "ready": chosen["available"], "missing": chosen["missing"],
        "voice": voice if voice in voices else (voices[0] if len(voices) == 1 else None),
        "voices": voices, "note": chosen["note"],
        "words": sum(len(plain(l.text).split()) for l in lines),
        "inlineTerms": n_inline, "title": plain(lines[0].text),
        **{k: chosen[k] for k in ("calls", "answerPauses", "characters", "billedCharacters",
                                  "wordsPerMinute", "estSeconds", "estCostUsd")},
    }


# --- engines ---------------------------------------------------------------------------

def _post(url: str, headers: dict, body: bytes, log: Callable[[str], None]) -> bytes:
    error = ""
    ctx = _ssl_context()
    for attempt in range(1, ATTEMPTS + 1):
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S, context=ctx) as res:
                return res.read()
        except urllib.error.HTTPError as e:
            error = f"HTTP {e.code}: {e.read()[:300].decode('utf-8', 'replace')}"
            if e.code == 429:          # per-minute limit: really wait
                log(f"rate limited; waiting {20 * attempt} s")
                time.sleep(20 * attempt)
                continue
            if e.code < 500:
                break
        except (urllib.error.URLError, OSError) as e:
            error = str(e)
        time.sleep(3 * attempt)
    raise TTSError(f"TTS request failed: {error}")


def _ffmpeg(*args) -> None:
    proc = subprocess.run([_tool("ffmpeg"), "-y", "-loglevel", "error", *map(str, args)],
                          capture_output=True, text=True)
    if proc.returncode:
        raise TTSError(f"ffmpeg: {proc.stderr.strip()[-300:]}")


def gemini(lang: str, text: str, dest: Path, key: str, voice: str, log) -> int:
    model = config().get("geminiModel") or GEMINI_MODEL
    body = {"contents": [{"parts": [{"text": text}]}],
            "generationConfig": {"responseModalities": ["AUDIO"], "speechConfig": {
                "languageCode": LOCALE[lang],
                "voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}}}}
    raw = _post(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                {"x-goog-api-key": key, "Content-Type": "application/json"},
                json.dumps(body).encode(), log)
    return _gemini_audio(json.loads(raw), dest)


def vertex(lang: str, text: str, dest: Path, key: str, voice: str, log) -> int:
    """Gemini TTS through Google Cloud (Vertex AI); each call holds one language block,
    with its locale. Without a languageCode the model guesses the language from the text,
    and on a short Portuguese line it picked European Portuguese (2026-11-18). Without
    GOOGLE_CLOUD_PROJECT the key's own project is used (the short publisher path)."""
    cfg, ks = config(), keys()
    model = cfg.get("vertexModel") or cfg.get("geminiModel") or GEMINI_MODEL
    project = ks.get("GOOGLE_CLOUD_PROJECT")
    location = ks.get("GOOGLE_CLOUD_LOCATION") or "global"
    host = ("https://aiplatform.googleapis.com" if location == "global"
            else f"https://aiplatform.{location}.rep.googleapis.com")
    path = (f"/v1/projects/{project}/locations/{location}/publishers/google/models/{model}"
            if project else f"/v1/publishers/google/models/{model}")
    body = {"contents": [{"role": "user", "parts": [{"text": text}]}],
            "generationConfig": {"responseModalities": ["AUDIO"],
                                 "speechConfig": {"languageCode": LOCALE[lang],
                                                  "voiceConfig": {"voice": voice}}}}
    raw = _post(f"{host}{path}:generateContent",
                {"x-goog-api-key": key, "Content-Type": "application/json"},
                json.dumps(body).encode(), log)
    return _gemini_audio(json.loads(raw), dest)


def _gemini_audio(d: dict, dest: Path) -> int:
    """A generateContent answer -> WAV at dest; returns the audio tokens billed."""
    try:
        data = d["candidates"][0]["content"]["parts"][0]["inlineData"]["data"]
    except (KeyError, IndexError):
        raise TTSError(f"Gemini returned no audio: {json.dumps(d)[:400]}")
    audio = base64.b64decode(data)
    if audio[:4] == b"RIFF":
        dest.write_bytes(audio)
    else:   # raw 16-bit PCM
        pcm = dest.with_suffix(".pcm")
        pcm.write_bytes(audio)
        _ffmpeg("-f", "s16le", "-ar", RATE, "-ac", 1, "-i", pcm, dest)
    return int(d.get("usageMetadata", {}).get("candidatesTokenCount", 0))


LINE_BREAK = "<break/>"  # strength medium = 750 ms; 8 billed characters (a timed one is 21)


def ssml(lines: list[Line], voice: str) -> str:
    """One <voice> per language run (inside a single <voice>, word-level <lang> is
    ignored), but consecutive lines in one language share their run, and lines are
    separated by a bare <break/>: Azure bills the <lang> and <break> markup."""
    merged: list[list[str]] = []
    for ln in lines:
        rs = runs(ln.lang, ln.text)
        for i, (g, t) in enumerate(rs):
            piece = escape(respell(g, t)) + (LINE_BREAK if i == len(rs) - 1 else "")
            if merged and merged[-1][0] == g:
                merged[-1][1] += piece
            else:
                merged.append([g, piece])
    if merged and merged[-1][1].endswith(LINE_BREAK):  # the gap between calls follows
        merged[-1][1] = merged[-1][1][: -len(LINE_BREAK)]
    parts = [f'<voice name="{voice}"><lang xml:lang="{LOCALE[g]}">{t}</lang></voice>' for g, t in merged]
    return ('<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">'
            + "".join(parts) + "</speak>")


def azure(lines: list[Line], dest: Path, key: str, region: str, voice: str, log) -> None:
    region = region.lower().replace(" ", "")
    dest.write_bytes(_post(
        f"https://{region}.tts.speech.microsoft.com/cognitiveservices/v1",
        {"Ocp-Apim-Subscription-Key": key, "Content-Type": "application/ssml+xml",
         "X-Microsoft-OutputFormat": "riff-24khz-16bit-mono-pcm", "User-Agent": "remnote-media-bridge"},
        ssml(lines, voice).encode("utf-8"), log))


def elevenlabs(lang: str, text: str, dest: Path, key: str, voice: str, log) -> None:
    model = config().get("elevenModel") or ELEVEN_MODEL
    voice_id = eleven_voices(key).get(voice, voice)
    body = {"text": text, "model_id": model}
    if model in ELEVEN_LANGUAGE_MODELS:
        body["language_code"] = lang
    pcm = dest.with_suffix(".pcm")
    pcm.write_bytes(_post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=pcm_{RATE}",
        {"xi-api-key": key, "Content-Type": "application/json"}, json.dumps(body).encode(), log))
    _ffmpeg("-f", "s16le", "-ar", RATE, "-ac", 1, "-i", pcm, dest)


def silence(seconds: float, dest: Path) -> Path:
    _ffmpeg("-f", "lavfi", "-i", f"anullsrc=r={RATE}:cl=mono", "-t", seconds, "-c:a", "pcm_s16le", dest)
    return dest


def duration(path: Path) -> float:
    r = subprocess.run([_tool("ffprobe"), "-v", "error", "-show_entries", "format=duration",
                        "-of", "csv=p=0", str(path)], capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except ValueError:
        return 0.0


# --- checking what a generative engine said ------------------------------------------

def _whisper() -> tuple[str, Path] | None:
    """whisper.cpp's CLI and model, or None (then only the duration is checked).
    tts.json: "whisperCli", "whisperModel"; "verifySpeech": false turns the check off."""
    cfg = config()
    if cfg.get("verifySpeech") is False:
        return None
    cli = cfg.get("whisperCli") or shutil.which("whisper-cli") or "/opt/homebrew/bin/whisper-cli"
    model = Path(cfg.get("whisperModel") or WHISPER_MODEL).expanduser()
    return (cli, model) if Path(cli).exists() and model.exists() else None


_UNITS = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
_TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()


def _en_number(n: int) -> str:
    """140 -> 'one hundred and forty' (British 'and'), up to 9,999; else the digits."""
    if n < 20:
        return _UNITS[n]
    if n < 100:
        return _TENS[n // 10] + ("" if n % 10 == 0 else " " + _UNITS[n % 10])
    if n < 1000:
        rest = n % 100
        return _UNITS[n // 100] + " hundred" + ("" if rest == 0 else " and " + _en_number(rest))
    if n < 10000:
        rest = n % 1000
        return (_UNITS[n // 1000] + " thousand"
                + ("" if rest == 0 else (" and " if rest < 100 else " ") + _en_number(rest)))
    return str(n)


_PT_UNITS = ("zero um dois tres quatro cinco seis sete oito nove dez onze doze treze catorze quinze "
             "dezesseis dezessete dezoito dezenove").split()
_PT_TENS = "_ _ vinte trinta quarenta cinquenta sessenta setenta oitenta noventa".split()
_PT_HUNDREDS = "_ cento duzentos trezentos quatrocentos quinhentos seiscentos setecentos oitocentos novecentos".split()


def _pt_number(n: int) -> str:
    """2026 -> 'dois mil e vinte e seis', up to 9,999; else the digits. Accents left out,
    as _norm_words strips them before numbers are spelled."""
    if n < 20:
        return _PT_UNITS[n]
    if n < 100:
        return _PT_TENS[n // 10] + ("" if n % 10 == 0 else " e " + _PT_UNITS[n % 10])
    if n < 1000:
        if n == 100:
            return "cem"
        rest = n % 100
        return _PT_HUNDREDS[n // 100] + ("" if rest == 0 else " e " + _pt_number(rest))
    if n < 10000:
        rest = n % 1000
        head = "mil" if n < 2000 else _PT_UNITS[n // 1000] + " mil"
        if rest == 0:
            return head
        # "e" before a round hundred or anything under 100: dois mil e trezentos, dois mil e seis
        return head + (" e " if rest < 100 or rest % 100 == 0 else " ") + _pt_number(rest)
    return str(n)


# Portuguese forms a spelled number can take in the text but not in _pt_number
_PT_SPELLING = {"uma": "um", "duas": "dois", "quatorze": "catorze"}
_PT_FEMININE_HUNDREDS = re.compile(r"(?<=[a-z]{3})entas$")

# British and American spellings compared as one (scripts are British, whisper American)
_SPELLING = [(re.compile(r"oeuvre(s?)$"), r"euver\1"), (re.compile(r"oeuvr(ed|ing)$"), r"euver\1"),
             (re.compile(r"(?<=[a-z])tre(s?)$"), r"ter\1"),
             (re.compile(r"our(s?)$"), r"or\1"), (re.compile(r"(?<=[a-z]{3})is(e|ed|es|ing)$"), r"iz\1")]


def _norm_words(text: str, lang: str = "en") -> list[str]:
    """Words to compare a script line with its transcript. Numbers are spelled in the
    line's language: whisper writes "20 de novembro de 2026" where the script says
    "vinte de novembro de dois mil e vinte e seis" (spelled in English, every take of
    such a line failed as words added and missing, and was paid for three times)."""
    pt = lang == "pt"
    t = unicodedata.normalize("NFKD", text.lower())
    t = "".join(c for c in t if not unicodedata.combining(c))
    if pt:
        t = re.sub(r"(\d)\.(\d{3})\b", r"\1\2", t)  # 1.500 = mil e quinhentos
    else:
        t = re.sub(r"(\d),(\d{3})", r"\1\2", t)
    speller = _pt_number if pt else _en_number
    t = re.sub(r"\d+", lambda m: f" {speller(int(m.group()))} " if len(m.group()) <= 4 else m.group(), t)
    out = []
    for w in re.sub(r"[^a-z0-9]+", " ", t).split():
        if pt:
            w = _PT_FEMININE_HUNDREDS.sub("entos", _PT_SPELLING.get(w, w))
        else:
            for pat, rep in _SPELLING:
                w = pat.sub(rep, w)
        out.append(w)
    return out


def transcribe(wav: Path, lang: str) -> str | None:
    w = _whisper()
    if not w:
        return None
    w16 = wav.with_name(wav.stem + "_16k.wav")
    _ffmpeg("-i", wav, "-ar", 16000, "-ac", 1, w16)
    try:
        vad = Path(config().get("whisperVadModel") or WHISPER_VAD).expanduser()
        extra = ["--vad", "-vm", str(vad)] if vad.exists() else []
        r = subprocess.run([w[0], "-m", str(w[1]), "-f", str(w16), "-l", lang, "-nt", "-np",
                            "-mc", "0", *extra],
                           capture_output=True, text=True, timeout=600)
    except (OSError, subprocess.TimeoutExpired):
        return None
    finally:
        w16.unlink(missing_ok=True)
    return r.stdout if r.returncode == 0 else None


def verify_speech(text: str, wav: Path, lang: str, engine: str) -> dict:
    """Did the audio say the text? {seconds, expected, added, missing, problem}. `problem`
    is None when it did. Words come from a local whisper transcript when available."""
    n = len(_norm_words(text, lang))
    secs = duration(wav)
    expected = n / WORDS_PER_MIN.get(engine, 143.0) * 60
    res = {"seconds": round(secs, 1), "expected": round(expected, 1)}
    problems = []
    if secs > expected * VERIFY_LONG[0] + VERIFY_LONG[1]:
        problems.append(f"{secs:.0f} s for ~{expected:.0f} s of text")
    elif secs < expected * VERIFY_SHORT[0] - VERIFY_SHORT[1]:
        problems.append(f"only {secs:.0f} s for ~{expected:.0f} s of text")
    heard = transcribe(wav, lang)
    if heard is not None:
        a, b = _norm_words(text, lang), _norm_words(heard, lang)
        sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
        same = sum(m.size for m in sm.get_matching_blocks())
        added, missing = len(b) - same, len(a) - same
        run_add = max([j2 - j1 for op, i1, i2, j1, j2 in sm.get_opcodes() if op in ("insert", "replace")], default=0)
        run_miss = max([i2 - i1 for op, i1, i2, j1, j2 in sm.get_opcodes() if op in ("delete", "replace")], default=0)
        res.update(added=added, missing=missing, words=len(a), run_added=run_add, run_missing=run_miss)
        allowed = max(VERIFY_MIN_WORDS, VERIFY_SHARE * len(a))
        if added > allowed:
            problems.append(f"{added} words added")
        if missing > allowed:
            problems.append(f"{missing} of {len(a)} words missing")
        if run_add >= VERIFY_RUN and added <= allowed:
            problems.append(f"{run_add} words in a row added")
        if run_miss >= VERIFY_RUN and missing <= allowed:
            problems.append(f"{run_miss} words in a row missing")
    res["problem"] = "; ".join(problems) or None
    return res


def synthesize(script: str, out: Path, engine: str = "auto", voice: str | None = None,
               key_set: dict | None = None,
               progress: Callable[[str], None] | None = None) -> dict:
    """Script -> mono 64 kbps mp3 at `out`. Returns a summary; raises TTSError."""
    log = progress or (lambda _msg: None)
    ks = key_set if key_set is not None else keys()
    if engine not in ("auto", *ENGINES):
        raise TTSError(f"unknown engine {engine!r}")
    p = plan(script, engine, voice, key_set=ks)
    if not p["ok"]:
        raise TTSError("script problems:\n  " + "\n  ".join(p["errors"]))
    eng = p["engine"]
    if p["missing"]:
        raise TTSError(f"missing {', '.join(p['missing'])} (environment, or the envFile in {CONFIG_FILE})")
    voice = voice if voice in p["voices"] else random.choice(p["voices"])

    calls = build_calls(parse(script), eng)
    total = sum(1 for c in calls if c[0] != "pause")
    out = Path(out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="tts-", dir=out.parent))
    tokens, done, prev_speech, parts = 0, 0, False, []
    retries, warnings = 0, []
    try:
        for i, c in enumerate(calls):
            if c[0] == "pause":
                parts.append(silence(c[1], tmp / f"p_{i:03d}.wav"))
                prev_speech = False
                continue
            if prev_speech:
                parts.append(silence(GAP_S, tmp / f"g_{i:03d}.wav"))
            done += 1
            log(f"{ENGINES[eng]['label']} {done}/{total}")
            w = tmp / f"s_{i:03d}.wav"
            if eng in TOKEN_ENGINES:
                best = None
                for attempt in range(1, VERIFY_ATTEMPTS + 1):
                    wa = tmp / f"s_{i:03d}_{attempt}.wav"
                    if eng == "vertex":
                        tokens += vertex(c[1], c[2], wa, ks["GOOGLE_CLOUD_API_KEY"], voice, log)
                    else:
                        tokens += gemini(c[1], c[2], wa, ks["GEMINI_API_KEY"], voice, log)
                    chk = verify_speech(c[2], wa, c[1], eng)
                    score = chk.get("added", 0) + chk.get("missing", 0) + (1000 if chk["problem"] else 0)
                    if best is None or score < best[0]:
                        best = (score, wa, chk)
                    if not chk["problem"]:
                        break
                    retries += 1
                    log(f"call {done}: {chk['problem']}; " + (f"trying again ({attempt + 1}/{VERIFY_ATTEMPTS})"
                                                              if attempt < VERIFY_ATTEMPTS else "keeping the best take"))
                shutil.move(best[1], w)
                if best[2]["problem"]:
                    warnings.append(f"call {done} ({c[2][:50]}…): {best[2]['problem']}")
            elif eng == "elevenlabs":
                elevenlabs(c[1], c[2], w, ks["ELEVENLABS_API_KEY"], voice, log)
            else:
                azure(c[1], w, ks["AZURE_SPEECH_KEY"], ks["AZURE_SPEECH_REGION"], voice, log)
            parts.append(w)
            prev_speech = True
        log("joining")
        listing = tmp / "list.txt"
        listing.write_text("".join(f"file '{w}'\n" for w in parts))
        _ffmpeg("-f", "concat", "-safe", "0", "-i", listing, "-ar", RATE, "-ac", 1, "-b:a", "64k", out)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    secs = round(duration(out), 1)
    summary = {"file": str(out), "engine": eng, "voice": voice, "voiceLabel": voice_label(voice),
               "seconds": secs, "characters": p["characters"], "inlineTerms": p["inlineTerms"],
               "answerPauses": len(p["answerPauses"]), "title": p["title"],
               "retries": retries, "warnings": warnings}
    if eng in TOKEN_ENGINES:
        summary["audioTokens"] = tokens
        summary["costUsd"] = round(tokens * gemini_usd_per_m_tokens() / 1e6, 3)
    else:
        summary["costUsd"] = round(p["billedCharacters"] * usd_per_m_chars(eng) / 1e6, 3)
    return summary


# --- keeping a copy --------------------------------------------------------------------

def short_subject(text: str, limit: int = 40) -> str:
    """'Holding efficiency of the OSS anchor.' -> 'holding-efficiency-of-the-oss-anchor'."""
    t = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    out = ""
    for w in re.findall(r"[a-z0-9]+", t):
        if len(out) + len(w) + 1 > limit:
            break
        out = f"{out}-{w}" if out else w
    return out or "audio"


def keep_copy(script: str, mp3: Path, rem_id: str, subject: str, folder: Path | None = None) -> Path:
    """<folder>/<short subject>_<rem id>.txt/.mp3, with -2, -3… instead of overwriting."""
    folder = folder or audio_home()
    folder.mkdir(parents=True, exist_ok=True)
    name = f"{short_subject(subject)}_{re.sub(r'[^A-Za-z0-9]', '', rem_id) or 'rem'}"
    base, n = folder / name, 1
    while base.with_suffix(".mp3").exists():
        n += 1
        base = folder / f"{name}-{n}"
    base.with_suffix(".txt").write_text(script, encoding="utf-8")
    shutil.copyfile(mp3, base.with_suffix(".mp3"))
    return base.with_suffix(".mp3")


# --- CLI -------------------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("script", type=Path)
    ap.add_argument("--engine", choices=["auto", *ENGINES], default="auto")
    ap.add_argument("--voice")
    ap.add_argument("--out", type=Path, help="mp3 (default: next to the script)")
    ap.add_argument("--plan", action="store_true", help="engine, calls and estimate; no API call")
    a = ap.parse_args()
    text = a.script.read_text(encoding="utf-8")
    if a.plan:
        print(json.dumps(plan(text, a.engine, a.voice), ensure_ascii=False, indent=2))
        return
    try:
        res = synthesize(text, a.out or a.script.with_suffix(".mp3"), a.engine, a.voice,
                         progress=lambda m: print(m, file=sys.stderr, flush=True))
    except TTSError as e:
        sys.exit(str(e))
    print(json.dumps(res, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
