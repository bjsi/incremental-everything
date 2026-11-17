// A stand-in for @remnote/plugin-sdk, for docs/demos/audio-playlist.html: just enough
// of RemNote to run the real Audio Playlist player (src/widgets/audio_playlist_float.tsx)
// in a plain page, over an invented document. Built by build_audio_playlist_demo.sh.
const React = require('react');
const ReactDOM = require('react-dom');

const file = (name) => new URL('audio-playlist/' + name, document.baseURI).href;
const audio = (name) => ({ i: 'a', url: file(name), onlyAudio: true });

// [id, parent, text, tags]. An invented handbook chapter: two sections read aloud (their
// audio rems carry the file caption Read Aloud writes, and the #AI audio tag), a
// pronunciation clip under a second, and a lecture recording with a caption of its own.
const TREE = [
  ['book', null, ['Harbour Pilot’s Handbook']],
  ['part', 'book', ['Part II – The moving sea']],
  ['ch4', 'part', ['Chapter 4 – Tides']],
  ['s41', 'ch4', ['4.1 What raises the tide']],
  ['a41', 's41', ['🔊 Audio (Ava) ', audio('4-1-what-raises-the-tide.mp3')], ['tagAI']],
  ['n41', 's41', ['Two bulges: one facing the Moon, one on the far side.']],
  ['s42', 'ch4', ['4.2 Springs and neaps']],
  ['a42', 's42', ['🔊 Audio (Ava) ', audio('4-2-springs-and-neaps.mp3')], ['tagAI']],
  ['n42', 's42', ['neap: the smallest range, at the Moon’s quarters']],
  ['p42', 'n42', ['🔊 ', audio('neap-pronunciation.mp3')]],
  ['s43', 'ch4', ['4.3 Reading a tide table']],
  ['a43', 's43', ['Lecture 7 – recording ', audio('lecture-7-reading-a-tide-table.mp3')]],
  ['n43', 's43', ['Rule of twelfths: 1, 2, 3, 3, 2, 1.']],
  ['tagAI', null, ['AI audio']],
];
const rems = new Map();
for (const [id, parent, text, tags] of TREE) {
  rems.set(id, {
    _id: id, parent, text, backText: undefined, createdAt: rems.size, tags: tags || [],
    getDescendants: async () => descendants(id),
    taggedRem: async () => [...rems.values()].filter((r) => r.tags.includes(id)),
  });
}
function descendants(id) {
  const out = [];
  for (const rem of rems.values()) if (rem.parent === id) out.push(rem, ...descendants(rem._id));
  return out;
}

const session = new Map();
const trackers = new Set();
const STORE = 'ir-demo-audio:';
const asyncNoop = () => Promise.resolve(undefined);
const anyNs = new Proxy(function () {}, { get: (_t, k) => (k === 'then' ? undefined : asyncNoop), apply: () => undefined });

const base = {
  storage: {
    getSession: async (k) => session.get(k),
    setSession: async (k, v) => { session.set(k, v); trackers.forEach((run) => run()); window.dispatchEvent(new Event('demo-session')); },
    // The player's own keys are kept; anything else asked for is the plugin's settings.
    getSynced: async (k) => {
      if (!k.startsWith('audio-playlist-')) return { 'read-aloud-tag': 'AI audio' };
      try { const raw = localStorage.getItem(STORE + k); return raw ? JSON.parse(raw) : undefined; } catch { return undefined; }
    },
    setSynced: async (k, v) => { try { localStorage.setItem(STORE + k, JSON.stringify(v)); } catch {} },
    getLocal: async () => undefined,
    setLocal: async () => {},
  },
  kb: { getCurrentKnowledgeBaseData: async () => ({ _id: 'demo' }) },
  app: { toast: async () => {}, getOperatingSystem: async () => 'mac', getPlatform: async () => 'web', registerCommand: async () => {} },
  widget: { getWidgetContext: async () => ({ floatingWidgetId: 'demo', widgetInstanceId: 1 }), openPopup: async () => {} },
  window: {
    setFloatingWidgetPosition: async () => {},
    closeFloatingWidget: async () => {},
    isFloatingWidgetOpen: async () => true,
    openRem: async (rem) => window.dispatchEvent(new CustomEvent('demo-open-rem', { detail: rem._id })),
    getFocusedPaneId: async () => 'pane',
    getOpenPaneRemId: async () => 'ch4',
  },
  rem: {
    findOne: async (id) => rems.get(id),
    findMany: async (ids) => ids.map((id) => rems.get(id)).filter(Boolean),
    findByName: async (name) => [...rems.values()].find((r) => r.text.join('') === name[0]),
  },
};
const plugin = new Proxy(base, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : anyNs) });

// The index's part (lib/audio_playlist.ts, registerAudioPlaylist): the player is on
// screen while it is wanted.
let Player = null;
function sync() {
  const mount = document.getElementById('player');
  if (!Player || !mount) return;
  const wanted = !!session.get('audio-playlist-wanted');
  if (wanted && !mount.firstChild) ReactDOM.render(React.createElement(Player), mount);
  else if (!wanted && mount.firstChild) ReactDOM.unmountComponentAtNode(mount);
  document.body.classList.toggle('player-open', wanted);
}
window.addEventListener('demo-session', sync);

window.AudioPlaylistDemo = {
  tree: TREE,
  ask: (spec, play) => {
    base.storage.setSession('audio-playlist-request', { spec, play: !!play, at: Date.now() });
    base.storage.setSession('audio-playlist-wanted', true);
  },
  open: () => base.storage.setSession('audio-playlist-wanted', true),
};

const deepAny = (name) => new Proxy(function () {}, {
  get: (_t, k) => (k === Symbol.toPrimitive || k === 'toString' || k === 'valueOf' ? () => name : k === 'then' ? undefined : deepAny(String(k))),
  apply: () => undefined,
});
const sdk = {
  __esModule: true,
  renderWidget: (Component) => { Player = Component; sync(); },
  usePlugin: () => plugin,
  useTrackerPlugin: (fn, deps) => {
    const [value, setValue] = React.useState(undefined);
    React.useEffect(() => {
      let alive = true;
      const run = () => Promise.resolve().then(() => fn(plugin)).then((v) => alive && setValue(v)).catch(() => {});
      run();
      trackers.add(run);
      return () => { alive = false; trackers.delete(run); };
    }, deps || []);
    return value;
  },
  useAPIEventListener: () => {},
  WidgetLocation: { FloatingWidget: 'FloatingWidget' },
  SelectionType: { Rem: 'Rem', Text: 'Text' },
  PowerupSlotCodeMap: {},
};
// The bundler copies this module's own keys onto a fresh object that keeps its
// prototype, so the catch-all for every other SDK export lives on the prototype.
Object.setPrototypeOf(sdk, new Proxy({}, { get: (_t, k) => (typeof k === 'symbol' || k === 'then' ? undefined : deepAny(String(k))) }));
module.exports = sdk;
