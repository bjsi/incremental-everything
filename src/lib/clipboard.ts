// Plain-text clipboard writes from plugin code.
//
// The SDK can only put Rem references on the clipboard (copyReferenceToClipboard),
// never arbitrary text, and RemNote creates plugin iframes without the
// `clipboard-write` permission: navigator.clipboard.writeText fails with a
// "Permissions policy violation", and execCommand('copy') needs a keystroke made
// inside the iframe. So:
//   1. With the Local Media Bridge on, the helper writes the clipboard (pbcopy):
//      silent, no popup.
//   2. Otherwise the copy_text_popup widget shows the text selected; ⌘C or Enter
//      inside it copies (the key press is the activation execCommand needs).

import { RNPlugin } from '@remnote/plugin-sdk';
import { mediaBridgeEnabledId } from './consts';
import { MEDIA_BRIDGE_URL } from './media_bridge';
import { getIESetting } from './settings';

export const copyTextPopupWidgetId = 'copy_text_popup';
const BRIDGE_TIMEOUT_MS = 1500;

const clipboardToastText = (label: string, text: string) =>
  `📋 Copied ${label}: ${text.length > 60 ? text.slice(0, 57) + '…' : text}`;

async function copyViaBridge(plugin: RNPlugin, text: string): Promise<boolean> {
  if (!(await getIESetting(plugin, mediaBridgeEnabledId))) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BRIDGE_TIMEOUT_MS);
  try {
    const res = await fetch(`${MEDIA_BRIDGE_URL}/clipboard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: ctrl.signal,
    });
    return res.ok; // 404 = a helper older than /clipboard
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Copy `text`; `label` names it in the confirmation ("Rem ID", "3 Rem IDs"). */
export async function copyTextToClipboard(
  plugin: RNPlugin,
  text: string,
  label: string
): Promise<void> {
  if (await copyViaBridge(plugin, text)) {
    await plugin.app.toast(clipboardToastText(label, text));
    return;
  }
  await plugin.widget.openPopup(copyTextPopupWidgetId, { text, label, toast: clipboardToastText(label, text) });
}

/**
 * Copy from inside a popup's own key or click handler, where that gesture lets
 * execCommand('copy') through. Call it synchronously from the handler, before
 * any await. Falls back to the bridge, then to copy_text_popup. Resolves false
 * when copy_text_popup took over: the caller must not close its popup then,
 * since that would close the replacement.
 */
export async function copyTextFromGesture(plugin: RNPlugin, text: string, label: string): Promise<boolean> {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.focus();
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  area.remove();
  if (ok || (await copyViaBridge(plugin, text))) {
    await plugin.app.toast(clipboardToastText(label, text));
    return true;
  }
  await plugin.widget.openPopup(copyTextPopupWidgetId, { text, label, toast: clipboardToastText(label, text) });
  return false;
}

// --- Rem references -------------------------------------------------------------------
//
// RemNote's editor pastes the clipboard's `linear-editor/json` flavour (a rich-text
// array) ahead of the plain text, as long as no `application/rem-id` comes with it (read
// from its paste handler, 1.30.4). So several references, pins or "text + pin" go into
// the one Rem the cursor is in. The flavour is written from a `copy` event, which the
// gesture's execCommand('copy') fires in this frame; Chromium keeps custom types as web
// custom data, which RemNote's own copy uses for this flavour. Which form is chosen at
// copy time: RemNote reads the same payload for ⌘V, ⇧⌘V and the rest.

/** reference: [[Rem]] · pin: 📍 · text-pin: the Rem's text, then a 📍 to it. */
export type RemRefForm = 'reference' | 'pin' | 'text-pin';

export interface RemRefItem {
  remId: string;
  /** Plain name, for the plain-text flavour. */
  name: string;
  /** The Rem's own rich text (text-pin). */
  rich?: any[];
}

const textItem = (text: string) => ({ i: 'm', text });

/** The Rem's text without its cloze marks, so the pasted copy makes no cards. */
function stripClozes(rich: any[]): any[] {
  return rich
    .filter((el) => typeof el === 'string' || (el && typeof el === 'object'))
    .map((el) => {
      if (typeof el === 'string') return textItem(el);
      const { cId, ...rest } = el;
      return rest;
    });
}

export function remRefsRichText(items: RemRefItem[], form: RemRefForm): { rich: any[]; plain: string } {
  const rich: any[] = [];
  const plain: string[] = [];
  items.forEach((it, i) => {
    if (i > 0) rich.push(textItem(form === 'reference' ? ', ' : ' '));
    if (form === 'text-pin') {
      rich.push(...stripClozes(it.rich ?? [it.name]));
      rich.push(textItem(' '));
    }
    rich.push(form === 'reference' ? { i: 'q', _id: it.remId } : { i: 'q', _id: it.remId, pin: true, content: false });
    plain.push(it.name);
  });
  return { rich, plain: plain.join(form === 'reference' ? ', ' : '\n') };
}

/** Write `flavours` from inside a click or key handler; true when the copy happened. */
function copyFlavoursFromGesture(flavours: Record<string, string>): boolean {
  let wrote = false;
  const onCopy = (e: ClipboardEvent) => {
    if (!e.clipboardData) return;
    e.preventDefault();
    for (const [type, data] of Object.entries(flavours)) e.clipboardData.setData(type, data);
    wrote = true;
  };
  const area = document.createElement('textarea');
  area.value = flavours['text/plain'] || ' ';
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  const before = document.activeElement as HTMLElement | null;
  document.body.appendChild(area);
  area.focus();
  area.select();
  document.addEventListener('copy', onCopy, true);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    document.removeEventListener('copy', onCopy, true);
    area.remove();
    before?.focus?.();
  }
  return ok && wrote;
}

/**
 * Copy references to these Rems, in `form`. Call synchronously from the click or key
 * handler. Without the gesture, one Rem still goes through the helper as the text
 * RemNote turns into a reference (`[[id`) or a pin (`[[*id`) on paste.
 */
export async function copyRemRefsFromGesture(plugin: RNPlugin, items: RemRefItem[], form: RemRefForm): Promise<boolean> {
  if (!items.length) return false;
  const { rich, plain } = remRefsRichText(items, form);
  const one = form === 'reference' ? 'reference' : form === 'pin' ? 'pin' : 'text + pin';
  const many = form === 'reference' ? 'references' : form === 'pin' ? 'pins' : 'texts + pins';
  const label = items.length === 1 ? one : `${items.length} ${many}`;
  if (copyFlavoursFromGesture({ 'text/plain': plain, 'linear-editor/json': JSON.stringify(rich) })) {
    await plugin.app.toast(`📋 Copied ${label}. Paste it into a Rem (⌘V).`);
    return true;
  }
  if (items.length === 1 && form !== 'text-pin' && (await copyViaBridge(plugin, `${form === 'pin' ? '[[*' : '[['}${items[0].remId}`))) {
    await plugin.app.toast(`📋 Copied ${label}. Paste it into a Rem (⌘V).`);
    return true;
  }
  await plugin.app.toast('Could not write the clipboard from here. Click the button (or press the keys) again.');
  return false;
}
