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
      #banner { margin-bottom: 6px; padding: 8px 10px; border-radius: 6px; background: #111827; color: white; max-width: 340px; overflow-wrap: anywhere; }
    </style>
    <div id="banner" hidden></div>
    <div id="bar">
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
  const report = (name, ok, detail) => send({ spike: 'pageReport', host: location.hostname, name, ok, detail });

  function request(op, data, timeoutMs = 30000) {
    const id = `${Date.now()}-${Math.random()}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`No answer in ${timeoutMs / 1000} s. Is the panel open and the test started?`));
      }, timeoutMs);
      pending.set(id, (message) => {
        clearTimeout(timeout);
        if (message.ok) resolve(message.result);
        else reject(new Error(message.error));
      });
      send({ spike: 'pageOp', id, op, data: { url: location.href, title: document.title, ...data } });
    });
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
    const summary = `${ranges.length} of ${extracts.length} painted (${JSON.stringify(counts)}), read point: ${readPoint ? 'yes' : 'no'}`;
    if (summary !== lastSummary && (extracts.length || readPoint)) {
      lastSummary = summary;
      report('Highlights', hasApi && counts.lost === 0, `From ${source}: ${summary}${hasApi ? '' : '; CSS Highlight API not available here'}`);
      show(`From ${source}: ${summary}`);
    }
    return counts;
  }

  const saveCache = () => chrome.storage.local.set({ [cacheKey]: { extracts, readPoint } }).catch(() => {});

  async function loadFromPlugin() {
    try {
      const state = await request('pageState', {}, 8000);
      extracts = state.extracts;
      readPoint = state.readPoint ?? null;
      if (state.removed) report('Deleted extract loses its highlight', true, `${state.removed} removed`);
      saveCache();
      paint('RemNote');
    } catch {
      // No panel yet. The cached copy is on screen, and pluginReady calls this again.
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

  function attach() {
    document.documentElement.append(host);

    document.addEventListener('selectionchange', () => {
      $('extract').hidden = !window.getSelection()?.toString().trim();
    });
    root.addEventListener('mousedown', (event) => event.preventDefault());

    $('extract').addEventListener('click', async () => {
      const selection = window.getSelection();
      if (!selection?.rangeCount) return;
      const range = selection.getRangeAt(0).cloneRange();
      const index = A.buildIndex(document);
      const anchor = A.describeRange(index, range);
      if (!anchor) return show('Nothing to extract in that selection.');
      const outline = A.readOutline(document);
      const started = performance.now();
      show('Adding the extract…', 30000);
      try {
        const result = await request('addExtract', {
          text: anchor.exact,
          markdown: A.rangeToMarkdown(range),
          anchor,
          chain: chainFor(A.sectionOf(outline, range), outline, index),
        });
        extracts.push({ remId: result.remId, anchor });
        saveCache();
        selection.removeAllRanges();
        paint('this extract');
        const passed = result.isIncremental && result.inSection && result.inReadingOrder;
        show(`${passed ? '✅' : '❌'} In “${result.section}”, ${Math.round(performance.now() - started)} ms`);
        report(`Extract: ${anchor.exact.slice(0, 40)}…`, passed, JSON.stringify(result));
      } catch (err) {
        show(`❌ ${err.message}`);
        report('Extract', false, err.message);
      }
    });

    $('setRead').addEventListener('click', async () => {
      const index = A.buildIndex(document);
      const at = firstVisiblePosition(index);
      if (at === -1) return show('No text found at the top of the window.');
      const anchor = A.anchorAt(index, at, Math.min(at + 80, index.text.length));
      const percent = scrollY / Math.max(1, document.documentElement.scrollHeight - innerHeight);
      try {
        await request('setReadPoint', { anchor, percent });
        readPoint = { anchor, percent };
        saveCache();
        paint('read point');
        report('Read point saved', true, `“${anchor.exact.slice(0, 50)}…” at ${Math.round(percent * 100)}%`);
        show(`📍 Read point set at “${anchor.exact.slice(0, 40)}…”`);
      } catch (err) {
        show(`❌ ${err.message}`);
        report('Read point saved', false, err.message);
      }
    });

    $('goRead').addEventListener('click', () => {
      if (!readPoint) return show('No read point on this page yet.');
      const index = A.buildIndex(document);
      const found = A.resolveAnchor(index, readPoint.anchor);
      if (found) {
        A.toRange(document, index, found.start, found.end).startContainer.parentElement.scrollIntoView({ block: 'start' });
        report('Go to read point', true, `Found by text (${found.how}), now at y=${Math.round(scrollY)}`);
      } else {
        scrollTo(0, readPoint.percent * (document.documentElement.scrollHeight - innerHeight));
        report('Go to read point', false, 'Text not found, so it used the saved scroll percentage');
      }
    });

    $('import').addEventListener('click', async () => {
      const index = A.buildIndex(document);
      const outline = A.readOutline(document);
      if (!outline.length) {
        report('Import headings', false, 'This page has no usable headings');
        return show('This page has no usable headings.');
      }
      show(`Importing ${outline.length} sections…`, 120000);
      try {
        const result = await request('importHeadings', { headings: outline.map((s) => chainFor(s, outline, index)) }, 120000);
        show(`✅ ${result.created} sections created, in ${result.elapsedMs} ms`);
        report('Import headings', true, JSON.stringify(result));
      } catch (err) {
        show(`❌ ${err.message}`);
        report('Import headings', false, err.message);
      }
    });

    chrome.storage.local.get(cacheKey).then((stored) => {
      const cached = stored[cacheKey];
      if (cached) {
        extracts = cached.extracts ?? [];
        readPoint = cached.readPoint ?? null;
        paint('this browser, before RemNote answered');
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
    if (message.spike === 'opDone') {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    } else if (message.spike === 'pluginReady') {
      loadFromPlugin();
    } else if (message.spike === 'toPage') {
      show(`📨 ${message.text}`);
    }
    respond(true);
  });
}

if (isPanelRemNoteFrame()) runInRemNoteFrame();
else if (isPanelPluginFrame()) runInPluginFrame();
else if (window === window.top && location.protocol.startsWith('http') && location.origin !== 'https://www.remnote.com') runInPage();
