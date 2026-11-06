// Runs in every frame and decides which of three roles it has here.

const PLUGIN_IDS = ['incremental-everything', 'incremental-everything-plus'];
/**
 * After the extension is updated or reloaded, a page opened before that still runs
 * this script, but every chrome.* call fails until the page is reloaded.
 */
const extensionIsGone = () => !chrome.runtime?.id;
const send = (message) => {
  if (!extensionIsGone()) chrome.runtime.sendMessage(message).catch(() => {});
};
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
  // RemNote reads this once as it starts, so the panel reloads the frame after a change.
  const KB_KEY = 'knowledgebaseId';
  const port = chrome.runtime.connect({ name: 'remnote-frame' });
  port.onMessage.addListener(({ kind, id }) => {
    if (kind !== 'setKb' || typeof id !== 'string' || !/^[\w-]+$/.test(id)) return;
    localStorage.setItem(KB_KEY, id);
    port.postMessage({ kind: 'kbSet', id });
  });
  // Fires only for a change made elsewhere, such as in a RemNote tab.
  window.addEventListener('storage', (event) => {
    if (event.key === KB_KEY) port.postMessage({ kind: 'kbChanged' });
  });
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
  // The knowledge base this page shows and adds to, as { id, name }. None until the
  // panel has connected for the first time.
  let kb = null;
  let knownKbs = {};
  const cacheKey = (kbId = kb?.id) => `page:${kbId ?? 'none'}:${location.origin}${location.pathname}${location.search}`;
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
      #dock { display: flex; gap: 4px; align-items: flex-end; justify-content: flex-end; }
      #bar { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; max-width: 340px; }
      /* Collapsed, only the selection's own Add Extract button still shows. */
      #bar.collapsed { display: none; }
      #toggle { padding: 5px 7px; opacity: 0.75; }
      #toggle:hover { opacity: 1; }
      button { padding: 5px 9px; border: 0; border-radius: 6px; background: #1f2937; color: white; cursor: pointer; }
      label { display: inline-flex; align-items: center; gap: 4px; padding: 5px 9px; border-radius: 6px; background: #1f2937; color: white; font: 12px system-ui, sans-serif; cursor: pointer; }
      input { margin: 0; }
      #prompt { position: fixed; padding: 8px 10px; border-radius: 8px; background: #111827; color: white; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4); }
      #prompt[hidden] { display: none; }
      #priorityField { padding: 0; background: none; cursor: default; font-weight: 600; }
      #priorityInput { width: 72px; padding: 3px 6px; border: 1px solid #4b5563; border-radius: 4px; background: #1f2937; color: white; font: 13px system-ui, sans-serif; outline: none; }
      #priorityInput:focus { border-color: #3b82f6; }
      #priorityInput.invalid { border-color: #ef4444; }
      #promptHint { margin-top: 4px; font-size: 11px; color: #9ca3af; }
      #kbField { max-width: 100%; }
      #kbField[hidden] { display: none; }
      #kbPick { max-width: 150px; border: 0; background: #1f2937; color: white; font: 12px system-ui, sans-serif; cursor: pointer; }
      /* The menu that comes up beside a selection. */
      #menu { position: fixed; display: flex; align-items: center; padding: 3px; border-radius: 8px; background: #111827; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35); }
      #menu[hidden] { display: none; }
      #menu button { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; background: none; font-size: 13px; }
      #menu button:hover { background: #374151; }
      #menu .sep { width: 1px; align-self: stretch; margin: 4px 0; background: #374151; }
      .dot { width: 9px; height: 9px; border-radius: 50%; }
      #extract .dot { background: #3b82f6; }
      #highlight .dot { background: #facc15; }
      #banner { margin-bottom: 6px; padding: 8px 10px; border-radius: 6px; background: #111827; color: white; max-width: 340px; overflow-wrap: anywhere; }
    </style>
    <div id="prompt" hidden>
      <label id="priorityField">Priority <input id="priorityInput" inputmode="numeric" maxlength="3" placeholder="inherited" autocomplete="off" /></label>
      <div id="promptHint">Enter add · Esc cancel · Shift+Enter more options</div>
    </div>
    <div id="menu" hidden>
      <button id="extract" title="Opt+X · makes the selection an Incremental Rem"><span class="dot"></span>Add Extract</button>
      <span class="sep"></span>
      <button id="highlight" title="Opt+H · adds the selection as a Rem, left out of the queue"><span class="dot"></span>Add Highlight</button>
    </div>
    <div id="banner" hidden></div>
    <div id="dock">
      <div id="bar">
        <label id="kbField" hidden>Send to <select id="kbPick"></select></label>
        <label id="priorityLabel"><input id="priority" type="checkbox" />Set priority</label>
        <button id="setRead">Set read point</button>
        <button id="goRead">Go to read point</button>
        <button id="import">Import headings</button>
      </div>
      <button id="toggle"></button>
    </div>`;
  const $ = (id) => root.getElementById(id);
  let bannerTimer;
  const show = (text, ms = 8000) => {
    $('banner').textContent = text;
    $('banner').hidden = false;
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => ($('banner').hidden = true), ms);
  };
  /** For what the user just asked for, so that it does not seem to work and then vanish. */
  const refuseIfGone = () => {
    if (!extensionIsGone()) return false;
    show('The extension was updated. Reload this page to go on using it.', 15000);
    return true;
  };
  const logLine = (text) => send({ ie: 'log', host: location.hostname, text });

  /** A write: stored first, so it survives a closed panel, then carried out by the panel. */
  async function enqueue(op, data, onDone) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    if (onDone) pending.set(id, onDone);
    await chrome.storage.local.set({
      [`op:${id}`]: { id, op, at: Date.now(), data: { url: location.href, title: document.title, opId: id, kbId: kb?.id, ...data } },
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
      if (pending.has(id)) show(`Saved${kb ? ` for “${kb.name}”` : ''}. It reaches RemNote when the panel is open and connected to it.`, 6000);
    }, 2500);
  }

  /** Added with Add Highlight, and not made Incremental since. */
  const isYellow = (extract) => extract.kind === 'highlight' && !extract.incremental;

  function paint(source) {
    const index = A.buildIndex(document);
    const counts = { exact: 0, edges: 0, ambiguous: 0, lost: 0 };
    const blue = [];
    const yellow = [];
    for (const extract of extracts) {
      const found = A.resolveAnchor(index, extract.anchor);
      if (!found) {
        counts.lost++;
        continue;
      }
      counts[found.how]++;
      (isYellow(extract) ? yellow : blue).push(A.toRange(document, index, found.start, found.end));
    }
    const ranges = [...blue, ...yellow];
    const hasApi = typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight !== 'undefined';
    if (hasApi) {
      CSS.highlights.set('ie-extract', new Highlight(...blue));
      CSS.highlights.set('ie-highlight', new Highlight(...yellow));
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

  /** Only pages with something on them, or the browser copy would become a browsing history. */
  const saveCache = () => {
    if (extensionIsGone()) return;
    const write =
      extracts.length || readPoint
        ? chrome.storage.local.set({ [cacheKey()]: { extracts, readPoint } })
        : chrome.storage.local.remove(cacheKey());
    write.catch(() => {});
  };

  /** Extracts added here that RemNote does not know of yet, kept across a reload. */
  const stillPending = () => extracts.filter((extract) => extract.opId && !extract.remId);

  async function loadFromPlugin() {
    try {
      const state = await read('pageState', {});
      // The panel may be on its way to another KB. This page shows the one it names.
      if (state.kbId && kb && state.kbId !== kb.id) return;
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

  function showKbs() {
    const names = { ...knownKbs, ...(kb ? { [kb.id]: kb.name } : {}) };
    $('kbField').hidden = !Object.keys(names).length;
    $('kbPick').replaceChildren(
      ...Object.entries(names).map(([id, name]) => {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = name;
        return option;
      })
    );
    if (kb) $('kbPick').value = kb.id;
  }

  async function loadBrowserCopy() {
    const key = cacheKey();
    const cached = (await chrome.storage.local.get(key))[key];
    if (key !== cacheKey()) return;
    extracts = cached?.extracts ?? [];
    readPoint = cached?.readPoint ?? null;
    lastSummary = '';
    paint('browser copy');
  }

  /** The panel connected, or a KB was picked: this page now shows that KB only. */
  async function showKb(next) {
    const previous = kb;
    kb = next ?? null;
    showKbs();
    if (previous?.id === kb?.id) return;
    if (previous || !kb) {
      await loadBrowserCopy();
    } else {
      // The first connection: what was added before it goes to this KB.
      chrome.storage.local.remove(cacheKey('none')).catch(() => {});
      saveCache();
    }
    loadFromPlugin();
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

  /** What is about to be extracted, read while the selection still exists. */
  function captureSelection() {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.toString().trim()) return null;
    const range = selection.getRangeAt(0).cloneRange();
    const index = A.buildIndex(document);
    const anchor = A.describeRange(index, range);
    if (!anchor) {
      show('Nothing to extract in that selection.');
      return null;
    }
    const outline = A.readOutline(document);
    return {
      range,
      anchor,
      started: performance.now(),
      payload: {
        text: anchor.exact,
        richText: A.rangeToRichText(range),
        anchor,
        chain: chainFor(A.sectionOf(outline, range), outline, index),
      },
    };
  }

  async function commitExtract({ anchor, started, payload }, options = {}) {
    if (refuseIfGone()) return;
    const extract = { anchor, ...(options.highlight ? { kind: 'highlight' } : {}) };
    extracts.push(extract);
    window.getSelection()?.removeAllRanges();
    paint('this extract');

    const id = await enqueue('addExtract', { ...payload, ...options }, (message) => {
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
      const priorityText = r.priority === undefined ? '' : `, priority ${r.priority}`;
      const what = options.highlight ? '🖍 Highlight added' : '✅ Extract added';
      show(`${what}${r.section ? ` to “${r.section}”` : ''}${priorityText}`, 3500);
    });
    extract.opId = id;
    saveCache();
    warnIfWaiting(id);
  }

  // ---- The priority field, per extract ----

  let promptFor = null;

  function setPendingHighlight(range) {
    if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return;
    if (range) CSS.highlights.set('ie-pending', new Highlight(range));
    else CSS.highlights.delete('ie-pending');
  }

  function closePrompt() {
    promptFor = null;
    $('prompt').hidden = true;
    $('priorityInput').value = '';
    $('priorityInput').classList.remove('invalid');
    setPendingHighlight(null);
  }

  function openPrompt(captured) {
    promptFor = captured;
    hideMenu();
    // Focusing the field takes the page's selection away, so this keeps it visible.
    setPendingHighlight(captured.range);
    const rect = captured.range.getBoundingClientRect?.();
    const prompt = $('prompt');
    prompt.hidden = false;
    const width = prompt.offsetWidth || 300;
    const height = prompt.offsetHeight || 60;
    const inView = rect && rect.bottom > 0 && rect.bottom < innerHeight;
    prompt.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, inView ? rect.left : (innerWidth - width) / 2))}px`;
    prompt.style.top = `${inView ? Math.max(8, Math.min(innerHeight - height - 8, rect.bottom + 6)) : (innerHeight - height) / 2}px`;
    const input = $('priorityInput');
    input.focus();
    // Some pages take the focus back after a selection settles.
    setTimeout(() => promptFor === captured && input.focus(), 50);
  }

  function cancelPrompt() {
    const captured = promptFor;
    closePrompt();
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(captured.range);
  }

  /** Enter: a whole number from 0 to 100, or nothing for the inherited priority. */
  function confirmPrompt(moreOptions) {
    const input = $('priorityInput');
    const text = input.value.trim();
    const priority = Number(text);
    if (!moreOptions && text && (!/^\d+$/.test(text) || priority > 100)) {
      input.classList.add('invalid');
      return;
    }
    const captured = promptFor;
    closePrompt();
    if (moreOptions) {
      // The full popup lives in the panel. Before any await: Chrome opens it only as
      // a direct response to the key.
      send({ ie: 'openPanel' });
      commitExtract(captured, { withPriority: true });
    } else {
      commitExtract(captured, text ? { priority } : {});
    }
  }

  function stepPrompt(delta) {
    const input = $('priorityInput');
    const current = Number(input.value);
    const base = input.value.trim() && Number.isFinite(current) ? current : delta > 0 ? -1 : 101;
    input.value = String(Math.max(0, Math.min(100, base + delta)));
    input.classList.remove('invalid');
  }

  /** While the field is open it gets the keys, and the page's own shortcuts do not. */
  function handlePromptKey(event) {
    // Not composedPath(): it hides a closed shadow root from a listener on the window.
    if (root.activeElement !== $('priorityInput')) return;
    event.stopPropagation();
    if (event.type !== 'keydown') return;
    if (event.key === 'Enter') {
      event.preventDefault();
      confirmPrompt(event.shiftKey);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelPrompt();
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      stepPrompt(event.key === 'ArrowUp' ? 1 : -1);
    }
  }

  function startExtract(askPriority) {
    if (promptFor || refuseIfGone()) return;
    const captured = captureSelection();
    if (!captured) return;
    if (askPriority) openPrompt(captured);
    else commitExtract(captured);
  }

  /** Like an extract, but the Rem is not made Incremental, so it has no priority to ask for. */
  function startHighlight() {
    if (promptFor || refuseIfGone()) return;
    const captured = captureSelection();
    if (captured) commitExtract(captured, { highlight: true });
  }

  // ---- The menu beside a selection ----

  let mouseIsDown = false;
  let menuTimer;

  /** The selection the menu is for, or null when there is none it can act on. */
  function selectionForMenu() {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.toString().trim() || isEditable(selection.anchorNode)) return null;
    return selection.getRangeAt(0);
  }

  function hideMenu() {
    clearTimeout(menuTimer);
    $('menu').hidden = true;
  }

  /** Above the selection, or below it when there is no room, and always in the window. */
  function placeMenu() {
    const range = !promptFor && !mouseIsDown && selectionForMenu();
    const rect = range && range.getBoundingClientRect?.();
    if (!rect || rect.bottom < 0 || rect.top > innerHeight) return hideMenu();
    const menu = $('menu');
    menu.hidden = false;
    const width = menu.offsetWidth || 260;
    const height = menu.offsetHeight || 34;
    const above = rect.top - height - 8;
    const below = rect.bottom + 8;
    const top = above >= 8 ? above : below + height <= innerHeight - 8 ? below : 8;
    const left = rect.left + rect.width / 2 - width / 2;
    menu.style.top = `${top}px`;
    menu.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, left))}px`;
  }

  /** Once the selection has settled: not while a drag is still making it. */
  function scheduleMenu() {
    clearTimeout(menuTimer);
    if (mouseIsDown) return;
    menuTimer = setTimeout(placeMenu, 150);
  }

  function showCollapsed(collapsed) {
    $('bar').classList.toggle('collapsed', collapsed);
    $('toggle').textContent = collapsed ? '‹' : '›';
    $('toggle').title = collapsed ? 'Show the Companion buttons' : 'Hide the Companion buttons';
  }

  function attach() {
    document.documentElement.append(host);
    showCollapsed(false);

    chrome.storage.local.get(['setPriority', 'barCollapsed']).then((stored) => {
      $('priority').checked = !!stored.setPriority;
      showCollapsed(!!stored.barCollapsed);
    });
    // One setting for every tab, so a collapsed bar stays out of the way everywhere.
    $('toggle').addEventListener('mousedown', (event) => event.preventDefault());
    $('toggle').addEventListener('click', () => {
      const collapsed = !$('bar').classList.contains('collapsed');
      showCollapsed(collapsed);
      if (!refuseIfGone()) chrome.storage.local.set({ barCollapsed: collapsed });
    });
    $('priority').addEventListener('change', () => {
      if (!refuseIfGone()) chrome.storage.local.set({ setPriority: $('priority').checked });
    });
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.setPriority) $('priority').checked = !!changes.setPriority.newValue;
      if (changes.barCollapsed) showCollapsed(!!changes.barCollapsed.newValue);
      if (changes.kbKnown) {
        knownKbs = changes.kbKnown.newValue ?? {};
        showKbs();
      }
      if (changes.kb) showKb(changes.kb.newValue);
    });

    document.addEventListener('selectionchange', () => (selectionForMenu() ? scheduleMenu() : hideMenu()));
    // A press in the page starts a new selection, or ends this one. One on the bar
    // or the menu arrives with the host as its target.
    document.addEventListener(
      'mousedown',
      (event) => {
        if (event.target === host) return;
        mouseIsDown = true;
        hideMenu();
      },
      true
    );
    document.addEventListener(
      'mouseup',
      () => {
        mouseIsDown = false;
        scheduleMenu();
      },
      true
    );
    addEventListener('scroll', () => !$('menu').hidden && placeMenu(), { capture: true, passive: true });
    addEventListener('resize', () => !$('menu').hidden && placeMenu());
    // Keeps the page's selection when the menu is clicked.
    $('menu').addEventListener('mousedown', (event) => event.preventDefault());
    $('highlight').addEventListener('click', startHighlight);
    // Keeps the page's selection when the bar is clicked. Clicks still work.
    $('bar').addEventListener('mousedown', (event) => {
      if (event.target !== $('kbPick')) event.preventDefault();
    });
    $('kbPick').addEventListener('change', () => {
      if (refuseIfGone()) return;
      const id = $('kbPick').value;
      chrome.storage.local.set({ kb: { id, name: knownKbs[id] ?? id }, kbPick: id });
    });
    $('prompt').addEventListener('mousedown', (event) => {
      if (event.target !== $('priorityInput')) event.preventDefault();
    });
    $('extract').addEventListener('click', () => startExtract($('priority').checked));
    for (const type of ['keydown', 'keypress', 'keyup']) {
      window.addEventListener(type, (event) => promptFor && handlePromptKey(event), true);
    }
    // Clicking elsewhere on the page is a change of mind. Switching to another
    // window or the panel is not.
    $('priorityInput').addEventListener('blur', () => {
      setTimeout(() => {
        if (promptFor && document.hasFocus() && root.activeElement !== $('priorityInput')) closePrompt();
      }, 100);
    });
    $('priorityInput').addEventListener('input', () => $('priorityInput').classList.remove('invalid'));

    // Opt+X and Opt+Shift+X for an extract, Opt+H for a highlight, only with text
    // selected outside an editable area. The key's code, because Option changes
    // what `key` reports on a Mac.
    window.addEventListener(
      'keydown',
      (event) => {
        const extract = event.code === 'KeyX';
        const highlight = event.code === 'KeyH' && !event.shiftKey;
        if (promptFor || !(extract || highlight) || !event.altKey || event.ctrlKey || event.metaKey) return;
        const selection = window.getSelection();
        if (!selection?.toString().trim() || isEditable(selection.anchorNode) || isEditable(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        if (highlight) startHighlight();
        else startExtract(event.shiftKey || $('priority').checked);
      },
      true
    );

    $('setRead').addEventListener('click', async () => {
      if (refuseIfGone()) return;
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
      if (refuseIfGone()) return;
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

    chrome.storage.local.get(['kb', 'kbKnown']).then(async (stored) => {
      kb = stored.kb ?? null;
      knownKbs = stored.kbKnown ?? {};
      showKbs();
      await loadBrowserCopy();
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
    } else if (message.ie === 'pluginReady' || message.ie === 'pageChanged') {
      loadFromPlugin();
    }
    respond(true);
  });
}

if (isPanelRemNoteFrame()) runInRemNoteFrame();
else if (isPanelPluginIndexFrame()) runInPluginFrame();
else if (window === window.top && location.protocol.startsWith('http') && location.origin !== 'https://www.remnote.com') runInPage();
