#!/usr/bin/env python3
"""Prints the base64 WOFF used by src/register/true_false.ts to hide the verdict marks in the queue.

The font covers only the marks (✅ ✔ ☑ ✓ and ❌ ✖) and the emoji variation selector, each as an
empty zero-width glyph. Requires fontTools.
"""
import base64
import io

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

CODEPOINTS = {
    0x2705: "check",
    0x2714: "heavycheck",
    0x2611: "ballotcheck",
    0x2713: "lightcheck",
    0x274C: "cross",
    0x2716: "heavycross",
    0xFE0F: "vs16",
}

glyphs = [".notdef", *CODEPOINTS.values()]
empty = TTGlyphPen(None).glyph()

fb = FontBuilder(1000, isTTF=True)
fb.setupGlyphOrder(glyphs)
fb.setupCharacterMap(CODEPOINTS)
fb.setupGlyf({name: empty for name in glyphs})
fb.setupHorizontalMetrics({name: (0, 0) for name in glyphs})
fb.setupHorizontalHeader(ascent=800, descent=-200)
fb.setupNameTable({"familyName": "TF Mark Hide", "styleName": "Regular"})
fb.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
fb.setupPost()

fb.font.flavor = "woff"
out = io.BytesIO()
fb.font.save(out)
print(base64.b64encode(out.getvalue()).decode())
