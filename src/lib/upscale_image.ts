/**
 * "Upscale image with ChatGPT": a low-quality figure in a rem is regenerated at
 * higher resolution by ChatGPT's image model and, after the user has compared
 * the two, swapped into the rem in place.
 *
 * The plugin cannot run programs, so the work is done by the Local Media Bridge
 * helper (scripts/media_bridge/media_bridge.py, POST /upscale), which runs
 * scripts/media_bridge/upscale_image.py: Codex CLI image generation signed in with
 * the user's ChatGPT plan, then a fidelity check (ink overlay, hue, OCR words,
 * zoomed crops of every changed region).
 *
 * It runs in the background, as Read aloud does: the command queues an UpscaleJob and
 * returns; the tracker (register/tracker.ts, persistent index widget) runs the rem's
 * images one after another on the helper and posts a notice whose **Review** button
 * opens the popup (widgets/upscale_image_popup) with the side-by-side and the check.
 * Only "Replace image" there touches the rem. The job and the notice live in this
 * window's session: a reload drops them (the helper's folder on disk keeps the files).
 */
import { PluginRem, RNPlugin, RichTextInterface, SelectionType } from '@remnote/plugin-sdk';
import { mediaBridgeEnabledId, pendingUpscaleJobsKey, UPSCALE_IMAGE_POPUP } from './consts';
import { imageUrlsOf, prepareForSetText, storeImageInRemNote } from './localize_media';
import { MEDIA_BRIDGE_URL } from './media_bridge';
import { showMessageDialog } from './message_dialog';
import { showNotice } from './notice';
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

/** What the Review button opens: the job's images with their finished results. */
export interface UpscaleReviewContext extends UpscalePopupContext {
  /** One per image, in order; a failure is `{ ok: false, message }`. */
  results: UpscaleResult[];
  /** The notice that opened it, dismissed once every image has been dealt with. */
  noticeId?: string;
}

/** A background upscale (see the module comment). */
export interface UpscaleJob extends UpscalePopupContext {
  /** Unique per run, so a job the tracker reads twice runs once. */
  id: string;
  /** For Try again: what to keep. */
  extra: string;
  queuedAt: number;
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
  await enqueueUpscaleJob(plugin, {
    remId: rem._id,
    title: await remTitle(plugin, rem),
    kbId: kb?._id,
    images,
  });
  const n = images.length;
  await plugin.app.toast(
    `🖼 Upscaling ${n === 1 ? 'the image' : `${n} images`} with ChatGPT in the background ` +
      `(about ${45 * n} s). A notice will bring the comparison.`
  );
}

// --- background jobs ------------------------------------------------------------------

/** Waiting stops after this long per image, or after this many failed polls in a row. */
const JOB_TIMEOUT_MS = 15 * 60_000;
const JOB_MAX_POLL_FAILURES = 10;
const JOB_POLL_MS = 2000;

export async function enqueueUpscaleJob(
  plugin: RNPlugin,
  context: UpscalePopupContext,
  extra = ''
): Promise<void> {
  const job: UpscaleJob = {
    ...context,
    id: `upscale-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    extra,
    queuedAt: Date.now(),
  };
  const queue = (await plugin.storage.getSession<UpscaleJob[]>(pendingUpscaleJobsKey)) || [];
  await plugin.storage.setSession(pendingUpscaleJobsKey, [...queue, job]);
}

async function upscaleOne(context: UpscalePopupContext, image: UpscaleTarget, extra: string) {
  try {
    const taskId = await startUpscale(context, image, extra);
    const until = Date.now() + JOB_TIMEOUT_MS;
    let failures = 0;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, JOB_POLL_MS));
      try {
        const task = await getUpscaleTask(taskId);
        failures = 0;
        if (task.status === 'done') return task.result ?? { ok: false, message: 'no result' };
      } catch (err) {
        // A helper restart forgets its tasks: that answer repeats, a network blip does not.
        if (++failures >= JOB_MAX_POLL_FAILURES) {
          return { ok: false, message: `lost contact with the helper (${String(err)})` };
        }
      }
    }
    return { ok: false, message: `the helper took more than ${JOB_TIMEOUT_MS / 60_000} minutes` };
  } catch (err) {
    return { ok: false, message: String(err) };
  }
}

/**
 * Run a job's images one after another (ChatGPT is slow, and the helper runs Codex for
 * each), then post the notice: Review opens the popup with every result, failures
 * included, so they can be tried again from there.
 */
export async function runUpscaleJob(plugin: RNPlugin, job: UpscaleJob): Promise<void> {
  const name = job.title || 'Untitled rem';
  const results: UpscaleResult[] = [];
  for (const image of job.images) results.push(await upscaleOne(job, image, job.extra));

  const ok = results.filter((r) => r.ok);
  if (!ok.length) {
    await showNotice(plugin, {
      title: 'Upscale image: no result',
      message: `“${name}”: ${results.map((r) => r.message ?? 'failed').join('; ')}`,
      tone: 'error',
      openRemId: job.remId,
    });
    return;
  }
  const toCheck = ok.filter((r) => r.verdict !== 'pass').length;
  const failed = results.length - ok.length;
  const parts = [
    results.length === 1
      ? 'the upscaled image is ready to compare'
      : `${ok.length} of ${results.length} upscaled images are ready to compare`,
    toCheck
      ? `the check found differences in ${toCheck === 1 && ok.length === 1 ? 'it' : toCheck}`
      : 'the check found no changes',
    failed ? `${failed} failed` : '',
  ].filter(Boolean);
  const noticeId = `${job.id}-notice`;
  const review: UpscaleReviewContext = {
    remId: job.remId,
    title: job.title,
    kbId: job.kbId,
    images: job.images,
    results,
    noticeId,
  };
  await showNotice(plugin, {
    id: noticeId,
    title: 'Upscale image: ready to review',
    message: `“${name}”: ${parts.join('; ')}. Nothing is replaced until you approve it.`,
    tone: toCheck || failed ? 'info' : 'success',
    action: { label: 'Review', popup: UPSCALE_IMAGE_POPUP, data: review },
  });
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
