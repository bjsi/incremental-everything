"""Writes the icon SVGs, with continents traced from public/logo.png, and renders the PNGs with headless Chrome.

Run: python3 companion/icons/make_icons.py (needs Pillow and Google Chrome on a Mac).
Chrome extensions need PNG icons, and each size has the drawing that survives at it.
"""
import os, subprocess, tempfile
from PIL import Image

OUT = os.path.dirname(os.path.abspath(__file__))
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

SCALE, DX = 128 / 1148, (128 - 1012 * 128 / 1148) / 2
def pt(p): return (p[0] * SCALE + DX, p[1] * SCALE)

def smooth(points):
    """A closed curve through the midpoints, with the given points as controls."""
    pts = [pt(p) for p in points]
    mid = lambda a, b: ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
    start = mid(pts[-1], pts[0])
    d = f'M{start[0]:.2f} {start[1]:.2f}'
    for i, p in enumerate(pts):
        m = mid(p, pts[(i + 1) % len(pts)])
        d += f'Q{p[0]:.2f} {p[1]:.2f} {m[0]:.2f} {m[1]:.2f}'
    return d + 'Z'

AFRICA = [(285,490),(300,430),(350,385),(430,362),(520,368),(590,398),(625,450),(660,512),(702,512),(672,565),(640,622),(622,690),(562,750),(498,780),(478,720),(458,640),(440,572),(400,555),(330,558),(292,520)]
EURASIA = [(348,348),(352,318),(392,288),(438,262),(462,190),(560,158),(632,118),(725,180),(805,270),(852,380),(868,445),(830,522),(790,440),(722,418),(680,396),(735,470),(722,492),(660,502),(600,405),(590,385),(540,350),(480,342),(438,330),(385,358)]
SOUTH_AMERICA = [(70,470),(150,562),(206,622),(190,722),(272,818),(200,772),(110,690),(70,570)]
GREENLAND = [(280,197),(340,122),(436,108),(382,165),(292,197)]
NORTH_AMERICA = [(88,372),(150,270),(235,165),(285,125),(235,222),(180,262),(120,335)]
MADAGASCAR = [(640,730),(662,672),(688,658),(668,716)]
UK = [(366,258),(395,222),(415,262),(380,268)]

GLOBE = pt((470, 476))[0], pt((470, 476))[1], 392 * SCALE

DEFS = '''  <defs>
    <radialGradient id="sea" cx="0.32" cy="0.3" r="0.8">
      <stop offset="0" stop-color="#6db7e8"/><stop offset="0.45" stop-color="#2f80c4"/><stop offset="1" stop-color="#17508f"/>
    </radialGradient>
    <radialGradient id="gold" gradientUnits="userSpaceOnUse" cx="42" cy="32" r="82">
      <stop offset="0" stop-color="#fbe9a6"/><stop offset="0.5" stop-color="#e2b955"/><stop offset="1" stop-color="#b98a2c"/>
    </radialGradient>
    <linearGradient id="wood" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#b9713a"/><stop offset="1" stop-color="#7f4720"/>
    </linearGradient>
    <clipPath id="ball"><circle cx="{cx:.2f}" cy="{cy:.2f}" r="{r:.2f}"/></clipPath>
  </defs>'''

def stand(width, pin, stem_w, base_w, base_h):
    cx, cy, r = GLOBE
    R = r + 6.4 + (width - 5) / 2
    import math
    def at(deg, rad):
        a = math.radians(deg)
        return cx + rad * math.sin(a), cy - rad * math.cos(a)
    # From the top, clockwise round to the bottom left, tilted like the logo.
    x0, y0 = at(21, R); x1, y1 = at(203, R)
    pa, pb = at(21, r - 1), at(21, R)
    qa, qb = at(203, r - 1), at(203, R)
    foot = at(172, R)
    stem_top = foot[1] + width * 0.2
    base_y = 128 - base_h - 1.5
    base_cx = foot[0]
    return f'''  <path d="M{qa[0]:.2f} {qa[1]:.2f}L{qb[0]:.2f} {qb[1]:.2f}M{pa[0]:.2f} {pa[1]:.2f}L{pb[0]:.2f} {pb[1]:.2f}" stroke="#8a5126" stroke-width="{pin}" stroke-linecap="round"/>
  <path d="M{base_cx - stem_w / 2:.2f} {stem_top:.2f}L{base_cx + stem_w / 2:.2f} {stem_top:.2f}L{base_cx + stem_w * 0.72:.2f} {base_y + 1:.2f}L{base_cx - stem_w * 0.72:.2f} {base_y + 1:.2f}Z" fill="url(#wood)"/>
  <rect x="{base_cx - base_w / 2:.2f}" y="{base_y:.2f}" width="{base_w}" height="{base_h}" rx="{base_h / 2:.2f}" fill="url(#wood)"/>
  <path d="M{x0:.2f} {y0:.2f}A{R:.2f} {R:.2f} 0 1 1 {x1:.2f} {y1:.2f}" fill="none" stroke="url(#wood)" stroke-width="{width}" stroke-linecap="round"/>'''

def full():
    cx, cy, r = GLOBE
    land = ''.join(f'\n    <path d="{smooth(shape)}"/>' for shape in (AFRICA, EURASIA, SOUTH_AMERICA, GREENLAND, NORTH_AMERICA, MADAGASCAR, UK))
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">
  <title>Incremental RemNote Companion</title>
{DEFS.format(cx=cx, cy=cy, r=r)}
{stand(5, 2.6, 7, 42, 7)}
  <circle cx="{cx:.2f}" cy="{cy:.2f}" r="{r:.2f}" fill="url(#sea)"/>
  <g clip-path="url(#ball)" fill="url(#gold)" stroke="#a8791f" stroke-width="0.6" stroke-linejoin="round">{land}
  </g>
</svg>
'''

def small():
    """For 16 and 32 px: only shapes that survive, and a heavier stand."""
    cx, cy, r = GLOBE
    land = ''.join(f'\n    <path d="{smooth(shape)}"/>' for shape in (AFRICA, EURASIA, SOUTH_AMERICA))
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">
  <title>Incremental RemNote Companion</title>
{DEFS.format(cx=cx, cy=cy, r=r)}
{stand(9, 5, 14, 58, 13)}
  <circle cx="{cx:.2f}" cy="{cy:.2f}" r="{r:.2f}" fill="#2478bf"/>
  <g clip-path="url(#ball)" fill="#f0c04f">{land}
  </g>
</svg>
'''

def tiny():
    """For 16 px, drawn on the pixel grid: mostly blue, one clear landmass, a crisp stand."""
    return '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none">
  <title>Incremental RemNote Companion</title>
  <defs><clipPath id="ball"><circle cx="6.5" cy="6.5" r="5"/></clipPath></defs>
  <rect x="7" y="12.5" width="2" height="2" fill="#a5602a"/>
  <rect x="4" y="14" width="8" height="2" rx=".5" fill="#a5602a"/>
  <circle cx="6.5" cy="6.5" r="5" fill="#1f76c4"/>
  <g clip-path="url(#ball)" fill="#ffc93c">
    <path d="M3 5.2H7.5L8.5 7 7.5 8 6.8 10.6H5.5L5 8H3.5L3 6.5Z"/>
    <path d="M5 3.6 6.5 1.5H9L11.5 4.5 11 6.2 9.8 5 8.5 4.2H5.5Z"/>
  </g>
  <path d="M9.8 .9A6.5 6.5 0 1 1 2.8 11.8" stroke="#a5602a" stroke-width="1.4" stroke-linecap="round"/>
</svg>
'''

def render(svg, size=1024):
    with tempfile.TemporaryDirectory() as profile:
        html = os.path.join(profile, 'render.html')
        png = os.path.join(profile, 'render.png')
        open(html, 'w').write(f'<!doctype html><style>html,body{{margin:0;background:transparent}}svg{{display:block;width:{size}px;height:{size}px}}</style>{svg}')
        subprocess.run([CHROME, '--headless=new', f'--user-data-dir={profile}', '--disable-gpu', '--hide-scrollbars',
                        '--force-device-scale-factor=1', '--default-background-color=00000000',
                        f'--window-size={size},{size}', f'--screenshot={png}', f'file://{html}'],
                       check=True, capture_output=True, timeout=90)
        return Image.open(png).convert('RGBA').copy()

def main():
    os.makedirs(OUT, exist_ok=True)
    f, s = full(), small()
    open(f'{OUT}/icon.svg', 'w').write(f)
    open(f'{OUT}/icon-small.svg', 'w').write(s)
    t = tiny()
    open(f'{OUT}/icon-tiny.svg', 'w').write(t)
    big, little, smallest = render(f), render(s), render(t)
    for size, source in ((128, big), (48, big), (32, little), (16, smallest)):
        source.resize((size, size), Image.BOX if size <= 32 else Image.LANCZOS).save(f'{OUT}/icon-{size}.png')
main()
