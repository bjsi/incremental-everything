// Hosts RemNote, connects to the plugin's frame, and carries out what the pages
// ask for. Writes wait in chrome.storage as `op:<id>`, so they survive the panel
// being closed; reads go straight through and are simply repeated once ready.

const CLIPPER_ID = 'ie-companion';
const REMNOTE = 'https://www.remnote.com';
const PLUGIN_IDS = new Set(['incremental-everything', 'incremental-everything-plus']);
const OP_TIMEOUT_MS = 120000;
/** RemNote saves to its database shortly after a change, so a reload waits for that. */
const SETTLE_BEFORE_RELOAD_MS = 1500;
const FOCUS_TIMEOUT_MS = 20000;
const NEEDS_DOCUMENT = new Set(['addExtract', 'importHeadings']);

const frame = document.getElementById('frame');
const statusText = document.getElementById('statusText');
const startedAt = Date.now();
const log = [];
const waiting = new Map();
let pluginPort = null;
let pluginInfo = null;
let frameStarted = false;
/** The tab this panel was opened on. Chrome shows the panel only there. */
let ownTabId = null;
let focusedUrl = null;
let remnotePort = null;
/** The KB of the connected plugin, which is the one this panel can write to. */
let panelKbId = null;
/** The KB a reload of the frame is meant to arrive in. */
let switchingTo = null;

function note(text) {
  log.push(`${((Date.now() - startedAt) / 1000).toFixed(1)}s ${text}`);
}

function showStatus(text) {
  statusText.textContent = text;
  note(text);
}

// ---- RemNote in the frame ----

const isOrdinaryPage = (tab) => tab?.url?.startsWith('http') && !tab.url.startsWith(REMNOTE);

// RemNote creates the document of the page named in this address, so it names a
// page only when the user asked for that page.
function clipperAddress(tab) {
  const page = tab
    ? `clipperURL=${encodeURIComponent(tab.url)}&clipperTitle=${encodeURIComponent(tab.title || tab.url)}&`
    : '';
  return `${REMNOTE}/clipper?${page}clipperId=${CLIPPER_ID}`;
}

const ownTab = () => (ownTabId === null ? undefined : chrome.tabs.get(ownTabId).catch(() => undefined));

/** Opening the panel on a page is what asks for that page's document. */
async function startFrame() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  ownTabId = tab.id;
  if (!isOrdinaryPage(tab)) return;
  frameStarted = true;
  focusedUrl = tab.url;
  showStatus('Starting RemNote…');
  frame.src = clipperAddress(tab);
}

/** Starts RemNote again, which is what makes it read its knowledge base anew. */
function reloadFrame(tab) {
  focusedUrl = tab?.url ?? null;
  showStatus('Restarting RemNote…');
  frame.src = clipperAddress(tab);
}

/** Runs once nothing is being written, as a reload would lose it. */
function whenIdle(task) {
  return navigator.locks.request('ie-companion-drain', {}, async () => {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_BEFORE_RELOAD_MS));
    await task();
  });
}

/** Says false if there is no RemNote frame to move. */
function switchKb(id) {
  if (!remnotePort) return false;
  switchingTo = id;
  showStatus('Switching knowledge base…');
  whenIdle(() => remnotePort?.postMessage({ kind: 'setKb', id }));
  return true;
}

const withoutFragment = (url) => url?.split('#')[0];

/** Shows a page's document, creating it if needed. Only for what the user asked for. */
async function showPage(tab) {
  focusedUrl = tab.url;
  showPageOffer();
  try {
    await callRemNote('focusDoc', { url: tab.url, title: tab.title || tab.url }, FOCUS_TIMEOUT_MS);
    note(`Showing the document of ${tab.url}`);
  } catch (err) {
    // It is stuck, so it starts again on that page.
    note(`${err.message}. Restarting.`);
    if (pluginPort && !switchingTo) whenIdle(() => reloadFrame(tab));
  }
}

/** The tab went on to a page the panel does not show: nothing happens until asked. */
async function showPageOffer() {
  const tab = await ownTab();
  const differs =
    isOrdinaryPage(tab) && tab.status !== 'loading' && withoutFragment(tab.url) !== withoutFragment(focusedUrl);
  const box = document.getElementById('pageOffer');
  box.hidden = !(differs && pluginPort && !switchingTo);
  document.getElementById('showPage').onclick = () => showPage(tab);
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

/** Records the KB the plugin is in. Says false if the frame must first move to another. */
async function settleKb({ knowledgeBaseId: id, knowledgeBase: name }) {
  panelKbId = id ?? null;
  // A plugin from before knowledge bases were told apart.
  if (!id) return true;
  const stored = await chrome.storage.local.get(['kbKnown', 'kbPick']);
  const kbKnown = { ...stored.kbKnown, [id]: name };
  const tried = switchingTo;
  switchingTo = null;

  if (stored.kbPick && stored.kbPick !== id && stored.kbPick !== tried) {
    await chrome.storage.local.set({ kbKnown });
    if (switchKb(stored.kbPick)) return false;
  }
  await chrome.storage.local.set({ kb: { id, name }, kbKnown });
  await chrome.storage.local.remove('kbPick');
  if (tried && tried !== id) showStatus(`Could not switch to “${kbKnown[tried] ?? tried}”. Connected to “${name}”.`);
  const everything = await chrome.storage.local.get(null);
  // Copies from before the first connection, or from before copies had a KB.
  const stale = Object.keys(everything).filter((key) => /^page:(none:|https?:)/.test(key));
  if (stale.length) await chrome.storage.local.remove(stale);
  return true;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'remnote-frame') {
    if (new URL(port.sender?.url ?? 'about:blank').origin !== REMNOTE) return port.disconnect();
    remnotePort = port;
    port.onMessage.addListener((message) => {
      if (message.kind === 'kbSet') {
        reloadFrame();
      } else if (message.kind === 'kbChanged' && !switchingTo) {
        note('The knowledge base was changed in another tab.');
        whenIdle(() => reloadFrame());
      }
    });
    port.onDisconnect.addListener(() => {
      if (remnotePort === port) remnotePort = null;
    });
    return;
  }

  // Chrome fills in sender.url, so another plugin cannot pose as this one.
  if (port.name !== 'plugin-frame' || !isOurPluginFrame(port.sender?.url)) return port.disconnect();

  port.onMessage.addListener(async (message) => {
    if (message.kind === 'here') {
      pluginPort = port;
      pluginInfo = message.info;
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      const pluginId = new URL(port.sender.url).searchParams.get('pluginId');
      showStatus(`Connected in ${seconds} s to “${message.info.knowledgeBase}”${message.info.lightMode ? ', light mode' : ''}`);
      note(`plugin ${pluginId} ${JSON.stringify(message.info)}`);
      if (!(await settleKb(message.info))) return;
      showWaiting();
      showPageOffer();
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
      panelKbId = null;
      showPageOffer();
      if (!switchingTo) showStatus('The plugin disconnected. Waiting for it to return…');
      // Their answers will never come. Not a refusal, so a write stays queued.
      for (const answer of [...waiting.values()]) answer({ ok: false, lost: true, error: 'The plugin disconnected.' });
      waiting.clear();
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
      else reject(Object.assign(new Error(message.error), { fromPlugin: !message.lost }));
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
  // An action on the page this panel belongs to brings its document up.
  if (NEEDS_DOCUMENT.has(op)) {
    const tab = await ownTab();
    if (tab && withoutFragment(tab.url) === withoutFragment(data.url) && withoutFragment(tab.url) !== withoutFragment(focusedUrl)) {
      showPage(tab);
    }
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

/** No stamp: queued before the first connection, so whichever KB comes first takes it. */
const isForThisKb = (data) => !panelKbId || !data.kbId || data.kbId === panelKbId;

/** With a panel in two windows, the lock leaves one of them to carry out the queue. */
function drain() {
  if (!pluginPort) return;
  navigator.locks.request('ie-companion-drain', { ifAvailable: true }, async (lock) => {
    if (!lock) return;
    while (pluginPort && !switchingTo) {
      const stored = await chrome.storage.local.get(null);
      const [next] = Object.keys(stored)
        .filter((key) => key.startsWith('op:'))
        .map((key) => ({ key, ...stored[key] }))
        .filter((op) => isForThisKb(op.data))
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

/** What is queued for another knowledge base stays there, and the panel says so. */
async function showWaiting() {
  const stored = await chrome.storage.local.get(null);
  const forOthers = Object.keys(stored)
    .filter((key) => key.startsWith('op:') && !isForThisKb(stored[key].data))
    .map((key) => stored[key])
    .sort((a, b) => a.at - b.at);
  const box = document.getElementById('waiting');
  box.hidden = !forOthers.length || !panelKbId;
  if (box.hidden) return;
  const { kbId } = forOthers[0].data;
  const name = stored.kbKnown?.[kbId] ?? kbId;
  const count = forOthers.filter((op) => op.data.kbId === kbId).length;
  document.getElementById('waitingText').textContent = `${count} waiting for “${name}”`;
  const button = document.getElementById('switchKb');
  button.textContent = `Switch to ${name}`;
  button.onclick = () => chrome.storage.local.set({ kb: { id: kbId, name }, kbPick: kbId });
}

chrome.storage.onChanged.addListener((changes) => {
  if (Object.keys(changes).some((key) => key.startsWith('op:') && changes[key].newValue)) drain();
  if (Object.keys(changes).some((key) => key.startsWith('op:') || key === 'kbKnown')) showWaiting();
  const pick = changes.kbPick?.newValue;
  if (!pick || !pluginPort || switchingTo) return;
  if (pick === panelKbId) chrome.storage.local.remove('kbPick');
  else switchKb(pick);
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

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (tabId !== ownTabId || !(change.status === 'complete' || change.url)) return;
  showPageOffer();
  if (frameStarted) return;
  // Opened on a page RemNote cannot show. It starts once this tab has a web page,
  // without that page's document.
  ownTab().then((tab) => {
    if (frameStarted || !isOrdinaryPage(tab)) return;
    frameStarted = true;
    showStatus('Starting RemNote…');
    frame.src = clipperAddress();
  });
});
startFrame();
