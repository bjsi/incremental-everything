// Runs in every frame and decides which of three roles it has here.

const PLUGIN_IDS = ['incremental-everything', 'incremental-everything-plus'];
const send = (message) => chrome.runtime.sendMessage(message).catch(() => {});
const ancestors = () => Array.from(location.ancestorOrigins ?? []);
const insidePanel = () => window !== window.top && ancestors().some((origin) => origin.startsWith('chrome-extension:'));

function isPanelRemNoteFrame() {
  return (
    location.origin === 'https://www.remnote.com' &&
    insidePanel() &&
    new URLSearchParams(location.search).get('clipperId') === 'ie-companion'
  );
}

function isPanelPluginIndexFrame() {
  const params = new URLSearchParams(location.search);
  return (
    insidePanel() &&
    ancestors()[0] === 'https://www.remnote.com' &&
    params.get('widgetName') === 'index' &&
    PLUGIN_IDS.includes(params.get('pluginId'))
  );
}

// ---- Role 1: the RemNote app inside the side panel ----
function runInRemNoteFrame() {
  window.addEventListener('load', () => {
    // An embedded /clipper page waits for this before starting the app. The
    // Clipper's own content script sends it the same way.
    window.postMessage(
      { function: 'loadFrame', data: {}, messageId: `ie-${Math.random()}`, nonce: Math.random() },
      '*'
    );
    send({ ie: 'frameAlive', signedIn: !!localStorage.getItem('userId') });
  });
}

// ---- Role 2: inside the plugin's index frame. Relays between it and the panel. ----
function runInPluginFrame() {
  const port = chrome.runtime.connect({ name: 'plugin-frame' });
  const toPlugin = (message) => window.postMessage({ ieCompanion: 'toPlugin', ...message }, '*');
  let answered = false;

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.ieCompanion !== 'toExtension') return;
    if (event.data.kind === 'here') answered = true;
    port.postMessage(event.data);
  });
  port.onMessage.addListener(({ id, op, data }) => toPlugin({ kind: 'op', id, op, data }));

  // The plugin's listener starts some time after this script does.
  let tries = 0;
  const timer = setInterval(() => {
    if (answered || ++tries > 240) return clearInterval(timer);
    toPlugin({ kind: 'hello' });
  }, 500);
}

// ---- Role 3: an ordinary web page ----
function runInPage() {
  const A = globalThis.IEAnchors;
  const cacheKey = `page:${location.origin}${location.pathname}${location.search}`;
  let extracts = [];
  let readPoint = null;
  let lastSummary = '';
  const pending = new Map();

  const host = document.createElement('div');
  host.setAttribute('data-ie-companion', '');
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; bottom: 12px; right: 12px;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      div, button { font: 12px system-ui, sans-serif; }
      #bar { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; max-width: 340px; }
      button { padding: 5px 9px; border: 0; border-radius: 6px; background: #1f2937; color: white; cursor: pointer; }
      #extract { background: #3b82f6; }
      label { display: inline-flex; align-items: center; gap: 4px; padding: 5px 9px; border-radius: 6px; background: #1f2937; color: white; font: 12px system-ui, sans-serif; cursor: pointer; }
      input { margin: 0; }
      #banner { margin-bottom: 6px; padding: 8px 10px; border-radius: 6px; background: #111827; color: white; max-width: 340px; overflow-wrap: anywhere; }
    </style>
    <div id="banner" hidden></div>
    <div id="bar">
      <label id="priorityLabel"><input id="priority" type="checkbox" />Set priority</label>
      <button id="extract" hidden>Add Extract</button>
      <button id="setRead">Set read point</button>
      <button id="goRead">Go to read point</button>
      <button id="import">Import headings</button>
    </div>`;
  const $ = (id) => root.getElementById(id);
  let bannerTimer;
  const show = (text, ms = 8000) => {
    $('banner').textContent = text;
    $('banner').hidden = false;
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => ($('banner').hidden = true), ms);
  };
  const logLine = (text) => send({ ie: 'log', host: location.hostname, text });

  /** A write: stored first, so it survives a closed panel, then carried out by the panel. */
  async function enqueue(op, data, onDone) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    if (onDone) pending.set(id, onDone);
    await chrome.storage.local.set({
      [`op:${id}`]: { id, op, at: Date.now(), data: { url: location.href, title: document.title, opId: id, ...data } },
    });
    return id;
  }

  /** A read: answered only while the panel is connected. */
  function read(op, data, timeoutMs = 8000) {
    const id = `${Date.now()}-${Math.random()}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error('The panel is not connected.'));
      }, timeoutMs);
      pending.set(id, (message) => {
        clearTimeout(timeout);
        if (message.ok) resolve(message.result);
        else reject(new Error(message.error));
      });
      send({ ie: 'read', id, op, data: { url: location.href, ...data } });
    });
  }

  /** Says so if the panel doesn't take an operation up soon. */
  function warnIfWaiting(id) {
    setTimeout(() => {
      if (pending.has(id)) show('Saved. It reaches RemNote when the panel is open and connected.', 6000);
    }, 2500);
  }

  function paint(source) {
    const index = A.buildIndex(document);
    const counts = { exact: 0, edges: 0, ambiguous: 0, lost: 0 };
    const ranges = [];
    for (const { anchor } of extracts) {
      const found = A.resolveAnchor(index, anchor);
      if (!found) {
        counts.lost++;
        continue;
      }
      counts[found.how]++;
      ranges.push(A.toRange(document, index, found.start, found.end));
    }
    const hasApi = typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight !== 'undefined';
    if (hasApi) {
      CSS.highlights.set('ie-extract', new Highlight(...ranges));
      const point = readPoint && A.resolveAnchor(index, readPoint.anchor);
      if (point) CSS.highlights.set('ie-readpoint', new Highlight(A.toRange(document, index, point.start, point.end)));
      else CSS.highlights.delete('ie-readpoint');
    }
    const summary = `${ranges.length} of ${extracts.length} highlights, ${JSON.stringify(counts)}, read point: ${readPoint ? 'yes' : 'no'}`;
    if (summary !== lastSummary && (extracts.length || readPoint)) {
      lastSummary = summary;
      logLine(`${source}: ${summary}${hasApi ? '' : '; no CSS Highlight API here'}`);
      if (counts.lost) show(`${counts.lost} highlight${counts.lost === 1 ? '' : 's'} could not be placed: the page's text has changed.`);
    }
    return counts;
  }

  const saveCache = () => chrome.storage.local.set({ [cacheKey]: { extracts, readPoint } }).catch(() => {});

  /** Extracts added here that RemNote does not know of yet, kept across a reload. */
  const stillPending = () => extracts.filter((extract) => extract.opId && !extract.remId);

  async function loadFromPlugin() {
    try {
      const state = await read('pageState', {});
      const waitingOps = await chrome.storage.local.get(null);
      const known = new Set(state.extracts.map((extract) => extract.opId));
      const queued = stillPending().filter((e) => !known.has(e.opId) && waitingOps[`op:${e.opId}`]);
      extracts = [...state.extracts, ...queued];
      readPoint = state.readPoint ?? readPoint;
      saveCache();
      paint('RemNote');
    } catch {
      // No panel yet. The browser's copy is on screen, and pluginReady calls this again.
    }
  }

  /** The heading chain of a section, each with its position in the text. */
  function chainFor(section, outline, index) {
    if (!section) return [];
    return section.path.map((_, depth) => {
      const path = section.path.slice(0, depth + 1).join('\u0001');
      const heading = outline.find((candidate) => candidate.path.join('\u0001') === path);
      const range = document.createRange();
      range.selectNodeContents(heading.element);
      return { text: heading.path[depth], position: A.describeRange(index, range)?.position ?? 0 };
    });
  }

  function firstVisiblePosition(index) {
    const range = document.createRange();
    for (let n = 0; n < index.nodes.length; n++) {
      const node = index.nodes[n];
      range.selectNodeContents(node);
      const rect = range.getClientRects()[0];
      if (!rect || rect.top < 0 || rect.top > innerHeight || rect.width === 0) continue;
      let fixed = false;
      for (let el = node.parentElement; el && !fixed; el = el.parentElement) {
        fixed = ['fixed', 'sticky'].includes(getComputedStyle(el).position);
      }
      if (fixed) continue;
      const at = index.mapNode.indexOf(n);
      if (at !== -1 && index.text.slice(at, at + 12).trim().length > 3) return at;
    }
    return -1;
  }

  function isEditable(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    return !!element?.closest('input,textarea,select,[contenteditable=""],[contenteditable=true]');
  }

  async function addExtract(withPriority) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.toString().trim()) return;
    const range = selection.getRangeAt(0).cloneRange();
    const index = A.buildIndex(document);
    const anchor = A.describeRange(index, range);
    if (!anchor) return show('Nothing to extract in that selection.');
    const outline = A.readOutline(document);
    const started = performance.now();

    // The priority popup lives in the panel, so that needs it open. Before any
    // await: Chrome allows opening it only as a direct response to the key or click.
    if (withPriority) send({ ie: 'openPanel' });

    const extract = { anchor };
    extracts.push(extract);
    selection.removeAllRanges();
    paint('this extract');

    const id = await enqueue(
      'addExtract',
      {
        text: anchor.exact,
        markdown: A.rangeToMarkdown(range),
        anchor,
        chain: chainFor(A.sectionOf(outline, range), outline, index),
        withPriority,
      },
      (message) => {
        if (!message.ok) {
          extracts = extracts.filter((candidate) => candidate !== extract);
          saveCache();
          paint('a failed extract');
          logLine(`Extract failed: ${message.error}`);
          return show(`❌ ${message.error}`);
        }
        extract.remId = message.result.remId;
        saveCache();
        const r = message.result;
        logLine(`Extract ${Math.round(performance.now() - started)} ms in all: ${JSON.stringify(r)}`);
        show(`✅ Extract added${r.section ? ` to “${r.section}”` : ''}`, 3500);
      }
    );
    extract.opId = id;
    saveCache();
    warnIfWaiting(id);
  }

  function attach() {
    document.documentElement.append(host);

    chrome.storage.local.get('setPriority').then((stored) => {
      $('priority').checked = !!stored.setPriority;
    });
    $('priority').addEventListener('change', () => {
      chrome.storage.local.set({ setPriority: $('priority').checked });
    });
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.setPriority) $('priority').checked = !!changes.setPriority.newValue;
    });

    document.addEventListener('selectionchange', () => {
      const selection = window.getSelection();
      $('extract').hidden = !selection?.toString().trim() || isEditable(selection.anchorNode);
    });
    // Keeps the page's selection when the bar is clicked. Clicks still work.
    $('bar').addEventListener('mousedown', (event) => event.preventDefault());
    $('extract').addEventListener('click', () => addExtract($('priority').checked));

    // Opt+X and Opt+Shift+X, only with text selected outside an editable area. The
    // key's code, because Option changes what `key` reports on a Mac.
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.code !== 'KeyX' || !event.altKey || event.ctrlKey || event.metaKey) return;
        const selection = window.getSelection();
        if (!selection?.toString().trim() || isEditable(selection.anchorNode) || isEditable(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        addExtract(event.shiftKey || $('priority').checked);
      },
      true
    );

    $('setRead').addEventListener('click', async () => {
      const index = A.buildIndex(document);
      const at = firstVisiblePosition(index);
      if (at === -1) return show('No text found at the top of the window.');
      const anchor = A.anchorAt(index, at, Math.min(at + 80, index.text.length));
      const percent = scrollY / Math.max(1, document.documentElement.scrollHeight - innerHeight);
      readPoint = { anchor, percent };
      saveCache();
      paint('read point');
      const id = await enqueue('setReadPoint', { anchor, percent }, (message) => {
        if (message.ok) show(`📍 Read point set at “${anchor.exact.slice(0, 40)}…”`, 3500);
        else show(`❌ ${message.error}`);
      });
      warnIfWaiting(id);
    });

    $('goRead').addEventListener('click', () => {
      if (!readPoint) return show('No read point on this page yet.');
      const index = A.buildIndex(document);
      const found = A.resolveAnchor(index, readPoint.anchor);
      if (found) {
        A.toRange(document, index, found.start, found.end).startContainer.parentElement.scrollIntoView({ block: 'start' });
      } else {
        scrollTo(0, readPoint.percent * (document.documentElement.scrollHeight - innerHeight));
        show("The read point's text has changed, so this is its old scroll position.");
      }
    });

    $('import').addEventListener('click', async () => {
      const index = A.buildIndex(document);
      const outline = A.readOutline(document);
      if (!outline.length) return show('This page has no usable headings.');
      show(`Importing ${outline.length} sections…`, 120000);
      const id = await enqueue('importHeadings', { headings: outline.map((s) => chainFor(s, outline, index)) }, (message) => {
        if (message.ok) {
          logLine(`Import: ${JSON.stringify(message.result)}`);
          show(`✅ ${message.result.created} sections added`, 4000);
        } else {
          show(`❌ ${message.error}`);
        }
      });
      warnIfWaiting(id);
    });

    chrome.storage.local.get(cacheKey).then((stored) => {
      const cached = stored[cacheKey];
      if (cached) {
        extracts = cached.extracts ?? [];
        readPoint = cached.readPoint ?? null;
        paint('browser copy');
      }
      loadFromPlugin();
    });

    // Pages that build their text late: paint again once it settles.
    let repaints = 0;
    let repaintTimer;
    new MutationObserver(() => {
      clearTimeout(repaintTimer);
      repaintTimer = setTimeout(() => {
        if (extracts.length && repaints++ < 20) paint('a change in the page');
      }, 1500);
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  if (document.readyState === 'complete') attach();
  else window.addEventListener('load', attach);

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.ie === 'opDone' || message.ie === 'readDone') {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    } else if (message.ie === 'pluginReady') {
      loadFromPlugin();
    }
    respond(true);
  });
}

if (isPanelRemNoteFrame()) runInRemNoteFrame();
else if (isPanelPluginIndexFrame()) runInPluginFrame();
else if (window === window.top && location.protocol.startsWith('http') && location.origin !== 'https://www.remnote.com') runInPage();
