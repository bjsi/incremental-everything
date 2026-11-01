// Hosts RemNote, connects to the plugin's frame, and carries out what the pages
// ask for. Writes wait in chrome.storage as `op:<id>`, so they survive the panel
// being closed; reads go straight through and are simply repeated once ready.

const CLIPPER_ID = 'ie-companion';
const REMNOTE = 'https://www.remnote.com';
const PLUGIN_IDS = new Set(['incremental-everything', 'incremental-everything-plus']);
const OP_TIMEOUT_MS = 120000;
const NEEDS_DOCUMENT = new Set(['addExtract', 'importHeadings']);

const frame = document.getElementById('frame');
const statusText = document.getElementById('statusText');
const startedAt = Date.now();
const log = [];
const waiting = new Map();
let pluginPort = null;
let pluginInfo = null;
let frameStarted = false;
let focusedUrl = null;

function note(text) {
  log.push(`${((Date.now() - startedAt) / 1000).toFixed(1)}s ${text}`);
}

function showStatus(text) {
  statusText.textContent = text;
  note(text);
}

// ---- RemNote in the frame ----

async function startFrame() {
  if (frameStarted) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith('http') || tab.url.startsWith(REMNOTE)) return;
  frameStarted = true;
  focusedUrl = tab.url;
  showStatus('Starting RemNote…');
  frame.src =
    `${REMNOTE}/clipper?clipperURL=${encodeURIComponent(tab.url)}` +
    `&clipperTitle=${encodeURIComponent(tab.title || tab.url)}&clipperId=${CLIPPER_ID}`;
}

/** Sends one of the /clipper page's own commands and waits for its answer. */
function callRemNote(name, data, timeoutMs = 20000) {
  const messageId = `ie-${Date.now()}-${Math.random()}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      window.removeEventListener('message', onReply);
      reject(new Error(`RemNote did not answer ${name} in ${timeoutMs / 1000} s`));
    }, timeoutMs);
    function onReply(event) {
      if (event.data?.messageId === messageId && event.data?.return) {
        clearTimeout(timeout);
        window.removeEventListener('message', onReply);
        resolve(event.data.value);
      }
    }
    window.addEventListener('message', onReply);
    frame.contentWindow?.postMessage({ function: name, data, messageId, nonce: Math.random() }, REMNOTE);
  });
}

// ---- The plugin ----

function isOurPluginFrame(url) {
  try {
    const parsed = new URL(url);
    const trustedHost =
      parsed.origin === 'https://www.remnoteplugins.com' || parsed.hostname === 'localhost';
    return trustedHost && PLUGIN_IDS.has(parsed.searchParams.get('pluginId'));
  } catch {
    return false;
  }
}

chrome.runtime.onConnect.addListener((port) => {
  // Chrome fills in sender.url, so another plugin cannot pose as this one.
  if (port.name !== 'plugin-frame' || !isOurPluginFrame(port.sender?.url)) return port.disconnect();

  port.onMessage.addListener((message) => {
    if (message.kind === 'here') {
      pluginPort = port;
      pluginInfo = message.info;
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      const pluginId = new URL(port.sender.url).searchParams.get('pluginId');
      showStatus(`Connected in ${seconds} s to “${message.info.knowledgeBase}”${message.info.lightMode ? ', light mode' : ''}`);
      note(`plugin ${pluginId} ${JSON.stringify(message.info)}`);
      drain();
      notifyTabs({ ie: 'pluginReady' });
    } else if (message.kind === 'opDone') {
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  port.onDisconnect.addListener(() => {
    if (pluginPort === port) {
      pluginPort = null;
      showStatus('The plugin disconnected. Waiting for it to return…');
    }
  });
});

function callPlugin(op, data) {
  const id = `${Date.now()}-${Math.random()}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`The plugin did not answer ${op} in ${OP_TIMEOUT_MS / 1000} s`));
    }, OP_TIMEOUT_MS);
    waiting.set(id, (message) => {
      clearTimeout(timeout);
      if (message.ok) resolve(message.result);
      else reject(Object.assign(new Error(message.error), { fromPlugin: true }));
    });
    pluginPort.postMessage({ id, op, data });
  });
}

// ---- Carrying out what pages ask for ----

async function notifyTabs(message, url) {
  const tabs = await chrome.tabs.query(url ? {} : { active: true });
  for (const tab of tabs) {
    if (!url || tab.url === url) chrome.tabs.sendMessage(tab.id, message).catch(() => {});
  }
}

async function runStoredOp({ id, op, data }) {
  const started = Date.now();
  if (NEEDS_DOCUMENT.has(op)) {
    const doc = await callRemNote('getOrCreatePageDocument', { url: data.url, title: data.title });
    if (!doc?._id) throw new Error('RemNote returned no document for this page');
    data.docId = doc._id;
  }
  const result = await callPlugin(op, data);
  if (NEEDS_DOCUMENT.has(op) && data.url !== focusedUrl) {
    focusedUrl = data.url;
    callRemNote('focusDoc', { url: data.url, title: data.title }).catch(() => {});
  }
  if (result?.priorityPopup) {
    // Lets the keys reach the popup. Chrome may keep the focus on the page, in
    // which case one click in the panel is needed.
    window.focus();
    frame.focus();
    frame.contentWindow?.focus();
  }
  note(`${op} in ${Date.now() - started} ms: ${JSON.stringify(result)}`);
  return result;
}

/** With a panel in two windows, the lock leaves one of them to carry out the queue. */
function drain() {
  if (!pluginPort) return;
  navigator.locks.request('ie-companion-drain', { ifAvailable: true }, async (lock) => {
    if (!lock) return;
    while (pluginPort) {
      const stored = await chrome.storage.local.get(null);
      const [next] = Object.keys(stored)
        .filter((key) => key.startsWith('op:'))
        .map((key) => ({ key, ...stored[key] }))
        .sort((a, b) => a.at - b.at);
      if (!next) return;
      try {
        const result = await runStoredOp(next);
        await chrome.storage.local.remove(next.key);
        notifyTabs({ ie: 'opDone', id: next.id, op: next.op, ok: true, result }, next.data.url);
      } catch (err) {
        note(`${next.op} failed: ${err.message}`);
        // A refusal is final. Anything else may be a lost connection, so it stays
        // queued. addExtract carries an id, which makes running it again safe.
        if (!err.fromPlugin) return;
        await chrome.storage.local.remove(next.key);
        notifyTabs({ ie: 'opDone', id: next.id, op: next.op, ok: false, error: err.message }, next.data.url);
      }
    }
  });
}

chrome.storage.onChanged.addListener((changes) => {
  if (Object.keys(changes).some((key) => key.startsWith('op:') && changes[key].newValue)) drain();
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.ie === 'read' && pluginPort && sender.tab) {
    callPlugin(message.op, message.data).then(
      (result) => chrome.tabs.sendMessage(sender.tab.id, { ie: 'readDone', id: message.id, ok: true, result }),
      (err) => chrome.tabs.sendMessage(sender.tab.id, { ie: 'readDone', id: message.id, ok: false, error: err.message })
    ).catch(() => {});
  } else if (message.ie === 'log') {
    note(`[${message.host}] ${message.text}`);
  } else if (message.ie === 'frameAlive') {
    note(`RemNote frame loaded, signed in: ${message.signedIn}`);
    if (!message.signedIn) showStatus('Sign in to RemNote in this browser, then reopen the panel.');
  }
});

// ---- Status ----

document.getElementById('diagnostics').addEventListener('click', () => {
  const text = [
    `Chrome: ${navigator.userAgent}`,
    `Plugin: ${pluginInfo ? JSON.stringify(pluginInfo) : 'not connected'}`,
    '',
    ...log,
  ].join('\n');
  const box = document.getElementById('diagnosticsText');
  box.value = text;
  box.style.display = box.style.display === 'block' ? 'none' : 'block';
  box.select();
  navigator.clipboard?.writeText(text).catch(() => {});
});

chrome.tabs.onActivated.addListener(startFrame);
chrome.tabs.onUpdated.addListener((_id, change) => {
  if (change.status === 'complete') startFrame();
});
startFrame();
