/**
 * "Upscale image with ChatGPT": a low-quality figure in a rem is regenerated at
 * higher resolution by ChatGPT's image model and, after the user has compared
 * the two, swapped into the rem in place.
 *
 * The plugin cannot run programs, so the work is done by the Local Media Bridge
 * helper (scripts/media_bridge/media_bridge.py, POST /upscale), which runs
 * scripts/media_bridge/upscale_image.py: Codex CLI image generation signed in with
 * the user's ChatGPT plan, then a fidelity check (ink overlay, hue, OCR words,
 * zoomed crops of every changed region). The popup (widgets/upscale_image_popup)
 * shows the side-by-side and the check; only "Replace image" touches the rem.
 */
import { PluginRem, RNPlugin, RichTextInterface, SelectionType } from '@remnote/plugin-sdk';
import { mediaBridgeEnabledId, UPSCALE_IMAGE_POPUP } from './consts';
import { imageUrlsOf, prepareForSetText, storeImageInRemNote } from './localize_media';
import { MEDIA_BRIDGE_URL } from './media_bridge';
import { showMessageDialog } from './message_dialog';
import { getIESetting } from './settings';

/** The helper version that has /upscale. */
const MIN_HELPER_VERSION = 3;

export type ImageField = 'text' | 'backText';

export interface UpscaleTarget {
  field: ImageField;
  url: string;
}

export interface UpscalePopupContext {
  remId: string;
  title: string;
  kbId?: string;
  images: UpscaleTarget[];
}

export interface UpscaleCrop {
  kind: 'missing' | 'added';
  px: number;
  url: string;
}

export interface UpscaleResult {
  ok: boolean;
  message?: string;
  seconds?: number;
  folder?: string;
  upscaledUrl?: string;
  origSize?: [number, number];
  newSize?: [number, number];
  verdict?: 'pass' | 'review';
  flags?: string[];
  sideBySideUrl?: string;
  diffUrl?: string;
  crops?: UpscaleCrop[];
  ocrWordDiff?: string[];
}

export interface UpscaleTask {
  id: string;
  status: 'running' | 'done';
  stage: string;
  elapsed: number;
  result: UpscaleResult | null;
}

const remTitle = async (plugin: RNPlugin, rem: PluginRem) => {
  try {
    const words = (rem.text ?? []).filter((el) => typeof el === 'string' || (el as any).i !== 'i');
    const text = (await plugin.richText.toString(words)).trim();
    return text.length > 80 ? `${text.slice(0, 79)}…` : text;
  } catch {
    return '';
  }
};

const helperProblem = async (): Promise<string | undefined> => {
  try {
    const res = await fetch(`${MEDIA_BRIDGE_URL}/health`);
    const health = await res.json();
    if ((health?.version ?? 1) < MIN_HELPER_VERSION) {
      return (
        `The media-bridge helper running on this computer is version ${health?.version ?? 1}; ` +
        `upscaling needs ${MIN_HELPER_VERSION}. Restart it: ` +
        'launchctl kickstart -k gui/$(id -u)/com.incrementalremnote.media-bridge'
      );
    }
    return undefined;
  } catch {
    return (
      `The media-bridge helper is not reachable at ${MEDIA_BRIDGE_URL}. Start it with ` +
      'scripts/media_bridge/media_bridge.py start (or load its launchd agent).'
    );
  }
};

/** The command: check the setup, find the focused rem's images, open the popup. */
export async function openUpscaleImage(plugin: RNPlugin) {
  if (!(await getIESetting(plugin, mediaBridgeEnabledId))) {
    await showMessageDialog(plugin, {
      title: 'Upscale image needs the Local Media Bridge',
      message:
        'Turn on the setting "Local Media Bridge" in Incremental Everything. The upscaling runs in ' +
        'its helper program on this computer (Codex CLI signed in with your ChatGPT account).',
      tone: 'info',
    });
    return;
  }
  const selection = await plugin.editor.getSelection();
  const rem =
    selection?.type === SelectionType.Rem
      ? await plugin.rem.findOne(selection.remIds[0])
      : await plugin.focus.getFocusedRem();
  if (!rem) {
    await plugin.app.toast('No focused rem — place your cursor in the rem that has the image.');
    return;
  }
  const images: UpscaleTarget[] = [
    ...imageUrlsOf(rem.text).map((url) => ({ field: 'text' as const, url })),
    ...imageUrlsOf(rem.backText).map((url) => ({ field: 'backText' as const, url })),
  ].filter((image) => image.url);
  if (images.length === 0) {
    await plugin.app.toast('This rem has no image to upscale.');
    return;
  }
  const problem = await helperProblem();
  if (problem) {
    await showMessageDialog(plugin, { title: 'Cannot upscale', message: problem, tone: 'error' });
    return;
  }
  const kb = await plugin.kb.getCurrentKnowledgeBaseData();
  const context: UpscalePopupContext = {
    remId: rem._id,
    title: await remTitle(plugin, rem),
    kbId: kb?._id,
    images,
  };
  await plugin.widget.openPopup(UPSCALE_IMAGE_POPUP, context);
}

export async function startUpscale(
  context: UpscalePopupContext,
  image: UpscaleTarget,
  extra: string
): Promise<string> {
  const res = await fetch(`${MEDIA_BRIDGE_URL}/upscale`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ remId: context.remId, url: image.url, kbId: context.kbId, extra }),
  });
  const body = await res.json();
  if (!res.ok || !body.taskId) throw new Error(body?.error ?? `helper answered ${res.status}`);
  return body.taskId as string;
}

export async function getUpscaleTask(taskId: string): Promise<UpscaleTask> {
  const res = await fetch(`${MEDIA_BRIDGE_URL}/upscale/${taskId}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `helper answered ${res.status}`);
  return body as UpscaleTask;
}

/**
 * Store the upscaled image in RemNote and point the rem's image element at it,
 * keeping everything else (caption, display width, other images). The height is
 * rescaled from the width if the aspect ratio moved at all.
 */
export async function replaceRemImage(
  plugin: RNPlugin,
  remId: string,
  image: UpscaleTarget,
  result: UpscaleResult
): Promise<void> {
  if (!result.upscaledUrl) throw new Error('No upscaled image to store.');
  const hosted = await storeImageInRemNote(plugin, result.upscaledUrl);
  if (!hosted) throw new Error('RemNote did not take the upscaled image (see the console).');
  // Re-read: the generation took a while and the rem may have been edited since.
  const rem = await plugin.rem.findOne(remId);
  if (!rem) throw new Error('The rem is gone.');
  const current = (image.field === 'text' ? rem.text : rem.backText) ?? [];
  let swapped = 0;
  const next = current.map((element) => {
    const el = element as any;
    if (typeof element === 'string' || el.i !== 'i' || el.url !== image.url || swapped > 0) return element;
    swapped++;
    const updated = { ...el, url: hosted };
    if (typeof el.width === 'number' && result.newSize) {
      updated.height = (el.width * result.newSize[1]) / result.newSize[0];
    }
    return updated;
  }) as RichTextInterface;
  if (swapped === 0) throw new Error('The image in the rem changed while upscaling; nothing was replaced.');
  if (image.field === 'text') await rem.setText(prepareForSetText(next));
  else await rem.setBackText(prepareForSetText(next));
}
