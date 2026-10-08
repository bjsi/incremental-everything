/**
 * Giving imported images a size, the way RemNote's own UI would have.
 *
 * Why this exists: in the flashcard queue RemNote draws every plain image
 * through its zoomable drawing canvas, and an image that still carries the size
 * it was imported with — its full pixel dimensions, or none at all — can come
 * out as a zoomed crop behind the canvas's scrollbars. Images the user has
 * resized do not. See findings/QUEUE_AND_PRACTICE.md.
 *
 * What RemNote writes (read from the 1.28 bundle):
 *   - a drag-resize: `width`/`height` in on-screen pixels, `percent` removed;
 *   - Small / Medium / Large: `percent` 25 / 50 / 100, with `width`/`height`
 *     shrunk to fit the editor (never enlarged).
 * Either way the stored width ends up no wider than the editor, which is what an
 * untouched import violates. The steps below reproduce those shapes.
 *
 * Pure functions only — the bridge work lives in lib/image_size_cycle.ts.
 */

/**
 * Stand-in for "the editor's width", which a plugin cannot measure. It is the
 * widest drag-resized image found in a real knowledge base.
 */
export const IMAGE_FIT_MAX_WIDTH = 680;

export type ImageSizeStep = 'fit' | 'large' | 'medium' | 'original';

/** The order one command press after another walks through. */
export const IMAGE_SIZE_CYCLE: ImageSizeStep[] = ['fit', 'large', 'medium', 'original'];

export const IMAGE_SIZE_STEP_LABEL: Record<ImageSizeStep, string> = {
  fit: 'Fit',
  large: 'Large',
  medium: 'Medium',
  original: 'Original',
};

export const nextImageSizeStep = (current: ImageSizeStep | undefined): ImageSizeStep => {
  if (!current) return IMAGE_SIZE_CYCLE[0];
  return IMAGE_SIZE_CYCLE[(IMAGE_SIZE_CYCLE.indexOf(current) + 1) % IMAGE_SIZE_CYCLE.length];
};

export interface NaturalSize {
  width: number;
  height: number;
}

const isPositive = (value: unknown): value is number => typeof value === 'number' && value > 0;

/**
 * True for an image element this feature may resize at all.
 *
 * Image occlusions, drawings and crops are left alone: their shapes are stored
 * in coordinates tied to the image's `width`/`height`, so changing those would
 * move every occlusion box.
 */
export const isSizableImage = (element: unknown): boolean => {
  const el = element as any;
  if (!el || typeof el !== 'object' || el.i !== 'i') return false;
  if (typeof el.url !== 'string' || !el.url || el.url === 'about:blank') return false;
  if (el.blocks?.length || el.drawing || el.drawingData || el.imgId) return false;
  return true;
};

/** True when the element has no usable stored size, so its file must be measured. */
export const hasNoStoredSize = (element: unknown): boolean => {
  const el = element as any;
  return !isPositive(el?.width) || !isPositive(el?.height);
};

/**
 * True when nobody has sized this image in RemNote: it has no stored size, or
 * the stored size is still the file's own pixel size.
 *
 * `natural` undefined means the file could not be measured. An image with no
 * stored size is still unsized then; one WITH a size is given the benefit of
 * the doubt and treated as the user's.
 */
export const isUnsizedImage = (element: unknown, natural: NaturalSize | undefined): boolean => {
  if (!isSizableImage(element)) return false;
  if (hasNoStoredSize(element)) return true;
  if (!natural) return false;
  const el = element as any;
  return Math.abs(el.width - natural.width) < 1 && Math.abs(el.height - natural.height) < 1;
};

/** The three fields a step writes, for telling "ours" from a later manual resize. */
export const sizeSignature = (element: unknown): string => {
  const el = element as any;
  return [el?.width, el?.height, el?.percent].map((v) => (v === undefined ? '' : String(v))).join('|');
};

/**
 * The element as `step` would leave it. Every other field is kept, so titles,
 * upload metadata and attribution survive.
 *
 * `original` is what the element looked like before the first step touched it;
 * the `original` step hands it back.
 */
export const applyImageSizeStep = <T extends object>(
  original: T,
  step: ImageSizeStep,
  natural: NaturalSize
): T => {
  if (step === 'original') return { ...original };
  const width = Math.min(natural.width, IMAGE_FIT_MAX_WIDTH);
  const height = (natural.height * width) / natural.width;
  const { percent: _dropped, ...rest } = original as any;
  const sized = { ...rest, width, height };
  if (step === 'large') sized.percent = 100;
  if (step === 'medium') sized.percent = 50;
  return sized as T;
};
