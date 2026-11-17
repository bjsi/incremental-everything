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
import { AppEvents, ReactRNPlugin, RNPlugin } from '@remnote/plugin-sdk';
import { currentIncRemKey, EXTRACT_EDITOR_FLOAT, extractEditorFloatIdKey, extractEditorTargetKey } from './consts';
import { isQueueUrl } from './open_in_window';

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

/** Below this width the queue is a phone's. */
const COMPACT_PX = 520;

type Rect = { top: number; left: number; width: number; height: number };

/**
 * Where the editor goes: exactly over the viewer's card, from the queue frame's place
 * in the window and the card's place in the frame; a centred panel when either is
 * unknown. On a phone the panel keeps the card's top and width but is kept short, so
 * the on-screen keyboard (about 40% of the screen) does not cover it.
 */
export function editorPlacement(
  frame: Rect | null | undefined,
  screen: { width: number; height: number },
  card?: Rect | null
): Pick<ExtractEditorTarget, 'width' | 'height' | 'position' | 'compact'> {
  const known = (r: Rect | null | undefined): r is Rect => !!r && r.width > 0 && r.height > 0;
  if (!known(frame) || !known(card)) {
    const compact = (known(frame) ? frame.width : screen.width) < COMPACT_PX;
    const width = Math.min(900, Math.max(280, screen.width - (compact ? 8 : 48)));
    const height = Math.max(240, Math.round(screen.height * (compact ? 0.4 : 0.6)));
    return {
      width,
      height,
      position: { top: compact ? 96 : 80, left: Math.max(4, Math.round((screen.width - width) / 2)) },
      compact,
    };
  }
  const compact = frame.width < COMPACT_PX;
  const height = compact ? Math.max(200, Math.min(card.height, screen.height * 0.4)) : Math.max(240, card.height);
  return {
    width: Math.round(card.width),
    height: Math.round(height),
    position: { top: Math.round(frame.top + card.top), left: Math.round(frame.left + card.left) },
    compact,
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

/**
 * Open the editor on a Rem, over the frame that asks (the queue's Extract Viewer).
 * `card` is the viewer's card element: the panel is laid over its rectangle.
 */
export async function openExtractEditor(
  plugin: RNPlugin,
  remId: string,
  title: string,
  card?: HTMLElement | null
): Promise<void> {
  const box = card?.getBoundingClientRect();
  const placement = editorPlacement(
    await ownFrame(plugin),
    {
      width: window.screen?.availWidth || window.innerWidth || 1024,
      height: window.screen?.availHeight || window.innerHeight || 768,
    },
    box ? { top: box.top, left: box.left, width: box.width, height: box.height } : null
  );
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

/**
 * The index's part: closing the editor when its card is gone.
 *
 * The Extract Viewer cannot be trusted to do it. When the queue advances or closes, the
 * host destroys the viewer's frame, and whatever its cleanup had started (the session
 * read, the close call) dies with it. The index lives all session and hears the queue's
 * events, so it closes the editor when another card loads, when the queue exits, and
 * when the window leaves the queue by any other road.
 */
export function registerExtractEditorHost(plugin: ReactRNPlugin) {
  const target = () => plugin.storage.getSession<ExtractEditorTarget>(extractEditorTargetKey).catch(() => undefined);

  // A flashcard: its event carries a card id. The plugin's own items carry none, and
  // the Incremental Rem now on screen is known only once the queue widget has rendered
  // it, after this fires: that case is the tracker below.
  plugin.event.addListener(AppEvents.QueueLoadCard, undefined, async (data: { cardId?: string } | undefined) => {
    if (data?.cardId && (await target())) await closeExtractEditor(plugin);
  });
  // Another Incremental Rem on screen (queue.tsx writes its id when it renders it).
  // The same Rem again, a re-render or a hybrid card flipping views, keeps the editor.
  plugin.track(async (rp) => {
    const current = await rp.storage.getSession<string>(currentIncRemKey);
    const open = await target();
    if (open && current && current !== open.remId) await closeExtractEditor(plugin);
  });
  plugin.event.addListener(AppEvents.QueueExit, undefined, async () => {
    if (await target()) await closeExtractEditor(plugin);
  });
  plugin.event.addListener(AppEvents.URLChange, undefined, async () => {
    if (!(await target())) return;
    const url = await plugin.window.getURL().catch(() => undefined);
    if (typeof url === 'string' && !isQueueUrl(url)) await closeExtractEditor(plugin);
  });
  // One left from before a plugin reload has no viewer under it any more.
  void closeExtractEditor(plugin);
}
