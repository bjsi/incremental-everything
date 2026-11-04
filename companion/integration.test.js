// Runs content.js and panel.js under jsdom against a stand-in for Chrome's APIs,
// from a key press on a page to the plugin's answer. Run from the repo root:
// node --test companion/integration.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const TEST_KB = { id: 'kbTest', name: 'Test' };
const MAIN_KB = { id: 'kbMain', name: 'Main' };

const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

/** One browser: shared storage, a message bus, and the tabs and panel attached to it. */
function browser() {
  const stored = {};
  const storageListeners = [];
  const messageListeners = new Set();
  const connectListeners = new Set();
  const tabs = new Map();
  const opened = [];
  const tabListeners = [];

  const storage = {
    local: {
      get: async (key) => {
        if (key === null) return { ...stored };
        const keys = Array.isArray(key) ? key : [key];
        return Object.fromEntries(keys.filter((k) => k in stored).map((k) => [k, stored[k]]));
      },
      set: async (values) => {
        Object.assign(stored, JSON.parse(JSON.stringify(values)));
        const changes = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { newValue: v }]));
        storageListeners.forEach((listener) => listener(changes));
      },
      remove: async (keys) => {
        for (const key of [keys].flat()) {
          delete stored[key];
          storageListeners.forEach((listener) => listener({ [key]: {} }));
        }
      },
    },
    onChanged: { addListener: (listener) => storageListeners.push(listener) },
  };

  const chromeFor = (sender) => ({
    storage,
    runtime: {
      id: 'abc',
      sendMessage: async (message) => {
        if (message.ie === 'openPanel') opened.push(sender);
        // As in Chrome, a message does not come back to the context that sent it.
        for (const listener of messageListeners) {
          if (!sender.listeners?.includes(listener)) listener(message, sender, () => {});
        }
      },
      onMessage: {
        addListener: (listener) => {
          messageListeners.add(listener);
          sender.listeners?.push(listener);
        },
      },
      onConnect: { addListener: (listener) => connectListeners.add(listener) },
      connect: ({ name }) => {
        const toFrame = [];
        const toPanel = [];
        const frameEnd = {
          postMessage: (message) => toPanel.forEach((listener) => listener(message)),
          onMessage: { addListener: (listener) => toFrame.push(listener) },
        };
        const panelEnd = {
          name,
          sender: { url: sender.url },
          disconnect: () => {
            panelEnd.disconnected = true;
          },
          postMessage: (message) => toFrame.forEach((listener) => listener(message)),
          onMessage: { addListener: (listener) => toPanel.push(listener) },
          onDisconnect: { addListener: () => {} },
        };
        connectListeners.forEach((listener) => listener(panelEnd));
        return frameEnd;
      },
    },
    tabs: {
      get: async (id) => {
        const tab = tabs.get(id);
        if (!tab) throw new Error('No tab');
        return { id, url: tab.url, title: tab.title, status: tab.status };
      },
      query: async () => [...tabs.values()].map(({ id, url, title, status }) => ({ id, url, title, status })),
      sendMessage: async (id, message) => tabs.get(id)?.listeners.forEach((listener) => listener(message, {}, () => {})),
      onActivated: { addListener: () => {} },
      onUpdated: { addListener: (listener) => tabListeners.push((id) => listener(id, { status: 'complete' })) },
    },
  });

  return { stored, tabs, opened, chromeFor, tabChanged: (id = 1) => tabListeners.forEach((listener) => listener(id)) };
}

function run(dom, chromeApi, scripts, edit = (source) => source) {
  const { window } = dom;
  window.chrome = chromeApi;
  for (const script of scripts) window.eval(edit(read(script)));
}

/** jsdom has no parent frame, and leaves event.source empty on window.postMessage. */
function makeFrame(window) {
  window.postMessage = (data) => {
    setTimeout(() => window.dispatchEvent(new window.MessageEvent('message', { data, source: window })));
  };
}

function openPage(b, url, html, id = 1) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.CSS = { highlights: new Map() };
  dom.window.Highlight = class {
    constructor(...ranges) {
      this.ranges = ranges;
    }
  };
  const tab = { id, url, title: 'A page', listeners: [], dom };
  b.tabs.set(id, tab);
  // Keeps the real closed shadow root, which behaves differently from an open one
  // for event paths, and only remembers it so these tests can reach into the bar.
  const attachShadow = dom.window.Element.prototype.attachShadow;
  dom.window.Element.prototype.attachShadow = function (options) {
    dom.shadowForTests = attachShadow.call(this, options);
    return dom.shadowForTests;
  };
  run(dom, b.chromeFor({ tab: { id, windowId: 7 }, listeners: tab.listeners }), ['anchors.js', 'content.js']);
  return dom;
}

const shadow = (dom) => dom.shadowForTests;
const priorityInput = (dom) => shadow(dom).getElementById('priorityInput');
const promptIsOpen = (dom) => !shadow(dom).getElementById('prompt').hidden;

function typeInField(dom, text, key = 'Enter', shiftKey = false) {
  priorityInput(dom).value = text;
  priorityInput(dom).dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, composed: true, cancelable: true })
  );
}

const queued = (b) => Object.values(b.stored).filter((value) => value?.op === 'addExtract');

function selectParagraph(dom, selector) {
  const { document, getSelection } = dom.window;
  const range = document.createRange();
  range.selectNodeContents(document.querySelector(selector));
  getSelection().removeAllRanges();
  getSelection().addRange(range);
  document.dispatchEvent(new dom.window.Event('selectionchange'));
}

const pressOptX = (dom, shiftKey = false) =>
  dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'KeyX', altKey: true, shiftKey, cancelable: true }));

function openPanel(b, { unresponsive = [], edit } = {}) {
  const html = read('panel.html').replace('<script src="panel.js"></script>', '');
  const dom = new JSDOM(html, { url: 'chrome-extension://abc/panel.html', runScripts: 'outside-only' });
  const { window } = dom;
  window.navigator.locks = { request: (_name, _options, task) => task({}) };
  const calls = [];
  const sent = [];
  Object.defineProperty(window.document.getElementById('frame'), 'contentWindow', {
    value: {
      focus: () => {},
      postMessage: (message) => {
        calls.push(message.function);
        sent.push(message);
        if (unresponsive.includes(message.function)) return;
        window.dispatchEvent(
          new window.MessageEvent('message', { data: { messageId: message.messageId, return: true, value: { _id: 'doc1' } } })
        );
      },
    },
  });
  run(dom, b.chromeFor({ url: 'chrome-extension://abc/panel.html', listeners: [] }), ['panel.js'], edit);
  return { dom, calls, sent };
}

/** Plays the plugin's index frame: the real content script, and a fake plugin answering in the frame. */
function startPlugin(b, answer, pluginId = 'incremental-everything-plus', kb = TEST_KB) {
  const url = `https://www.remnoteplugins.com/${pluginId}/1.0.0/index.html?widgetName=index&pluginId=${pluginId}`;
  const dom = new JSDOM('<body></body>', { url, runScripts: 'outside-only' });
  const { window } = dom;
  Object.defineProperty(window.location, 'ancestorOrigins', { value: ['https://www.remnote.com', 'chrome-extension://abc'], configurable: true });
  makeFrame(window);
  const seen = [];
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== window || data?.ieCompanion !== 'toPlugin') return;
    if (data.kind === 'hello') {
      window.postMessage({ ieCompanion: 'toExtension', kind: 'here', info: { knowledgeBase: kb.name, knowledgeBaseId: kb.id, lightMode: true } }, '*');
    } else if (data.kind === 'op') {
      seen.push(data);
      window.postMessage({ ieCompanion: 'toExtension', kind: 'opDone', id: data.id, ...answer(data) }, '*');
    }
  });
  const boot = (senderUrl = url) =>
    run(dom, b.chromeFor({ url: senderUrl, listeners: [] }), ['anchors.js', 'content.js'], (source) =>
      source.replace('window !== window.top &&', 'true &&')
    );
  return { dom, seen, boot };
}

const PAGE = '<body><h1>Title</h1><h2 id="s">A section</h2><p id="p">Some <b>bold</b> text to extract from this page.</p><p id="q">Another paragraph.</p></body>';
const URL_A = 'https://example.org/article';
const anExtract = () => ({ ok: true, result: { remId: 'rem1', section: 'A section', isIncremental: true } });

describe('Add Extract', () => {
  it('Opt+X with the panel connected reaches the plugin, in its section, and comes back', async () => {
    const b = browser();
    const page = openPage(b, URL_A, PAGE);
    await settle();
    const panel = openPanel(b);
    const plugin = startPlugin(b, anExtract);
    plugin.boot();
    await settle(600);

    selectParagraph(page, '#p');
    pressOptX(page);
    await settle(100);

    assert.equal(plugin.seen.filter((op) => op.op === 'addExtract').length, 1);
    const { data } = plugin.seen.find((op) => op.op === 'addExtract');
    assert.equal(data.text, 'Some bold text to extract from this page.');
    assert.deepEqual(data.richText, ['Some ', { i: 'm', text: 'bold', b: true }, ' text to extract from this page.']);
    assert.deepEqual(data.chain.map((c) => c.text), ['A section']);
    assert.equal(data.docId, 'doc1');
    assert.equal(data.withPriority, undefined);
    assert.equal(data.priority, undefined);
    assert.ok(panel.calls.includes('getOrCreatePageDocument'));
    assert.deepEqual(Object.keys(b.stored).filter((k) => k.startsWith('op:')), []);
  });

  it('Waits in the browser while the panel is closed, then runs once it connects', async () => {
    const b = browser();
    const page = openPage(b, URL_A, PAGE);
    await settle();
    selectParagraph(page, '#p');
    pressOptX(page);
    await settle();
    assert.equal(Object.keys(b.stored).filter((k) => k.startsWith('op:')).length, 1);

    openPanel(b);
    const plugin = startPlugin(b, anExtract);
    plugin.boot();
    await settle(600);
    assert.equal(plugin.seen.filter((op) => op.op === 'addExtract').length, 1);
    assert.deepEqual(Object.keys(b.stored).filter((k) => k.startsWith('op:')), []);
  });

  it('The Set priority setting persists and asks on Opt+X too', async () => {
    const b = browser();
    b.stored.setPriority = true;
    const page = openPage(b, URL_A, PAGE);
    await settle();
    selectParagraph(page, '#p');
    pressOptX(page);
    await settle();
    assert.equal(promptIsOpen(page), true);
    assert.equal(shadow(page).getElementById('priority').checked, true);
  });

  it('Leaves Opt+X alone without a selection, or inside a text box', async () => {
    const b = browser();
    const page = openPage(b, URL_A, `${PAGE}<input id="i" value="typing">`);
    await settle();
    pressOptX(page);
    const { document } = page.window;
    const input = document.querySelector('#i');
    selectParagraph(page, '#p');
    input.dispatchEvent(new page.window.KeyboardEvent('keydown', { code: 'KeyX', altKey: true, bubbles: true }));
    await settle();
    assert.equal(Object.values(b.stored).filter((value) => value?.op === 'addExtract').length, 0);
  });

  it('A refusal from the plugin is final, and does not stay queued', async () => {
    const b = browser();
    const page = openPage(b, URL_A, PAGE);
    await settle();
    openPanel(b);
    const plugin = startPlugin(b, () => ({ ok: false, error: 'Refused' }));
    plugin.boot();
    await settle(600);
    selectParagraph(page, '#p');
    pressOptX(page);
    await settle(100);
    assert.deepEqual(Object.keys(b.stored).filter((k) => k.startsWith('op:')), []);
  });
});

describe('After the extension is updated, on a page opened before that', () => {
  const invalidate = (page) => {
    const fail = () => {
      throw new Error('Extension context invalidated.');
    };
    page.window.chrome.runtime = {};
    page.window.chrome.storage = { local: { get: fail, set: fail, remove: fail } };
  };
  const failures = (page) => {
    const seen = [];
    page.window.addEventListener('error', (event) => seen.push(event.message));
    process.on('unhandledRejection', (reason) => seen.push(String(reason)));
    return seen;
  };

  it('Refuses an extract and says to reload, without an error', async () => {
    const b = browser();
    const page = openPage(b, URL_A, PAGE);
    await settle();
    const seen = failures(page);
    invalidate(page);
    selectParagraph(page, '#p');
    pressOptX(page);
    shadow(page).getElementById('setRead').click();
    shadow(page).getElementById('import').click();
    await settle();
    assert.deepEqual(seen, []);
    assert.equal(queued(b).length, 0);
    assert.equal(page.window.getSelection().toString().includes('Some bold text'), true);
    const banner = shadow(page).getElementById('banner');
    assert.equal(banner.hidden, false);
    assert.match(banner.textContent, /Reload this page/);
  });

  it('A page changing its own text later causes no error', async () => {
    const b = browser();
    const page = openPage(b, URL_A, PAGE);
    await settle();
    selectParagraph(page, '#p');
    pressOptX(page);
    await settle();
    const seen = failures(page);
    invalidate(page);
    page.window.document.body.append('More text.');
    await settle(1700);
    assert.deepEqual(seen, []);
  });
});

describe('The browser copy', () => {
  const pageEntries = (b) => Object.keys(b.stored).filter((key) => key.startsWith('page:'));
  const emptyState = () => ({ ok: true, result: { extracts: [] } });

  async function connected(answer) {
    const b = browser();
    const page = openPage(b, URL_A, PAGE);
    await settle();
    openPanel(b);
    const plugin = startPlugin(b, answer);
    plugin.boot();
    await settle(700);
    return { b, page, plugin };
  }

  it('Keeps no entry for a page with nothing on it, so it is no browsing history', async () => {
    const { b, plugin } = await connected(emptyState);
    assert.ok(plugin.seen.some((op) => op.op === 'pageState'));
    assert.deepEqual(pageEntries(b), []);
  });

  it('Keeps an entry once the page has an extract', async () => {
    const { b, page } = await connected((op) => (op.op === 'pageState' ? emptyState() : anExtract()));
    selectParagraph(page, '#p');
    pressOptX(page);
    await settle(100);
    assert.equal(pageEntries(b).length, 1);
  });

  it('Removes the entry when the last extract is gone', async () => {
    const b = browser();
    b.stored[`page:${TEST_KB.id}:${URL_A}`] = { extracts: [{ remId: 'gone', anchor: { exact: 'Another paragraph.', prefix: '', suffix: '', position: 0 } }], readPoint: null };
    openPage(b, URL_A, PAGE);
    await settle();
    openPanel(b);
    startPlugin(b, emptyState).boot();
    await settle(700);
    assert.deepEqual(pageEntries(b), []);
  });
});

describe('Knowledge bases', () => {
  const opKeys = (b) => Object.keys(b.stored).filter((key) => key.startsWith('op:'));
  const marks = (page) => page.window.CSS.highlights.get('ie-extract')?.ranges.length ?? 0;
  const anchorIn = (exact) => ({ exact, prefix: '', suffix: '', position: 0 });
  const nothing = () => ({ ok: true, result: { extracts: [] } });
  const stateOf = (kb, extracts) => () => ({ ok: true, result: { kbId: kb.id, extracts } });

  /** Plays the RemNote app in the panel: the real content script, with its own localStorage. */
  function startRemNoteFrame(b) {
    const url = 'https://www.remnote.com/clipper?clipperId=ie-companion';
    const dom = new JSDOM('<body></body>', { url, runScripts: 'outside-only' });
    Object.defineProperty(dom.window.location, 'ancestorOrigins', { value: ['chrome-extension://abc'], configurable: true });
    run(dom, b.chromeFor({ url, listeners: [] }), ['anchors.js', 'content.js'], (source) =>
      source.replace('window !== window.top &&', 'true &&')
    );
    return dom;
  }

  it('Shows the KB on the bar once the panel has connected', async () => {
    const b = browser();
    openPanel(b);
    const page = openPage(b, URL_A, PAGE);
    await settle();
    assert.equal(shadow(page).getElementById('kbField').hidden, true);
    startPlugin(b, nothing, undefined, TEST_KB).boot();
    await settle(700);
    assert.equal(shadow(page).getElementById('kbField').hidden, false);
    assert.equal(shadow(page).getElementById('kbPick').value, TEST_KB.id);
  });

  it('Marks only what belongs to the KB, even with the panel closed', async () => {
    const b = browser();
    b.stored.kb = MAIN_KB;
    b.stored[`page:${TEST_KB.id}:${URL_A}`] = { extracts: [{ remId: 'r', anchor: anchorIn('Another paragraph.') }], readPoint: null };
    const page = openPage(b, URL_A, PAGE);
    await settle();
    assert.equal(marks(page), 0);

    await b.chromeFor({}).storage.local.set({ kb: TEST_KB });
    await settle();
    assert.equal(marks(page), 1);
  });

  it('Keeps the browser copy of the other KB when the panel connects to this one', async () => {
    const b = browser();
    b.stored.kb = TEST_KB;
    const copy = `page:${TEST_KB.id}:${URL_A}`;
    b.stored[copy] = { extracts: [{ remId: 'r', anchor: anchorIn('Another paragraph.') }], readPoint: null };
    const page = openPage(b, URL_A, PAGE);
    await settle();
    assert.equal(marks(page), 1);

    openPanel(b);
    startPlugin(b, stateOf(MAIN_KB, []), undefined, MAIN_KB).boot();
    await settle(700);
    assert.equal(b.stored.kb.id, MAIN_KB.id);
    assert.equal(marks(page), 0);
    assert.ok(b.stored[copy], 'the other KB keeps its copy');
  });

  it('Ignores an answer from a KB other than the one this page shows', async () => {
    const b = browser();
    b.stored.kb = TEST_KB;
    b.stored.kbPick = TEST_KB.id;
    openPanel(b);
    startRemNoteFrame(b);
    // The panel is in Main and on its way to Test when this page opens and asks.
    const plugin = startPlugin(b, stateOf(MAIN_KB, [{ remId: 'r', anchor: anchorIn('Another paragraph.') }]), undefined, MAIN_KB);
    plugin.boot();
    await settle(600);
    const page = openPage(b, URL_A, PAGE);
    await settle(300);
    assert.ok(plugin.seen.some((op) => op.op === 'pageState'));
    assert.equal(marks(page), 0);
    assert.equal(Object.keys(b.stored).filter((key) => key.startsWith('page:')).length, 0);
  });

  it('Goes on in the KB it is in when there is no frame to move', async () => {
    const b = browser();
    b.stored.kb = TEST_KB;
    b.stored.kbPick = TEST_KB.id;
    openPanel(b);
    startPlugin(b, nothing, undefined, MAIN_KB).boot();
    await settle(700);
    assert.equal(b.stored.kb.id, MAIN_KB.id);
    assert.equal(b.stored.kbPick, undefined);
  });

  it('Holds an extract for another KB, says so, and runs those of its own', async () => {
    const b = browser();
    b.stored.kb = TEST_KB;
    const page = openPage(b, URL_A, PAGE);
    await settle();
    selectParagraph(page, '#p');
    pressOptX(page);
    await settle();
    assert.equal(queued(b)[0].data.kbId, TEST_KB.id);

    const panel = openPanel(b);
    const plugin = startPlugin(b, (op) => (op.op === 'pageState' ? stateOf(MAIN_KB, [])() : anExtract()), undefined, MAIN_KB);
    plugin.boot();
    await settle(700);
    assert.equal(plugin.seen.filter((op) => op.op === 'addExtract').length, 0);
    assert.equal(opKeys(b).length, 1);
    const { document } = panel.dom.window;
    assert.equal(document.getElementById('waiting').hidden, false);
    assert.match(document.getElementById('waitingText').textContent, /^1 waiting for/);
  });

  it('An extract queued before any connection goes to the first KB', async () => {
    const b = browser();
    const page = openPage(b, URL_A, PAGE);
    await settle();
    selectParagraph(page, '#p');
    pressOptX(page);
    await settle();
    assert.equal(queued(b)[0].data.kbId, undefined);
    openPanel(b);
    const plugin = startPlugin(b, (op) => (op.op === 'pageState' ? nothing() : anExtract()));
    plugin.boot();
    await settle(700);
    assert.equal(plugin.seen.filter((op) => op.op === 'addExtract').length, 1);
  });

  it('Picking a KB moves the page at once, and the panel over to it', async () => {
    const b = browser();
    b.stored.kb = TEST_KB;
    b.stored.kbKnown = { [TEST_KB.id]: TEST_KB.name, [MAIN_KB.id]: MAIN_KB.name };
    const page = openPage(b, URL_A, PAGE);
    await settle();
    const panel = openPanel(b);
    const frame = startRemNoteFrame(b);
    startPlugin(b, stateOf(TEST_KB, []), undefined, TEST_KB).boot();
    await settle(700);
    const srcBefore = panel.dom.window.document.getElementById('frame').src;

    const picker = shadow(page).getElementById('kbPick');
    picker.value = MAIN_KB.id;
    picker.dispatchEvent(new page.window.Event('change'));
    await settle();
    assert.equal(b.stored.kb.id, MAIN_KB.id);
    assert.equal(b.stored.kbPick, MAIN_KB.id);

    await settle(1700);
    assert.equal(frame.window.localStorage.getItem('knowledgebaseId'), MAIN_KB.id);
    panel.dom.window.document.getElementById('frame').src = srcBefore;

    // RemNote has restarted in the picked KB.
    startPlugin(b, stateOf(MAIN_KB, []), undefined, MAIN_KB).boot();
    await settle(700);
    assert.equal(b.stored.kb.id, MAIN_KB.id);
    assert.equal(b.stored.kbPick, undefined);
  });

  it('A pick made with the panel closed is carried out when it connects', async () => {
    const b = browser();
    b.stored.kb = MAIN_KB;
    b.stored.kbPick = MAIN_KB.id;
    openPanel(b);
    const frame = startRemNoteFrame(b);
    const plugin = startPlugin(b, stateOf(TEST_KB, []), undefined, TEST_KB);
    plugin.boot();
    await settle(2400);
    assert.equal(frame.window.localStorage.getItem('knowledgebaseId'), MAIN_KB.id);
    assert.equal(b.stored.kb.id, MAIN_KB.id);
  });

  it('Gives up on a switch that did not work, and says where it is', async () => {
    const b = browser();
    b.stored.kb = MAIN_KB;
    b.stored.kbPick = MAIN_KB.id;
    const panel = openPanel(b);
    startRemNoteFrame(b);
    startPlugin(b, stateOf(TEST_KB, []), undefined, TEST_KB).boot();
    await settle(2400);

    // Restarted, but still in the same KB.
    startPlugin(b, stateOf(TEST_KB, []), undefined, TEST_KB).boot();
    await settle(700);
    assert.equal(b.stored.kb.id, TEST_KB.id);
    assert.equal(b.stored.kbPick, undefined);
    assert.match(panel.dom.window.document.getElementById('statusText').textContent, /Could not switch/);
  });

  it('Follows a change of KB made in a RemNote tab', async () => {
    const b = browser();
    b.tabs.set(9, { id: 9, url: URL_A, title: 'A page', listeners: [] });
    const panel = openPanel(b);
    const frame = startRemNoteFrame(b);
    await settle();
    const element = panel.dom.window.document.getElementById('frame');
    element.src = 'about:blank';
    frame.window.dispatchEvent(new frame.window.StorageEvent('storage', { key: 'knowledgebaseId', newValue: MAIN_KB.id }));
    await settle(1700);
    assert.match(element.src, /clipperId=ie-companion/);
    assert.equal(element.src.includes('clipperURL'), false, 'A change of KB asks for no document');
  });

  it('Clears browser copies from before they had a KB', async () => {
    const b = browser();
    b.stored[`page:${URL_A}`] = { extracts: [], readPoint: null };
    b.stored[`page:none:${URL_A}`] = { extracts: [], readPoint: null };
    b.stored[`page:${MAIN_KB.id}:${URL_A}`] = { extracts: [], readPoint: null };
    openPanel(b);
    startPlugin(b, nothing).boot();
    await settle(700);
    assert.deepEqual(Object.keys(b.stored).filter((key) => key.startsWith('page:')), [`page:${MAIN_KB.id}:${URL_A}`]);
  });
});

describe('Documents are made only when asked for', () => {
  const URL_B = 'https://other.example/page';
  const nothing = () => ({ ok: true, result: { extracts: [] } });
  const madeOrShown = (panel) =>
    panel.sent.filter((message) => ['focusDoc', 'getOrCreatePageDocument'].includes(message.function));
  const offer = (panel) => panel.dom.window.document.getElementById('pageOffer');
  const frameSrc = (panel) => panel.dom.window.document.getElementById('frame').src;

  async function connected(options) {
    const b = browser();
    const tab = { id: 1, url: URL_A, title: 'A page', listeners: [] };
    b.tabs.set(1, tab);
    const panel = openPanel(b, options);
    await settle();
    startPlugin(b, nothing).boot();
    await settle(700);
    return { b, tab, panel };
  }

  it('Opening the panel names that page, and nothing more', async () => {
    const { panel } = await connected();
    assert.ok(frameSrc(panel).includes(encodeURIComponent(URL_A)));
    assert.deepEqual(madeOrShown(panel), []);
    assert.equal(offer(panel).hidden, true);
  });

  it('Another tab being opened or shown does nothing', async () => {
    const { b, panel } = await connected();
    b.tabs.set(2, { id: 2, url: URL_B, title: 'Other', listeners: [] });
    b.tabChanged(2);
    await settle(1700);
    assert.deepEqual(madeOrShown(panel), []);
    assert.equal(offer(panel).hidden, true);
  });

  it('Going to another page in the tab only offers to show it', async () => {
    const { b, tab, panel } = await connected();
    Object.assign(tab, { url: URL_B, title: 'Other' });
    b.tabChanged();
    await settle(1700);
    assert.deepEqual(madeOrShown(panel), []);
    assert.equal(offer(panel).hidden, false);

    panel.dom.window.document.getElementById('showPage').click();
    await settle();
    assert.deepEqual(madeOrShown(panel).map((message) => message.data.url), [URL_B]);
    assert.equal(madeOrShown(panel)[0].data.title, 'Other');
    assert.equal(offer(panel).hidden, true);
  });

  it('Offers nothing for a section of the page, RemNote, or a page still loading', async () => {
    const { b, tab, panel } = await connected();
    for (const change of [
      { url: `${URL_A}#section` },
      { url: 'https://www.remnote.com/notes' },
      { url: 'chrome://settings' },
      { url: URL_B, status: 'loading' },
    ]) {
      Object.assign(tab, change);
      b.tabChanged();
      await settle();
      assert.equal(offer(panel).hidden, true, change.url);
    }
    tab.status = 'complete';
    b.tabChanged();
    await settle();
    assert.equal(offer(panel).hidden, false);
  });

  it('An extract on a newer page of the tab makes its document and brings it up', async () => {
    const b = browser();
    const page = openPage(b, URL_A, PAGE);
    await settle();
    const panel = openPanel(b);
    startPlugin(b, (op) => (op.op === 'pageState' ? nothing() : anExtract())).boot();
    await settle(700);
    const tab = b.tabs.get(1);
    tab.url = `${URL_A}/next`;
    page.window.document.title = 'Next';
    selectParagraph(page, '#p');
    pressOptX(page);
    await settle(150);
    assert.deepEqual(panel.sent.filter((m) => m.function === 'getOrCreatePageDocument').length, 1);
  });

  it('An extract from another tab makes its document, and the panel stays where it is', async () => {
    const b = browser();
    b.tabs.set(1, { id: 1, url: URL_A, title: 'A page', listeners: [] });
    const panel = openPanel(b);
    await settle();
    startPlugin(b, (op) => (op.op === 'pageState' ? nothing() : anExtract())).boot();
    await settle(700);
    const other = openPage(b, URL_B, PAGE, 2);
    await settle();
    selectParagraph(other, '#p');
    pressOptX(other);
    await settle(150);
    const urls = madeOrShown(panel).map((message) => `${message.function} ${message.data.url}`);
    assert.deepEqual(urls, [`getOrCreatePageDocument ${URL_B}`]);
  });

  it('Restarts RemNote on the page when asked to show it and there is no answer', async () => {
    const { b, tab, panel } = await connected({
      unresponsive: ['focusDoc'],
      edit: (source) => source.replace('FOCUS_TIMEOUT_MS = 20000', 'FOCUS_TIMEOUT_MS = 50'),
    });
    tab.url = URL_B;
    b.tabChanged();
    await settle();
    panel.dom.window.document.getElementById('showPage').click();
    await settle(1800);
    assert.ok(frameSrc(panel).includes(encodeURIComponent(URL_B)), frameSrc(panel));
  });

  it('A panel opened on a page RemNote cannot show starts without any document', async () => {
    const b = browser();
    const tab = { id: 1, url: 'chrome://newtab', title: 'New Tab', listeners: [] };
    b.tabs.set(1, tab);
    const panel = openPanel(b);
    await settle();
    assert.equal(frameSrc(panel), '');
    Object.assign(tab, { url: URL_B, title: 'Other' });
    b.tabChanged();
    await settle();
    assert.ok(frameSrc(panel).includes('clipperId=ie-companion'));
    assert.equal(frameSrc(panel).includes('clipperURL'), false);
  });
});

describe('The panel belongs to a tab', () => {
  function background() {
    const calls = [];
    const listeners = {};
    const session = {};
    const event = (name) => ({ addListener: (listener) => (listeners[name] = listener) });
    const quiet = (name) => (args) => {
      calls.push([name, args]);
      return Promise.resolve();
    };
    const window = {
      chrome: {
        sidePanel: { setPanelBehavior: quiet('behavior'), setOptions: quiet('setOptions'), open: quiet('open') },
        action: { onClicked: event('clicked'), setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {} },
        runtime: { onInstalled: event('installed'), onStartup: event('startup'), onMessage: event('message') },
        storage: {
          onChanged: event('changed'),
          local: { get: async () => ({}) },
          session: {
            get: async () => ({ ...session }),
            set: async (values) => Object.assign(session, values),
          },
        },
      },
    };
    new Function('chrome', read('background.js'))(window.chrome);
    return { calls, listeners };
  }
  const tabA = { id: 1, windowId: 7 };
  const tabB = { id: 2, windowId: 7 };

  it('Handles the click itself, so that no panel is opened for all tabs', () => {
    const { calls, listeners } = background();
    listeners.installed();
    assert.deepEqual(calls, [['behavior', { openPanelOnActionClick: false }]]);
    assert.equal(JSON.parse(read('manifest.json')).side_panel, undefined);
  });

  it("Makes the tab's own panel, then opens it, before anything is awaited", () => {
    const { calls, listeners } = background();
    listeners.clicked(tabA);
    assert.deepEqual(calls, [
      ['setOptions', { tabId: 1, path: 'panel.html', enabled: true }],
      ['open', { tabId: 1, windowId: 7 }],
    ]);
  });

  it('Opening on a second tab closes the panel of the first', async () => {
    const { calls, listeners } = background();
    listeners.clicked(tabA);
    await settle();
    calls.length = 0;
    listeners.clicked(tabB);
    await settle();
    assert.deepEqual(calls.at(-1), ['setOptions', { tabId: 1, enabled: false }]);
  });

  it('Clicking again on the same tab closes nothing', async () => {
    const { calls, listeners } = background();
    listeners.clicked(tabA);
    await settle();
    listeners.clicked(tabA);
    await settle();
    assert.equal(calls.some(([, args]) => args.enabled === false), false);
  });

  it('A request from a page opens the panel on that page', () => {
    const { calls, listeners } = background();
    listeners.message({ ie: 'openPanel' }, { tab: tabB });
    assert.deepEqual(calls.at(-1), ['open', { tabId: 2, windowId: 7 }]);
  });
});

describe('The priority field', () => {
  async function asked() {
    const b = browser();
    const page = openPage(b, URL_A, PAGE);
    await settle();
    selectParagraph(page, '#p');
    pressOptX(page, true);
    await settle();
    return { b, page };
  }

  it('Opt+Shift+X asks first and writes nothing yet, and needs no panel', async () => {
    const { b, page } = await asked();
    assert.equal(promptIsOpen(page), true);
    assert.equal(page.window.document.activeElement, page.window.document.querySelector('[data-ie-companion]'));
    assert.equal(shadow(page).activeElement, priorityInput(page));
    assert.equal(queued(b).length, 0);
    assert.equal(b.opened.length, 0);
  });

  it('Enter adds the extract with that priority, for this extract only', async () => {
    const { b, page } = await asked();
    typeInField(page, '35');
    await settle();
    assert.equal(promptIsOpen(page), false);
    const [op] = queued(b);
    assert.equal(op.data.priority, 35);
    assert.equal(op.data.withPriority, undefined);
    assert.equal(op.data.text, 'Some bold text to extract from this page.');
    assert.equal(b.opened.length, 0);

    selectParagraph(page, '#q');
    pressOptX(page);
    await settle();
    const second = queued(b).find((candidate) => candidate.data.text === 'Another paragraph.');
    assert.equal(second.data.priority, undefined);
  });

  it('Enter on an empty field keeps the inherited priority', async () => {
    const { b, page } = await asked();
    typeInField(page, '');
    await settle();
    assert.equal(queued(b)[0].data.priority, undefined);
  });

  it('Accepts 0 and 100, and stays open on anything else', async () => {
    for (const bad of ['101', 'abc', '-1', '1.5']) {
      const { b, page } = await asked();
      typeInField(page, bad);
      await settle();
      assert.equal(promptIsOpen(page), true, bad);
      assert.equal(queued(b).length, 0, bad);
    }
    for (const [good, value] of [['0', 0], ['100', 100]]) {
      const { b, page } = await asked();
      typeInField(page, good);
      await settle();
      assert.equal(queued(b)[0].data.priority, value);
    }
  });

  it('Esc adds nothing and gives the selection back', async () => {
    const { b, page } = await asked();
    typeInField(page, '20', 'Escape');
    await settle();
    assert.equal(promptIsOpen(page), false);
    assert.equal(queued(b).length, 0);
    assert.ok(page.window.getSelection().toString().includes('Some bold text'));
  });

  it('Shift+Enter opens the full popup in the panel instead', async () => {
    const { b, page } = await asked();
    typeInField(page, '', 'Enter', true);
    await settle();
    assert.equal(queued(b)[0].data.withPriority, true);
    assert.equal(b.opened.length, 1);
  });

  it('Arrow keys step the number, within 0 to 100', async () => {
    const { page } = await asked();
    typeInField(page, '100', 'ArrowUp');
    assert.equal(priorityInput(page).value, '100');
    typeInField(page, '10', 'ArrowDown');
    assert.equal(priorityInput(page).value, '9');
  });

  it("The page's own key handlers do not see what is typed in the field", async () => {
    const { page } = await asked();
    let seen = 0;
    page.window.document.addEventListener('keydown', () => seen++);
    typeInField(page, '3', '3');
    assert.equal(seen, 0);
  });

  it('A second Opt+Shift+X while it is open changes nothing', async () => {
    const { b, page } = await asked();
    pressOptX(page, true);
    await settle();
    assert.equal(promptIsOpen(page), true);
    assert.equal(queued(b).length, 0);
  });
});

describe('The plugin frame', () => {
  async function tryAs(boot) {
    const b = browser();
    const page = openPage(b, URL_A, PAGE);
    await settle();
    openPanel(b);
    const plugin = boot(b);
    await settle(600);
    selectParagraph(page, '#p');
    pressOptX(page);
    await settle(100);
    return { plugin, waiting: Object.keys(b.stored).filter((k) => k.startsWith('op:')).length };
  }

  it('Another plugin is not connected: its own frame does not even start the relay', async () => {
    const { plugin, waiting } = await tryAs((b) => {
      const other = startPlugin(b, anExtract, 'some-other-plugin');
      other.boot();
      return other;
    });
    assert.equal(plugin.seen.length, 0);
    assert.equal(waiting, 1);
  });

  it('A frame served from elsewhere is refused, whatever plugin id it claims', async () => {
    const { plugin, waiting } = await tryAs((b) => {
      const impostor = startPlugin(b, anExtract);
      impostor.boot('https://evil.example/?widgetName=index&pluginId=incremental-everything');
      return impostor;
    });
    assert.equal(plugin.seen.length, 0);
    assert.equal(waiting, 1);
  });
});
