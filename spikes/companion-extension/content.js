// Runs in every frame and decides which of three roles it has here.

const PLUGIN_ID = 'incremental-everything-plus';
const send = (message) => chrome.runtime.sendMessage(message).catch(() => {});

function isPanelRemNoteFrame() {
  return (
    location.origin === 'https://www.remnote.com' &&
    window !== window.top &&
    new URLSearchParams(location.search).get('clipperId') === 'ie-spike'
  );
}

function isPanelPluginFrame() {
  const ancestors = Array.from(location.ancestorOrigins ?? []);
  return (
    window !== window.top &&
    ancestors[0] === 'https://www.remnote.com' &&
    ancestors.some((origin) => origin.startsWith('chrome-extension:'))
  );
}

// ---- Role 1: the RemNote app inside the side panel ----
function runInRemNoteFrame() {
  const extensionOrigin = chrome.runtime.getURL('').slice(0, -1);
  let pluginWindow = null;

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (data?.ieSpike === 'hello' && data.from === PLUGIN_ID) {
      pluginWindow = event.source;
      pluginWindow.postMessage({ ieSpike: 'ack' }, '*');
      send({ spike: 'hello', from: data.from, href: data.href });
    } else if (data?.ieSpike === 'fromPlugin' && event.source === pluginWindow) {
      send({ spike: 'fromPlugin', payload: data.payload });
    } else if (data?.ieSpike === 'toPlugin' && event.origin === extensionOrigin) {
      pluginWindow?.postMessage(data.payload, '*');
    }
  });

  window.addEventListener('load', async () => {
    // An embedded /clipper page waits for this before starting the app. The
    // Clipper's own content script sends it the same way.
    window.postMessage(
      { function: 'loadFrame', data: {}, messageId: `spike-${Math.random()}`, nonce: Math.random() },
      '*'
    );

    let databases = 'unknown';
    try {
      databases = (await indexedDB.databases()).length;
    } catch {}
    send({
      spike: 'frameAlive',
      href: location.href,
      ancestors: Array.from(location.ancestorOrigins ?? []).join(', '),
      signedIn: !!localStorage.getItem('userId'),
      databases,
    });

    let seconds = 0;
    const timer = setInterval(() => {
      seconds += 1;
      if (document.querySelector('[class*="rn-"]')) {
        clearInterval(timer);
        send({
          spike: 'booted',
          title: document.title,
          pluginFrames: document.querySelectorAll('iframe.rn-plugin-root').length,
        });
      } else if (seconds >= 120) {
        clearInterval(timer);
        send({ spike: 'notBooted', seconds });
      }
    }, 1000);
  });
}

// ---- Role 2: inside a plugin's iframe. Shows which plugins loaded. ----
function runInPluginFrame() {
  send({ spike: 'pluginFrame', href: location.href, runtimeOk: !!chrome.runtime?.id });
}

// ---- Role 3: an ordinary web page ----
function runInPage() {
  const host = document.createElement('div');
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; top: 12px; right: 12px;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      div, button { font: 13px system-ui, sans-serif; }
      button { padding: 6px 12px; border: 0; border-radius: 6px; background: #3b82f6; color: white; cursor: pointer; }
      #banner { margin-top: 8px; padding: 8px 12px; border-radius: 6px; background: #111827; color: white; max-width: 320px; }
    </style>
    <button id="send" hidden>Test: Add Extract</button>
    <div id="banner" hidden></div>`;
  const button = root.getElementById('send');
  const banner = root.getElementById('banner');
  const pending = new Map();
  let bannerTimer;

  const show = (text) => {
    banner.textContent = text;
    banner.hidden = false;
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => (banner.hidden = true), 8000);
  };

  const attach = () => document.documentElement.append(host);
  if (document.documentElement) attach();
  else document.addEventListener('DOMContentLoaded', attach);

  document.addEventListener('selectionchange', () => {
    button.hidden = !window.getSelection()?.toString().trim();
  });

  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', () => {
    const id = `${Date.now()}`;
    const started = performance.now();
    const timeout = setTimeout(() => {
      pending.delete(id);
      show('No answer in 30 s. Is the panel open and the test started?');
    }, 30000);
    pending.set(id, (text) => {
      clearTimeout(timeout);
      show(`${text} (${Math.round(performance.now() - started)} ms in total)`);
    });
    send({ spike: 'extract', id, text: window.getSelection().toString(), url: location.href, title: document.title });
  });

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.spike === 'toPage') {
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message.text);
        pending.delete(message.id);
      } else {
        show(`📨 ${message.text}`);
      }
      respond(true);
    }
  });
}

if (isPanelRemNoteFrame()) runInRemNoteFrame();
else if (isPanelPluginFrame()) runInPluginFrame();
else if (window === window.top && location.protocol.startsWith('http') && location.origin !== 'https://www.remnote.com') runInPage();
