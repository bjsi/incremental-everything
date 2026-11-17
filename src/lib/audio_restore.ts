import { PluginRem, RichTextInterface, RNPlugin } from '@remnote/plugin-sdk';
import { MEDIA_BRIDGE_URL } from './media_bridge_url';
import { prepareForSetText, storeUrlsViaImport } from './localize_media';

/**
 * Audio stored with its real type, so that every RemNote client plays it.
 *
 * The plugin SDK has no upload call, and the data-URI door
 * (localize_media.ts) takes only `data:image/…`. A plugin that pushed audio
 * through it relabelled `data:image/mp3` (Sierra Pilots Importer, Oct 2026)
 * got it stored as `image/mp3` with no file extension. The desktop app plays
 * that, from its local copy; iOS streams it from S3, trusts the type and
 * refuses it ("The operation is not supported").
 *
 * The import door stores a file with the Content-Type it is served with, so
 * the Local Media Bridge helper serves the bytes as audio (POST /files sniffs
 * the real type) and RemNote fetches them from there:
 *  - restoreMislabelledAudio: the bridge op `restore-audio`, for audio already
 *    stored the wrong way;
 *  - storeServedMedia: the `store-media` request of the bridge for other
 *    plugins (external_media_bridge.ts), for audio they import.
 * Both need the helper running (desktop only).
 */

const LOG = '[AudioRestore]';
const LOCAL_FILE_PREFIX = '%LOCAL_FILE%';
const REMNOTE_FILE_HOST = 'https://remnote-user-data.s3.amazonaws.com/';
/** A batch may go this long without a file landing: a long audio uploads slowly. */
export const AUDIO_STALL_MS = 180_000;

/** The stored file's name, for an address in RemNote's storage. */
export function storedFileName(url: string): string | undefined {
  if (url.startsWith(LOCAL_FILE_PREFIX)) return url.slice(LOCAL_FILE_PREFIX.length) || undefined;
  if (url.startsWith(REMNOTE_FILE_HOST)) return url.slice(REMNOTE_FILE_HOST.length).split(/[?#]/)[0] || undefined;
  return undefined;
}

/**
 * An audio stored through the data-URI door. RemNote names every file it
 * stores with a known type `<128 random chars>.<ext>` (`.mpga`, `.mp3`, `.mp4`…);
 * the relabelled audio got no extension.
 */
export const isMislabelledAudioUrl = (url: string): boolean => {
  const name = storedFileName(url);
  return !!name && !name.includes('.');
};

/** Whether a URL is one the helper serves (the only kind storeServedMedia accepts). */
export const isBridgeFileUrl = (url: string) => url.startsWith(`${MEDIA_BRIDGE_URL}/files/`);

const audioUrlOf = (el: unknown): string | undefined =>
  el && typeof el === 'object' && (el as any).i === 'a' && typeof (el as any).url === 'string'
    ? (el as any).url
    : undefined;

/** Has the helper keep a RemNote-stored file under its real type; returns the address it serves it at. */
async function stageStoredFile(url: string, kbId: string | undefined): Promise<string> {
  const res = await fetch(`${MEDIA_BRIDGE_URL}/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, kbId }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || typeof body.url !== 'string') throw new Error(body.error || `helper answered ${res.status}`);
  if (typeof body.type !== 'string' || !body.type.startsWith('audio/')) {
    throw new Error(`not an audio file (${body.type ?? 'unknown type'})`);
  }
  return body.url;
}

/**
 * Stores the files the helper serves at `urls` in RemNote; url → stored URL
 * for those RemNote took.
 */
export async function storeServedMedia(plugin: RNPlugin, urls: string[]): Promise<Map<string, string>> {
  const accepted = urls.filter(isBridgeFileUrl);
  if (accepted.length < urls.length) console.warn(LOG, 'ignored URLs the helper does not serve', urls.filter((u) => !isBridgeFileUrl(u)));
  return storeUrlsViaImport(plugin, accepted, AUDIO_STALL_MS);
}

export interface AudioRestoreResult {
  ok: boolean;
  summary: string;
  /** Rems whose every mislabelled audio now points at a new copy. */
  fixed: string[];
  failed: string[];
  /** Rems with no mislabelled audio (or not found). */
  untouched: string[];
  /** Distinct files stored again. */
  files: number;
  error?: string;
}

/**
 * Stores again, under its real type, every mislabelled audio of `rems`
 * (text and back text) and points the players at the new copies. The old
 * files stay in RemNote's storage, unreferenced.
 */
export async function restoreMislabelledAudio(plugin: RNPlugin, rems: PluginRem[]): Promise<AudioRestoreResult> {
  const result: AudioRestoreResult = { ok: true, summary: '', fixed: [], failed: [], untouched: [], files: 0 };
  const targets = rems.filter((rem) =>
    [rem.text, rem.backText].some((rt) => (rt ?? []).some((el) => isMislabelledAudioUrl(audioUrlOf(el) ?? '')))
  );
  const targetIds = new Set(targets.map((rem) => rem._id));
  result.untouched = rems.filter((rem) => !targetIds.has(rem._id)).map((rem) => rem._id);

  const old = new Set<string>();
  for (const rem of targets) {
    for (const rt of [rem.text, rem.backText]) {
      for (const el of rt ?? []) {
        const url = audioUrlOf(el);
        if (url && isMislabelledAudioUrl(url)) old.add(url);
      }
    }
  }

  // 1. The helper serves each file under its real type.
  const kbId = (await plugin.kb.getCurrentKnowledgeBaseData())?._id;
  const staged = new Map<string, string>(); // old url → helper url
  for (const url of old) {
    try {
      staged.set(url, await stageStoredFile(url, kbId));
    } catch (e) {
      result.error ??= e instanceof Error ? e.message : String(e);
      console.warn(LOG, 'not staged', url, e);
    }
  }

  // 2. RemNote stores them from there.
  const hosted = await storeServedMedia(plugin, [...new Set(staged.values())]);
  const replacement = new Map<string, string>();
  for (const [url, served] of staged) {
    const stored = hosted.get(served);
    if (stored) replacement.set(url, stored);
  }
  result.files = new Set(replacement.values()).size;
  if (staged.size > replacement.size) result.error ??= 'RemNote did not store some files (timed out)';

  // 3. Point the players at the new copies. Re-read: the uploads took a while.
  for (const rem of targets) {
    try {
      const current = await plugin.rem.findOne(rem._id);
      if (!current) {
        result.failed.push(rem._id);
        continue;
      }
      let missing = false;
      const rewrite = (rt: RichTextInterface | undefined) => {
        if (!rt) return undefined;
        let changed = false;
        const next = rt.map((el) => {
          const url = audioUrlOf(el);
          if (!url || !isMislabelledAudioUrl(url)) return el;
          const stored = replacement.get(url);
          if (!stored) {
            missing = true;
            return el;
          }
          changed = true;
          return { ...(el as any), url: stored } as RichTextInterface[number];
        });
        return changed ? next : undefined;
      };
      const text = rewrite(current.text);
      const backText = rewrite(current.backText);
      if (text) await current.setText(prepareForSetText(text));
      if (backText) await current.setBackText(prepareForSetText(backText));
      (missing ? result.failed : result.fixed).push(rem._id);
    } catch (e) {
      console.error(LOG, 'could not rewrite', rem._id, e);
      result.error ??= e instanceof Error ? e.message : String(e);
      result.failed.push(rem._id);
    }
  }

  result.ok = result.failed.length === 0;
  result.summary =
    `${result.fixed.length} rem(s) fixed (${result.files} audio file(s) stored again)` +
    (result.failed.length ? `, ${result.failed.length} failed` : '') +
    (result.untouched.length ? `, ${result.untouched.length} with no audio to restore` : '');
  console.log(LOG, result.summary, result);
  return result;
}
