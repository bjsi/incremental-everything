"""Generate docs/RemNote-Native-Shortcuts.md from the RemNote desktop app bundle.

RemNote's default keyboard shortcuts live in one table inside app.asar, and the
sections of its shortcut settings screen in one array next to it. This reads
both, adds the plugin's own bindings from src/register/commands.ts, and writes
the page twice over: by function (RemNote's sections) and by key (a keyboard
map that also shows which combinations the plugin takes).

Run it again after a RemNote update:  python3 scripts/extract_remnote_shortcuts.py
"""
import datetime
import plistlib
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
APP = Path('/Applications/RemNote.app/Contents')
OUT = REPO / 'docs' / 'RemNote-Native-Shortcuts.md'

data = (APP / 'Resources' / 'app.asar').read_bytes().decode('latin1')
version = plistlib.load(open(APP / 'Info.plist', 'rb')).get('CFBundleShortVersionString')


def utf8(s):
    """The bundle is read as latin1 so offsets stay byte-exact; labels are UTF-8."""
    try:
        return s.encode('latin1').decode('utf8')
    except UnicodeError:
        return s


# ---- 1. The defaults table: from the ZoomIn entry to the spread that merges its parts.
start = data.find('{[s.wP.ZoomIn]:{default:"mod++"')
end = data.find('p={...l,...d,...c,...u}', start)
if start < 0 or end < 0:
    raise SystemExit('Shortcut defaults table not found — the bundle layout changed.')
seg = data[start:end]
keys = list(re.finditer(r'\[s\.(Sj|wP)\.([A-Za-z0-9_]+)\]:\{', seg))
entries = {}
for i, k in enumerate(keys):
    body = seg[k.end(): keys[i + 1].start() if i + 1 < len(keys) else len(seg)]
    head = body.split('name:(0,')[0]
    nm = re.search(r'name:\(0,[a-zA-Z_$]{1,3}\.[a-zA-Z_$]{1,3}\)\((["\'`])((?:\\.|(?!\1).)*)\1', body)

    def field(name, text):
        m = re.search(r'(?<![A-Za-z0-9])' + name +
                      r':(void 0|"[^"]*"|`[^`]*`|\[[^\]]*\]|[A-Za-z_$][\w$.]*(?:\?[^,]*:[^,]*)?)', text)
        return m.group(1) if m else None

    entries[k.group(2)] = dict(
        id=k.group(2),
        name=utf8(nm.group(2)).replace("\\'", "'") if nm else k.group(2),
        default=field('default', head),
        old0=field('oldDefaultVersion0', head),
        old1=field('oldDefaultVersion1', head),
        alt=field('alternative', body),
        flags=[f for f in ('noModifier', 'allowClash', 'cantChange', 'desktopAppGlobalShortcut') if f + ':!0' in body],
    )

VK = dict(ArrowLeft='arrowleft', ArrowRight='arrowright', ArrowUp='arrowup', ArrowDown='arrowdown',
          Backspace='backspace', Space=' ', Tab='tab', Enter='enter', Delete='delete', Escape='escape',
          **{f'F{n}': f'f{n}' for n in range(1, 13)})


def lit(expr):
    """A default expression -> (mac bindings, windows bindings); [] when unbound."""
    c = re.fullmatch(r'r\.Env\.os\.isLikeMac\?(.+?):(".*"|`.*`)', expr or '')
    if c:
        return lit1(c.group(1)), lit1(c.group(2))
    return lit1(expr), lit1(expr)


def lit1(expr):
    if expr is None or expr == 'void 0':
        return []
    expr = re.sub(r'\$\{s\.vK\.(\w+)\}', lambda m: VK.get(m.group(1), m.group(1)), expr)
    if re.fullmatch(r's\.vK\.\w+', expr):
        return [VK.get(expr.split('.')[-1], expr)]
    if expr[0] in '"`':
        return [expr[1:-1]]
    if expr[0] == '[':
        return [x.strip('"`') for x in re.findall(r'"[^"]*"|`[^`]*`', expr)]
    raise SystemExit(f'Unparsed shortcut expression: {expr}')


# ---- 2. Hotkey strings: parse, render, compare.
MOD_ALIAS = {'mod': 'mod', 'cmd': 'meta', 'command': 'meta', 'meta': 'meta', 'win': 'meta',
             'ctrl': 'ctrl', 'control': 'ctrl', 'opt': 'alt', 'option': 'alt', 'alt': 'alt',
             'shift': 'shift', 'fn': 'fn'}
KEY_ALIAS = {'right': 'arrowright', 'left': 'arrowleft', 'up': 'arrowup', 'down': 'arrowdown',
             'esc': 'escape', 'return': 'enter', 'space': ' ', 'spacebar': ' ', 'del': 'delete'}
MOD_ORDER = ['mod', 'meta', 'ctrl', 'alt', 'shift', 'fn']


def parse(h):
    if h.endswith('++'):
        parts = h[:-2].split('+') + ['+']
    elif h == '+':
        parts = ['+']
    else:
        parts = h.split('+')
    mods = frozenset(MOD_ALIAS[m.lower()] for m in parts[:-1])
    key = parts[-1].lower()
    return mods, KEY_ALIAS.get(key, key)


def physical(h, mac):
    mods, key = parse(h)
    real = {'mod': 'meta' if mac else 'ctrl'}
    return frozenset(real.get(m, m) for m in mods), key


KEY_LABEL = {'arrowleft': '←', 'arrowright': '→', 'arrowup': '↑', 'arrowdown': '↓', ' ': 'Space',
             'enter': 'Enter', 'tab': 'Tab', 'escape': 'Esc', 'backspace': 'Backspace', 'delete': 'Delete'}


def render(h, mac):
    mods, key = parse(h)
    label = {'mod': 'Cmd' if mac else 'Ctrl', 'meta': 'Cmd' if mac else 'Win', 'ctrl': 'Ctrl',
             'alt': 'Opt' if mac else 'Alt', 'shift': 'Shift', 'fn': 'Fn'}
    k = KEY_LABEL.get(key) or (key.upper() if len(key) == 1 or re.fullmatch(r'f\d+', key) else key.capitalize())
    text = ' + '.join([label[m] for m in sorted(mods, key=MOD_ORDER.index)] + [k])
    return f'`` {text} ``' if '`' in text else f'`{text}`'


def render_both(h, platforms=('mac', 'win')):
    mac, win = render(h, True), render(h, False)
    if platforms == ('mac',):
        return mac
    if platforms == ('win',):
        return win
    return mac if mac == win else f'{mac} / {win}'


def cell(hs, mac):
    return ' or '.join(render(h, mac) for h in hs) if hs else '—'


# ---- 3. Settings-screen sections.
g0 = data.find('[{name:(0,y.pw)("Global",{},"settings-keyboard-shortcuts"),shortcuts:')
gend = data.find('}],P=[', g0)
if g0 < 0 or gend < 0:
    raise SystemExit('Shortcut settings sections not found — the bundle layout changed.')
groups = [(utf8(m.group(1)), re.findall(r'm\.(?:Sj|wP|SO)\.(\w+)', m.group(2)))
          for m in re.finditer(r'\{name:\(0,y\.pw\)\("([^"]+)"(.*?)(?=\{name:\(0,y\.pw\)\(|$)',
                               data[g0:gend], re.S)]

# ---- 4. The plugin's own bindings.
src = (REPO / 'src' / 'register' / 'commands.ts').read_text()
plugin = []
for block in src.split('registerCommand({')[1:]:
    block = '\n'.join(l for l in block.split('action:')[0].splitlines() if not l.strip().startswith('//'))
    n = re.search(r"name:\s*(['\"`])((?:\\.|(?!\1).)*)\1", block)
    k = re.search(r"keyboardShortcut:\s*'([^']+)'", block)
    if k:
        plugin.append((n.group(2) if n else '?', k.group(1)))

# Every live binding, one per platform set: RemNote defaults and their alternatives, then the plugin's.
bindings = []  # dict(h, platforms, owner, name, flags, section)
section_of = {i: g for g, ids in groups for i in ids}
for e in entries.values():
    for expr in (e['default'], e['alt']):
        mac, win = lit(expr)
        if mac == win:
            bindings += [dict(h=h, platforms=('mac', 'win'), owner='remnote', name=e['name'], flags=e['flags'],
                              section=section_of.get(e['id'])) for h in mac]
        else:
            bindings += [dict(h=h, platforms=('mac',), owner='remnote', name=e['name'], flags=e['flags'],
                              section=section_of.get(e['id'])) for h in mac]
            bindings += [dict(h=h, platforms=('win',), owner='remnote', name=e['name'], flags=e['flags'],
                              section=section_of.get(e['id'])) for h in win]
bindings += [dict(h=h, platforms=('mac', 'win'), owner='plugin', name=n, flags=[], section=None) for n, h in plugin]


def clashes_with(b):
    """Bindings from the other owner that press the same physical keys on a shared platform."""
    out = {}
    for o in bindings:
        if o['owner'] == b['owner']:
            continue
        for p in set(b['platforms']) & set(o['platforms']):
            if physical(b['h'], p == 'mac') == physical(o['h'], p == 'mac'):
                out.setdefault(o['name'], set()).add('Mac' if p == 'mac' else 'Windows')
    return out


def clash_note(b):
    return '; '.join(f'⚠️ Same keys as *{name}* ({" & ".join(sorted(p))})' for name, p in clashes_with(b).items())


FLAG_LABEL = {'noModifier': 'single key', 'cantChange': 'fixed', 'allowClash': 'may clash',
              'desktopAppGlobalShortcut': 'desktop global'}

# ---- 5. The page.
unbound = sum(1 for e in entries.values() if not lit(e['default'])[0])
L = [
    '# RemNote Native Shortcuts',
    '',
    f"Every default keyboard shortcut of RemNote itself, read out of the desktop app (RemNote {version}, "
    f"{datetime.date.today():%B %-d, %Y}): {len(entries)} commands, {unbound} of them unbound by default. "
    "The plugin's own shortcuts are on [Keyboard Shortcuts](Keyboard-Shortcuts.md).",
    '',
    'The same shortcuts are listed **twice**:',
    '',
    "- **[By function](#by-function)** — in the sections and order of RemNote's own keyboard-shortcut settings.",
    "- **[By key](#by-key)** — grouped by modifier, with the plugin's shortcuts mixed in. Use it to check whether a combination is free before assigning your own.",
    '',
    '!!! note "Defaults only"',
    "    A shortcut you changed in RemNote's settings overrides what is listed here. Not listed either: keys the editor handles directly rather than as a command, such as `Ctrl + →` to jump a word on Windows or `Cmd/Ctrl + →` to move a selected table column.",
    '',
    '**Reading the tables**',
    '',
    '- `Cmd` on Mac is `Ctrl` on Windows and Linux, and `Opt` is `Alt`. A `Ctrl` in the Mac column is the Control key itself.',
    "- **Old default**: the key RemNote used before it revised its shortcuts. It still applies with *Use old keyboard shortcuts* turned on.",
    '- **single key**: no modifier, so it only works outside text editing — in the queue, the PDF viewer, a drawing. **fixed**: cannot be changed in settings. **may clash**: RemNote lets it share its key with another command. **desktop global**: handled by the desktop app itself.',
    '- **⚠️ Same keys as…**: a plugin shortcut presses the same keys, on the platform named.',
    '',
    '---',
    '## By function { #by-function }',
    '',
]


def function_table(ids):
    rows = ['| Command | Mac | Windows / Linux | Notes |', '| :--- | :--- | :--- | :--- |']
    for i in ids:
        e = entries.get(i)
        if not e:
            continue
        hp = lit(e['default'])
        notes = []

        def both(p):
            return ' / '.join(dict.fromkeys([cell(p[0], True), cell(p[1], False)]))

        for label, key in (('Old default', 'old0'), ('Old default (v1)', 'old1')):
            old = lit(e[key])
            if old[0] and old != hp:
                notes.append(f'{label}: {both(old)}')
        alt = lit(e['alt'])
        if alt[0]:
            notes.append(f'Also: {both(alt)}')
        if e['flags']:
            notes.append(', '.join(FLAG_LABEL[f] for f in e['flags']))
        for b in bindings:
            if b['owner'] == 'remnote' and b['name'] == e['name'] and b['h'] in hp[0] + hp[1]:
                note = clash_note(b)
                if note and note not in notes:
                    notes.append(note)
        name = e['name'].replace('|', '\\|')
        rows.append(f'| {name} | {cell(hp[0], True)} | {cell(hp[1], False)} | {"; ".join(notes)} |')
    return rows


seen = set()
for gname, ids in groups:
    ids = [i for i in ids if i not in seen]
    seen.update(ids)
    L += [f'### {gname}', ''] + function_table(ids) + ['']
rest = [k for k in entries if k not in seen]
if rest:
    L += ['### Not listed in the settings screen', '',
          'Commands in RemNote\'s defaults table that its settings screen does not show — PDF highlight actions, drawing arrangement, debug tools. They still respond to their keys.', '']
    L += function_table(rest) + ['']

# By key: one table per modifier combination, in the notation of the page.
GROUP_LABEL = {'mod': 'Cmd/Ctrl', 'meta': 'Cmd/Win', 'ctrl': 'Ctrl', 'alt': 'Opt/Alt', 'shift': 'Shift', 'fn': 'Fn'}
ARROWS = ['arrowleft', 'arrowright', 'arrowup', 'arrowdown']


def key_order(key):
    if len(key) == 1 and key.isalpha():
        return 0, key
    if len(key) == 1 and key.isdigit():
        return 1, key
    if len(key) == 1:
        return 2, key
    if key in ARROWS:
        return 3, str(ARROWS.index(key))
    f = re.fullmatch(r'f(\d+)', key)
    if f:
        return 5, f'{int(f.group(1)):02d}'
    return 4, key


by_mods = {}
for b in bindings:
    by_mods.setdefault(parse(b['h'])[0], []).append(b)

L += ['---', '## By key { #by-key }', '',
      "Grouped by the modifiers you hold. Rows marked **Incremental RemNote** are the plugin's; "
      'everything else is RemNote. A combination that appears in no table is free in both.', '']
for mods in sorted(by_mods, key=lambda m: (len(m), [MOD_ORDER.index(x) for x in sorted(m, key=MOD_ORDER.index)])):
    title = 'Single keys' if not mods else ' + '.join(GROUP_LABEL[m] for m in sorted(mods, key=MOD_ORDER.index)) + ' + key'
    L += [f'### {title}', '']
    if not mods:
        L += ['Active only outside text editing: in the queue, the PDF viewer and drawings.', '']
    L += ['| Keys | Command | Where | Notes |', '| :--- | :--- | :--- | :--- |']
    rows = sorted(by_mods[mods], key=lambda b: (key_order(parse(b['h'])[1]), b['owner'] != 'remnote', b['name']))
    for b in rows:
        notes = []
        if b['platforms'] != ('mac', 'win'):
            notes.append('Mac only' if b['platforms'] == ('mac',) else 'Windows / Linux only')
        notes += [FLAG_LABEL[f] for f in b['flags'] if f != 'noModifier']
        if clash_note(b):
            notes.append(clash_note(b))
        if b['owner'] == 'plugin':
            command, where = f'[{b["name"]}](Keyboard-Shortcuts.md)', '**Incremental RemNote**'
        else:
            command, where = b['name'].replace('|', '\\|'), b['section'] or '—'
        L.append(f'| {render_both(b["h"], b["platforms"])} | {command} | {where} | {"; ".join(notes)} |')
    L.append('')

OUT.write_text('\n'.join(L))
print(f'{OUT.relative_to(REPO)}: {len(entries)} commands, {len(groups)} sections, '
      f'{len(plugin)} plugin shortcuts, {len(by_mods)} key groups, '
      f'{sum(1 for b in bindings if b["owner"] == "plugin" and clashes_with(b))} plugin shortcuts sharing keys')
