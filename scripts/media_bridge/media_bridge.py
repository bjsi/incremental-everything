#!/usr/bin/env python3
"""Local Media Bridge: get local images into RemNote's own storage from outside the app,
and run a few rem operations the RemNote MCP lacks (move, untag, get-image, incrementalize).

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
  untag <rem>[,<rem>…] <tag id | tag name | powerup:<code>>
  get-image <rem> [--out DIR]       copies the rem's images to files, prints their paths
  incrementalize <rem>[,<rem>…] [--priority N]

Each prints the plugin's JSON answer; exit 0 = done, 1 = failed (or partly), 2 = timeout.

The helper starts itself in the background the first time a command needs it.
Standard library only. Files older than 30 days are removed from the store.

Endpoints (127.0.0.1:3460, CORS open, for the plugin iframe):
  GET  /health                 {ok, version, pluginSeenSecondsAgo}
  GET  /files/<name>           a stored file
  POST /jobs {op?, remIds, …}  → {jobId}   (op defaults to "localize")
  GET  /jobs/<id>              {status: queued|taken|done, result?}
  POST /upscale {remId, url, kbId?, extra?} → {taskId}   (plugin → helper: the
                               "Upscale image with ChatGPT" command; runs upscale_image.py,
                               i.e. Codex CLI image generation + the fidelity check)
  GET  /upscale/<id>           {status: queued|running|done, stage, result?}
  GET  /next?wait=25&v=2       plugin long-poll → {id, op, remIds, …} or 204. A plugin
                               polling without v=2 is an older build: it gets only
                               localize jobs, the rest wait for a build that knows them.
  POST /result {jobId, …}      plugin answer
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

VERSION = 3  # 3: /upscale
# The jobs a plugin build understands, by the protocol version it polls with.
OPS_BY_PLUGIN_VERSION = {1: {"localize"}, 2: {"localize", "move", "untag", "get-image", "incrementalize"}}
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
REDELIVER_AFTER_S = 120  # a localize job taken but never answered goes back to the queue
# Only localize is safe to run twice. Any other job taken and never answered (the
# plugin reloaded mid-job) is marked lost instead, so it cannot run later, after
# newer commands, once its caller has given up.
REPEATABLE_OPS = {"localize"}

UPSCALE_SCRIPT = Path(__file__).resolve().parent / "upscale_image.py"
UPSCALE_HOME = Path(os.environ.get("REMNOTE_UPSCALE_HOME", Path.home() / "Pictures" / "remnote-upscale"))

# --- server --------------------------------------------------------------------

_jobs: dict[str, dict] = {}
_cond = threading.Condition()
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
            ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            return self._send(200, path.read_bytes(), ctype)
        if url.path.startswith("/upscale/"):
            task = _tasks.get(url.path[len("/upscale/"):])
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

    def do_POST(self):
        url = urlparse(self.path)
        body = self._body()
        if url.path == "/jobs":
            op = body.pop("op", None) or "localize"
            if op not in KNOWN_OPS:
                return self._json(400, {"error": f"unknown op {op!r}"})
            rem_ids = [r for r in body.pop("remIds", []) if isinstance(r, str) and r]
            if not rem_ids:
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


def put(paths: list[str]) -> None:
    ensure_running()
    STORE.mkdir(parents=True, exist_ok=True)
    for p in paths:
        src = Path(p).expanduser().resolve()
        if not src.is_file():
            sys.exit(f"not a file: {p}")
        digest = hashlib.sha1(src.read_bytes()).hexdigest()[:10]
        stem = re.sub(r"[^A-Za-z0-9._-]+", "-", src.stem).strip("-") or "file"
        name = f"{digest}-{stem}{src.suffix.lower()}"
        shutil.copyfile(src, STORE / name)
        print(f"{BASE}/files/{quote(name)}")


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


def untag(rems: str, tag: str, drop_properties: bool, timeout: float) -> None:
    result = run_job("untag", split_ids(rems), {"tag": tag, "removeProperties": drop_properties}, timeout)
    finish(result, bool(result.get("ok")))


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
        with urllib.request.urlopen(req, timeout=30) as res:
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
    elif a.cmd == "untag":
        untag(a.rems, a.tag, a.drop_properties, a.timeout)
    elif a.cmd == "get-image":
        get_image(a.rem, a.out, a.timeout)
    elif a.cmd == "incrementalize":
        incrementalize(a.rems, a.priority, a.timeout)


if __name__ == "__main__":
    main()
