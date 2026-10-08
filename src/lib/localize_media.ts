import { RNPlugin, PluginRem, RichTextInterface } from '@remnote/plugin-sdk';
import { sanitizeRichTextForSetText } from './richTextSanitize';

/**
 * Turning linked images and audio into files RemNote stores itself.
 *
 * Why this exists: an image or audio inserted through "Embed Link" is saved as
 * the bare URL — `{ i: 'a', url: 'https://dictionary.example/word.mp3' }` — and
 * nothing is copied. The day that server moves the file, the rem holds a dead
 * player. An *uploaded* file is different: RemNote keeps its own copy and the
 * element points at `%LOCAL_FILE%<name>`. This module converts the former into
 * the latter.
 *
 * The plugin SDK has no upload call, so the bytes reach RemNote's storage
 * through two side doors that the app's own importer leaves open:
 *
 *  1. Data-URI door (images only). The markdown image rule uploads a
 *     `![](data:image/…;base64,…)` on the spot and returns the stored URL, and
 *     `richText.parseFromMarkdown` runs that rule. The plugin fetches the bytes
 *     and hands them over; the answer comes back in the same call.
 *
 *  2. Import door (images and audio). A rem created from markdown is queued for
 *     RemNote's "re-upload external images" job, which fetches every image
 *     element's URL and stores whatever comes back, without checking that it is
 *     a picture. So a throwaway rem holding `![](https://…/word.mp3)` gets its
 *     URL swapped for a stored `.mpga`, which is then harvested and the rem
 *     deleted. The fetch is RemNote's, and the swap happens in the background,
 *     hence the polling. Confirmed working on RemNote 1.28.19 (about 2s a file).
 *
 * Both doors are implementation details of RemNote, not SDK contract. If either
 * closes, the affected URLs are reported as failed and the rem is left as it was.
 */

export type MediaKind = 'image' | 'audio';

export interface ExternalMedia {
  kind: MediaKind;
  url: string;
}

export interface LocalizeMediaResult {
  /** Rems looked at. */
  scanned: number;
  /** Rems whose text was rewritten. */
  updatedRems: number;
  /** Distinct external URLs now stored in RemNote. */
  localized: number;
  /** Distinct external URLs that could not be fetched or stored. */
  failed: string[];
}

const LOG = '[localize-media]';
const LOCAL_FILE_PREFIX = '%LOCAL_FILE%';
const REMNOTE_FILE_HOST = 'remnote-user-data.s3.amazonaws.com';

/** How long the import door is given to swap the URL before giving up. */
const REUPLOAD_TIMEOUT_MS = 30_000;
const REUPLOAD_POLL_MS = 500;
const FETCH_TIMEOUT_MS = 30_000;
/**
 * URLs carried by one throwaway rem. `createSingleRemWithMarkdown` makes a
 * second, empty top-level rem as a side effect that nothing links to, so it
 * cannot be found and removed afterwards. Batching keeps that to one stray per
 * batch instead of one per file.
 */
const IMPORT_BATCH_SIZE = 20;
/** Above this the data URI is too big to be worth posting across the sandbox. */
const MAX_DATA_URI_BYTES = 20_000_000;

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

/** True for a file RemNote already stores: an upload, a paste, a recording. */
export const isRemNoteHostedUrl = (url: string): boolean => {
  if (url.startsWith(LOCAL_FILE_PREFIX)) return true;
  try {
    return new URL(url).hostname === REMNOTE_FILE_HOST;
  } catch {
    return false;
  }
};

/** True for a web link that lives on someone else's server. */
export const isExternalMediaUrl = (url: unknown): url is string =>
  typeof url === 'string' && /^https?:\/\//i.test(url) && !isRemNoteHostedUrl(url);

/**
 * The image and audio elements of a rich text that still point at an outside
 * server. A video element shares the audio type (`i: 'a'`) but is usually a
 * YouTube page rather than a file, so only `onlyAudio` players are taken.
 */
export const collectExternalMedia = (richText: RichTextInterface | undefined): ExternalMedia[] => {
  const found: ExternalMedia[] = [];
  for (const element of richText ?? []) {
    if (typeof element === 'string') continue;
    const el = element as any;
    if (!isExternalMediaUrl(el.url)) continue;
    if (el.i === 'i') found.push({ kind: 'image', url: el.url });
    else if (el.i === 'a' && el.onlyAudio === true) found.push({ kind: 'audio', url: el.url });
  }
  return found;
};

/**
 * Swap media URLs according to `stored` (external URL -> RemNote URL). Returns
 * the same array when nothing matched, so the caller can skip the write.
 */
export const replaceMediaUrls = (
  richText: RichTextInterface,
  stored: Map<string, string>
): RichTextInterface => {
  let changed = false;
  const next = richText.map((element) => {
    if (typeof element === 'string') return element;
    const el = element as any;
    if ((el.i !== 'i' && el.i !== 'a') || !stored.has(el.url)) return element;
    changed = true;
    return { ...el, url: stored.get(el.url) };
  });
  return changed ? (next as RichTextInterface) : richText;
};

const MARKDOWN_URL_ESCAPES: Record<string, string> = {
  '(': '%28',
  ')': '%29',
  '<': '%3C',
  '>': '%3E',
};

/** `![](url)` with the characters that would end the markdown link escaped. */
export const markdownImageFor = (url: string): string =>
  `![](${url.replace(/[()<>]|\s/g, (c) => MARKDOWN_URL_ESCAPES[c] ?? encodeURIComponent(c))})`;

/** The URLs of a rich text's image elements, in order. */
export const imageUrlsOf = (richText: RichTextInterface | undefined): string[] =>
  (richText ?? [])
    .filter((element) => typeof element !== 'string' && (element as any).i === 'i')
    .map((element) => String((element as any).url ?? ''));

/** The first image element RemNote stores itself, if any. */
export const findHostedImageUrl = (richText: RichTextInterface | undefined): string | undefined =>
  imageUrlsOf(richText).find(isRemNoteHostedUrl);

/** An image MIME type for the blob, falling back on the URL's extension. */
export const imageMimeFor = (blobType: string, url: string): string | undefined => {
  const mime = blobType.split(';')[0].trim().toLowerCase();
  if (mime.startsWith('image/')) return mime;
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // keep the raw string
  }
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_MIME_BY_EXTENSION[extension];
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(blob);
  });

/** Door 1: fetch the image here and let the markdown parser upload it. */
const storeImageViaDataUri = async (plugin: RNPlugin, url: string): Promise<string | undefined> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let blob: Blob;
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return undefined;
    blob = await response.blob();
  } finally {
    clearTimeout(timer);
  }
  const mime = imageMimeFor(blob.type, url);
  if (!mime || blob.size === 0 || blob.size > MAX_DATA_URI_BYTES) return undefined;
  const parsed = await plugin.richText.parseFromMarkdown(
    `![](data:${mime};base64,${await blobToBase64(blob)})`
  );
  return findHostedImageUrl(parsed);
};

/**
 * Door 2: let RemNote's import job fetch and store the files, then harvest them.
 *
 * One throwaway rem carries the whole batch, an image element per URL, and the
 * job swaps them one by one; `onStored` fires as each lands. The deadline is
 * pushed back on every swap, so only a stall gives up, not a long batch.
 */
const storeViaImportedRem = async (
  plugin: RNPlugin,
  urls: string[],
  onStored: (url: string, hosted: string) => void
): Promise<void> => {
  const temp = await plugin.rem.createSingleRemWithMarkdown(urls.map(markdownImageFor).join(' '));
  if (!temp) return;
  try {
    const harvested = new Set<number>();
    let deadline = Date.now() + REUPLOAD_TIMEOUT_MS;
    while (harvested.size < urls.length && Date.now() < deadline) {
      await sleep(REUPLOAD_POLL_MS);
      const current = await plugin.rem.findOne(temp._id);
      if (!current) return;
      const now = imageUrlsOf(current.text);
      // Results are matched to requests by position, so the parser must have
      // kept exactly one image per URL.
      if (now.length !== urls.length) return;
      now.forEach((url, index) => {
        if (harvested.has(index) || !isRemNoteHostedUrl(url)) return;
        harvested.add(index);
        deadline = Date.now() + REUPLOAD_TIMEOUT_MS;
        onStored(urls[index], url);
      });
    }
  } finally {
    await temp.remove();
  }
};

/**
 * The shared sanitizer keeps an audio `percent` verbatim, but the stored value
 * is sometimes a float (59.42…) that `setText` rejects outright.
 */
const prepareForSetText = (richText: RichTextInterface): RichTextInterface =>
  sanitizeRichTextForSetText(richText).map((element) => {
    const el = element as any;
    if (typeof element === 'string' || el.i !== 'a' || el.percent === undefined) return element;
    if ([25, 50, 100].includes(el.percent)) return element;
    const { percent: _dropped, ...rest } = el;
    return rest;
  }) as RichTextInterface;

/**
 * Store every externally linked image and audio of `rems` in RemNote and point
 * the rems at the stored copies. A URL shared by several rems is fetched once.
 */
export const localizeMediaInRems = async (
  plugin: RNPlugin,
  rems: PluginRem[]
): Promise<LocalizeMediaResult> => {
  const pending = new Map<string, ExternalMedia>();
  for (const rem of rems) {
    for (const media of [...collectExternalMedia(rem.text), ...collectExternalMedia(rem.backText)]) {
      if (!pending.has(media.url)) pending.set(media.url, media);
    }
  }

  console.log(
    `${LOG} ${rems.length} rem(s) scanned, ${pending.size} externally linked file(s) found`,
    [...pending.keys()]
  );

  const stored = new Map<string, string>();
  const store = (url: string, hosted: string) => {
    stored.set(url, hosted);
    console.log(`${LOG} stored ${stored.size}/${pending.size}: ${url} -> ${hosted}`);
  };

  // Images go through the data-URI door first; audio, and any image that door
  // turned away, are left for the import door.
  const forImport: string[] = [];
  for (const media of pending.values()) {
    if (media.kind === 'image') {
      try {
        const hosted = await storeImageViaDataUri(plugin, media.url);
        if (hosted) {
          store(media.url, hosted);
          continue;
        }
      } catch (error) {
        console.warn(`${LOG} data-URI upload failed, trying the import job`, media.url, error);
      }
    }
    forImport.push(media.url);
  }
  for (let start = 0; start < forImport.length; start += IMPORT_BATCH_SIZE) {
    try {
      await storeViaImportedRem(plugin, forImport.slice(start, start + IMPORT_BATCH_SIZE), store);
    } catch (error) {
      console.warn(`${LOG} import-job upload failed`, error);
    }
  }
  const failed = [...pending.keys()].filter((url) => !stored.has(url));
  if (failed.length > 0) console.warn(`${LOG} could not store, left linked:`, failed);

  let updatedRems = 0;
  if (stored.size > 0) {
    for (const rem of rems) {
      // Re-read: the uploads took a while and the rem may have been edited since.
      const current = await plugin.rem.findOne(rem._id);
      if (!current) continue;
      const text = current.text ? replaceMediaUrls(current.text, stored) : undefined;
      const backText = current.backText ? replaceMediaUrls(current.backText, stored) : undefined;
      const textChanged = !!text && text !== current.text;
      const backChanged = !!backText && backText !== current.backText;
      if (textChanged) await current.setText(prepareForSetText(text!));
      if (backChanged) await current.setBackText(prepareForSetText(backText!));
      if (textChanged || backChanged) updatedRems++;
    }
  }

  console.log(
    `${LOG} done: ${stored.size} file(s) stored, ${updatedRems} rem(s) updated, ${failed.length} failed`
  );
  return { scanned: rems.length, updatedRems, localized: stored.size, failed };
};
