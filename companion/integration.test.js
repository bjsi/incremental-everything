// Runs content.js and panel.js under jsdom against a stand-in for Chrome's APIs,
// from a key press on a page to the plugin's answer. Run from the repo root:
// node --test companion/integration.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

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

  const storage = {
    local: {
      get: async (key) => {
        if (key === null) return { ...stored };
        return typeof key === 'string' && key in stored ? { [key]: stored[key] } : {};
      },
      set: async (values) => {
        Object.assign(stored, JSON.parse(JSON.stringify(values)));
        const changes = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { newValue: v }]));
        storageListeners.forEach((listener) => listener(changes));
      },
      remove: async (key) => {
        delete stored[key];
        storageListeners.forEach((listener) => listener({ [key]: {} }));
      },
    },
    onChanged: { addListener: (listener) => storageListeners.push(listener) },
  };

  const chromeFor = (sender) => ({
    storage,
    runtime: {
      sendMessage: async (message) => {
        if (message.ie === 'openPanel') opened.push(sender);
        for (const listener of messageListeners) listener(message, sender);
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
      query: async () => [...tabs.values()].map(({ id, url, title }) => ({ id, url, title })),
      sendMessage: async (id, message) => tabs.get(id)?.listeners.forEach((listener) => listener(message, {}, () => {})),
      onActivated: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
    },
  });

  return { stored, tabs, opened, chromeFor };
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
  const tab = { id, url, title: 'A page', listeners: [], dom };
  b.tabs.set(id, tab);
  run(dom, b.chromeFor({ tab: { id, windowId: 7 }, listeners: tab.listeners }), ['anchors.js', 'content.js']);
  return dom;
}

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

function openPanel(b) {
  const html = read('panel.html').replace('<script src="panel.js"></script>', '');
  const dom = new JSDOM(html, { url: 'chrome-extension://abc/panel.html', runScripts: 'outside-only' });
  const { window } = dom;
  window.navigator.locks = { request: (_name, _options, task) => task({}) };
  const calls = [];
  Object.defineProperty(window.document.getElementById('frame'), 'contentWindow', {
    value: {
      focus: () => {},
      postMessage: (message) => {
        calls.push(message.function);
        window.dispatchEvent(
          new window.MessageEvent('message', { data: { messageId: message.messageId, return: true, value: { _id: 'doc1' } } })
        );
      },
    },
  });
  run(dom, b.chromeFor({ url: 'chrome-extension://abc/panel.html', listeners: [] }), ['panel.js']);
  return { dom, calls };
}

/** Plays the plugin's index frame: the real content script, and a fake plugin answering in the frame. */
function startPlugin(b, answer, pluginId = 'incremental-everything-plus') {
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
      window.postMessage({ ieCompanion: 'toExtension', kind: 'here', info: { knowledgeBase: 'Test', lightMode: true } }, '*');
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
    assert.equal(data.markdown, 'Some **bold** text to extract from this page.');
    assert.deepEqual(data.chain.map((c) => c.text), ['A section']);
    assert.equal(data.docId, 'doc1');
    assert.equal(data.withPriority, false);
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

  it('Opt+Shift+X asks for the priority popup and opens the panel', async () => {
    const b = browser();
    const page = openPage(b, URL_A, PAGE);
    await settle();
    selectParagraph(page, '#p');
    pressOptX(page, true);
    await settle();
    const [op] = Object.values(b.stored).filter((value) => value?.op === 'addExtract');
    assert.equal(op.data.withPriority, true);
    assert.equal(b.opened.length, 1);
  });

  it('The Set priority setting persists and applies to the shortcut', async () => {
    const b = browser();
    b.stored.setPriority = true;
    const page = openPage(b, URL_A, PAGE);
    await settle();
    selectParagraph(page, '#p');
    pressOptX(page);
    await settle();
    const [op] = Object.values(b.stored).filter((value) => value?.op === 'addExtract');
    assert.equal(op.data.withPriority, true);
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
