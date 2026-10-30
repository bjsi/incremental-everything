import { RemId, ReactRNPlugin } from '@remnote/plugin-sdk';
import { imageSizeConfirmAboveId } from './consts';
import {
  applyImageSizes,
  ImageScan,
  ImageSizeCycleResult,
  resolveImageSizeTargets,
  resolveImageSrc,
  scanImageScope,
  scannedImages,
} from './image_size_cycle';
import { ImageSizeStep, needsImageSizeConfirmation } from './image_sizing';
import { showMessageDialog } from './message_dialog';
import { getIESetting } from './settings';

/**
 * Everything around one press of Cycle Image Size: whether it has to ask first,
 * and showing what it did. Runs in the index widget, which lives all session.
 *
 * The confirmation popup and the feedback widget ask for work by posting a
 * request to session storage rather than resizing themselves: the popup is torn
 * down the moment it closes, and every press has to go through one queue, or two
 * of them would read the same Rem and the second would write over the first.
 */

export const IMAGE_SIZE_CONFIRM_POPUP = 'image_size_confirm';
export const IMAGE_SIZE_FEEDBACK_WIDGET = 'image_size_feedback';

export const imageSizeFeedbackKey = 'image-size-feedback';
export const imageSizeRequestKey = 'image-size-request';
const imageSizeFeedbackIdKey = 'image-size-feedback-id';
const imageSizeGrantsKey = 'image-size-grants';

/** How long a confirmation holds for its target after the last press. */
const GRANT_IDLE_MS = 10 * 60 * 1000;

/** Bottom-right, clear of the answer buttons and of where toasts appear. */
const FEEDBACK_POSITION = { bottom: 24, right: 24 };

/** Thumbnails shown per group in the confirmation. */
const CONFIRM_THUMBNAILS = 12;

export interface ImageSizeRequest {
  /** Tells one request from the last; a repeat of the same click is a new one. */
  id: string;
  rootIds: RemId[];
  step?: ImageSizeStep;
  /** The answer from the confirmation; undefined means ask if needed. */
  includeUserSized?: boolean;
}

export interface ImageSizeFeedback {
  at: number;
  rootIds: RemId[];
  /** The size just set; undefined when nothing was resized. */
  step?: ImageSizeStep;
  changed: number;
  /** Shown instead of the count when nothing was resized. */
  message?: string;
  notes: string[];
}

export interface ImageSizeConfirmThumb {
  src?: string;
  label: string;
}

export interface ImageSizeConfirmContext {
  rootIds: RemId[];
  step?: ImageSizeStep;
  userSized: { count: number; thumbs: ImageSizeConfirmThumb[] };
  unsized: { count: number; thumbs: ImageSizeConfirmThumb[] };
  skippedNotes: string[];
}

interface Grant {
  includeUserSized: boolean;
  at: number;
}

const targetKey = (rootIds: RemId[]) => [...rootIds].sort().join(',');

export const newImageSizeRequestId = () => `${Date.now()}-${Math.random()}`;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

const skippedNotes = (counts: { protectedImages: number; unmeasurable: number }) =>
  [
    counts.protectedImages > 0 ? `${counts.protectedImages} occlusion/highlight skipped` : '',
    counts.unmeasurable > 0 ? `${counts.unmeasurable} could not be measured` : '',
  ].filter(Boolean);

const resultNotes = (result: ImageSizeCycleResult) =>
  [
    result.userSized > 0 ? `${result.userSized} sized by you kept` : '',
    ...skippedNotes(result),
    result.failed > 0 ? `${plural(result.failed, 'Rem')} failed` : '',
  ].filter(Boolean);

let feedbackWidgetId: string | null = null;

async function showFeedback(
  plugin: ReactRNPlugin,
  feedback: Omit<ImageSizeFeedback, 'at'>
): Promise<void> {
  await plugin.storage.setSession(imageSizeFeedbackKey, { ...feedback, at: Date.now() });
  const open =
    !!feedbackWidgetId &&
    (await plugin.window.isFloatingWidgetOpen(feedbackWidgetId).catch(() => false));
  if (open) return;
  feedbackWidgetId = await plugin.window.openFloatingWidget(
    IMAGE_SIZE_FEEDBACK_WIDGET,
    FEEDBACK_POSITION,
    undefined,
    false
  );
  await plugin.storage.setSession(imageSizeFeedbackIdKey, feedbackWidgetId);
}

async function thumbsOf(
  plugin: ReactRNPlugin,
  images: ReturnType<typeof scannedImages>
): Promise<ImageSizeConfirmThumb[]> {
  return Promise.all(
    images.slice(0, CONFIRM_THUMBNAILS).map(async (image) => ({
      src: await resolveImageSrc(plugin, image.original),
      label: image.sizeLabel,
    }))
  );
}

async function openConfirmation(plugin: ReactRNPlugin, request: ImageSizeRequest, scan: ImageScan) {
  const images = scannedImages(scan);
  const userSized = images.filter((image) => image.kind === 'user');
  const unsized = images.filter((image) => image.kind !== 'user');
  const context: ImageSizeConfirmContext = {
    rootIds: request.rootIds,
    step: request.step,
    userSized: { count: userSized.length, thumbs: await thumbsOf(plugin, userSized) },
    unsized: { count: unsized.length, thumbs: await thumbsOf(plugin, unsized) },
    skippedNotes: skippedNotes(scan),
  };
  await plugin.widget.openPopup(IMAGE_SIZE_CONFIRM_POPUP, context);
}

async function runRequest(plugin: ReactRNPlugin, request: ImageSizeRequest): Promise<void> {
  const { rootIds } = request;
  const found = await Promise.all(rootIds.map((id) => plugin.rem.findOne(id)));
  const roots = found.filter((rem): rem is NonNullable<typeof rem> => !!rem);
  const scan = await scanImageScope(plugin, roots);
  const images = scannedImages(scan);

  if (images.length === 0) {
    await showFeedback(plugin, {
      rootIds,
      changed: 0,
      message: 'No images to resize here.',
      notes: skippedNotes(scan),
    });
    return;
  }

  const now = Date.now();
  const key = targetKey(rootIds);
  const grants = (await plugin.storage.getSession<Record<string, Grant>>(imageSizeGrantsKey)) || {};
  const grant = grants[key] && now - grants[key].at < GRANT_IDLE_MS ? grants[key] : undefined;
  const answer = request.includeUserSized ?? grant?.includeUserSized;

  if (answer === undefined) {
    const askAbove = await getIESetting(plugin, imageSizeConfirmAboveId);
    const userSized = images.filter((image) => image.kind === 'user').length;
    if (needsImageSizeConfirmation({ total: images.length, userSized }, askAbove)) {
      await openConfirmation(plugin, request, scan);
      return;
    }
  } else {
    for (const [id, { at }] of Object.entries(grants)) {
      if (now - at >= GRANT_IDLE_MS) delete grants[id];
    }
    grants[key] = { includeUserSized: answer, at: now };
    await plugin.storage.setSession(imageSizeGrantsKey, grants);
  }

  const result = await applyImageSizes(plugin, scan, {
    step: request.step,
    includeUserSized: answer ?? false,
  });
  await showFeedback(plugin, {
    rootIds,
    step: result.step,
    changed: result.changed,
    message: result.step ? undefined : 'Nothing to resize here.',
    notes: resultNotes(result),
  });
}

/** One at a time, in the order they came: each reads what the last one wrote. */
let queue = Promise.resolve();

function enqueue(plugin: ReactRNPlugin, request: ImageSizeRequest): void {
  queue = queue
    .then(() => runRequest(plugin, request))
    .catch(async (error) => {
      console.error('[ImageSize] command failed', error);
      await showMessageDialog(plugin, {
        title: 'Could not resize the images',
        message: error instanceof Error ? error.message : String(error),
        tone: 'error',
      });
    });
}

/** The command's action. */
export async function pressCycleImageSize(plugin: ReactRNPlugin): Promise<void> {
  const targets = await resolveImageSizeTargets(plugin);
  if (targets.length === 0) {
    await showFeedback(plugin, {
      rootIds: [],
      changed: 0,
      message: 'No Rem focused and no card on screen.',
      notes: [],
    });
    return;
  }
  enqueue(plugin, { id: newImageSizeRequestId(), rootIds: targets.map((rem) => rem._id) });
}

export function registerImageSizeSession(plugin: ReactRNPlugin): void {
  void (async () => {
    // A widget left over from before a plugin reload has no owner any more, and
    // a request left over from then is not the user's next action.
    const stale = await plugin.storage.getSession<string>(imageSizeFeedbackIdKey);
    if (stale) await plugin.window.closeFloatingWidget(stale).catch(() => {});
    await plugin.storage.setSession(imageSizeFeedbackIdKey, null);
    await plugin.storage.setSession(imageSizeRequestKey, null);

    let lastId: string | undefined;
    plugin.track(async (rp) => {
      const request = await rp.storage.getSession<ImageSizeRequest>(imageSizeRequestKey);
      if (!request || request.id === lastId) return;
      lastId = request.id;
      enqueue(plugin, request);
    });
  })();
}
