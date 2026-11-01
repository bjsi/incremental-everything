// Runs the checks and shows them. The answers come from content.js in the
// RemNote frame, and from src/lib/companion_spike.ts in the plugin.

const CHECKS = [
  ['headers', 'Test 3: /clipper response allows embedding', true],
  ['frameScript', 'Test 3: extension script runs inside the RemNote frame', true],
  ['signedIn', 'Test 3: already signed in (shares the browser session)', true],
  ['booted', 'Test 3: RemNote starts inside the frame', true],
  ['protocol', 'Test 3: RemNote answers this extension (getRemById)', true],
  ['hello', 'Real plugin: its message reaches the extension', true],
  ['ready', 'Real plugin: answers, and reports its mode', true],
  ['latency', 'Real plugin: panel → plugin → panel round trips', true],
  ['pluginToPage', 'Plugin command → page banner (by hand)', true],
  ['pluginFrames', 'Info: plugins loaded in this panel', false],
];

const state = Object.fromEntries(CHECKS.map(([id]) => [id, { mark: '⬜', detail: '' }]));
const log = [];
const frame = document.getElementById('frame');
const CLIPPER_ID = 'ie-spike';
const pendingPings = new Map();
const pendingOps = new Map();
const queuedOps = [];
const pageRows = new Map();
let pluginReady = false;
const pluginIds = new Set();
let protocolTimer;
let startedAt = 0;

function render() {
  const rows = [
    ...CHECKS.map(([id, label]) => [state[id], label]),
    ...[...pageRows.entries()].map(([label, row]) => [row, label]),
  ];
  document.getElementById('checks').replaceChildren(
    ...rows.map(([entry, label]) => {
      const row = document.createElement('div');
      row.className = 'check';
      const mark = document.createElement('span');
      mark.className = 'mark';
      mark.textContent = entry.mark;
      const text = document.createElement('div');
      text.textContent = label;
      if (entry.detail) {
        const detail = document.createElement('div');
        detail.className = 'detail';
        detail.textContent = entry.detail;
        text.append(detail);
      }
      row.append(mark, text);
      return row;
    })
  );
}

function set(id, passed, detail = '') {
  state[id] = { mark: passed === null ? '⏳' : passed ? '✅' : '❌', detail };
  log.push(`${Date.now() - startedAt}ms ${id} ${state[id].mark} ${detail}`);
  render();
}

const unresolved = (id) => state[id].mark === '⬜' || state[id].mark === '⏳';

const toFrame = (message) => frame.contentWindow?.postMessage(message, 'https://www.remnote.com');
const toPlugin = (payload) => toFrame({ ieSpike: 'toPlugin', payload });

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const header = (name) =>
      details.responseHeaders?.find((h) => h.name.toLowerCase() === name)?.value;
    const csp = header('content-security-policy') ?? '';
    const ancestors = csp.split(';').map((p) => p.trim()).find((p) => p.startsWith('frame-ancestors'));
    const xfo = header('x-frame-options');
    const blocked = !!xfo || (!!ancestors && !ancestors.includes('chrome-extension:') && !ancestors.includes('*'));
    set(
      'headers',
      // Not judged on the status: a plain request for /clipper returned 404, yet the Clipper works.
      !blocked,
      `HTTP ${details.statusCode}; x-frame-options: ${xfo ?? 'none'}; ${ancestors ?? 'frame-ancestors: none'}`
    );
  },
  { urls: ['https://www.remnote.com/clipper*'], types: ['sub_frame'] },
  ['responseHeaders']
);

function startProtocolCheck() {
  clearInterval(protocolTimer);
  const messageId = `spike-${Date.now()}`;
  let tries = 0;
  protocolTimer = setInterval(() => {
    if (!unresolved('protocol')) return clearInterval(protocolTimer);
    if (++tries > 60) {
      clearInterval(protocolTimer);
      return set('protocol', false, 'No answer in 2 minutes');
    }
    toFrame({ function: 'getRemById', data: { id: 'ieSpikeNoSuchRem' }, messageId, nonce: Math.random() });
  }, 2000);

  window.addEventListener('message', function onReply(event) {
    if (event.data?.messageId === messageId && event.data?.return) {
      window.removeEventListener('message', onReply);
      clearInterval(protocolTimer);
      set('protocol', true, 'Answered from a chrome-extension: origin that is not the Clipper');
    }
  });
}

function measureLatency(left = 5, times = []) {
  if (!left) {
    const average = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
    return set('latency', true, `${times.length} round trips, average ${average} ms`);
  }
  const id = `${Date.now()}-${left}`;
  const timeout = setTimeout(() => {
    pendingPings.delete(id);
    set('latency', false, 'A ping got no answer within 5 s');
  }, 5000);
  pendingPings.set(id, (ms) => {
    clearTimeout(timeout);
    measureLatency(left - 1, [...times, ms]);
  });
  toPlugin({ kind: 'ping', id, sentAt: performance.now() });
}

function fromPlugin(payload) {
  if (payload.kind === 'ready') {
    set('ready', true, JSON.stringify(payload.info));
    measureLatency();
    pluginReady = true;
    for (const [message, tabId, at] of queuedOps.splice(0)) {
      if (message.op !== 'pageState') {
        setPageRow(`Clicked before the plugin was ready: ${message.op}`, true, `Held for ${Date.now() - at} ms, then run`);
      }
      runOp(message, tabId);
    }
    chrome.tabs.query({ active: true }).then((tabs) => {
      for (const tab of tabs) chrome.tabs.sendMessage(tab.id, { spike: 'pluginReady' }).catch(() => {});
    });
  } else if (payload.kind === 'pong') {
    pendingPings.get(payload.id)?.(Math.round(performance.now() - payload.sentAt));
    pendingPings.delete(payload.id);
  } else if (payload.kind === 'opDone') {
    const tabId = pendingOps.get(payload.id);
    pendingOps.delete(payload.id);
    if (tabId !== undefined) chrome.tabs.sendMessage(tabId, { spike: 'opDone', ...payload }).catch(() => {});
  } else if (payload.kind === 'push') {
    activeTab().then((tab) => {
      if (!tab?.id) return set('pluginToPage', false, 'No active tab');
      chrome.tabs.sendMessage(tab.id, { spike: 'toPage', text: payload.text }).then(
        () => set('pluginToPage', true, `Delivered to: ${tab.url}`),
        (err) => set('pluginToPage', false, `${err.message}. Is the tab a normal web page, reloaded after installing?`)
      );
    });
  }
}

/** Sends one of /clipper's own commands to the RemNote frame and waits for its answer. */
function callRemNote(name, data, timeoutMs = 15000) {
  const messageId = `spike-${Date.now()}-${Math.random()}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      window.removeEventListener('message', onReply);
      reject(new Error(`${name}: no answer in ${timeoutMs / 1000} s`));
    }, timeoutMs);
    function onReply(event) {
      if (event.data?.messageId === messageId && event.data?.return) {
        clearTimeout(timeout);
        window.removeEventListener('message', onReply);
        resolve(event.data.value);
      }
    }
    window.addEventListener('message', onReply);
    toFrame({ function: name, data, messageId, nonce: Math.random() });
  });
}

function setPageRow(label, ok, detail) {
  pageRows.set(label, { mark: ok ? '✅' : '❌', detail });
  log.push(`${Date.now() - startedAt}ms ${label} ${ok ? '✅' : '❌'} ${detail}`);
  render();
}

const NEEDS_DOCUMENT = new Set(['addExtract', 'importHeadings']);

async function runOp(message, tabId) {
  const { id, op, data } = message;
  pendingOps.set(id, tabId);
  try {
    if (NEEDS_DOCUMENT.has(op)) {
      const doc = await callRemNote('getOrCreatePageDocument', { url: data.url, title: data.title });
      if (!doc?._id) throw new Error('getOrCreatePageDocument returned no Rem');
      data.docId = doc._id;
    }
    toPlugin({ kind: 'op', id, op, data });
  } catch (err) {
    fromPlugin({ kind: 'opDone', id, ok: false, error: err.message });
  }
}

chrome.runtime.onMessage.addListener((message, sender) => {
  switch (message.spike) {
    case 'frameAlive':
      set('frameScript', true, `${message.href}\nancestors: ${message.ancestors}`);
      set('signedIn', message.signedIn, `userId in localStorage: ${message.signedIn}; IndexedDB databases: ${message.databases}`);
      startProtocolCheck();
      break;
    case 'booted':
      set('booted', true, `Title: ${message.title}; plugin iframes visible: ${message.pluginFrames}`);
      break;
    case 'notBooted':
      set('booted', false, `Nothing rendered after ${message.seconds}s`);
      break;
    case 'hello':
      set('hello', true, `From ${message.from}: ${message.href}`);
      break;
    case 'fromPlugin':
      fromPlugin(message.payload);
      break;
    case 'pluginFrame':
      pluginIds.add(new URL(message.href).searchParams.get('pluginId') ?? message.href);
      set('pluginFrames', pluginIds.has('incremental-everything-plus'), [...pluginIds].join(', '));
      break;
    case 'pageOp':
      if (pluginReady) runOp(message, sender.tab?.id);
      else queuedOps.push([message, sender.tab?.id, Date.now()]);
      break;
    case 'pageReport':
      setPageRow(`${message.host}: ${message.name}`, message.ok, message.detail);
      break;
  }
});

document.getElementById('start').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab?.url?.startsWith('http')) {
    document.getElementById('target').textContent = 'Switch to a normal web page first.';
    return;
  }
  for (const [id] of CHECKS) state[id] = { mark: '⬜', detail: '' };
  pluginIds.clear();
  pageRows.clear();
  pluginReady = false;
  log.length = 0;
  startedAt = Date.now();
  document.getElementById('target').textContent = tab.url;
  set('frameScript', null, 'Waiting for the frame…');
  frame.src =
    `https://www.remnote.com/clipper?clipperURL=${encodeURIComponent(tab.url)}` +
    `&clipperTitle=${encodeURIComponent(tab.title || tab.url)}&clipperId=${CLIPPER_ID}`;
  setTimeout(() => {
    if (unresolved('frameScript')) {
      set('frameScript', false, 'The frame did not load within 30 s. See the error inside it, or the panel console.');
    }
    if (unresolved('headers')) set('headers', false, 'No /clipper response seen within 30 s');
  }, 30000);
  setTimeout(() => {
    if (unresolved('hello')) set('hello', false, 'No message from the test plugin in 3 minutes. Is it installed and enabled in this KB?');
  }, 180000);
});

document.getElementById('report').addEventListener('click', () => {
  const text = [
    `Chrome: ${navigator.userAgent}`,
    `Tested page: ${document.getElementById('target').textContent}`,
    '',
    ...CHECKS.map(([id, label]) => `${state[id].mark} ${label}${state[id].detail ? `\n     ${state[id].detail}` : ''}`),
    ...[...pageRows.entries()].map(([label, row]) => `${row.mark} ${label}\n     ${row.detail}`),
    '',
    'Timeline:',
    ...log,
  ].join('\n');
  const box = document.getElementById('reportText');
  box.value = text;
  box.style.display = 'block';
  box.select();
  navigator.clipboard?.writeText(text).catch(() => {});
});

activeTab().then((tab) => {
  document.getElementById('target').textContent = tab?.url ?? '';
});
render();
