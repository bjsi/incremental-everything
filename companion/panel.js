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
    refreshDocument();
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
      } else if (message.kind === 'activity') {
        markPanelActive();
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
      refreshDocument();
    } else if (message.kind === 'documentChanged') {
      // Asked again, for the reviews since the clock began.
      if (message.status?.docId === shownDocId) refreshStatus();
    } else if (message.kind === 'pageChanged' && typeof message.url === 'string') {
      // An extract's Rem was deleted: the page drops its highlight now, not on reload.
      notifyTabs({ ie: 'pageChanged' }, message.url);
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
      showDocument(null);
      closeClockBar();
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
  } else if (message.ie === 'clock' && sender.tab) {
    liveClocks.set(sender.tab.id, { message, at: Date.now() });
  } else if (message.ie === 'log') {
    note(`[${message.host}] ${message.text}`);
  } else if (message.ie === 'frameAlive') {
    note(`RemNote frame loaded, signed in: ${message.signedIn}`);
    if (!message.signedIn) showStatus('Sign in to RemNote in this browser, then reopen the panel.');
  }
});

// ---- The page's document: Incremental or not ----

const docStatus = document.getElementById('docStatus');
const makeButton = document.getElementById('makeIncremental');
const makeField = document.getElementById('makeField');
const makePriority = document.getElementById('makePriority');
/** The document the header is about: the one RemNote shows for this panel's page. */
let shownDocId = null;
let documentAsked = 0;

function showDocument(status) {
  const changedDoc = (status?.docId ?? null) !== shownDocId;
  shownDocId = status?.docId ?? null;
  shownStatus = status ?? null;
  docStatus.hidden = !status;
  if (changedDoc) loadClock();
  if (status) {
    document.getElementById('docIncremental').hidden = !status.incremental;
    document.getElementById('docDismissed').hidden = !status.dismissed;
    document.getElementById('docPriority').textContent = status.priority === undefined ? '' : `P${status.priority}`;
    makeButton.textContent = status.dismissed ? 'Make Incremental again' : 'Make Incremental';
    makeButton.hidden = status.incremental || !makeField.hidden;
    if (status.incremental) closeMakeField();
    applyReviews(status);
    setReadingTarget(status);
  }
  renderClock();
}

/** Asks the plugin again about the document shown, with the reviews since the clock's time began. */
async function refreshStatus() {
  if (!pluginPort || !shownDocId) return;
  const docId = shownDocId;
  try {
    const status = await callPlugin('documentStatus', { docId, since: clockSince() });
    if (docId === shownDocId) showDocument(status);
  } catch (err) {
    note(`Document status: ${err.message}`);
  }
}

/** Asks for the document of the page RemNote shows, which opening the panel already created. */
async function refreshDocument() {
  const asked = ++documentAsked;
  if (!pluginPort || !focusedUrl || switchingTo) return showDocument(null);
  try {
    const tab = await ownTab();
    const title = tab && withoutFragment(tab.url) === withoutFragment(focusedUrl) ? tab.title : undefined;
    const doc = await callRemNote('getOrCreatePageDocument', { url: focusedUrl, title: title || focusedUrl });
    if (!doc?._id) throw new Error('RemNote returned no document for this page');
    if (doc._id !== shownDocId) await loadClock(doc._id);
    const status = await callPlugin('documentStatus', { docId: doc._id, since: clockSince(doc._id) });
    if (asked === documentAsked) showDocument(status);
  } catch (err) {
    note(`Document status: ${err.message}`);
    if (asked === documentAsked) showDocument(null);
  }
}

function closeMakeField() {
  makeField.hidden = true;
  makePriority.value = '';
  makePriority.disabled = false;
  makePriority.classList.remove('invalid');
}

makeField.hidden = true;
makeButton.addEventListener('click', () => {
  makeButton.hidden = true;
  makeField.hidden = false;
  makePriority.focus();
});

makePriority.addEventListener('input', () => makePriority.classList.remove('invalid'));
makePriority.addEventListener('keydown', async (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeMakeField();
    makeButton.hidden = false;
    return;
  }
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault();
    const current = Number(makePriority.value);
    const delta = event.key === 'ArrowUp' ? 1 : -1;
    const base = makePriority.value.trim() && Number.isFinite(current) ? current : delta > 0 ? -1 : 101;
    makePriority.value = String(Math.max(0, Math.min(100, base + delta)));
    return;
  }
  if (event.key !== 'Enter' || makePriority.disabled) return;
  event.preventDefault();
  // Empty: the priority it would inherit, or the default.
  const text = makePriority.value.trim();
  if (text && (!/^\d+$/.test(text) || Number(text) > 100)) return makePriority.classList.add('invalid');
  if (!shownDocId || !pluginPort) return;
  makePriority.disabled = true;
  try {
    const status = await callPlugin('makeDocumentIncremental', {
      docId: shownDocId,
      ...(text ? { priority: Number(text) } : {}),
    });
    note(`Made the document Incremental: ${JSON.stringify(status)}`);
    closeMakeField();
    showDocument(status);
  } catch (err) {
    makePriority.disabled = false;
    showStatus(`Could not make the document Incremental: ${err.message}`);
  }
});

// ---- The reading clock ----
//
// The page counts (content.js); this shows the time, records it, and keeps the
// cover: what of that time is no longer unrecorded. See clock.js.

const C = globalThis.IEClock;
const clockButton = document.getElementById('clock');
const clockBar = document.getElementById('clockBar');
let shownStatus = null;
/** Per tab, the last report of a page counting for some document. */
const liveClocks = new Map();
/** The shown document's stored clock and cover. */
let clockDoc = null;
let clockStored = null;
let clockCover = null;
/** Shift+Enter opened the popup: a review recorded after this clears the time it was opened for. */
let awaitingPopup = null;
let barMode = null;

const clockKeys = (docId = shownDocId) =>
  panelKbId && docId ? { clock: C.clockKey(panelKbId, docId), cover: C.coverKey(panelKbId, docId) } : null;

async function loadClock(docId = shownDocId) {
  const keys = clockKeys(docId);
  clockDoc = docId;
  if (!keys) {
    clockStored = clockCover = null;
    return;
  }
  const stored = await chrome.storage.local.get([keys.clock, keys.cover]);
  if (clockDoc !== docId) return;
  clockStored = stored[keys.clock] ?? null;
  clockCover = stored[keys.cover] ?? null;
}

async function writeCover(cover) {
  const keys = clockKeys();
  if (!keys) return;
  clockCover = cover;
  await chrome.storage.local.set({ [keys.cover]: cover });
  renderClock();
}

/** The pages tell which documents to count for: the Incremental ones the panel has shown. */
async function setReadingTarget(status) {
  if (!panelKbId || !focusedUrl) return;
  const key = C.targetKey(panelKbId, focusedUrl);
  const { readingTargets = {} } = await chrome.storage.local.get('readingTargets');
  const wanted = status.incremental ? status.docId : undefined;
  if (readingTargets[key] === wanted) return;
  if (wanted) readingTargets[key] = wanted;
  else delete readingTargets[key];
  await chrome.storage.local.set({ readingTargets });
}

/** The clock as it stands: from a page counting it now, or from what is stored. */
function clockNow(docId = shownDocId) {
  const now = Date.now();
  const live = [...liveClocks.values()].filter(
    ({ message, at }) => now - at < 3000 && message.docId === docId && message.kbId === panelKbId
  );
  const report = live.find(({ message }) => message.running) ?? live[0];
  if (report) {
    const { message } = report;
    return {
      unrecordedMs: message.unrecordedMs,
      lastReadAt: message.lastReadAt,
      firstReadAt: message.firstReadAt,
      running: message.running,
      reason: message.reason,
    };
  }
  const segments = docId === clockDoc ? C.uncovered(clockStored?.segments, clockCover) : [];
  return {
    unrecordedMs: C.totalMs(segments),
    lastReadAt: C.lastEnd(segments),
    firstReadAt: C.firstStart(segments),
    running: false,
    reason: 'closed',
  };
}

const clockSince = (docId = shownDocId) => clockNow(docId).firstReadAt;

/** Reviews recorded in RemNote while the page was read: their time is not counted twice. */
function applyReviews(status) {
  if (!status.incremental || !status.reviewsSince?.length) return;
  let cover = C.withWindows(clockCover, C.windowsOf(status.reviewsSince)) ?? clockCover;
  if (awaitingPopup?.docId === status.docId && status.reviewsSince.some((review) => review.date >= awaitingPopup.since)) {
    cover = { ...cover, clearedUntil: Math.max(cover?.clearedUntil ?? 0, awaitingPopup.endedAt) };
    awaitingPopup = null;
  }
  if (cover !== clockCover) writeCover(cover);
}

const PAUSED = {
  background: 'Paused: the page is in a background tab',
  unfocused: 'Paused: Chrome is not the window in use',
  idle: 'Paused: no scrolling, typing or clicking for 3 minutes',
  closed: 'Paused: the page is not open',
};

function renderClock() {
  const shown = !!shownStatus?.incremental;
  clockButton.hidden = !shown;
  if (!shown) {
    if (barMode !== 'notice') closeClockBar();
    return;
  }
  const now = clockNow();
  const totalMs = (shownStatus.totalSeconds ?? 0) * 1000 + now.unrecordedMs;
  document.getElementById('clockTime').textContent = C.format(now.unrecordedMs);
  document.getElementById('clockTotal').textContent = totalMs > now.unrecordedMs ? ` · Σ ${C.formatShort(totalMs)}` : '';
  clockButton.classList.toggle('paused', !now.running);
  clockButton.title = [
    now.running ? 'Reading time not yet recorded' : PAUSED[now.reason] ?? 'Paused',
    `Total, with the reviews in its history: ${C.formatShort(totalMs)}`,
    shownStatus.editorTimerRunning
      ? 'The Editor Review Timer is running on this page: End Review there records the review'
      : 'Click to record it as a review',
  ].join('\n');

  // A past session nobody recorded is offered once, until more reading is added.
  const isPast =
    !now.running &&
    now.unrecordedMs >= C.PAST_MIN_MS &&
    now.lastReadAt &&
    Date.now() - now.lastReadAt > C.PAST_AFTER_MS &&
    clockCover?.keptAt !== now.lastReadAt;
  if (isPast && !barMode && !shownStatus.editorTimerRunning) showPastSession(now);
}

// The bar under the header: keys on the bar itself, arrows move the selection.
let barButtons = [];
let barSelected = 0;
let barTimer;

function setClockBar(mode, text, buttons = [], hint = '') {
  barMode = mode;
  clearTimeout(barTimer);
  clockBar.hidden = false;
  document.getElementById('clockText').textContent = text;
  document.getElementById('clockHint').textContent = hint;
  barButtons = buttons.map(({ label, run }) => {
    const button = document.createElement('button');
    button.textContent = label;
    button.tabIndex = -1;
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => run());
    return button;
  });
  document.getElementById('clockButtons').replaceChildren(...barButtons);
  barSelected = 0;
  paintBarSelection();
  if (buttons.length) clockBar.focus();
}

function paintBarSelection() {
  barButtons.forEach((button, index) => button.classList.toggle('selected', index === barSelected));
}

function closeClockBar() {
  barMode = null;
  clearTimeout(barTimer);
  clockBar.hidden = true;
  barButtons = [];
}

function flashClockBar(text, ms = 6000) {
  setClockBar('notice', text);
  barTimer = setTimeout(closeClockBar, ms);
}

clockBar.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    if (barMode === 'past') writeCover({ ...clockCover, keptAt: clockNow().lastReadAt });
    closeClockBar();
  } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
    event.preventDefault();
    if (!barButtons.length) return;
    barSelected = (barSelected + (event.key === 'ArrowRight' ? 1 : barButtons.length - 1)) % barButtons.length;
    paintBarSelection();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    if (event.shiftKey && barMode === 'confirm') return recordClock(true);
    barButtons[barSelected]?.click();
  }
});

function showPastSession(now) {
  const when = new Date(now.lastReadAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  setClockBar('past', `Unrecorded session: ${C.formatShort(now.unrecordedMs)}, last read ${when}.`, [
    { label: 'Record it', run: () => recordClock(false) },
    {
      label: 'Keep counting',
      run: () => {
        writeCover({ ...clockCover, keptAt: now.lastReadAt });
        closeClockBar();
      },
    },
  ]);
}

function openRecordConfirm() {
  if (!shownStatus?.incremental) return;
  if (shownStatus.editorTimerRunning) {
    return flashClockBar('The Editor Review Timer is running on this page. End Review there records the review.');
  }
  const now = clockNow();
  if (now.unrecordedMs < 1000) return flashClockBar('No reading time to record yet.', 3000);
  const until = new Date(now.lastReadAt).toLocaleTimeString(undefined, { timeStyle: 'short' });
  setClockBar(
    'confirm',
    `Record ${C.formatShort(now.unrecordedMs)} of reading, until ${until}, as a review?`,
    [
      { label: 'Record', run: () => recordClock(false) },
      { label: 'Choose interval…', run: () => recordClock(true) },
      { label: 'Discard', run: () => confirmDiscard() },
    ],
    'Enter · Shift+Enter: choose · Esc'
  );
}

function confirmDiscard() {
  const now = clockNow();
  setClockBar('confirm', `Discard ${C.formatShort(now.unrecordedMs)}? It won't be recorded anywhere.`, [
    { label: 'Cancel', run: () => openRecordConfirm() },
    {
      label: 'Discard',
      run: async () => {
        await writeCover({ ...clockCover, clearedUntil: Math.max(clockCover?.clearedUntil ?? 0, now.lastReadAt) });
        flashClockBar('Discarded.', 3000);
      },
    },
  ]);
}

/** Enter: the scheduler picks the date. Shift+Enter: the Execute Repetition popup, in the panel. */
async function recordClock(withPopup) {
  const docId = shownDocId;
  const now = clockNow();
  if (!docId || !pluginPort || now.unrecordedMs < 1000) return closeClockBar();
  const reviewTimeSeconds = Math.round(now.unrecordedMs / 1000);
  const endedAt = now.lastReadAt;
  setClockBar('busy', withPopup ? 'Opening the review popup…' : 'Recording…');
  try {
    if (withPopup) {
      await callPlugin('openReviewPopup', { docId, minutes: Math.max(1, Math.round(reviewTimeSeconds / 60)) });
      awaitingPopup = { docId, since: Date.now(), endedAt };
      closeClockBar();
      window.focus();
      frame.focus();
      return;
    }
    const result = await callPlugin('recordPageReview', { docId, reviewTimeSeconds, endedAt, url: focusedUrl });
    note(`Recorded the page's review: ${JSON.stringify(result)}`);
    await writeCover({ ...clockCover, clearedUntil: Math.max(clockCover?.clearedUntil ?? 0, endedAt) });
    if (docId === shownDocId) showDocument(result);
    const next = result.nextRepDate
      ? ` Next review: ${new Date(result.nextRepDate).toLocaleDateString(undefined, { dateStyle: 'medium' })}.`
      : '';
    flashClockBar(`✓ Recorded ${C.formatShort(reviewTimeSeconds * 1000)} of reading.${next}`);
  } catch (err) {
    setClockBar('error', `Could not record it: ${err.message}`, [{ label: 'OK', run: closeClockBar }]);
  }
}

clockButton.addEventListener('click', () => (barMode === 'confirm' ? closeClockBar() : openRecordConfirm()));

chrome.storage.onChanged.addListener((changes) => {
  const keys = clockKeys();
  if (!keys) return;
  if (changes[keys.clock]) clockStored = changes[keys.clock].newValue ?? null;
  if (changes[keys.cover]) clockCover = changes[keys.cover].newValue ?? null;
});

// The pages count time spent in the panel too: its focus, and what is done in it.
let panelFocusReported = null;
let panelActiveReported = 0;
function markPanelActive() {
  if (Date.now() - panelActiveReported < 10000) return;
  panelActiveReported = Date.now();
  chrome.storage.local.set({ panelActiveAt: panelActiveReported }).catch(() => {});
}
for (const type of ['mousedown', 'keydown', 'mousemove', 'wheel']) {
  document.addEventListener(type, markPanelActive, { capture: true, passive: true });
}
addEventListener('pagehide', () => chrome.storage.local.set({ panelFocus: false }).catch(() => {}));

let statusPolledAt = 0;
setInterval(() => {
  const focused = document.hasFocus();
  if (focused !== panelFocusReported) {
    panelFocusReported = focused;
    chrome.storage.local.set({ panelFocus: focused }).catch(() => {});
  }
  renderClock();
  // Reviews recorded on another device reach this one by sync, with no event here.
  if (shownStatus?.incremental && clockNow().unrecordedMs > 0 && Date.now() - statusPolledAt > 60000) {
    statusPolledAt = Date.now();
    refreshStatus();
  }
}, 1000);

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
