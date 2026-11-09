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
