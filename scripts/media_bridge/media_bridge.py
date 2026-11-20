#!/usr/bin/env python3
"""Local Media Bridge: get local images into RemNote's own storage from outside the app,
and run a few rem operations the RemNote MCP lacks (move, tag, untag, get-image, incrementalize,
pin, pin-quote, card, audio).

Why: since RemNote 1.29 the desktop window runs sandboxed (webSecurity on), so an
image written into a rem as `![](file:///…)` — e.g. by the RemNote MCP — is never
uploaded and renders as "Unable to find this image". RemNote still uploads
http(s) images (its main process fetches them), but only when something asks it to.
That something is the Incremental Everything plugin (src/lib/media_bridge.ts):

  1. `media_bridge.py put fig.png`  copies the file into the bridge store and prints
     an http://127.0.0.1:3460/files/… URL, served by this helper.
  2. Write the rem with `![](<that URL>)` (MCP append_doc / edit_rem / create_doc).
  3. `media_bridge.py localize <remId> …`  queues a job. The plugin, which long-polls
     GET /next while its "Local Media Bridge" setting is on, runs
     "Store linked images & audio in RemNote" on those rems: the URL is swapped for
     a stored %LOCAL_FILE% copy and the rem no longer depends on this helper.

The same job channel carries the operations the RemNote MCP cannot do, each run by the
plugin with its own code (src/lib/media_bridge_ops.ts):

  move <rem>[,<rem>…] <parent> [first|last|N|before:<id>|after:<id>]
  tag <rem>[,<rem>…] <tag rem id>   adds a tag (works on PDF rems, which the MCP's tag_rems refuses)
  untag <rem>[,<rem>…] <tag id | tag name | powerup:<code>>
  get-image <rem> [--out DIR]       copies the rem's images to files, prints their paths
  incrementalize <rem>[,<rem>…] [--priority N]
  pin <rem>[,<rem>…] [--refs <id>[,<id>…]] [--unpin]   references → 📌 pins (default: highlight refs)
  pin-quote <rem>[,<rem>…] [--source <pdf/article rem>] [--view pdf|html|both] [--quote TEXT]
                                    without --source: your source finder names each rem's book and PDF
                                    Pin Source Quote: find the rem's text in the source, pin its highlight
  card <rem>[,<rem>…] [--type concept|descriptor|default] [--direction forward|backward|both|none]
  heading <rem>[,<rem>…] [--level next|1-6|none]
  portal <rem>[,<rem>…] <parent> [first|last|N|before:<id>|after:<id>]
  audio <parent> <file> [--caption TEXT] [--position first|last|N|before:<id>|after:<id>]
                                    adds a child rem with a playable audio file (default: first child),
                                    stored in RemNote like a localized image
  restore-audio <rem>[,<rem>…]      stores again, under its real audio type, every audio of these rems
                                    that was stored as an image (no file extension, served as image/…,
                                    which iOS refuses to play), and points the player at the new copy

Each prints the plugin's JSON answer; exit 0 = done, 1 = failed (or partly), 2 = timeout.

The helper starts itself in the background the first time a command needs it.
Standard library only. Files older than 30 days are removed from the store.

Endpoints (127.0.0.1:3460, CORS open, for the plugin iframe):
  GET  /health                 {ok, version, pluginSeenSecondsAgo}
  GET  /files/<name>           a stored file
  POST /files[?name=…]         raw bytes → {url, type, bytes}: kept in the store under their real
                               type (sniffed from the bytes), served at url. With a JSON body
                               {url, kbId?} for a file RemNote already stores (%LOCAL_FILE%… or its
                               S3 address): read from this computer's copy, else downloaded. Used by
                               restore-audio, and by other plugins (through Incremental RemNote's
                               store-media bridge) to get audio stored with its real type.
  POST /jobs {op?, remIds, …}  → {jobId}   (op defaults to "localize")
  GET  /jobs/<id>              {status: queued|taken|done, result?}
  POST /upscale {remId, url, kbId?, extra?} → {taskId}   (plugin → helper: the
                               "Upscale image with ChatGPT" command; runs upscale_image.py,
                               i.e. Codex CLI image generation + the fidelity check)
  GET  /upscale/<id>           {status: queued|running|done, stage, result?}
  POST /tts/plan {script, engine?, voice?}  what a /tts run would do: errors, every engine
                               (available = its keys are set, voices, note, estimate), the
                               suggested one, and for the planned engine: voices, calls,
                               characters, estSeconds, estCostUsd. No API call.
  POST /tts {script, engine?, voice?, remId?, subject?, purpose?} → {taskId}; purpose
                               "pronunciation" keeps the copy in tts.py's pronunciationHome   (plugin → helper: the
                               "Read aloud" command; runs tts.py: Gemini or Azure TTS, mp3)
  POST /tts/write {mode: adapted|summary, source, lang, title?, targetWords?, instructions?}
                               → {taskId}: an LLM writes the spoken script from the plugin's
                               outline (spoken_script.py: `claude -p`, Anthropic API fallback);
                               result {script, errors, via, model, costUsd, fallbackReason?}
  POST /tts/play {url}         plays one of the helper's served audio files on this computer
                               (ffplay, or afplay on macOS): "Add pronunciation" when RemNote
                               refuses to autoplay in the plugin
  GET  /tts/<id>               {status: running|done, stage, result?}; result.url serves the
                               mp3 for the `audio` op; a copy is kept in tts.py's audioHome
  GET  /next?wait=25&v=2       plugin long-poll → {id, op, remIds, …} or 204. A plugin
                               polling without v=2 is an older build: it gets only
                               localize jobs, the rest wait for a build that knows them.
  POST /result {jobId, …}      plugin answer
  POST /answers {askId, answer}  the user's choice on an `ask` notice (askId = the job id);
                               kept in answers.json, so it outlives a helper restart
  GET  /answers/<askId>        {askId, status: pending|answered, answer?, at?}
  POST /clipboard {text}       puts text on the system clipboard (pbcopy). Plugin iframes
                               have no clipboard-write permission, so "Copy Rem ID" asks here.
  POST /shutdown
"""
from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

VERSION = 19  # 3: /upscale, 4: /clipboard, 5: pin, pin-quote, card, 6: tag, 7: audio, 8: /tts, 9: /tts/plan lists engines, 10: /tts/write, ElevenLabs, 11: /tts/play, 12: /tts purpose, 13: POST /files, restore-audio, 14: notice, 15: set-text, remove, 16: heading, 17: portal, 18: ask + /answers, outline, 19: strip-priority, card --practice
# The jobs a plugin build understands, by the protocol version it polls with.
OPS_BY_PLUGIN_VERSION = {
    1: {"localize"},
    2: {"localize", "move", "untag", "get-image", "incrementalize"},
    3: {"localize", "move", "untag", "get-image", "incrementalize", "pin", "pin-quote", "card"},
    4: {"localize", "move", "tag", "untag", "get-image", "incrementalize", "pin", "pin-quote", "card"},
    5: {"localize", "move", "tag", "untag", "get-image", "incrementalize", "pin", "pin-quote", "card", "audio"},
    6: {"localize", "move", "tag", "untag", "get-image", "incrementalize", "pin", "pin-quote", "card", "audio",
        "restore-audio"},
    7: {"localize", "move", "tag", "untag", "get-image", "incrementalize", "pin", "pin-quote", "card", "audio",
        "restore-audio", "notice"},
    8: {"localize", "move", "tag", "untag", "get-image", "incrementalize", "pin", "pin-quote", "card", "audio",
        "restore-audio", "notice", "set-text", "remove"},
    9: {"localize", "move", "tag", "untag", "get-image", "incrementalize", "pin", "pin-quote", "card", "audio",
        "restore-audio", "notice", "set-text", "remove", "heading"},
    10: {"localize", "move", "tag", "untag", "get-image", "incrementalize", "pin", "pin-quote", "card", "audio",
         "restore-audio", "notice", "set-text", "remove", "heading", "portal"},
    11: {"localize", "move", "tag", "untag", "get-image", "incrementalize", "pin", "pin-quote", "card", "audio",
         "restore-audio", "notice", "set-text", "remove", "heading", "portal", "ask"},
    12: {"localize", "move", "tag", "untag", "get-image", "incrementalize", "pin", "pin-quote", "card", "audio",
         "restore-audio", "notice", "set-text", "remove", "heading", "portal", "ask", "outline"},
    13: {"localize", "move", "tag", "untag", "get-image", "incrementalize", "pin", "pin-quote", "card", "audio",
         "restore-audio", "notice", "set-text", "remove", "heading", "portal", "ask", "outline", "strip-priority"},
}
# Jobs that may name no rem at all.
OPS_WITHOUT_REMS = {"notice", "ask"}
KNOWN_OPS = OPS_BY_PLUGIN_VERSION[max(OPS_BY_PLUGIN_VERSION)]
HOST = "127.0.0.1"
PORT = int(os.environ.get("REMNOTE_MEDIA_BRIDGE_PORT", "3460"))
BASE = f"http://{HOST}:{PORT}"
HOME = Path(os.environ.get("REMNOTE_MEDIA_BRIDGE_HOME", Path.home() / ".remnote-media-bridge"))
STORE = HOME / "files"
LOG_FILE = HOME / "bridge.log"
OUT_DIR = HOME / "out"
REMNOTE_DATA = Path(os.environ.get("REMNOTE_DATA_DIR", Path.home() / "remnote"))
MAX_AGE_S = 30 * 24 * 3600
MAX_UPLOAD_BYTES = 200 * 1024 * 1024
REMNOTE_FILE_HOST = "https://remnote-user-data.s3.amazonaws.com/"
# Served types where mimetypes' table is missing or differs by platform.
CTYPE_BY_EXT = {
    ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".ogg": "audio/ogg",
    ".webm": "audio/webm", ".flac": "audio/flac",
}
REDELIVER_AFTER_S = 120  # a localize job taken but never answered goes back to the queue
# Only localize is safe to run twice. Any other job taken and never answered (the
# plugin reloaded mid-job) is marked lost instead, so it cannot run later, after
# newer commands, once its caller has given up.
REPEATABLE_OPS = {"localize"}

UPSCALE_SCRIPT = Path(__file__).resolve().parent / "upscale_image.py"
TTS_SCRIPT = Path(__file__).resolve().parent / "tts.py"
SPOKEN_SCRIPT = Path(__file__).resolve().parent / "spoken_script.py"
UPSCALE_HOME = Path(os.environ.get("REMNOTE_UPSCALE_HOME", Path.home() / "Pictures" / "remnote-upscale"))

# --- server --------------------------------------------------------------------

_jobs: dict[str, dict] = {}
_cond = threading.Condition()
ANSWERS_FILE = HOME / "answers.json"
_answers_lock = threading.Lock()


def _load_answers() -> dict:
    try:
        return json.loads(ANSWERS_FILE.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def _save_answer(ask_id: str, answer: str) -> None:
    with _answers_lock:
        data = _load_answers()
        now = time.time()
        data = {k: v for k, v in data.items() if now - v.get("at", now) < MAX_AGE_S}
        data[ask_id] = {"answer": answer, "at": now}
        HOME.mkdir(parents=True, exist_ok=True)
        tmp = ANSWERS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(data))
        tmp.replace(ANSWERS_FILE)
_plugin_seen = 0.0
_plugin_version = 0


def _next_job(plugin_version: int) -> dict | None:
    now = time.time()
    ops = OPS_BY_PLUGIN_VERSION.get(plugin_version, KNOWN_OPS if plugin_version > 2 else {"localize"})
    for job in _jobs.values():
        if job["status"] == "taken" and now - job["takenAt"] > REDELIVER_AFTER_S and job["op"] not in REPEATABLE_OPS:
            job["status"], job["result"] = "done", {
                "ok": False, "lost": True,
                "message": "the plugin took this job but never answered (reloaded mid-job?); check the rems, then rerun",
            }
            continue
        if job["op"] not in ops:
            continue
        if job["status"] == "queued" or (job["status"] == "taken" and now - job["takenAt"] > REDELIVER_AFTER_S):
            job["status"], job["takenAt"] = "taken", now
            return job
    return None


class Handler(BaseHTTPRequestHandler):
    server_version = "RemNoteMediaBridge/1"

    def log_message(self, fmt, *args):  # quiet, but keep a trail in the log file
        sys.stderr.write("%s %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def _send(self, status: int, body: bytes = b"", ctype: str = "application/json"):
        self.send_response(status)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store")
        if body or status != 204:
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _json(self, status: int, obj) -> None:
        self._send(status, json.dumps(obj).encode())

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            return {}

    def do_OPTIONS(self):
        self._send(204)

    def do_GET(self):
        global _plugin_seen, _plugin_version
        url = urlparse(self.path)
        if url.path == "/health":
            ago = None if not _plugin_seen else round(time.time() - _plugin_seen, 1)
            return self._json(
                200,
                {"ok": True, "version": VERSION, "pluginSeenSecondsAgo": ago, "pluginVersion": _plugin_version or None},
            )
        if url.path.startswith("/files/"):
            name = unquote(url.path[len("/files/"):])
            path = (STORE / name).resolve()
            if path.parent != STORE.resolve() or not path.is_file():
                return self._json(404, {"error": "not found"})
            ctype = CTYPE_BY_EXT.get(path.suffix.lower()) or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            return self._send(200, path.read_bytes(), ctype)
        if url.path.startswith("/upscale/"):
            task = _tasks.get(url.path[len("/upscale/"):])
            if not task:
                return self._json(404, {"error": "no such task (helper restarted?)"})
            out = {k: task.get(k) for k in ("id", "remId", "status", "stage", "result")}
            out["elapsed"] = round(time.time() - task["createdAt"])
            return self._json(200, out)
        if url.path.startswith("/tts/"):
            task = _tts_tasks.get(url.path[len("/tts/"):])
            if not task:
                return self._json(404, {"error": "no such task (helper restarted?)"})
            out = {k: task.get(k) for k in ("id", "remId", "status", "stage", "result")}
            out["elapsed"] = round(time.time() - task["createdAt"])
            return self._json(200, out)
        if url.path.startswith("/jobs/"):
            job = _jobs.get(url.path[len("/jobs/"):])
            if not job:
                return self._json(404, {"error": "no such job"})
            return self._json(200, {k: job.get(k) for k in ("id", "op", "status", "remIds", "result")})
        if url.path.startswith("/answers/"):
            ask_id = url.path[len("/answers/"):]
            got = _load_answers().get(ask_id)
            if got:
                return self._json(200, {"askId": ask_id, "status": "answered", **got})
            return self._json(200, {"askId": ask_id, "status": "pending"})
        if url.path == "/next":
            query = parse_qs(url.query)
            _plugin_seen = time.time()
            try:
                _plugin_version = int(query.get("v", ["1"])[0])
            except ValueError:
                _plugin_version = 1
            wait = min(float(query.get("wait", ["25"])[0]), 55)
            deadline = time.time() + wait
            with _cond:
                job = _next_job(_plugin_version)
                while job is None and time.time() < deadline:
                    _cond.wait(timeout=max(0.0, deadline - time.time()))
                    job = _next_job(_plugin_version)
            _plugin_seen = time.time()
            if job is None:
                return self._send(204)
            return self._json(200, {**job["args"], "id": job["id"], "op": job["op"], "remIds": job["remIds"]})
        self._json(404, {"error": "unknown path"})

    def _post_file(self, query: dict) -> None:
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_UPLOAD_BYTES:
            return self._json(413, {"error": "file too large"})
        raw = self.rfile.read(n)
        declared = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        try:
            if declared == "application/json":
                req = json.loads(raw or b"{}")
                data = _fetch_stored(str(req.get("url") or ""), req.get("kbId"))
                stem = "restored"
            else:
                data, stem = raw, query.get("name", ["upload"])[0]
            url = _store_bytes(data, stem, declared)
        except (ValueError, FileNotFoundError, OSError, urllib.error.URLError) as err:
            return self._json(400, {"error": str(err)})
        name = unquote(urlparse(url).path.rsplit("/", 1)[-1])
        ctype = CTYPE_BY_EXT.get(Path(name).suffix) or mimetypes.guess_type(name)[0]
        return self._json(200, {"url": url, "type": ctype, "bytes": len(data)})

    def do_POST(self):
        url = urlparse(self.path)
        if url.path == "/files":  # a binary body: read before _body() parses it as JSON
            return self._post_file(parse_qs(url.query))
        body = self._body()
        if url.path == "/jobs":
            op = body.pop("op", None) or "localize"
            if op not in KNOWN_OPS:
                return self._json(400, {"error": f"unknown op {op!r}"})
            rem_ids = [r for r in body.pop("remIds", []) if isinstance(r, str) and r]
            if not rem_ids and op not in OPS_WITHOUT_REMS:
                return self._json(400, {"error": "remIds required"})
            job = {
                "id": uuid.uuid4().hex[:12], "op": op, "remIds": rem_ids, "args": body,
                "status": "queued", "takenAt": 0, "result": None,
            }
            with _cond:
                _jobs[job["id"]] = job
                _cond.notify_all()
            return self._json(200, {"jobId": job["id"]})
        if url.path.startswith("/jobs/") and url.path.endswith("/cancel"):
            job = _jobs.get(url.path[len("/jobs/"):-len("/cancel")])
            if not job:
                return self._json(404, {"error": "no such job"})
            with _cond:
                if job["status"] == "queued":
                    job["status"], job["result"] = "done", {"ok": False, "cancelled": True}
            return self._json(200, {"status": job["status"], "cancelled": bool((job["result"] or {}).get("cancelled"))})
        if url.path == "/upscale":
            if not body.get("remId") or not isinstance(body.get("url"), str) or not body["url"]:
                return self._json(400, {"error": "remId and url required"})
            task = {
                "id": uuid.uuid4().hex[:12], "remId": str(body["remId"]), "url": body["url"],
                "kbId": body.get("kbId"), "extra": body.get("extra") or "",
                "status": "running", "stage": "starting", "result": None, "createdAt": time.time(),
            }
            _tasks[task["id"]] = task
            threading.Thread(target=_run_upscale, args=(task,), daemon=True).start()
            return self._json(200, {"taskId": task["id"]})
        if url.path == "/tts/play":
            path = urlparse(str(body.get("url") or "")).path
            if not path.startswith("/files/"):
                return self._json(400, {"error": "url must be one of this helper's /files/ addresses"})
            name = Path(unquote(path[len("/files/"):])).name  # no folders: only the store
            file = STORE / name
            if not file.is_file():
                return self._json(404, {"error": "no such file"})
            player = shutil.which("ffplay", path=os.pathsep.join([os.environ.get("PATH", ""), "/opt/homebrew/bin", "/usr/local/bin"]))
            cmd = ([player, "-nodisp", "-autoexit", "-loglevel", "quiet", str(file)] if player
                   else ["afplay", str(file)] if shutil.which("afplay") else None)
            if not cmd:
                return self._json(501, {"error": "no audio player (install ffmpeg)"})
            subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return self._json(200, {"ok": True})
        if url.path == "/tts/write":
            source = body.get("source")
            if not isinstance(source, str) or not source.strip():
                return self._json(400, {"error": "source required"})
            mode = body.get("mode")
            if mode not in ("adapted", "summary"):
                return self._json(400, {"error": f"unknown mode {mode!r}"})
            try:
                target = int(body["targetWords"]) if body.get("targetWords") else None
            except (TypeError, ValueError):
                return self._json(400, {"error": "targetWords must be a number"})
            try:
                _spoken_module()
            except Exception as err:
                return self._json(500, {"error": f"spoken_script.py did not load: {err}"})
            task = {
                "id": uuid.uuid4().hex[:12], "remId": str(body.get("remId") or ""), "mode": mode,
                "source": source, "lang": body.get("lang") if body.get("lang") in ("pt", "en") else "en",
                "title": str(body.get("title") or ""), "targetWords": target,
                "instructions": str(body.get("instructions") or ""),
                "status": "running", "stage": "starting", "result": None, "createdAt": time.time(),
            }
            _tts_tasks[task["id"]] = task
            threading.Thread(target=_run_write, args=(task,), daemon=True).start()
            return self._json(200, {"taskId": task["id"]})
        if url.path in ("/tts", "/tts/plan"):
            script = body.get("script")
            if not isinstance(script, str) or not script.strip():
                return self._json(400, {"error": "script required"})
            engine = body.get("engine") or "auto"
            try:
                tts = _tts_module()
            except Exception as err:
                return self._json(500, {"error": f"tts.py did not load: {err}"})
            if engine not in ("auto", *tts.ENGINES):
                return self._json(400, {"error": f"unknown engine {engine!r}"})
            if url.path == "/tts/plan":
                return self._json(200, tts.plan(script, engine, body.get("voice")))
            task = {
                "id": uuid.uuid4().hex[:12], "remId": str(body.get("remId") or ""), "script": script,
                "engine": engine, "voice": body.get("voice") or None, "subject": body.get("subject") or "",
                "purpose": "pronunciation" if body.get("purpose") == "pronunciation" else "read-aloud",
                "status": "running", "stage": "starting", "result": None, "createdAt": time.time(),
            }
            _tts_tasks[task["id"]] = task
            threading.Thread(target=_run_tts, args=(task,), daemon=True).start()
            return self._json(200, {"taskId": task["id"]})
        if url.path == "/clipboard":
            text = body.get("text")
            if not isinstance(text, str) or not text:
                return self._json(400, {"error": "text required"})
            if not shutil.which("pbcopy"):
                return self._json(501, {"error": "pbcopy not available"})
            proc = subprocess.run(["pbcopy"], input=text, text=True, capture_output=True, timeout=5)
            if proc.returncode != 0:
                return self._json(500, {"error": proc.stderr.strip() or "pbcopy failed"})
            return self._json(200, {"ok": True})
        if url.path == "/answers":
            ask_id, answer = body.get("askId"), body.get("answer")
            if not isinstance(ask_id, str) or not ask_id or not isinstance(answer, str) or not answer:
                return self._json(400, {"error": "askId and answer required"})
            _save_answer(ask_id, answer)
            return self._json(200, {"ok": True})
        if url.path == "/result":
            job = _jobs.get(str(body.get("jobId")))
            if not job:
                return self._json(404, {"error": "no such job"})
            job["status"], job["result"] = "done", body
            return self._json(200, {"ok": True})
        if url.path == "/shutdown":
            self._json(200, {"ok": True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        self._json(404, {"error": "unknown path"})


# --- upscale (plugin → helper) ------------------------------------------------------

_tasks: dict[str, dict] = {}
_upscale_lock = threading.Lock()  # one Codex image generation at a time


def _publish(path: str, task_id: str) -> str:
    """Serve a result file from the store; returns its URL."""
    src = Path(path)
    name = f"up-{task_id}-{re.sub(r'[^A-Za-z0-9._-]+', '-', src.name)}"
    shutil.copyfile(src, STORE / name)
    return f"{BASE}/files/{quote(name)}"


def _run_upscale(task: dict) -> None:
    tid = task["id"]
    try:
        task["stage"] = "fetching the image"
        data, ext = _fetch_image(task["url"], task.get("kbId"))
        folder = UPSCALE_HOME / re.sub(r"[^A-Za-z0-9_-]", "_", task["remId"]) / time.strftime("%Y%m%d-%H%M%S")
        folder.mkdir(parents=True, exist_ok=True)
        src = folder / f"original{ext}"
        src.write_bytes(data)
        task["stage"] = "waiting for another upscale" if _upscale_lock.locked() else "generating"
        with _upscale_lock:
            task["stage"], task["startedAt"] = "generating", time.time()
            cmd = [sys.executable, "-I", str(UPSCALE_SCRIPT), "upscale", str(src), "--out", str(folder)]
            if task.get("extra"):
                cmd += ["--extra", str(task["extra"])]
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=1500)
        try:
            res = json.loads(proc.stdout)
        except ValueError:
            raise RuntimeError((proc.stderr or proc.stdout or "upscale_image.py gave no answer").strip()[-600:])
        if not res.get("upscaled"):
            msg = res.get("error") or "no image came back"
            last = (res.get("messages") or [""])[-1]
            raise RuntimeError(f"{msg}{' — ' + last if last else ''}")
        chk = res.get("check") or {}
        task["result"] = {
            "ok": True,
            "seconds": res.get("seconds"),
            "folder": str(folder),
            "upscaledUrl": _publish(res["upscaled"], tid),
            "origSize": chk.get("orig_size"), "newSize": chk.get("new_size"),
            "verdict": chk.get("verdict"), "flags": chk.get("flags", []),
            "sideBySideUrl": _publish(chk["side_by_side"], tid) if chk.get("side_by_side") else None,
            "diffUrl": _publish(chk["diff_overlay"], tid) if chk.get("diff_overlay") else None,
            "crops": [{"kind": c["kind"], "px": c["px"], "url": _publish(c["crop"], tid)}
                      for c in chk.get("change_crops", [])],
            "ocrWordDiff": (chk.get("ocr") or {}).get("word_diff", []),
            "metrics": {k: chk.get(k) for k in ("missing_pct", "added_pct", "hue_shift_gt40_pct",
                                                "color_lost_pct", "aspect_deviation", "iou")},
        }
    except Exception as err:  # reported to the plugin, which shows it
        task["result"] = {"ok": False, "message": str(err)}
    finally:
        task["status"], task["stage"] = "done", "done"
        print(f"{time.strftime('%H:%M:%S')} upscale {tid} {task['remId']}: "
              f"{'ok ' + str(task['result'].get('verdict')) if task['result'].get('ok') else task['result'].get('message')}",
              file=sys.stderr, flush=True)


# --- text to speech (plugin → helper) -------------------------------------------------------

_tts_tasks: dict[str, dict] = {}
_tts_lock = threading.Lock()  # one synthesis at a time (Gemini's per-minute limit)
_tts_mod = None


def _tts_module():
    """tts.py, loaded by path: under -I the script's folder is not on sys.path."""
    global _tts_mod
    if _tts_mod is None:
        import importlib.util
        spec = importlib.util.spec_from_file_location("remnote_bridge_tts", TTS_SCRIPT)
        mod = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = mod  # dataclasses look their module up there
        spec.loader.exec_module(mod)
        _tts_mod = mod
    return _tts_mod


_spoken_mod = None


def _spoken_module():
    """spoken_script.py (loads tts.py first, under the same module name)."""
    global _spoken_mod
    if _spoken_mod is None:
        _tts_module()
        import importlib.util
        spec = importlib.util.spec_from_file_location("remnote_bridge_spoken", SPOKEN_SCRIPT)
        mod = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = mod
        spec.loader.exec_module(mod)
        _spoken_mod = mod
    return _spoken_mod


def _run_write(task: dict) -> None:
    tid = task["id"]
    try:
        spoken = _spoken_module()
        res = spoken.write(task["mode"], task["source"], task["lang"], task["title"],
                           task["targetWords"], task["instructions"],
                           progress=lambda msg: task.__setitem__("stage", msg))
        task["result"] = {"ok": True, **res}
    except Exception as err:  # reported to the plugin, which shows it
        task["result"] = {"ok": False, "message": str(err)}
    finally:
        task["status"] = "done"
        task["stage"] = "done"
        r = task["result"] or {}
        print(f"{time.strftime('%H:%M:%S')} tts-write {tid} {task['mode']} {task['remId']}: "
              f"{'ok ' + str(r.get('via')) + ' US$' + str(r.get('costUsd')) if r.get('ok') else r.get('message')}",
              file=sys.stderr, flush=True)


def _run_tts(task: dict) -> None:
    tid = task["id"]
    try:
        tts = _tts_module()
        task["stage"] = "waiting for another audio" if _tts_lock.locked() else "starting"
        with _tts_lock:
            out = OUT_DIR / f"tts-{tid}.mp3"
            res = tts.synthesize(task["script"], out, task["engine"], task["voice"],
                                 progress=lambda msg: task.__setitem__("stage", msg))
        task["stage"] = "saving"
        subject = task["subject"] or res.get("title") or "audio"
        folder = tts.pronunciation_home() if task.get("purpose") == "pronunciation" else None
        kept = tts.keep_copy(task["script"], out, task["remId"] or "norem", subject, folder)
        name = f"{kept.stem}.mp3"
        shutil.copyfile(out, STORE / name)
        out.unlink(missing_ok=True)
        task["result"] = {"ok": True, **{k: v for k, v in res.items() if k != "file"},
                          "url": f"{BASE}/files/{quote(name)}", "saved": str(kept)}
    except Exception as err:  # reported to the plugin, which shows it
        task["result"] = {"ok": False, "message": str(err)}
    finally:
        task["status"] = "done"
        task["stage"] = "done"
        r = task["result"] or {}
        print(f"{time.strftime('%H:%M:%S')} tts {tid} {task['remId']}: "
              f"{'ok ' + str(r.get('seconds')) + ' s ' + str(r.get('voice')) if r.get('ok') else r.get('message')}",
              file=sys.stderr, flush=True)


def _prune_store() -> None:
    cutoff = time.time() - MAX_AGE_S
    for f in STORE.glob("*"):
        if f.is_file() and f.stat().st_mtime < cutoff:
            f.unlink(missing_ok=True)


def serve() -> None:
    STORE.mkdir(parents=True, exist_ok=True)
    _prune_store()
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    httpd.daemon_threads = True
    print(f"RemNote media bridge v{VERSION} on {BASE}, store {STORE}", file=sys.stderr, flush=True)
    httpd.serve_forever()


# --- client ----------------------------------------------------------------------


def _request(method: str, path: str, body: dict | None = None, timeout: float = 5):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        raw = res.read()
        return json.loads(raw) if raw else None


def health() -> dict | None:
    try:
        return _request("GET", "/health", timeout=2)
    except (urllib.error.URLError, OSError, ValueError):
        return None


def ensure_running() -> dict:
    h = health()
    if h:
        return h
    HOME.mkdir(parents=True, exist_ok=True)
    log = open(LOG_FILE, "a")
    subprocess.Popen(
        [sys.executable, "-I", os.path.abspath(__file__), "serve"],
        stdout=log, stderr=log, stdin=subprocess.DEVNULL, start_new_session=True, cwd=str(HOME),
    )
    for _ in range(40):
        time.sleep(0.25)
        h = health()
        if h:
            return h
    sys.exit(f"media bridge did not start; see {LOG_FILE}")


def _store(path: str) -> str:
    """Copy a file into the helper's store and return its http URL."""
    src = Path(path).expanduser().resolve()
    if not src.is_file():
        sys.exit(f"not a file: {path}")
    STORE.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha1(src.read_bytes()).hexdigest()[:10]
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", src.stem).strip("-") or "file"
    name = f"{digest}-{stem}{src.suffix.lower()}"
    shutil.copyfile(src, STORE / name)
    return f"{BASE}/files/{quote(name)}"


def _sniff_ext(data: bytes) -> str | None:
    """The file's real extension from its first bytes, whatever it was labelled."""
    head = data[:16]
    if head[:3] == b"ID3" or (len(head) > 1 and head[0] == 0xFF and head[1] & 0xE0 == 0xE0 and head[1] & 0x06):
        return ".mp3"  # ID3 tag, or an MPEG audio frame (layer bits set; ADTS AAC has them clear)
    if head[4:8] == b"ftyp":
        return ".m4a" if head[8:12] in (b"M4A ", b"M4B ") else ".mp4"
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return ".wav"
    if head[:4] == b"OggS":
        return ".ogg"
    if head[:4] == b"fLaC":
        return ".flac"
    if head[:4] == b"\x1a\x45\xdf\xa3":
        return ".webm"
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if head[:3] == b"\xff\xd8\xff":
        return ".jpg"
    if head[:4] == b"GIF8":
        return ".gif"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return ".webp"
    return None


def _store_bytes(data: bytes, stem: str, declared: str = "") -> str:
    """Keep bytes in the store under their real type; returns the http URL that serves them."""
    if not data:
        raise ValueError("empty file")
    ext = _sniff_ext(data) or (mimetypes.guess_extension(declared) if declared else None)
    if not ext:
        raise ValueError(f"unknown file type (declared {declared or 'nothing'})")
    STORE.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha1(data).hexdigest()[:10]
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", Path(stem).stem).strip("-") or "file"
    name = f"{digest}-{stem}{ext}"
    path = STORE / name
    if not path.is_file():
        tmp = path.with_name(path.name + ".part")
        tmp.write_bytes(data)
        tmp.replace(path)
    return f"{BASE}/files/{quote(name)}"


def _tls_context():
    """The python.org build has no CA certificates of its own: certifi's, else macOS's."""
    import ssl
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        cafile = "/etc/ssl/cert.pem"
        return ssl.create_default_context(cafile=cafile) if os.path.exists(cafile) else ssl.create_default_context()


def _fetch_stored(url: str, kb_id: str | None) -> bytes:
    """A file RemNote stores: this computer's copy, else RemNote's S3. Nothing else is fetched."""
    if url.startswith("%LOCAL_FILE%"):
        name = url[len("%LOCAL_FILE%"):]
    elif url.startswith(REMNOTE_FILE_HOST):
        name = urlparse(url).path.lstrip("/")
    else:
        raise ValueError("only files stored by RemNote (%LOCAL_FILE%… or its S3 address)")
    local = _local_file(name, kb_id)
    if local:
        return local.read_bytes()
    req = urllib.request.Request(REMNOTE_FILE_HOST + quote(unquote(name)), headers={"User-Agent": "remnote-media-bridge"})
    with urllib.request.urlopen(req, timeout=120, context=_tls_context()) as res:
        data = res.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise ValueError("file too large")
    return data


def put(paths: list[str]) -> None:
    ensure_running()
    for p in paths:
        print(_store(p))


def run_job(op: str, rem_ids: list[str], args: dict, timeout: float) -> dict:
    """Queue a job, wait for the plugin's answer and return it. Exits 2 on timeout."""
    h = ensure_running()
    if h.get("version", 1) < VERSION:
        sys.exit(
            f"the running helper is an older version ({h.get('version')}); restart it so it knows {op!r}: "
            f"`{Path(__file__).name} stop` (or `launchctl kickstart -k gui/$(id -u)/com.incrementalremnote.media-bridge`)"
        )
    seen = h.get("pluginSeenSecondsAgo")
    if seen is None or seen > 60:
        print(
            "warning: the plugin has not polled the bridge in the last minute — is RemNote open and the "
            "Incremental Everything setting 'Local Media Bridge' on? The job stays queued for when it is.",
            file=sys.stderr,
        )
    elif op not in OPS_BY_PLUGIN_VERSION.get(h.get("pluginVersion") or 1, KNOWN_OPS):
        print(
            f"warning: the plugin build polling the bridge does not know {op!r} yet (protocol "
            f"v{h.get('pluginVersion') or 1}); the job waits until RemNote runs a newer Incremental Everything build.",
            file=sys.stderr,
        )
    job_id = _request("POST", "/jobs", {"op": op, "remIds": rem_ids, **args})["jobId"]
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = _request("GET", f"/jobs/{job_id}")
        if job and job["status"] == "done":
            return job["result"] or {}
        time.sleep(0.5)
    status = "timeout"
    if op != "localize":  # a localize job may run later; nothing else should
        cancel = _request("POST", f"/jobs/{job_id}/cancel", {})
        status = "timeout, cancelled" if cancel.get("cancelled") else "timeout — the plugin is still running it"
    print(json.dumps({"jobId": job_id, "op": op, "status": status}))
    sys.exit(2)


def finish(result: dict, ok: bool) -> None:
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(0 if ok else 1)


def localize(rem_ids: list[str], timeout: float) -> None:
    result = run_job("localize", rem_ids, {}, timeout)
    finish(result, bool(result.get("ok") and not result.get("failed") and not result.get("missing")))


def split_ids(value: str) -> list[str]:
    return [part.strip() for part in value.split(",") if part.strip()]


def parse_position(value: str | None) -> dict:
    if value is None or value == "last":
        return {"position": "last"}
    if value == "first":
        return {"position": "first"}
    if re.fullmatch(r"\d+", value):
        return {"position": "index", "index": int(value)}
    m = re.fullmatch(r"(before|after):(\S+)", value)
    if m:
        return {"position": m.group(1), "siblingId": m.group(2)}
    sys.exit(f"bad position {value!r}: use first, last, a 0-based index, before:<remId> or after:<remId>")


def move(rems: str, parent: str, position: str | None, expect_parent: str | None, dry_run: bool, timeout: float):
    args = {"parentId": parent, **parse_position(position), "dryRun": dry_run}
    if expect_parent:
        args["expectParentId"] = expect_parent
    result = run_job("move", split_ids(rems), args, timeout)
    finish(result, bool(result.get("ok")))


def tag(rems: str, tag_id: str, timeout: float) -> None:
    result = run_job("tag", split_ids(rems), {"tag": tag_id}, timeout)
    finish(result, bool(result.get("ok")))


def untag(rems: str, tag: str, drop_properties: bool, timeout: float) -> None:
    result = run_job("untag", split_ids(rems), {"tag": tag, "removeProperties": drop_properties}, timeout)
    finish(result, bool(result.get("ok")))


def pin(rems: str, refs: str | None, unpin: bool, timeout: float) -> None:
    args: dict = {"unpin": unpin}
    if refs:
        args["refIds"] = split_ids(refs)
    result = run_job("pin", split_ids(rems), args, timeout)
    finish(result, bool(result.get("ok")))


def pin_quote(rems: str, source: str, view: str | None, quote: str | None, timeout: float) -> None:
    args: dict = {"sourceId": source} if source else {}
    if view:
        args["view"] = view
    if quote:
        args["quote"] = quote
    result = run_job("pin-quote", split_ids(rems), args, timeout)
    finish(result, bool(result.get("ok")))


def card(rems: str, rem_type: str | None, direction: str | None, practice: str | None, timeout: float) -> None:
    if not rem_type and not direction and not practice:
        sys.exit("give --type, --direction and/or --practice")
    args: dict = {k: v for k, v in (("remType", rem_type), ("direction", direction)) if v}
    if practice:
        args["enablePractice"] = practice == "on"
    result = run_job("card", split_ids(rems), args, timeout)
    finish(result, bool(result.get("ok")))


def strip_priority(rems: str, timeout: float) -> None:
    result = run_job("strip-priority", split_ids(rems), {}, timeout)
    finish(result, bool(result.get("ok")))


def portal(rems: str, parent: str, position: str | None, timeout: float) -> None:
    args = {"parentId": parent, **parse_position(position)}
    result = run_job("portal", split_ids(rems), args, timeout)
    finish(result, bool(result.get("ok")))


def heading(rems: str, level: str, timeout: float) -> None:
    result = run_job("heading", split_ids(rems), {"level": level}, timeout)
    finish(result, bool(result.get("ok")))


def audio(parent: str, path: str, caption: str | None, position: str | None, timeout: float) -> None:
    ensure_running()
    args = {"url": _store(path), **parse_position(position or "first")}
    if caption:
        args["caption"] = caption
    result = run_job("audio", [parent], args, timeout)
    finish(result, bool(result.get("ok")))


def _chunked_job(op: str, items: list, chunk: int, timeout: float, make) -> None:
    """Run `op` over `items` in jobs of `chunk`; print every rem's result together."""
    results, ok = [], True
    for start in range(0, len(items), chunk):
        part = items[start:start + chunk]
        rem_ids, args = make(part)
        result = run_job(op, rem_ids, args, timeout)
        ok = ok and bool(result.get("ok"))
        results.extend(result.get("results") or [{"remIds": rem_ids, "ok": False, "error": result.get("message")}])
        print(f"{op}: {min(start + chunk, len(items))}/{len(items)} — {result.get('summary')}", file=sys.stderr)
    done = sum(1 for r in results if r.get("ok"))
    finish({"ok": ok, "summary": f"{done}/{len(items)} done", "results": results}, ok)


def outline(path: str, chunk: int, timeout: float, dry_run: bool) -> None:
    """Plan file: JSON {create: [{key, parent, text, tag?}], order: [{parent, children}],
    heading: [{rem, level}], document: [rem]} (see runOutline in the plugin). Runs creates, then orders, then
    headings, in jobs of about `chunk` items. The ids of created rems go to <plan>.keys.json
    as they come back, so a rerun after a failure resumes instead of creating them twice."""
    plan = json.loads(Path(path).read_text())
    keys_file = Path(path).with_suffix(".keys.json")
    keys: dict = json.loads(keys_file.read_text()) if keys_file.exists() else {}
    creates = [c for c in plan.get("create", []) if c["key"] not in keys]
    orders, heads = plan.get("order", []), plan.get("heading", [])
    if dry_run:
        finish({"ok": True, "dryRun": True, "create": len(creates), "alreadyCreated": len(keys),
                "orderParents": len(orders), "orderChildren": sum(len(o["children"]) for o in orders),
                "heading": len(heads)}, True)
    # the rems a job touches, keys resolved: the plugin waits for them to sync first
    ids = lambda refs: sorted({keys.get(r, r) for r in refs if r and (not r.startswith("new:") or r in keys)})
    failures: list = []
    totals = {"created": 0, "placed": 0, "headed": 0}

    def send(args: dict, refs: list[str], label: str) -> None:
        result = run_job("outline", ids(refs), {**args, "keys": keys}, timeout)
        keys.update(result.get("keys") or {})
        keys_file.write_text(json.dumps(keys, indent=1))
        for k in totals:
            totals[k] += result.get(k) or 0
        failures.extend(result.get("failures") or ([] if result.get("ok") else [{"step": label, "error": result.get("message")}]))
        print(f"outline {label}: {result.get('summary')}", file=sys.stderr, flush=True)

    for start in range(0, len(creates), chunk):
        part = creates[start:start + chunk]
        send({"create": part}, [c["parent"] for c in part], f"create {start + len(part)}/{len(creates)}")
    batch: list = []
    for o in orders + [None]:
        if o is None or (batch and sum(len(b["children"]) for b in batch) + len(o["children"]) > chunk):
            if batch:
                send({"order": batch}, [r for b in batch for r in [b["parent"], *b["children"]]],
                     f"order {len(batch)} parent(s)")
            batch = []
        if o is not None:
            batch.append(o)
    if plan.get("document"):
        send({"document": plan["document"]}, plan["document"], "document")
    for start in range(0, len(heads), chunk * 2):
        part = heads[start:start + chunk * 2]
        send({"heading": part}, [h["rem"] for h in part], f"heading {start + len(part)}/{len(heads)}")
    ok = not failures
    finish({"ok": ok, **totals, "keys": str(keys_file), "failures": failures}, ok)


def set_text(path: str, chunk: int, timeout: float) -> None:
    """Edits file: JSON list of {remId, text?: {before, after}, backText?: {before, after}} (RemNote rich text)."""
    edits = json.loads(Path(path).read_text())
    _chunked_job("set-text", edits, chunk, timeout, lambda part: ([e["remId"] for e in part], {"edits": part}))


def remove(path: str, chunk: int, timeout: float) -> None:
    """Expect file: JSON {remId: {text, backText}} — each rem is deleted only if it still has exactly that text and no children."""
    expect = json.loads(Path(path).read_text())
    _chunked_job("remove", list(expect), chunk, timeout,
                 lambda part: (part, {"expect": {i: expect[i] for i in part}}))


def notice(title: str, message: str, detail: str | None, rem: str | None, tone: str, wait: float) -> None:
    """Show a notice in RemNote (the plugin's floating card, with Open Rem when a rem is given).

    Never fails the caller: when RemNote is closed or the plugin has not polled yet, the
    job stays queued in the helper and shows as soon as a RemNote window polls.
    """
    h = ensure_running()
    if h.get("version", 1) < VERSION:
        sys.exit(
            f"the running helper is an older version ({h.get('version')}); restart it so it knows 'notice': "
            f"`{Path(__file__).name} stop` (or `launchctl kickstart -k gui/$(id -u)/com.incrementalremnote.media-bridge`)"
        )
    args = {"title": title, "message": message, "tone": tone}
    if detail:
        args["detail"] = detail
    job_id = _request("POST", "/jobs", {"op": "notice", "remIds": [rem] if rem else [], **args})["jobId"]
    deadline = time.time() + wait
    while time.time() < deadline:
        job = _request("GET", f"/jobs/{job_id}")
        if job and job["status"] == "done":
            finish({"jobId": job_id, "status": "shown", **(job["result"] or {})}, True)
        time.sleep(0.5)
    finish({"jobId": job_id, "status": "queued",
            "message": "RemNote has not picked it up yet; it shows when a RemNote window polls the bridge"}, True)


def _need_version(op: str, version: int) -> None:
    h = ensure_running()
    if h.get("version", 1) < version:
        sys.exit(
            f"the running helper is an older version ({h.get('version')}); restart it so it knows '{op}': "
            f"`{Path(__file__).name} stop` (or `launchctl kickstart -k gui/$(id -u)/com.incrementalremnote.media-bridge`)"
        )


def _answer_of(ask_id: str) -> dict:
    return _request("GET", f"/answers/{ask_id}") or {"askId": ask_id, "status": "pending"}


def ask(title: str, message: str, detail: str | None, items_file: str | None, rem: str | None,
        choices: str, tone: str, wait: float) -> None:
    """Ask the user in RemNote: a notice with one button per choice (default Accept / Reject).

    Prints {askId, status: queued|shown|answered, answer?}. The question stays in RemNote
    until answered; wait for it with `answer <askId> --wait N` (run that in the background).
    """
    _need_version("ask", 18)
    args: dict = {"title": title, "message": message, "tone": tone,
                  "choices": [c.strip() for c in choices.split(",") if c.strip()]}
    if detail:
        args["detail"] = detail
    if items_file:
        args["items"] = json.loads(Path(items_file).read_text())
    job_id = _request("POST", "/jobs", {"op": "ask", "remIds": [rem] if rem else [], **args})["jobId"]
    deadline = time.time() + wait
    status = "queued"
    while time.time() < deadline:
        got = _answer_of(job_id)
        if got.get("status") == "answered":
            finish({**got, "askId": job_id}, True)
        job = _request("GET", f"/jobs/{job_id}")
        if job and job["status"] == "done":
            if not (job["result"] or {}).get("ok", True):
                finish({"askId": job_id, "status": "failed", **(job["result"] or {})}, False)
            status = "shown"
        time.sleep(0.5)
    finish({"askId": job_id, "status": status}, True)


def answer(ask_ids: str, wait: float, any_: bool) -> None:
    """The answers to `ask` questions; waits up to `wait` s for all of them (or, with
    --any, for the first). 'dismissed' = closed without a choice."""
    _need_version("answer", 18)
    ids = split_ids(ask_ids)
    deadline = time.time() + wait
    while True:
        got = {i: _answer_of(i) for i in ids}
        done = [i for i in ids if got[i].get("status") == "answered"]
        if (len(done) == len(ids)) or (any_ and done) or time.time() >= deadline:
            break
        time.sleep(1.0)
    out = {i: {"status": got[i].get("status"), "answer": got[i].get("answer")} for i in ids}
    print(json.dumps({"answers": out, "pending": [i for i in ids if i not in done]}, ensure_ascii=False, indent=2))


def restore_audio(rems: str, chunk: int, timeout: float) -> None:
    """Runs in small jobs: a job taken and unanswered for REDELIVER_AFTER_S counts as lost."""
    ids = split_ids(rems)
    total: dict = {"ok": True, "fixed": [], "failed": [], "untouched": [], "files": 0}
    for start in range(0, len(ids), chunk):
        part = ids[start:start + chunk]
        result = run_job("restore-audio", part, {}, timeout)
        print(f"{min(start + chunk, len(ids))}/{len(ids)}: {result.get('summary')}", file=sys.stderr, flush=True)
        if not result.get("ok"):
            total["ok"] = False
        for key in ("fixed", "failed", "untouched"):
            total[key] += result.get(key) or []
        total["files"] += result.get("files") or 0
        if result.get("error") or result.get("message"):
            total.setdefault("errors", []).append(result.get("error") or result.get("message"))
    total["summary"] = (
        f"{len(total['fixed'])} rem(s) fixed ({total['files']} file(s)), {len(total['failed'])} failed, "
        f"{len(total['untouched'])} without audio to restore"
    )
    finish(total, bool(total["ok"]) and not total["failed"])


def incrementalize(rems: str, priority: int | None, timeout: float) -> None:
    if priority is not None and not 0 <= priority <= 100:
        sys.exit("--priority must be from 0 to 100")
    args = {} if priority is None else {"priority": priority}
    result = run_job("incrementalize", split_ids(rems), args, timeout)
    finish(result, bool(result.get("ok")))


EXT_BY_MIME = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
    "image/svg+xml": ".svg", "image/bmp": ".bmp", "image/avif": ".avif",
}


def _local_file(name: str, kb_id: str | None) -> Path | None:
    """A %LOCAL_FILE% name → the file in RemNote's data folder (this KB first, then any KB)."""
    name = unquote(name)
    if "/" in name or "\\" in name or name in ("", ".", ".."):
        return None
    folders = []
    if kb_id:
        folders.append(REMNOTE_DATA / f"remnote-{kb_id}" / "files")
    folders += sorted(p for p in REMNOTE_DATA.glob("remnote-*/files") if p not in folders)
    for folder in folders:
        exact = folder / name
        if exact.is_file():
            return exact
        if "." not in name:
            matches = sorted(folder.glob(f"{name}.*"))
            if matches:
                return matches[0]
    return None


def _fetch_image(url: str, kb_id: str | None) -> tuple[bytes, str]:
    """The image's bytes and a file extension."""
    if url.startswith("%LOCAL_FILE%"):
        path = _local_file(url[len("%LOCAL_FILE%"):], kb_id)
        if not path:
            raise FileNotFoundError("stored in RemNote but not on this computer's disk (not synced down yet?)")
        return path.read_bytes(), path.suffix.lower() or ".bin"
    if url.startswith("data:"):
        import base64
        header, _, payload = url.partition(",")
        mime = header[5:].split(";")[0].lower()
        data = base64.b64decode(payload) if ";base64" in header else unquote(payload).encode()
        return data, EXT_BY_MIME.get(mime, ".bin")
    if url.startswith(BASE + "/files/"):
        path = (STORE / unquote(url[len(BASE + "/files/"):])).resolve()
        if path.parent == STORE.resolve() and path.is_file():
            return path.read_bytes(), path.suffix.lower() or ".bin"
    if re.match(r"https?://", url, re.I):
        req = urllib.request.Request(url, headers={"User-Agent": "remnote-media-bridge"})
        with urllib.request.urlopen(req, timeout=30, context=_tls_context()) as res:
            mime = (res.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            data = res.read()
        ext = EXT_BY_MIME.get(mime) or (Path(urlparse(url).path).suffix.lower() or ".bin")
        return data, ext
    raise ValueError("unsupported image URL")


def get_image(rem: str, out: str | None, timeout: float) -> None:
    result = run_job("get-image", [rem], {}, timeout)
    if not result.get("ok"):
        finish(result, False)
    out_dir = Path(out).expanduser() if out else OUT_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    images, problems = [], 0
    for n, image in enumerate(result.get("images", []), 1):
        url = image.get("url", "")
        entry = {"field": image.get("field"), "url": url if len(url) < 300 else url[:120] + "…"}
        try:
            data, ext = _fetch_image(url, result.get("kbId"))
            path = out_dir / f"{rem}-{n}{ext}"
            path.write_bytes(data)
            entry.update(path=str(path), bytes=len(data))
        except (OSError, ValueError, urllib.error.URLError) as err:
            entry["error"] = str(err)
            problems += 1
        images.append(entry)
    summary = {"ok": bool(images) and not problems, "remId": rem, "title": result.get("title"), "images": images}
    if not images:
        summary["message"] = "the rem has no image"
    finish(summary, summary["ok"])


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("serve", help="run the server in the foreground")
    sub.add_parser("start", help="start the server in the background if it is not running")
    sub.add_parser("status", help="print /health")
    sub.add_parser("stop", help="stop the background server")
    p_put = sub.add_parser("put", help="store files and print their http URLs, one per line")
    p_put.add_argument("files", nargs="+")
    p_loc = sub.add_parser("localize", help="ask the plugin to upload the images of these rems; prints the result")
    p_loc.add_argument("remIds", nargs="+")
    p_loc.add_argument("--timeout", type=float, default=180)
    p_mv = sub.add_parser("move", help="move rems under a new parent")
    p_mv.add_argument("rems", help="rem id, or several comma-separated (kept in this order)")
    p_mv.add_argument("parent", help="new parent rem id")
    p_mv.add_argument("position", nargs="?", help="first | last (default) | 0-based index among the visible "
                      "children | before:<remId> | after:<remId>")
    p_mv.add_argument("--expect-parent", help="refuse unless each rem's current parent is this id")
    p_mv.add_argument("--dry-run", action="store_true", help="report what would move, change nothing")
    p_mv.add_argument("--timeout", type=float, default=150)
    p_tg = sub.add_parser("tag", help="add a tag (by its rem id) to rems, PDF rems included")
    p_tg.add_argument("rems", help="rem id, or several comma-separated")
    p_tg.add_argument("tag", help="the tag rem's id")
    p_tg.add_argument("--timeout", type=float, default=150)
    p_un = sub.add_parser("untag", help="remove a tag (or a built-in powerup such as Extra Card Detail) from rems")
    p_un.add_argument("rems", help="rem id, or several comma-separated")
    p_un.add_argument("tag", help="tag rem id, tag name (as shown), or powerup:<code> (e.g. powerup:x)")
    p_un.add_argument("--drop-properties", action="store_true", help="also delete the tag's property values")
    p_un.add_argument("--timeout", type=float, default=150)
    p_gi = sub.add_parser("get-image", help="copy a rem's images to files and print their paths")
    p_gi.add_argument("rem")
    p_gi.add_argument("--out", help=f"folder for the files (default {OUT_DIR})")
    p_gi.add_argument("--timeout", type=float, default=150)
    p_in = sub.add_parser("incrementalize", help="make rems Incremental (or set an IncRem's priority)")
    p_in.add_argument("rems", help="rem id, or several comma-separated")
    p_in.add_argument("--priority", type=int, help="0-100; omitted = inherited/default, as the plugin's own command")
    p_in.add_argument("--timeout", type=float, default=180)
    p_pin = sub.add_parser("pin", help="show references as 📌 pins (default: every reference to a highlight)")
    p_pin.add_argument("rems", help="rem id, or several comma-separated")
    p_pin.add_argument("--refs", help="only these referenced rem ids (comma-separated); waits for them to sync")
    p_pin.add_argument("--unpin", action="store_true", help="turn pins back into plain references")
    p_pin.add_argument("--timeout", type=float, default=150)
    p_pq = sub.add_parser("pin-quote", help="Pin Source Quote: find each rem's text in a PDF/article and pin it")
    p_pq.add_argument("rems", help="rem id, or several comma-separated")
    p_pq.add_argument("--source", help="the PDF or saved web article rem; without it, your source finder "
                      "(via the AI helper's /find-source) names each rem's book and the PDFs to try")
    p_pq.add_argument("--view", choices=["pdf", "html", "both"], help="for a PDF with a Text Reader version "
                      "(default: the PDF page view)")
    p_pq.add_argument("--quote", help="passage to look for instead of the rem's own text (one rem only)")
    p_pq.add_argument("--timeout", type=float, default=300)
    p_card = sub.add_parser("card", help="set rems' type (concept/descriptor) and practice direction, text untouched")
    p_card.add_argument("rems", help="rem id, or several comma-separated")
    p_card.add_argument("--type", dest="rem_type", choices=["concept", "descriptor", "default"])
    p_card.add_argument("--direction", choices=["forward", "backward", "both", "none"])
    p_card.add_argument("--practice", choices=["on", "off"],
                        help="RemNote's enable-practice flag (off = what /Disable Card does)")
    p_sp = sub.add_parser("strip-priority", help="remove the CardPriority slots, then the tag, from rems "
                          "(the plugin's own scoped removal; prints the removed values)")
    p_sp.add_argument("rems", help="rem id, or several comma-separated")
    p_sp.add_argument("--timeout", type=float, default=300)
    p_card.add_argument("--timeout", type=float, default=150)
    p_po = sub.add_parser("portal", help="make a portal under a parent that shows these rems")
    p_po.add_argument("rems", help="rem id, or several comma-separated (shown in this order)")
    p_po.add_argument("parent", help="the rem the portal goes under")
    p_po.add_argument("position", nargs="?", help="first | last (default) | 0-based index | before:<id> | after:<id>")
    p_po.add_argument("--timeout", type=float, default=150)
    p_hd = sub.add_parser("heading", help="set rems' heading level (next = one deeper than the heading above)")
    p_hd.add_argument("rems", help="rem id, or several comma-separated")
    p_hd.add_argument("--level", default="next", choices=["next", "none", "1", "2", "3", "4", "5", "6"])
    p_hd.add_argument("--timeout", type=float, default=150)
    p_au = sub.add_parser("audio", help="add a child rem that plays an audio file (stored in RemNote)")
    p_au.add_argument("parent", help="rem to put the audio rem under")
    p_au.add_argument("file", help="audio file (mp3, m4a, wav…)")
    p_au.add_argument("--caption", help="text before the player, e.g. '🔊 Áudio'")
    p_au.add_argument("--position", help="first (default), last, a 0-based index, before:<remId> or after:<remId>")
    p_au.add_argument("--timeout", type=float, default=180)
    p_ra = sub.add_parser("restore-audio", help="store again, as audio, the audio of these rems that RemNote stored as an image")
    p_ra.add_argument("rems", help="rem id(s), comma-separated")
    p_ra.add_argument("--chunk", type=int, default=5, help="rems per plugin job (default 5)")
    p_ra.add_argument("--timeout", type=float, default=600, help="seconds to wait for each job")
    p_st = sub.add_parser("set-text", help="rewrite rems' rich text exactly (front/back), only where it is unchanged")
    p_st.add_argument("edits", help="JSON file: [{remId, text?: {before, after}, backText?: {before, after}}]")
    p_st.add_argument("--chunk", type=int, default=25, help="rems per plugin job (default 25)")
    p_st.add_argument("--timeout", type=float, default=300, help="seconds to wait for each job")
    p_rm = sub.add_parser("remove", help="delete childless rems whose text still matches the given JSON")
    p_rm.add_argument("expect", help="JSON file: {remId: {text, backText}}")
    p_rm.add_argument("--chunk", type=int, default=25)
    p_rm.add_argument("--timeout", type=float, default=300)
    p_no = sub.add_parser("notice", help="show a notice in RemNote (floating card; Open Rem when --rem is given)")
    p_no.add_argument("--title", required=True)
    p_no.add_argument("--message", default="", help="one or two lines under the title")
    p_no.add_argument("--detail", help="smaller text under the message")
    p_no.add_argument("--rem", help="rem id the Open Rem button opens")
    p_no.add_argument("--tone", choices=["success", "info", "error"], default="success")
    p_no.add_argument("--wait", type=float, default=10,
                      help="seconds to wait for RemNote to show it (it stays queued after that)")
    p_ol = sub.add_parser("outline", help="create headers, set child order and heading levels from a plan file")
    p_ol.add_argument("plan", help="JSON {create: [...], order: [...], heading: [...]}")
    p_ol.add_argument("--chunk", type=int, default=30, help="items per plugin job (default 30)")
    p_ol.add_argument("--dry-run", action="store_true", help="count what would be sent")
    p_ol.add_argument("--timeout", type=float, default=300, help="seconds to wait for each job")
    p_ask = sub.add_parser("ask", help="ask the user in RemNote: a notice with Accept / Reject (or other) buttons")
    p_ask.add_argument("--title", required=True)
    p_ask.add_argument("--message", default="")
    p_ask.add_argument("--detail")
    p_ask.add_argument("--items", help="JSON file: [{title, lines: [..]}], one box per proposed change")
    p_ask.add_argument("--rem", help="rem id the Open Rem button opens (the question stays up)")
    p_ask.add_argument("--choices", default="Accept,Reject", help="comma-separated button labels, first = primary")
    p_ask.add_argument("--tone", choices=["success", "info", "error"], default="info")
    p_ask.add_argument("--wait", type=float, default=10, help="seconds to wait for the card (or an answer)")
    p_ans = sub.add_parser("answer", help="the answers to ask questions (waits for them)")
    p_ans.add_argument("askIds", help="ask id, or several comma-separated")
    p_ans.add_argument("--wait", type=float, default=0, help="seconds to wait for the answers")
    p_ans.add_argument("--any", action="store_true", help="return as soon as one is answered")
    a = ap.parse_args()
    if a.cmd == "serve":
        serve()
    elif a.cmd == "start":
        print(json.dumps(ensure_running()))
    elif a.cmd == "status":
        print(json.dumps(health()))
    elif a.cmd == "stop":
        if health():
            _request("POST", "/shutdown", {})
    elif a.cmd == "put":
        put(a.files)
    elif a.cmd == "localize":
        localize(a.remIds, a.timeout)
    elif a.cmd == "move":
        move(a.rems, a.parent, a.position, a.expect_parent, a.dry_run, a.timeout)
    elif a.cmd == "tag":
        tag(a.rems, a.tag, a.timeout)
    elif a.cmd == "untag":
        untag(a.rems, a.tag, a.drop_properties, a.timeout)
    elif a.cmd == "get-image":
        get_image(a.rem, a.out, a.timeout)
    elif a.cmd == "incrementalize":
        incrementalize(a.rems, a.priority, a.timeout)
    elif a.cmd == "pin":
        pin(a.rems, a.refs, a.unpin, a.timeout)
    elif a.cmd == "pin-quote":
        pin_quote(a.rems, a.source, a.view, a.quote, a.timeout)
    elif a.cmd == "card":
        card(a.rems, a.rem_type, a.direction, a.practice, a.timeout)
    elif a.cmd == "strip-priority":
        strip_priority(a.rems, a.timeout)
    elif a.cmd == "portal":
        portal(a.rems, a.parent, a.position, a.timeout)
    elif a.cmd == "heading":
        heading(a.rems, a.level, a.timeout)
    elif a.cmd == "audio":
        audio(a.parent, a.file, a.caption, a.position, a.timeout)
    elif a.cmd == "restore-audio":
        restore_audio(a.rems, max(1, a.chunk), a.timeout)
    elif a.cmd == "set-text":
        set_text(a.edits, max(1, a.chunk), a.timeout)
    elif a.cmd == "remove":
        remove(a.expect, max(1, a.chunk), a.timeout)
    elif a.cmd == "notice":
        notice(a.title, a.message, a.detail, a.rem, a.tone, a.wait)
    elif a.cmd == "outline":
        outline(a.plan, max(1, a.chunk), a.timeout, a.dry_run)
    elif a.cmd == "ask":
        ask(a.title, a.message, a.detail, a.items, a.rem, a.choices, a.tone, a.wait)
    elif a.cmd == "answer":
        answer(a.askIds, a.wait, a.any)


if __name__ == "__main__":
    main()
