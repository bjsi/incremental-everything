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
 * The bridge half of "Cycle Image Size": find the images under a Rem that
 * nobody has sized, and walk them through Fit, Large, Medium and back to how
 * they were. The shapes themselves are in lib/image_sizing.ts.
 */

const LOG = '[ImageSize]';

/** How far below the target the command reaches: children, grand- and great-grandchildren. */
export const IMAGE_SIZE_DEPTH = 3;

const MEASURE_TIMEOUT_MS = 8000;

/** The `percent` values setText accepts; anything else makes it drop the field. */
const VALID_PERCENTS = new Set([5, 25, 50, 100]);

/**
 * What the command has done this session.
 *
 * Needed because a sized image looks exactly like one the user sized: without
 * a record the second press would skip everything the first one changed. Kept
 * for the session only — after a restart those images count as sized.
 */
const IMAGE_SIZE_CYCLE_KEY = 'image-size-cycle-state';

interface ImageRecord {
  /** The element before the first step touched it, for the Original step. */
  original: any;
  natural: NaturalSize;
  /** Size signature of what was last written; a mismatch means a manual resize since. */
  written: string;
}

interface RemRecord {
  step: ImageSizeStep;
  /** Keyed by image url. */
  images: Record<string, ImageRecord>;
}

type CycleState = Record<RemId, RemRecord>;

export interface ImageSizeCycleResult {
  /** The step this press applied; undefined when nothing was eligible. */
  step?: ImageSizeStep;
  /** Rems looked at. */
  scanned: number;
  /** Images rewritten. */
  changed: number;
  /** Images left alone because the user has already sized them. */
  userSized: number;
  /** Occlusions, drawings and PDF/HTML highlight images, never touched. */
  protectedImages: number;
  /** Unsized images whose file could not be loaded to measure it. */
  unmeasurable: number;
  /** Rems whose write threw. */
  failed: number;
}

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

/** The file's own pixel size, or undefined when it cannot be loaded. */
async function measureImage(plugin: RNPlugin, element: any): Promise<NaturalSize | undefined> {
  let src: string = element.url;
  if (!/^(https?:|data:)/i.test(src)) {
    // `%LOCAL_FILE%…` — richText.toString resolves it to the stored file's URL.
    src = (await safeRemTextToString(plugin, [element]).catch(() => '')).trim();
    if (!/^https?:/i.test(src)) return undefined;
  }
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

interface Candidate {
  original: any;
  natural: NaturalSize;
}

interface RemPlan {
  rem: PluginRem;
  /** Keyed by image url. */
  candidates: Map<string, Candidate>;
  /** The step this Rem was left on by an earlier press, if any. */
  previousStep?: ImageSizeStep;
}

/**
 * Move every unsized image under `roots` to the next step of the cycle.
 *
 * The step is decided once per press — the one after whatever an earlier press
 * left on the first Rem it finds a record for, else Fit — and applied to every
 * eligible image, so a scope always ends up uniform.
 */
export async function cycleImageSizes(
  plugin: RNPlugin,
  roots: PluginRem[]
): Promise<ImageSizeCycleResult> {
  const result: ImageSizeCycleResult = {
    scanned: 0,
    changed: 0,
    userSized: 0,
    protectedImages: 0,
    unmeasurable: 0,
    failed: 0,
  };
  const state = (await plugin.storage.getSession<CycleState>(IMAGE_SIZE_CYCLE_KEY)) || {};
  const scope = await collectScope(roots);
  result.scanned = scope.length;

  const measured = new Map<string, NaturalSize | undefined>();
  const plans: RemPlan[] = [];

  for (const rem of scope) {
    const images = [...imagesOf(rem.text), ...imagesOf(rem.backText)];
    if (images.length === 0) continue;

    // An area highlight's image IS the highlight; RemNote regenerates it.
    if (await isHighlightRem(rem)) {
      result.protectedImages += images.length;
      continue;
    }

    const record = state[rem._id];
    const candidates = new Map<string, Candidate>();
    let ours = false;
    for (const el of images) {
      if (!isSizableImage(el)) {
        result.protectedImages++;
        continue;
      }
      const known = record?.images[el.url];
      if (known && known.written === sizeSignature(el)) {
        candidates.set(el.url, { original: known.original, natural: known.natural });
        ours = true;
        continue;
      }
      if (!measured.has(el.url)) measured.set(el.url, await measureImage(plugin, el));
      const natural = measured.get(el.url);
      if (!isUnsizedImage(el, natural)) {
        result.userSized++;
      } else if (!natural) {
        result.unmeasurable++;
      } else {
        candidates.set(el.url, { original: el, natural });
      }
    }
    if (candidates.size === 0) continue;

    // setText drops a `percent` it does not accept. A user-sized neighbour
    // carrying one would silently lose it, so such a Rem is left as it is.
    const wouldDamageNeighbour = images.some(
      (el) =>
        !candidates.has(el.url) && el.percent !== undefined && !VALID_PERCENTS.has(el.percent)
    );
    if (wouldDamageNeighbour) {
      result.userSized += candidates.size;
      continue;
    }
    plans.push({ rem, candidates, previousStep: ours ? record?.step : undefined });
  }

  if (plans.length === 0) return result;

  const step = nextImageSizeStep(plans.find((plan) => plan.previousStep)?.previousStep);
  result.step = step;

  for (const { rem, candidates } of plans) {
    const written: Record<string, ImageRecord> = {};
    const resize = (richText: RichTextInterface | undefined): RichTextInterface | undefined => {
      if (imagesOf(richText).every((el) => !candidates.has(el.url))) return undefined;
      return richText!.map((element) => {
        const el = element as any;
        const candidate = typeof element !== 'string' && el.i === 'i' && candidates.get(el.url);
        if (!candidate || !isSizableImage(el)) return element;
        const sized = applyImageSizeStep(candidate.original, step, candidate.natural);
        written[el.url] = { ...candidate, written: sizeSignature(sized) };
        return sized;
      }) as RichTextInterface;
    };

    try {
      const text = resize(rem.text);
      const backText = resize(rem.backText);
      if (text) await rem.setText(sanitizeRichTextForSetText(text));
      if (backText) await rem.setBackText(sanitizeRichTextForSetText(backText));
      result.changed += Object.keys(written).length;

      // Back at Original the images are unsized again, so the record goes and
      // the next press starts the cycle over.
      if (step === 'original') delete state[rem._id];
      else state[rem._id] = { step, images: written };
    } catch (error) {
      result.failed++;
      console.warn(`${LOG} could not resize the images of`, rem._id, error);
    }
  }

  await plugin.storage.setSession(IMAGE_SIZE_CYCLE_KEY, state);
  console.log(`${LOG} ${step}:`, result);
  return result;
}
