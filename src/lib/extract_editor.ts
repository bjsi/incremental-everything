/**
 * Extract Editor: editing an Incremental Rem from the queue, in place.
 *
 * The queue's Extract Viewer (components/ExtractViewer.tsx) is read-only for a reason
 * found in the bundle (1.30.4, queue chunk): the queue's shell has a click handler that,
 * 20 ms after ANY click inside it, gives the focus back to the queue unless the queue or
 * one of its own children holds it. A RemNote editor embedded in the queue's card
 * (DocumentViewer, RemHierarchyEditorTree) is inside that shell but is not a child of
 * the queue's focus path, so every click into it is answered by the queue taking the
 * focus away: the caret vanishes and keys go to the queue's shortcuts.
 *
 * A floating widget is mounted at the app's root, outside the shell, and its wrapper
 * stops click propagation. An editor there keeps the focus exactly as one in the right
 * sidebar does, and while it holds it the queue's own shortcuts are off (they are
 * enabled only while the queue has the focus). So the editor is a float laid over the
 * Extract Viewer's card, where the read-only text was. It also exists on a phone, where
 * the right sidebar does not.
 *
 * It embeds DocumentViewer, RemNote's own document page: the Rem's text as the title,
 * its children below, with everything a normal editor has (formatting, clozes, `/`,
 * references, the plugin's own commands on the focused Rem).
 */
import { RNPlugin } from '@remnote/plugin-sdk';
import { EXTRACT_EDITOR_FLOAT, extractEditorFloatIdKey, extractEditorTargetKey } from './consts';

const LOG = '[ExtractEditor]';

export interface ExtractEditorTarget {
  remId: string;
  title: string;
  /** The panel's size; the float is registered 'auto' and takes it from its content. */
  width: number;
  height: number;
  position: { top: number; left: number };
  /** A phone-sized queue: the panel keeps to the top, clear of the on-screen keyboard. */
  compact: boolean;
  at: number;
}

/** The Extract Viewer's card inside its frame: `padding: 48px 16px 16px`, at most 1000 wide. */
const CARD = { top: 48, side: 16, bottom: 16, maxWidth: 1000 };
/** Below this width the queue is a phone's. */
const COMPACT_PX = 520;

/**
 * Where the editor goes: over the viewer's card when the frame's place in the window
 * is known, else a centred panel.
 */
export function editorPlacement(
  frame: { top: number; left: number; width: number; height: number } | null | undefined,
  screen: { width: number; height: number }
): Pick<ExtractEditorTarget, 'width' | 'height' | 'position' | 'compact'> {
  if (!frame || !(frame.width > 0) || !(frame.height > 0)) {
    const width = Math.min(900, Math.max(280, screen.width - 48));
    const height = Math.max(240, Math.round(screen.height * 0.6));
    return { width, height, position: { top: 80, left: Math.max(8, Math.round((screen.width - width) / 2)) }, compact: screen.width < COMPACT_PX };
  }
  if (frame.width < COMPACT_PX) {
    // The keyboard takes about 40% of a phone's screen: stay in the part above it.
    const width = Math.round(frame.width - 8);
    const height = Math.max(200, Math.min(Math.round(frame.height - 8), Math.round(screen.height * 0.44)));
    return { width, height, position: { top: Math.round(frame.top + 4), left: Math.round(frame.left + 4) }, compact: true };
  }
  const width = Math.round(Math.min(CARD.maxWidth, frame.width - 2 * CARD.side));
  const height = Math.round(Math.max(240, frame.height - CARD.top - CARD.bottom));
  return {
    width,
    height,
    position: {
      top: Math.round(frame.top + CARD.top),
      left: Math.round(frame.left + (frame.width - width) / 2),
    },
    compact: false,
  };
}

/** The frame this code runs in, as the host places it. Null when the host will not say. */
async function ownFrame(plugin: RNPlugin) {
  try {
    const ctx = await plugin.widget.getWidgetContext<any>();
    const instance = Number(ctx?.widgetInstanceId);
    if (!Number.isFinite(instance)) return null;
    const rect = await plugin.widget.getDimensions(instance);
    return rect && rect.width > 0 ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height } : null;
  } catch (err) {
    console.warn(LOG, 'could not measure the viewer', err);
    return null;
  }
}

/** Open the editor on a Rem, over the frame that asks (the queue's Extract Viewer). */
export async function openExtractEditor(plugin: RNPlugin, remId: string, title: string): Promise<void> {
  const placement = editorPlacement(await ownFrame(plugin), {
    width: window.screen?.availWidth || window.innerWidth || 1024,
    height: window.screen?.availHeight || window.innerHeight || 768,
  });
  const target: ExtractEditorTarget = { remId, title, ...placement, at: Date.now() };
  await plugin.storage.setSession(extractEditorTargetKey, target);

  const floatId = await plugin.storage.getSession<string>(extractEditorFloatIdKey);
  const open = !!floatId && (await plugin.window.isFloatingWidgetOpen(floatId).catch(() => false));
  if (open) {
    // Already up (on another Rem, or moved): back over this card.
    await plugin.window.setFloatingWidgetPosition(floatId!, target.position).catch(() => {});
    return;
  }
  const id = await plugin.window.openFloatingWidget(EXTRACT_EDITOR_FLOAT, target.position, undefined, false);
  await plugin.storage.setSession(extractEditorFloatIdKey, id);
}

/** Close the editor; with a Rem id, only if it is showing that Rem. */
export async function closeExtractEditor(plugin: RNPlugin, remId?: string): Promise<void> {
  try {
    if (remId) {
      const target = await plugin.storage.getSession<ExtractEditorTarget>(extractEditorTargetKey);
      if (target && target.remId !== remId) return;
    }
    const floatId = await plugin.storage.getSession<string>(extractEditorFloatIdKey);
    await plugin.storage.setSession(extractEditorTargetKey, null);
    await plugin.storage.setSession(extractEditorFloatIdKey, null);
    if (floatId) await plugin.window.closeFloatingWidget(floatId).catch(() => {});
  } catch (err) {
    console.warn(LOG, 'could not close the editor', err);
  }
}
