#!/usr/bin/env python3
"""LLM-written spoken scripts for the plugin's "Read aloud" (helper endpoint /tts/write).

Two modes, both starting from the outline the plugin builds from the rem tree (same
rems and skips as the Literal script, but formulas kept as LaTeX, italics as *x*):
  - adapted: the whole note, content unchanged, made listenable (formulas and units in
    words, foreign terms marked, abbreviations expanded);
  - summary: a spoken summary of about a target number of words (the plugin sets it: a
    share of the note's length, capped by a maximum duration), plus the user's
    additional instructions. A summary more than 25 % over the target gets one retry
    asking to shorten it.

The answer is a script in tts.py's format, checked with tts.check(); one retry fixes
what the check finds. The LLM is the user's `claude` CLI (`claude -p`, their
subscription, no per-call charge); when it fails (usage limit, not installed, any
error) and ANTHROPIC_API_KEY is set (same places as the TTS keys, see tts.py), the
Anthropic API is used instead (official `anthropic` SDK; about US$0.05-0.10 a note).

Config in ~/.remnote-media-bridge/tts.json (optional): "llmModel" (default
claude-opus-5-5, for both the CLI and the API). A file
~/.remnote-media-bridge/read-aloud-adapted.md or read-aloud-summary.md replaces that
mode's task instructions (the script-format rules are always added).

CLI (for testing): spoken_script.py outline.md --mode summary --lang pt [--words 350]
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable

MODES = ("adapted", "summary")
DEFAULT_MODEL = "claude-opus-5-5"
CLI_TIMEOUT_S = 300
MAX_TOKENS = 16000
# A summary this much over its target gets one retry asking to shorten it.
OVERSHOOT = 1.25
# US$ per million tokens (input, output), for the API fallback's cost line.
PRICES = {"claude-opus-5": (4.0, 20.0), "claude-sonnet-5": (2.0, 10.0), "claude-haiku-5": (0.10, 0.50)}

LANG_NAME = {"pt": "Portuguese", "en": "English"}


class LLMError(RuntimeError):
    pass


def _tts():
    """tts.py (check, keys, config): the helper may already have loaded it by path."""
    mod = sys.modules.get("remnote_bridge_tts")
    if mod is None:
        spec = importlib.util.spec_from_file_location("remnote_bridge_tts", Path(__file__).with_name("tts.py"))
        mod = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = mod
        spec.loader.exec_module(mod)
    return mod


# --- prompts ---------------------------------------------------------------------------

SCRIPT_RULES = """\
The script is plain text for a text-to-speech engine, one idea per line:
- A Portuguese line starts with "[pt] ". An English line has no prefix.
- A foreign technical term inside a line goes between <en>…</en> (an English term in a \
Portuguese line) or <pt>…</pt> (a Portuguese term in an English line). Mark only terms \
written in the other language (the outline usually has them in *italics*); never names, \
acronyms or units.
- Nothing that would be read aloud wrongly: no markdown (no **, #, list dashes, "> "), \
no LaTeX or $, no links, no page numbers, no square brackets except [pt], [en] and \
[pause], no emoji or arrows, no "[…]".
- Formulas are said in words, the way a teacher reads them aloud ("F equals m times a"; \
"a força é igual à massa vezes a aceleração"). A subscript is read with "sub" in English and "índice" in Portuguese \
(never just the two letters, which sound like a product): V_A is "V sub A" / "V índice \
A", C_{Th} is "C sub T h" / "C índice T h", r_0 is "r sub zero" / "r índice zero", \
V_{corr} is "V sub corr" / "V índice corr", V_\\infty is "V sub infinity" / "V índice \
infinito". Units are spelled out (kN: quilonewtons / \
kilonewtons). Abbreviations a listener would not understand are expanded the first time.
- To quiz the listener: the question on one line, "[pause]" alone on the next line, then \
the answer on its own line. The pause is the time to answer, so a question for the \
listener is always followed by [pause] and its answer.
Answer with the script only: no preamble, no comments, no code fences."""

TASKS = {
    "adapted": """\
Turn this outline of a study note into a spoken script that follows it exactly. Keep \
every fact, number and example, in the same order; do not summarise, add or drop \
anything. Only make it listenable: headings become short sentences that announce the \
section, formulas and units go into words, foreign terms are marked, and a flashcard \
written "X ⇒ Y" is read as a question and its answer, or as one statement.""",
    "summary": """\
Write a spoken summary of this study note, for a student revising by ear. Start with \
one line naming the subject. Cover what matters most first: definitions, mechanisms, \
numbers and rules the student must remember. Use short sentences, one idea per line, \
and plain spoken transitions; no lists read as lists. Do not invent facts that are \
not in the note.""",
}


def task_text(mode: str) -> str:
    custom = _tts().BRIDGE_HOME / f"read-aloud-{mode}.md"
    try:
        return custom.read_text(encoding="utf-8").strip() or TASKS[mode]
    except OSError:
        return TASKS[mode]


def build_prompt(mode: str, source: str, lang: str, title: str,
                 target_words: int | None = None, instructions: str = "") -> tuple[str, str]:
    """(system, user) for one run."""
    language = LANG_NAME.get(lang, "the note's language")
    system = (f"You write scripts that are turned into speech.\n\n{SCRIPT_RULES}\n\n"
              f"Write in {language}, the note's language; a line the note writes in the other "
              "language keeps that language and its prefix.")
    parts = [task_text(mode)]
    if mode == "summary" and target_words:
        parts.append(f"Length: about {target_words} words, never more. Any questions and answers "
                     "asked for below count within it. Leave out the less important details to "
                     "fit; do not just shorten every sentence.")
    if mode == "summary" and instructions.strip():
        parts.append("Additional instructions from the student:\n" + instructions.strip())
    parts.append(f"The note{f' ({title})' if title else ''}, as an outline (indentation = "
                 f"structure):\n<note>\n{source}\n</note>")
    return system, "\n\n".join(parts)


def clean(text: str) -> str:
    """Strip what models add anyway: code fences, list dashes, bold."""
    text = re.sub(r"^```\w*\n|\n```\s*$", "", text.strip())
    lines = []
    for line in text.splitlines():
        line = re.sub(r"^\s*(?:[-*•]\s+)", "", line).replace("**", "")
        lines.append(line.rstrip())
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


# --- the two ways to call Claude ---------------------------------------------------------

def find_claude() -> str | None:
    # launchd carries a minimal PATH, so check the usual install spots too.
    for c in (shutil.which("claude"), Path.home() / ".local/bin/claude",
              "/opt/homebrew/bin/claude", "/usr/local/bin/claude"):
        if c and Path(c).exists():
            return str(c)
    return None


def run_cli(system: str, user: str, model: str) -> dict:
    claude = find_claude()
    if not claude:
        raise LLMError("the claude CLI is not installed")
    # Strip everything a text task does not need: tools, MCP servers, settings (hooks),
    # session files. ANTHROPIC_API_KEY is removed so the CLI uses the subscription login.
    cmd = [claude, "-p", "--output-format", "json", "--tools", "", "--strict-mcp-config",
           "--setting-sources", "", "--no-session-persistence", "--model", model,
           "--system-prompt", system]
    env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}
    cwd = _tts().BRIDGE_HOME
    cwd.mkdir(parents=True, exist_ok=True)
    try:
        proc = subprocess.run(cmd, input=user, capture_output=True, text=True,
                              timeout=CLI_TIMEOUT_S, cwd=cwd, env=env)
    except subprocess.TimeoutExpired:
        raise LLMError(f"claude -p took more than {CLI_TIMEOUT_S} s")
    try:
        out = json.loads(proc.stdout)
    except ValueError:
        raise LLMError(f"claude exited {proc.returncode}: {(proc.stderr or proc.stdout).strip()[-300:]}")
    if out.get("is_error") or not out.get("result"):
        raise LLMError(f"claude: {str(out.get('result') or out.get('subtype'))[:300]}")
    return {"text": out["result"], "via": "claude-cli",
            "model": next(iter(out.get("modelUsage") or {}), model)}


def run_api(system: str, user: str, model: str, key: str) -> dict:
    try:
        import anthropic
    except ImportError:
        raise LLMError("the Python package anthropic is not installed for the helper "
                       f"({sys.executable} -m pip install anthropic)")
    client = anthropic.Anthropic(api_key=key)
    try:
        with client.messages.stream(model=model, max_tokens=MAX_TOKENS, system=system,
                                    messages=[{"role": "user", "content": user}]) as stream:
            msg = stream.get_final_message()
    except anthropic.APIError as err:
        raise LLMError(f"Anthropic API: {err}")
    if msg.stop_reason == "refusal":
        raise LLMError("the model declined to write this script")
    text = "".join(b.text for b in msg.content if b.type == "text")
    if not text.strip():
        raise LLMError(f"the API returned no text (stop reason {msg.stop_reason})")
    price_in, price_out = next((p for prefix, p in PRICES.items() if model.startswith(prefix)), (0.0, 0.0))
    cost = (msg.usage.input_tokens * price_in + msg.usage.output_tokens * price_out) / 1e6
    return {"text": text, "via": "anthropic-api", "model": msg.model, "costUsd": round(cost, 3),
            "truncated": msg.stop_reason == "max_tokens"}


# --- the whole run -------------------------------------------------------------------------

def word_count(script: str) -> int:
    tts = _tts()
    return sum(len(tts.plain(i.text).split()) for i in tts.parse(script) if isinstance(i, tts.Line))


def write(mode: str, source: str, lang: str = "pt", title: str = "",
          target_words: int | None = None, instructions: str = "",
          key_set: dict | None = None,
          progress: Callable[[str], None] | None = None) -> dict:
    """Outline -> {script, errors, via, model, costUsd, fallbackReason?, seconds}.
    Raises LLMError when neither the CLI nor the API answered."""
    if mode not in MODES:
        raise LLMError(f"unknown mode {mode!r}")
    if not source.strip():
        raise LLMError("nothing to read")
    log = progress or (lambda _m: None)
    tts = _tts()
    model = tts.config().get("llmModel") or DEFAULT_MODEL
    key = (tts.keys() if key_set is None else key_set).get("ANTHROPIC_API_KEY")
    system, user = build_prompt(mode, source, lang, title, target_words, instructions)
    started = time.time()
    cost, fallback = 0.0, None

    def call(prompt: str, use_api: bool) -> dict:
        nonlocal cost
        res = run_api(system, prompt, model, key) if use_api else run_cli(system, prompt, model)
        cost += res.get("costUsd", 0.0)
        return res

    log("writing with Claude (claude -p)")
    try:
        res = call(user, False)
    except LLMError as err:
        if not key:
            raise LLMError(f"{err}. Set ANTHROPIC_API_KEY for the helper to use the API instead.")
        fallback = str(err)
        log("claude -p failed; writing with the Anthropic API")
        res = call(user, True)
    use_api = res["via"] == "anthropic-api"
    script = clean(res["text"])
    errors = tts.check(script)
    if errors:
        log(f"fixing {len(errors)} problem{'s' if len(errors) != 1 else ''}")
        retry = (f"{user}\n\nYour script:\n<script>\n{script}\n</script>\n\nIt breaks these rules:\n"
                 + "\n".join(errors) + "\n\nAnswer with the whole corrected script only.")
        try:
            fixed = clean(call(retry, use_api)["text"])
            if len(tts.check(fixed)) < len(errors):
                script, errors = fixed, tts.check(fixed)
        except LLMError:
            pass  # keep the first answer; the popup shows what is left to fix
    words = word_count(script)
    if mode == "summary" and target_words and words > target_words * OVERSHOOT:
        log(f"shortening ({words} words for a target of {target_words})")
        retry = (f"{user}\n\nYour script:\n<script>\n{script}\n</script>\n\nIt has {words} words. "
                 f"Shorten it to about {target_words} words: drop the less important points, keep "
                 "the format and any questions asked for. Answer with the whole script only.")
        try:
            shorter = clean(call(retry, use_api)["text"])
            n = word_count(shorter)
            if n < words and len(tts.check(shorter)) <= len(errors):
                script, words, errors = shorter, n, tts.check(shorter)
        except LLMError:
            pass
    out = {"script": script, "errors": errors, "words": words, "targetWords": target_words, "via": res["via"], "model": res["model"],
           "costUsd": round(cost, 3), "seconds": round(time.time() - started)}
    if fallback:
        out["fallbackReason"] = fallback
    if res.get("truncated"):
        out["errors"] = out["errors"] + ["the answer was cut off at the length limit"]
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("outline", type=Path)
    ap.add_argument("--mode", choices=MODES, default="summary")
    ap.add_argument("--lang", choices=["pt", "en"], default="pt")
    ap.add_argument("--words", type=int, help="summary target in words")
    ap.add_argument("--instructions", default="")
    ap.add_argument("--prompt", action="store_true", help="print the prompt; no call")
    a = ap.parse_args()
    source = a.outline.read_text(encoding="utf-8")
    if a.prompt:
        system, user = build_prompt(a.mode, source, a.lang, "", a.words, a.instructions)
        print(system, "\n\n---\n\n", user)
        return
    try:
        res = write(a.mode, source, a.lang, "", a.words, a.instructions,
                    progress=lambda m: print(f"  {m}", file=sys.stderr, flush=True))
    except LLMError as e:
        raise SystemExit(str(e))
    print(res.pop("script"))
    print(json.dumps(res, ensure_ascii=False), file=sys.stderr)


if __name__ == "__main__":
    main()
