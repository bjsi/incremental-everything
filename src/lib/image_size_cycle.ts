import {
  BuiltInPowerupCodes,
  PluginRem,
  RemId,
  RichTextInterface,
  RNPlugin,
  SelectionType,
} from '@remnote/plugin-sdk';
import { getEffectiveSelection } from './editor_selection';
import {
  applyImageSizeStep,
  describeImageSize,
  ImageSizeStep,
  isSizableImage,
  isUnsizedImage,
  NaturalSize,
  nextImageSizeStep,
  sizeSignature,
} from './image_sizing';
import { safeRemTextToString } from './pdfUtils';
import { resolveQueueCommandTarget } from './queue_target';
import { sanitizeRichTextForSetText } from './richTextSanitize';

/**
 * The bridge half of "Cycle Image Size": find the images under a Rem and walk
 * them through Fit, Large, Medium, Small and back to how they were. The shapes
 * themselves are in lib/image_sizing.ts; the confirmation and the on-screen
 * feedback around a press are in lib/image_size_session.ts.
 */

const LOG = '[ImageSize]';

/** How far below the target the command reaches: children, grand- and great-grandchildren. */
export const IMAGE_SIZE_DEPTH = 3;

const MEASURE_TIMEOUT_MS = 8000;

/** The `percent` values setText accepts; anything else makes it drop the field. */
const VALID_PERCENTS = new Set([5, 25, 50, 100]);

/**
 * What the command has done, per Rem.
 *
 * Needed because a sized image looks exactly like one the user sized: without a
 * record the next press could not tell them apart, and the size to go back to
 * would be gone. Local rather than session, because that size may be one the
 * user chose: a plugin reload mid-cycle must not lose it. Device-only, and
 * forgotten after IMAGE_RECORD_MAX_AGE_MS.
 */
const IMAGE_SIZE_RECORDS_KEY = 'image-size-records';

const IMAGE_RECORD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface ImageRecord {
  /** The element before the first step touched it, for the Original step. */
  original: any;
  natural: NaturalSize;
  /** Size signature of what was last written; a mismatch means a manual resize since. */
  written: string;
  step: ImageSizeStep;
  /** The original is a size the user chose, so changing this image needs their consent. */
  userSized: boolean;
}

interface RemRecord {
  at: number;
  /** Keyed by image url. */
  images: Record<string, ImageRecord>;
}

type ImageRecords = Record<RemId, RemRecord>;

export interface ScannedImage {
  url: string;
  /** Whose size the image is on: `user` needs consent before it changes. */
  kind: 'unsized' | 'user';
  /** Its current size, for showing in the confirmation. */
  sizeLabel: string;
  original: any;
  natural: NaturalSize;
  /** The step an earlier press left it on, if any. */
  step?: ImageSizeStep;
}

interface ScannedRem {
  rem: PluginRem;
  /** Every image element of the Rem, resizable or not. */
  elements: any[];
  images: ScannedImage[];
}

export interface ImageScan {
  /** Rems looked at. */
  scanned: number;
  rems: ScannedRem[];
  /** Occlusions, drawings and PDF/HTML highlight images, never touched. */
  protectedImages: number;
  /** Images whose file could not be loaded to measure it. */
  unmeasurable: number;
}

export interface ImageSizeCycleResult {
  /** The step this press applied; undefined when nothing was eligible. */
  step?: ImageSizeStep;
  /** Rems looked at. */
  scanned: number;
  /** Images rewritten. */
  changed: number;
  /** Images left alone because the user has sized them and did not include them. */
  userSized: number;
  protectedImages: number;
  unmeasurable: number;
  /** Rems whose write threw. */
  failed: number;
}

export const scannedImages = (scan: ImageScan): ScannedImage[] =>
  scan.rems.flatMap((scanned) => scanned.images);

const imagesOf = (richText: RichTextInterface | undefined): any[] =>
  (richText ?? []).filter((el) => typeof el !== 'string' && (el as any).i === 'i');

/** The Rems the command applies to, read where the user is: queue or editor. */
export async function resolveImageSizeTargets(plugin: RNPlugin): Promise<PluginRem[]> {
  const url = await plugin.window.getURL();
  const inQueue = typeof url === 'string' && /\/(flashcards|need_to_learn)/.test(url);

  let remIds: RemId[] = [];
  if (inQueue) {
    // A Rem selected in the previewer wins over the card — see lib/queue_target.
    const target = await resolveQueueCommandTarget(plugin);
    if (target.remId) remIds = [target.remId];
  }
  if (remIds.length === 0) {
    const selection = await getEffectiveSelection(plugin);
    if (selection?.type === SelectionType.Rem && selection.remIds?.length) {
      remIds = selection.remIds;
    } else if (selection?.type === SelectionType.Text && selection.remId) {
      remIds = [selection.remId];
    }
  }
  if (remIds.length === 0) {
    const focused = await plugin.focus.getFocusedRem();
    if (focused) return [focused];
  }
  const rems = await Promise.all(remIds.map((id) => plugin.rem.findOne(id)));
  return rems.filter((rem): rem is PluginRem => !!rem);
}

/** The targets plus their descendants down to IMAGE_SIZE_DEPTH levels. */
async function collectScope(roots: PluginRem[]): Promise<PluginRem[]> {
  const seen = new Map<RemId, PluginRem>();
  let level = roots;
  for (let depth = 0; depth <= IMAGE_SIZE_DEPTH && level.length > 0; depth++) {
    const next: PluginRem[] = [];
    for (const rem of level) {
      if (seen.has(rem._id)) continue;
      seen.set(rem._id, rem);
      if (depth < IMAGE_SIZE_DEPTH) {
        // getChildrenRem, not the lazy `children` field, which is empty for
        // Rems whose document has not been loaded.
        next.push(...((await rem.getChildrenRem().catch(() => [])) || []));
      }
    }
    level = next;
  }
  return [...seen.values()];
}

/** A URL the image can be loaded from, or undefined. */
export async function resolveImageSrc(plugin: RNPlugin, element: any): Promise<string | undefined> {
  const src: string = element.url;
  if (/^(https?:|data:)/i.test(src)) return src;
  // `%LOCAL_FILE%…` — richText.toString resolves it to the stored file's URL.
  const resolved = (await safeRemTextToString(plugin, [element]).catch(() => '')).trim();
  return /^https?:/i.test(resolved) ? resolved : undefined;
}

/** The file's own pixel size, or undefined when it cannot be loaded. */
async function measureImage(plugin: RNPlugin, element: any): Promise<NaturalSize | undefined> {
  const src = await resolveImageSrc(plugin, element);
  if (!src) return undefined;
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => resolve(undefined), MEASURE_TIMEOUT_MS);
    const done = (size: NaturalSize | undefined) => {
      clearTimeout(timer);
      resolve(size);
    };
    img.onload = () =>
      done(
        img.naturalWidth > 0 && img.naturalHeight > 0
          ? { width: img.naturalWidth, height: img.naturalHeight }
          : undefined
      );
    img.onerror = () => done(undefined);
    img.src = src;
  });
}

async function isHighlightRem(rem: PluginRem): Promise<boolean> {
  try {
    if (await rem.hasPowerup(BuiltInPowerupCodes.PDFHighlight)) return true;
    return await rem.hasPowerup(BuiltInPowerupCodes.HTMLHighlight);
  } catch {
    return false;
  }
}

const readRecords = async (plugin: RNPlugin): Promise<ImageRecords> =>
  (await plugin.storage.getLocal<ImageRecords>(IMAGE_SIZE_RECORDS_KEY)) || {};

/** Everything under `roots` the command could resize, and how each image stands. Writes nothing. */
export async function scanImageScope(plugin: RNPlugin, roots: PluginRem[]): Promise<ImageScan> {
  const records = await readRecords(plugin);
  const scope = await collectScope(roots);
  const scan: ImageScan = { scanned: scope.length, rems: [], protectedImages: 0, unmeasurable: 0 };
  const measured = new Map<string, NaturalSize | undefined>();

  for (const rem of scope) {
    const elements = [...imagesOf(rem.text), ...imagesOf(rem.backText)];
    if (elements.length === 0) continue;

    // An area highlight's image IS the highlight; RemNote regenerates it.
    if (await isHighlightRem(rem)) {
      scan.protectedImages += elements.length;
      continue;
    }

    const record = records[rem._id];
    const images = new Map<string, ScannedImage>();
    for (const el of elements) {
      if (!isSizableImage(el)) {
        scan.protectedImages++;
        continue;
      }
      const known = record?.images[el.url];
      if (known && known.written === sizeSignature(el)) {
        images.set(el.url, {
          url: el.url,
          kind: known.userSized ? 'user' : 'unsized',
          sizeLabel: describeImageSize(el, known.natural, known.step),
          original: known.original,
          natural: known.natural,
          step: known.step,
        });
        continue;
      }
      if (!measured.has(el.url)) measured.set(el.url, await measureImage(plugin, el));
      const natural = measured.get(el.url);
      if (!natural) {
        scan.unmeasurable++;
        continue;
      }
      // Anything else here is new to the command, including an image resized
      // by hand since its last press: that size is the one to go back to now.
      images.set(el.url, {
        url: el.url,
        kind: isUnsizedImage(el, natural) ? 'unsized' : 'user',
        sizeLabel: describeImageSize(el, natural),
        original: el,
        natural,
      });
    }
    if (images.size > 0) scan.rems.push({ rem, elements, images: [...images.values()] });
  }
  return scan;
}

export interface ApplyImageSizesOptions {
  /** Go straight to this size instead of the one after the last press. */
  step?: ImageSizeStep;
  /** Also resize the images the user has sized. */
  includeUserSized: boolean;
}

/**
 * Move the images of `scan` to the next step of the cycle.
 *
 * The step is decided once per press — the one after whatever an earlier press
 * left on the first image it finds a record for, else Fit — and applied to every
 * eligible image, so a scope always ends up uniform.
 */
export async function applyImageSizes(
  plugin: RNPlugin,
  scan: ImageScan,
  { step: chosenStep, includeUserSized }: ApplyImageSizesOptions
): Promise<ImageSizeCycleResult> {
  const result: ImageSizeCycleResult = {
    scanned: scan.scanned,
    changed: 0,
    userSized: 0,
    protectedImages: scan.protectedImages,
    unmeasurable: scan.unmeasurable,
    failed: 0,
  };

  const plans: { rem: PluginRem; candidates: Map<string, ScannedImage> }[] = [];
  for (const { rem, elements, images } of scan.rems) {
    const eligible = images.filter((image) => includeUserSized || image.kind !== 'user');
    result.userSized += images.length - eligible.length;
    if (eligible.length === 0) continue;

    const candidates = new Map(eligible.map((image) => [image.url, image]));
    // setText drops a `percent` it does not accept. A neighbour carrying one
    // would silently lose it, so such a Rem is left as it is.
    const wouldDamageNeighbour = elements.some(
      (el) =>
        !candidates.has(el.url) && el.percent !== undefined && !VALID_PERCENTS.has(el.percent)
    );
    if (wouldDamageNeighbour) {
      result.userSized += eligible.length;
      continue;
    }
    plans.push({ rem, candidates });
  }

  if (plans.length === 0) return result;

  const step =
    chosenStep ??
    nextImageSizeStep(
      plans.flatMap(({ candidates }) => [...candidates.values()]).find((image) => image.step)?.step
    );
  result.step = step;

  const records = await readRecords(plugin);
  const now = Date.now();

  for (const { rem, candidates } of plans) {
    const written: Record<string, ImageRecord> = {};
    const resize = (richText: RichTextInterface | undefined): RichTextInterface | undefined => {
      if (imagesOf(richText).every((el) => !candidates.has(el.url))) return undefined;
      return richText!.map((element) => {
        const el = element as any;
        const candidate = typeof element !== 'string' && el.i === 'i' && candidates.get(el.url);
        if (!candidate || !isSizableImage(el)) return element;
        const sized = applyImageSizeStep(candidate.original, step, candidate.natural);
        written[el.url] = {
          original: candidate.original,
          natural: candidate.natural,
          written: sizeSignature(sized),
          step,
          userSized: candidate.kind === 'user',
        };
        return sized;
      }) as RichTextInterface;
    };

    try {
      const text = resize(rem.text);
      const backText = resize(rem.backText);
      if (text) await rem.setText(sanitizeRichTextForSetText(text));
      if (backText) await rem.setBackText(sanitizeRichTextForSetText(backText));
      result.changed += Object.keys(written).length;

      // Records of images this press left out stay: they hold sizes to go back to.
      const images = { ...records[rem._id]?.images, ...written };
      for (const [url, image] of Object.entries(written)) {
        // Back at Original an unsized image is unsized again, so its record goes
        // and the next press starts over. A user-sized one looks like any other
        // sized image, so it keeps its record to stay in the cycle.
        if (step === 'original' && !image.userSized) delete images[url];
      }
      if (Object.keys(images).length > 0) records[rem._id] = { at: now, images };
      else delete records[rem._id];
    } catch (error) {
      result.failed++;
      console.warn(`${LOG} could not resize the images of`, rem._id, error);
    }
  }

  for (const [remId, record] of Object.entries(records)) {
    if (now - record.at > IMAGE_RECORD_MAX_AGE_MS) delete records[remId];
  }
  await plugin.storage.setLocal(IMAGE_SIZE_RECORDS_KEY, records);
  console.log(`${LOG} ${step}:`, result);
  return result;
}
