#!/usr/bin/env python3
"""Local Media Bridge: get local images into RemNote's own storage from outside the app.

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

The helper starts itself in the background the first time `put` or `localize` needs
it. Standard library only. Files older than 30 days are removed from the store.

Endpoints (127.0.0.1:3460, CORS open, for the plugin iframe):
  GET  /health                 {ok, version, pluginSeenSecondsAgo}
  GET  /files/<name>           a stored file
  POST /jobs {remIds}          → {jobId}
  GET  /jobs/<id>              {status: queued|taken|done, result?}
  GET  /next?wait=25           plugin long-poll → {id, remIds} or 204
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

VERSION = 1
HOST = "127.0.0.1"
PORT = int(os.environ.get("REMNOTE_MEDIA_BRIDGE_PORT", "3460"))
BASE = f"http://{HOST}:{PORT}"
HOME = Path(os.environ.get("REMNOTE_MEDIA_BRIDGE_HOME", Path.home() / ".remnote-media-bridge"))
STORE = HOME / "files"
LOG_FILE = HOME / "bridge.log"
MAX_AGE_S = 30 * 24 * 3600
REDELIVER_AFTER_S = 120  # a job taken but never answered goes back to the queue

# --- server --------------------------------------------------------------------

_jobs: dict[str, dict] = {}
_cond = threading.Condition()
_plugin_seen = 0.0


def _next_job() -> dict | None:
    now = time.time()
    for job in _jobs.values():
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
        global _plugin_seen
        url = urlparse(self.path)
        if url.path == "/health":
            ago = None if not _plugin_seen else round(time.time() - _plugin_seen, 1)
            return self._json(200, {"ok": True, "version": VERSION, "pluginSeenSecondsAgo": ago})
        if url.path.startswith("/files/"):
            name = unquote(url.path[len("/files/"):])
            path = (STORE / name).resolve()
            if path.parent != STORE.resolve() or not path.is_file():
                return self._json(404, {"error": "not found"})
            ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            return self._send(200, path.read_bytes(), ctype)
        if url.path.startswith("/jobs/"):
            job = _jobs.get(url.path[len("/jobs/"):])
            if not job:
                return self._json(404, {"error": "no such job"})
            return self._json(200, {k: job.get(k) for k in ("id", "status", "remIds", "result")})
        if url.path == "/next":
            _plugin_seen = time.time()
            wait = min(float(parse_qs(url.query).get("wait", ["25"])[0]), 55)
            deadline = time.time() + wait
            with _cond:
                job = _next_job()
                while job is None and time.time() < deadline:
                    _cond.wait(timeout=max(0.0, deadline - time.time()))
                    job = _next_job()
            _plugin_seen = time.time()
            if job is None:
                return self._send(204)
            return self._json(200, {"id": job["id"], "remIds": job["remIds"]})
        self._json(404, {"error": "unknown path"})

    def do_POST(self):
        url = urlparse(self.path)
        body = self._body()
        if url.path == "/jobs":
            rem_ids = [r for r in body.get("remIds", []) if isinstance(r, str) and r]
            if not rem_ids:
                return self._json(400, {"error": "remIds required"})
            job = {"id": uuid.uuid4().hex[:12], "remIds": rem_ids, "status": "queued", "takenAt": 0, "result": None}
            with _cond:
                _jobs[job["id"]] = job
                _cond.notify_all()
            return self._json(200, {"jobId": job["id"]})
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


def localize(rem_ids: list[str], timeout: float) -> None:
    h = ensure_running()
    seen = h.get("pluginSeenSecondsAgo")
    if seen is None or seen > 60:
        print(
            "warning: the plugin has not polled the bridge in the last minute — is RemNote open and the "
            "Incremental Everything setting 'Local Media Bridge' on? The job stays queued for when it is.",
            file=sys.stderr,
        )
    job_id = _request("POST", "/jobs", {"remIds": rem_ids})["jobId"]
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = _request("GET", f"/jobs/{job_id}")
        if job and job["status"] == "done":
            result = job["result"] or {}
            print(json.dumps(result, ensure_ascii=False, indent=2))
            ok = result.get("ok") and not result.get("failed") and not result.get("missing")
            sys.exit(0 if ok else 1)
        time.sleep(1)
    print(json.dumps({"jobId": job_id, "status": "timeout"}))
    sys.exit(2)


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


if __name__ == "__main__":
    main()
