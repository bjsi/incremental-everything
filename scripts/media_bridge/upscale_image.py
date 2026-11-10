#!/usr/bin/env python3
"""Upscale a RemNote rem's image with ChatGPT image generation (via Codex CLI,
signed in with the user's ChatGPT plan) and check the result did not change content.

The media-bridge helper's /upscale endpoint runs it for the plugin's "Upscale image with
ChatGPT" command; it also works on its own from a terminal. Needs the Codex CLI signed in
with a paid ChatGPT plan, plus Pillow, numpy and scipy (pyobjc Vision for the OCR check).

  upscale.py run <remId> [--out DIR] [--extra "prompt text"] [--attempts N]
      get-image → codex exec (gpt-image) → compare. Prints a JSON report.
  upscale.py upscale <image> [--out DIR] [--extra "..."]
      codex only, for an image file.
  upscale.py compare <orig> <new> [--out DIR]
      fidelity check only.

Nothing is written to RemNote here; replacing the image is done by the caller
(put → edit_rem → localize), after the check passes.
"""
import argparse, glob, json, os, shutil, subprocess, sys, time
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

BRIDGE = Path(__file__).resolve().parent / "media_bridge.py"
GEN_DIR = Path.home() / ".codex/generated_images"

PROMPT = (
    "Use your image generation tool to upscale the attached image to about 2x "
    "resolution, sharp and clean, as a faithful restoration of a scanned figure from a book. "
    "It must remain EXACTLY the same figure: same curves, lines, shapes, positions, "
    "proportions, colors, line styles, labels, symbols, formulas, numbers and text (same "
    "language, same spelling, same fonts as far as possible). Add nothing, remove nothing, "
    "translate nothing, do not fix or 'improve' content, do not change the aspect ratio or "
    "crop. Only remove blur, noise and JPEG artifacts and increase resolution. "
    "Do not run shell commands and do not copy or save files; just generate the image once "
    "and reply 'done'."
)


def sh(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


# ---------------------------------------------------------------- codex
def codex_bin() -> tuple[str, dict]:
    """codex and an env that can run it: under launchd (the media-bridge helper) PATH
    lacks Homebrew, and codex is a node script."""
    env = dict(os.environ)
    env["PATH"] = os.pathsep.join([env.get("PATH", ""), "/opt/homebrew/bin", "/usr/local/bin"])
    exe = shutil.which("codex", path=env["PATH"])
    if not exe:
        raise FileNotFoundError("codex CLI not found: npm i -g @openai/codex, then codex login")
    return exe, env


def codex_upscale(src: Path, out: Path, extra: str = "") -> dict:
    out.mkdir(parents=True, exist_ok=True)
    prompt = PROMPT + (("\n\nAdditional instructions: " + extra) if extra else "")
    t0 = time.time()
    exe, env = codex_bin()
    p = sh([exe, "exec", "--skip-git-repo-check", "-s", "read-only", "--json",
            "-C", str(out), prompt, "-i", str(src)], timeout=900, env=env)
    thread, msgs, usage = None, [], None
    for line in p.stdout.splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("type") == "thread.started":
            thread = e.get("thread_id")
        elif e.get("type") == "item.completed" and e["item"].get("type") == "agent_message":
            msgs.append(e["item"].get("text", ""))
        elif e.get("type") == "turn.completed":
            usage = e.get("usage")
        elif e.get("type") in ("error", "turn.failed"):
            msgs.append(json.dumps(e))
    gen = sorted(glob.glob(str(GEN_DIR / str(thread) / "*.png")), key=os.path.getmtime) if thread else []
    res = {"thread": thread, "seconds": round(time.time() - t0), "codex_exit": p.returncode,
           "messages": msgs, "usage": usage}
    if not gen:
        res["error"] = "no generated image found" + (f" (stderr: {p.stderr[-800:]})" if p.stderr else "")
        return res
    dst = out / (src.stem + "-upscaled.png")
    shutil.copyfile(gen[-1], dst)
    res["upscaled"] = str(dst)
    return res


# ---------------------------------------------------------------- compare
def ink_mask(rgb: np.ndarray, thr: float = 60.0) -> np.ndarray:
    bg = np.median(rgb.reshape(-1, 3), axis=0)
    d = np.sqrt(((rgb.astype(float) - bg) ** 2).sum(-1))
    return d > thr


def ocr(path: Path):
    try:
        import Vision, Quartz
        from Foundation import NSURL
    except Exception:
        return None
    url = NSURL.fileURLWithPath_(str(path))
    src = Quartz.CGImageSourceCreateWithURL(url, None)
    img = Quartz.CGImageSourceCreateImageAtIndex(src, 0, None)
    req = Vision.VNRecognizeTextRequest.alloc().init()
    req.setRecognitionLevel_(0)  # accurate
    req.setRecognitionLanguages_(["pt-BR", "en-US"])
    req.setUsesLanguageCorrection_(False)
    h = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(img, None)
    ok, _ = h.performRequests_error_([req], None)
    out = []
    for r in (req.results() or []):
        c = r.topCandidates_(1)
        if c:
            out.append(str(c[0].string()))
    return out


def norm_tokens(lines):
    toks = []
    for l in lines:
        toks += "".join(ch for ch in l.lower() if ch.isalnum() or ch.isspace()).split()
    return toks


def compare(orig: Path, new: Path, out: Path) -> dict:
    from scipy import ndimage
    out.mkdir(parents=True, exist_ok=True)
    O = Image.open(orig).convert("RGB")
    N = Image.open(new).convert("RGB")
    W, H = O.size
    aspect_dev = abs((N.size[0] / N.size[1]) / (W / H) - 1)
    Nd = N.resize((W, H), Image.LANCZOS)
    o = np.asarray(O.filter(ImageFilter.GaussianBlur(0.6)))
    n = np.asarray(Nd.filter(ImageFilter.GaussianBlur(0.6)))
    mo, mn = ink_mask(o), ink_mask(n)
    # faint traces (washed-out scans) count as "present" when judging added/missing ink
    lo_o, lo_n = ink_mask(o, 25), ink_mask(n, 25)

    # best integer shift (generators sometimes nudge the canvas by a few px)
    best = (-1, 0, 0)
    for dy in range(-6, 7):
        for dx in range(-6, 7):
            s = np.roll(np.roll(mn, dy, 0), dx, 1)
            iou = (mo & s).sum() / max(1, (mo | s).sum())
            if iou > best[0]:
                best = (iou, dx, dy)
    _, dx, dy = best
    mn = np.roll(np.roll(mn, dy, 0), dx, 1)
    lo_n = np.roll(np.roll(lo_n, dy, 0), dx, 1)
    n = np.roll(np.roll(n, dy, 0), dx, 1)

    r = max(2, round(min(W, H) / 250))  # tolerance radius in original px
    st = ndimage.generate_binary_structure(2, 1)
    mo_d = ndimage.binary_dilation(lo_o, st, iterations=r)
    mn_d = ndimage.binary_dilation(lo_n, st, iterations=r)
    missing = mo & ~mn_d   # in original, gone in new
    added = mn & ~mo_d     # new ink not in original

    def blobs(m):
        lab, k = ndimage.label(ndimage.binary_dilation(m, st, iterations=1))
        if not k:
            return []
        sizes = ndimage.sum(m, lab, range(1, k + 1))
        objs = ndimage.find_objects(lab)
        bl = [(int(s), objs[i]) for i, s in enumerate(sizes) if s >= 12]
        bl.sort(key=lambda t: -t[0])
        return [{"px": s, "bbox_xywh": [sl[1].start, sl[0].start, sl[1].stop - sl[1].start,
                                         sl[0].stop - sl[0].start]} for s, sl in bl[:8]]

    # hue drift on ink that is coloured in both (saturation/brightness changes are fine)
    def hsv(a):
        return np.asarray(Image.fromarray(a.astype(np.uint8)).convert("HSV")).astype(float)
    ho, hn = hsv(o), hsv(n)
    col = mo & mn & (ho[..., 1] > 70) & (hn[..., 1] > 70)
    if col.sum() > 50:
        dh = np.abs(ho[..., 0][col] - hn[..., 0][col]) * 360 / 255
        dh = np.minimum(dh, 360 - dh)
        cdiff = float(np.median(dh)); hue_bad = float((dh > 40).mean() * 100)
    else:
        cdiff, hue_bad = 0.0, 0.0
    # coloured in the original but grey in the new one
    lost = mo & mn & (ho[..., 1] > 90) & (hn[..., 1] < 30)
    color_lost_pct = float(lost.sum() / max(1, (mo & (ho[..., 1] > 90)).sum()) * 100)

    # overlay: grey = shared, red = missing in new, blue = added by new
    ov = np.full((H, W, 3), 255, np.uint8)
    ov[mo | mn] = (200, 200, 200)
    ov[missing] = (230, 30, 30)
    ov[added] = (20, 90, 230)
    ovp = out / (Path(new).stem + "-diff.png")
    Image.fromarray(ov).resize((W * 2, H * 2), Image.NEAREST).save(ovp)

    # side by side at the new image's height
    Hn = N.size[1]
    Ou = O.resize((round(W * Hn / H), Hn), Image.LANCZOS)
    sbs = Image.new("RGB", (Ou.size[0] + N.size[0] + 20, Hn), "white")
    sbs.paste(Ou, (0, 0)); sbs.paste(N, (Ou.size[0] + 20, 0))
    sbsp = out / (Path(new).stem + "-side-by-side.png")
    sbs.save(sbsp)

    # zoomed before/after crop for every changed region, so a human/LLM can judge it
    crops = []
    sx, sy = N.size[0] / W, N.size[1] / H
    for kind, bl in (("missing", blobs(missing)), ("added", blobs(added))):
        for i, bb in enumerate(bl):
            x, y, w, h = bb["bbox_xywh"]; pad = 18
            box = (max(0, x - pad), max(0, y - pad), min(W, x + w + pad), min(H, y + h + pad))
            a_ = O.crop(box).resize((round((box[2] - box[0]) * sx * 2), round((box[3] - box[1]) * sy * 2)), Image.LANCZOS)
            nb = (round(box[0] * sx) - dx * sx, round(box[1] * sy) - dy * sy, round(box[2] * sx) - dx * sx, round(box[3] * sy) - dy * sy)
            b_ = N.crop(tuple(round(v) for v in nb)).resize(a_.size, Image.LANCZOS)
            c = Image.new("RGB", (a_.size[0] * 2 + 12, a_.size[1]), (255, 0, 255))
            c.paste(a_, (0, 0)); c.paste(b_, (a_.size[0] + 12, 0))
            cp = out / f"{Path(new).stem}-{kind}{i + 1}.png"; c.save(cp)
            crops.append({"kind": kind, "px": bb["px"], "bbox_xywh": bb["bbox_xywh"], "crop": str(cp)})

    ink = max(1, mo.sum())
    t_o, t_n = ocr(orig_big(orig, out)), ocr(Path(new))
    res = {
        "orig_size": [W, H], "new_size": list(N.size), "scale": round(N.size[0] / W, 2),
        "aspect_deviation": round(aspect_dev, 4), "shift_px": [dx, dy],
        "iou": round(float(best[0]), 3),
        "missing_pct": round(100 * missing.sum() / ink, 2),
        "added_pct": round(100 * added.sum() / ink, 2),
        "missing_blobs": blobs(missing), "added_blobs": blobs(added),
        "change_crops": crops,
        "hue_shift_median_deg": round(cdiff, 1), "hue_shift_gt40_pct": round(hue_bad, 1),
        "color_lost_pct": round(color_lost_pct, 1),
        "diff_overlay": str(ovp), "side_by_side": str(sbsp),
    }
    if t_o is not None:
        a, b = norm_tokens(t_o), norm_tokens(t_n)
        from collections import Counter
        ca, cb = Counter(a), Counter(b)
        res["ocr"] = {"orig": t_o, "new": t_n,
                      "only_in_orig": sorted((ca - cb).elements()),
                      "only_in_new": sorted((cb - ca).elements())}
        # Vision misreads formulas/Greek, so only plain words (letters, len>=3) raise a flag
        plain = lambda ls: [l for l in ls if not any(ch in l for ch in "=()+/0123456789")]
        wa = Counter(t for t in norm_tokens(plain(t_o)) if t.isalpha() and len(t) >= 3)
        wb = Counter(t for t in norm_tokens(plain(t_n)) if t.isalpha() and len(t) >= 3)
        res["ocr"]["word_diff"] = sorted((wa - wb).elements()) + ["+" + w for w in sorted((wb - wa).elements())]
    flags = []
    if aspect_dev > 0.015: flags.append("aspect ratio changed")
    if res["missing_pct"] > 1.5: flags.append("ink missing from original")
    if res["added_pct"] > 1.5: flags.append("ink added")
    big = max([b["px"] for b in res["missing_blobs"] + res["added_blobs"]] or [0])
    if big > max(40, ink * 0.004): flags.append(f"localized change ({big} px blob)")
    elif crops: flags.append(f"{len(crops)} small changed region(s): inspect change_crops")
    if hue_bad > 10: flags.append(f"hue changed on {hue_bad:.0f}% of coloured ink")
    if color_lost_pct > 10: flags.append(f"colour lost on {color_lost_pct:.0f}% of coloured ink")
    if t_o is not None and res["ocr"]["word_diff"]:
        flags.append("OCR words differ: " + " ".join(res["ocr"]["word_diff"]))
    res["flags"] = flags
    res["verdict"] = "pass" if not flags else "review"
    return res


def orig_big(orig: Path, out: Path) -> Path:
    """OCR is more reliable on a 2x copy of the low-res original."""
    im = Image.open(orig).convert("RGB")
    p = out / (Path(orig).stem + "-2x-for-ocr.png")
    im.resize((im.size[0] * 2, im.size[1] * 2), Image.LANCZOS).save(p)
    return p


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    r = sp.add_parser("run"); r.add_argument("rem"); r.add_argument("--out"); r.add_argument("--extra", default="")
    r.add_argument("--attempts", type=int, default=1)
    u = sp.add_parser("upscale"); u.add_argument("image"); u.add_argument("--out"); u.add_argument("--extra", default="")
    c = sp.add_parser("compare"); c.add_argument("orig"); c.add_argument("new"); c.add_argument("--out")
    a = ap.parse_args()

    if a.cmd == "compare":
        out = Path(a.out or Path(a.new).parent)
        print(json.dumps(compare(Path(a.orig), Path(a.new), out), ensure_ascii=False, indent=2))
        return
    if a.cmd == "upscale":
        src = Path(a.image); out = Path(a.out or src.parent)
        res = codex_upscale(src, out, a.extra)
        if "upscaled" in res:
            res["check"] = compare(src, Path(res["upscaled"]), out)
        print(json.dumps(res, ensure_ascii=False, indent=2))
        sys.exit(0 if "upscaled" in res else 1)

    out = Path(a.out or Path.home() / "Pictures/remnote-upscale" / a.rem)
    out.mkdir(parents=True, exist_ok=True)
    g = sh([sys.executable, "-I", str(BRIDGE), "get-image", a.rem, "--out", str(out)])
    if g.returncode:
        print(g.stdout or g.stderr); sys.exit(1)
    info = json.loads(g.stdout)
    report = {"remId": a.rem, "title": info.get("title"), "images": []}
    for im in info.get("images", []):
        src = Path(im["path"])
        entry = {"field": im.get("field"), "orig": str(src), "orig_url": im.get("url"), "attempts": []}
        for i in range(a.attempts):
            sub = out / f"try{i + 1}"
            res = codex_upscale(src, sub, a.extra)
            if "upscaled" in res:
                res["check"] = compare(src, Path(res["upscaled"]), sub)
            entry["attempts"].append(res)
            if res.get("check", {}).get("verdict") == "pass":
                break
        report["images"].append(entry)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    ok = all(any(t.get("check", {}).get("verdict") == "pass" for t in e["attempts"]) for e in report["images"])
    sys.exit(0 if ok and report["images"] else 3)


if __name__ == "__main__":
    main()
