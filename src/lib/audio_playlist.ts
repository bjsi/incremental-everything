/**
 * Audio Playlist: the audios under a rem, or in the rems carrying a tag, played one
 * after the other as a single recording, with the position remembered.
 *
 * RemNote draws one small player per inline audio (a bare <audio> and a 28 px bar):
 * nothing plays the next one, nothing remembers where a long one stopped, and the
 * player goes away with its rem. This is the missing layer: a list built from the
 * tree, played by one <audio> element in a floating widget (which the host keeps
 * mounted across documents and the queue, on a phone too).
 *
 *  - This file: building the list, what is stored, the commands, and the index's part
 *    (opening the player, and reopening it when the host closed it).
 *  - lib/audio_playlist_core.ts: the SDK-free arithmetic, tested.
 *  - widgets/audio_playlist_float.tsx: the player.
 *
 * A stored audio is a public file on RemNote's S3 (`audio/mpeg`, range requests, CORS
 * `*`), so a plugin frame can both play it and read its first bytes. Files are not
 * joined: the knowledge base mixes 24 kHz mono, 44.1 kHz stereo and 48 kHz clips, and
 * MP3s of different formats cannot be concatenated. "One audio" is a timeline laid
 * over the tracks.
 */
import { PluginRem, ReactRNPlugin, RNPlugin, SelectionType } from '@remnote/plugin-sdk';
import {
  AUDIO_PLAYLIST_FLOAT,
  audioPlaylistBranchCommandId,
  audioPlaylistDurationsKeyPrefix,
  audioPlaylistFloatIdKey,
  audioPlaylistOpenCommandId,
  audioPlaylistRequestKey,
  audioPlaylistStateKeyPrefix,
  audioPlaylistTagCommandId,
  audioPlaylistWantedKey,
  readAloudTagId,
} from './consts';
import {
  audioUrlsIn,
  captionOf,
  isGenericCaption,
  mp3Length,
  normalizePlayerState,
  PATH_LEVELS,
  PlayerState,
  PlaylistSpec,
  Track,
  urlKey,
} from './audio_playlist_core';
import { showMessageDialog } from './message_dialog';
import { isMobileDevice } from './mobileUtils';
import { resolveRemTextAsTitle } from './richTextRemRefs';
import { getIESetting } from './settings';

const LOG = '[AudioPlaylist]';

export interface AudioPlaylistRequest {
  spec: PlaylistSpec;
  /** Used when the spec's roots hold no audio: the document the command was run in. */
  fallbackRootId?: string;
  /** Start playing once built (the player may still need a tap, on a phone). */
  play: boolean;
  at: number;
}

export interface BuiltPlaylist {
  spec: PlaylistSpec;
  title: string;
  tracks: Track[];
  /** The fallback document was used: the roots asked for held no audio. */
  usedFallback?: boolean;
}

// ---------------------------------------------------------------------------
// Asking for a playlist, from anywhere

export async function requestPlaylist(
  plugin: RNPlugin,
  spec: PlaylistSpec,
  opts: { fallbackRootId?: string; play?: boolean } = {}
): Promise<void> {
  const request: AudioPlaylistRequest = {
    spec,
    fallbackRootId: opts.fallbackRootId,
    play: opts.play ?? true,
    at: Date.now(),
  };
  await plugin.storage.setSession(audioPlaylistRequestKey, request);
  await plugin.storage.setSession(audioPlaylistWantedKey, true);
}

/** Where the player opens: above the tab bar on a phone, bottom right elsewhere. */
export async function playerPosition(plugin: RNPlugin): Promise<{ bottom: number; right: number }> {
  return (await isMobileDevice(plugin)) ? { bottom: 96, right: 8 } : { bottom: 28, right: 28 };
}

/** The player with the playlist last heard, paused where it stopped. */
export async function openAudioPlayer(plugin: RNPlugin): Promise<void> {
  await plugin.storage.setSession(audioPlaylistWantedKey, true);
}

export async function closeAudioPlayer(plugin: RNPlugin): Promise<void> {
  await plugin.storage.setSession(audioPlaylistWantedKey, false);
}

/** The document shown in the focused pane. */
async function paneRemId(plugin: RNPlugin): Promise<string | undefined> {
  try {
    return (await plugin.window.getOpenPaneRemId(await plugin.window.getFocusedPaneId())) || undefined;
  } catch {
    return undefined;
  }
}

/** The audios of the selected rems, of the rem with the cursor, or of the open document. */
export async function playBranch(plugin: RNPlugin, remId?: string): Promise<void> {
  if (remId) return requestPlaylist(plugin, { rootIds: [remId] });
  const doc = await paneRemId(plugin);
  const selection = await plugin.editor.getSelection().catch(() => undefined);
  const selected = selection?.type === SelectionType.Rem ? selection.remIds : [];
  const focused = selected.length ? undefined : (await plugin.focus.getFocusedRem().catch(() => undefined))?._id;
  const rootIds = selected.length ? selected : focused ? [focused] : doc ? [doc] : [];
  if (!rootIds.length) {
    await plugin.app.toast('Audio Playlist: open a document or put the cursor in a rem first.');
    return;
  }
  // A cursor left in a leaf rem should not mean an empty playlist.
  await requestPlaylist(plugin, { rootIds }, { fallbackRootId: doc && !rootIds.includes(doc) ? doc : undefined });
}

/** Every audio in the rems tagged with a rem: the one given, the focused one, or the open document. */
export async function playTagged(plugin: RNPlugin, remId?: string): Promise<void> {
  const candidates = remId
    ? [remId]
    : [(await plugin.focus.getFocusedRem().catch(() => undefined))?._id, await paneRemId(plugin)];
  let named: string | undefined;
  for (const id of candidates) {
    const rem = id ? await plugin.rem.findOne(id) : undefined;
    if (!rem) continue;
    named ??= await resolveRemTextAsTitle(plugin, rem.text);
    if ((await rem.taggedRem().catch(() => []))?.length) {
      await requestPlaylist(plugin, { tagId: rem._id });
      return;
    }
  }
  await showMessageDialog(plugin, {
    title: 'Audio Playlist',
    message: named
      ? `No rem is tagged with “${named}”. Open the tag's own page (or put the cursor in the tag rem) and run this again.`
      : 'Open a tag’s page, or put the cursor in the tag rem, and run this again.',
    tone: 'info',
  });
}

// ---------------------------------------------------------------------------
// Building the list

const audioOf = (rem: PluginRem): string[] => [...audioUrlsIn(rem.text), ...audioUrlsIn(rem.backText)];

const withoutAudio = (richText: unknown): unknown =>
  Array.isArray(richText) ? richText.filter((el) => !(el && typeof el === 'object' && (el as any).i === 'a')) : richText;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

/**
 * The audio rems a spec names, in playing order.
 *
 * A branch is read with ONE getDescendants() per root. The host builds that list
 * depth-first over each rem's ordered children (`allDescendantIdsAsync`, read in the
 * 1.30.4 bundle), so it arrives in document order and no per-rem position call is
 * needed. Rems shown through a portal are not descendants and are not included.
 *
 * With a tag, a rem counts when it carries the tag or sits under a rem that does
 * (tagging a section's title takes the section's audios). Across the whole knowledge
 * base there is no document order to follow, so tagged rems play oldest first.
 */
async function collect(
  plugin: RNPlugin,
  spec: PlaylistSpec
): Promise<{ rems: PluginRem[]; known: Map<string, PluginRem> }> {
  const known = new Map<string, PluginRem>();
  const rems: PluginRem[] = [];
  const seen = new Set<string>();
  const add = (rem: PluginRem) => {
    if (seen.has(rem._id) || !audioOf(rem).length) return;
    seen.add(rem._id);
    rems.push(rem);
  };

  let tagged: PluginRem[] | undefined;
  if (spec.tagId) {
    const tag = await plugin.rem.findOne(spec.tagId);
    if (!tag) throw new Error('The tag this playlist was made from no longer exists.');
    tagged = ((await tag.taggedRem()) || []) as PluginRem[];
  }
  const taggedIds = tagged ? new Set(tagged.map((r) => r._id)) : undefined;

  if (spec.rootIds?.length) {
    const roots = ((await plugin.rem.findMany(spec.rootIds)) || []) as PluginRem[];
    for (const root of roots) {
      const all = [root, ...(((await root.getDescendants()) || []) as PluginRem[])];
      for (const rem of all) known.set(rem._id, rem);
      const underTag = new Map<string, boolean>();
      const qualifies = (rem: PluginRem): boolean => {
        if (!taggedIds) return true;
        const cached = underTag.get(rem._id);
        if (cached !== undefined) return cached;
        underTag.set(rem._id, false); // a cycle ends here
        const parent = rem._id !== root._id && rem.parent ? known.get(rem.parent) : undefined;
        const result = taggedIds.has(rem._id) || (!!parent && qualifies(parent));
        underTag.set(rem._id, result);
        return result;
      };
      for (const rem of all) if (qualifies(rem)) add(rem);
    }
    return { rems, known };
  }

  const ordered = [...(tagged ?? [])].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  const groups = await mapLimit(ordered, 4, async (rem) => {
    // The usual case is a tagged audio rem (Read Aloud tags its own): no subtree to read.
    if (audioOf(rem).length) return [rem];
    const below = ((await rem.getDescendants().catch(() => [])) || []) as PluginRem[];
    for (const d of below) known.set(d._id, d);
    return below.filter((d) => audioOf(d).length);
  });
  for (const rem of ordered) known.set(rem._id, rem);
  for (const group of groups) for (const rem of group) add(rem);
  return { rems, known };
}

async function nameOf(plugin: RNPlugin, id: string | undefined): Promise<string | undefined> {
  const rem = id ? await plugin.rem.findOne(id) : undefined;
  return rem ? resolveRemTextAsTitle(plugin, withoutAudio(rem.text)) : undefined;
}

export async function playlistTitle(plugin: RNPlugin, spec: PlaylistSpec): Promise<string> {
  const roots = (await Promise.all((spec.rootIds ?? []).slice(0, 2).map((id) => nameOf(plugin, id)))).filter(
    Boolean
  ) as string[];
  const more = (spec.rootIds?.length ?? 0) - roots.length;
  const tag = await nameOf(plugin, spec.tagId);
  const where = roots.length ? roots.join(', ') + (more > 0 ? ` +${more}` : '') : '';
  if (where && tag) return `${where} · #${tag}`;
  return where || (tag ? `#${tag}` : 'Audio playlist');
}

/**
 * A track is called by its own caption when that says something; an audio rem whose
 * caption only names the file ("🔊 Áudio (Kore)", as Read Aloud writes) is called
 * after the rem it sits under, which is what it reads.
 */
export async function buildPlaylist(plugin: RNPlugin, request: Pick<AudioPlaylistRequest, 'spec' | 'fallbackRootId'>): Promise<BuiltPlaylist> {
  let spec = request.spec;
  let { rems, known } = await collect(plugin, spec);
  let usedFallback = false;
  if (!rems.length && request.fallbackRootId) {
    const fallback: PlaylistSpec = { rootIds: [request.fallbackRootId], tagId: spec.tagId };
    const second = await collect(plugin, fallback);
    if (second.rems.length) {
      spec = fallback;
      rems = second.rems;
      known = second.known;
      usedFallback = true;
    }
  }

  // The rems above each audio, for its name and its path: the parent (which names an
  // audio with a file caption) and PATH_LEVELS more. A branch already holds most of
  // them; the rest (above the root, or anything in a tag-wide list) is read one level
  // at a time, one call per level.
  let level: PluginRem[] = rems;
  for (let depth = 0; depth <= PATH_LEVELS && level.length; depth++) {
    const parentIds = [...new Set(level.map((r) => r.parent).filter((p): p is string => !!p))];
    const missing = parentIds.filter((id) => !known.has(id));
    if (missing.length) {
      for (const parent of ((await plugin.rem.findMany(missing).catch(() => [])) || []) as PluginRem[]) {
        known.set(parent._id, parent);
      }
    }
    level = parentIds.map((id) => known.get(id)).filter((r): r is PluginRem => !!r);
  }

  const names = new Map<string, Promise<string>>();
  const title = (rem: PluginRem | undefined): Promise<string> | undefined => {
    if (!rem) return undefined;
    let name = names.get(rem._id);
    if (!name) {
      name = resolveRemTextAsTitle(plugin, withoutAudio(rem.text)).catch(() => 'Untitled');
      names.set(rem._id, name);
    }
    return name;
  };

  const perRem = await mapLimit(rems, 6, async (rem): Promise<Track[]> => {
    const urls = audioOf(rem);
    const parent = rem.parent ? known.get(rem.parent) : undefined;
    const generic = isGenericCaption(captionOf(rem.text));
    const own = generic ? undefined : await title(rem);
    const base = own ?? (await title(parent)) ?? 'Audio';
    // The path starts above the rem the name came from.
    const path: string[] = [];
    const walked = new Set<string>([rem._id]);
    let above = own ? parent : parent?.parent ? known.get(parent.parent) : undefined;
    while (above && path.length < PATH_LEVELS && !walked.has(above._id)) {
      walked.add(above._id);
      const name = await title(above);
      if (name && name !== 'Untitled') path.push(name);
      above = above.parent ? known.get(above.parent) : undefined;
    }
    return urls.map((url, i) => ({
      key: `${rem._id}#${i}`,
      remId: rem._id,
      url,
      title: urls.length > 1 ? `${base} (${i + 1})` : base,
      path,
    }));
  });

  return { spec, title: await playlistTitle(plugin, spec), tracks: perRem.flat(), usedFallback };
}

// ---------------------------------------------------------------------------
// What is stored. Plugin synced storage belongs to the account, not the knowledge
// base, so every key carries the KB id (findings/PLUGIN_BRIDGE_AND_SDK.md).

let kbId: Promise<string> | undefined;
const kbKey = async (plugin: RNPlugin, prefix: string): Promise<string> => {
  kbId ??= plugin.kb.getCurrentKnowledgeBaseData().then((kb) => kb._id);
  return `${prefix}_${await kbId}`;
};

export async function loadPlayerState(plugin: RNPlugin): Promise<PlayerState> {
  const key = await kbKey(plugin, audioPlaylistStateKeyPrefix);
  return normalizePlayerState(await plugin.storage.getSynced(key));
}

export async function savePlayerState(plugin: RNPlugin, state: PlayerState): Promise<void> {
  await plugin.storage.setSynced(await kbKey(plugin, audioPlaylistStateKeyPrefix), state);
}

/** File lengths in seconds, by urlKey. */
export type Durations = Record<string, number>;
const MAX_DURATIONS = 6000;

export async function loadDurations(plugin: RNPlugin): Promise<Durations> {
  const raw = await plugin.storage.getSynced<Durations>(await kbKey(plugin, audioPlaylistDurationsKeyPrefix));
  return raw && typeof raw === 'object' ? raw : {};
}

/** Adds to what is stored (another device may have measured other files meanwhile). */
export async function saveDurations(plugin: RNPlugin, added: Durations): Promise<void> {
  const key = await kbKey(plugin, audioPlaylistDurationsKeyPrefix);
  const stored = (await plugin.storage.getSynced<Durations>(key)) || {};
  let merged: Durations = { ...stored, ...added };
  const keys = Object.keys(merged);
  if (keys.length > MAX_DURATIONS) {
    // Oldest insertions first; anything dropped is simply measured again.
    merged = Object.fromEntries(keys.slice(keys.length - MAX_DURATIONS / 2).map((k) => [k, merged[k]]));
  }
  await plugin.storage.setSynced(key, merged);
}

/** Tags a playlist can be filtered by: Read Aloud's own, then the ones used before. */
export async function knownTags(plugin: RNPlugin, state: PlayerState): Promise<{ id: string; name: string }[]> {
  const tags: { id: string; name: string }[] = [];
  try {
    const name = String((await getIESetting(plugin, readAloudTagId)) ?? '').trim();
    const rem = name ? await plugin.rem.findByName([name], null) : undefined;
    if (rem) tags.push({ id: rem._id, name });
  } catch (err) {
    console.warn(LOG, 'could not read the Read Aloud tag', err);
  }
  for (const tag of state.tags) if (!tags.some((t) => t.id === tag.id)) tags.push(tag);
  return tags;
}

// ---------------------------------------------------------------------------
// A file's length, without playing it

const HEAD_BYTES = 8192;

async function readRange(url: string, from: number, signal: AbortSignal): Promise<{ bytes: Uint8Array; size: number } | undefined> {
  const res = await fetch(url, { headers: { Range: `bytes=${from}-${from + HEAD_BYTES - 1}` }, signal });
  if (!res.ok || !res.body) return undefined;
  const total =
    res.status === 206
      ? Number((res.headers.get('Content-Range') || '').split('/')[1])
      : Number(res.headers.get('Content-Length'));
  if (!isFinite(total) || total <= 0) return undefined;
  if (res.status !== 206 && from > 0) return undefined; // the server ignored the range
  // Read only the head, even from a server that sends the whole file.
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (length < HEAD_BYTES) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    length += value.length;
  }
  reader.cancel().catch(() => {});
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return { bytes, size: total };
}

/** From the MP3's first bytes: one small request, and it needs no media element. */
async function lengthFromBytes(url: string): Promise<number | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const head = await readRange(url, 0, controller.signal);
    if (!head) return undefined;
    let found = mp3Length(head.bytes, head.size);
    if (found && 'readFrom' in found) {
      const from = found.readFrom;
      const next = await readRange(url, from, controller.signal);
      found = next ? mp3Length(next.bytes, next.size, from) : undefined;
    }
    return found && 'seconds' in found ? found.seconds : undefined;
  } catch {
    return undefined; // no CORS on a linked file, offline, or not an MP3
  } finally {
    clearTimeout(timer);
  }
}

/** Element probes that timed out in a row; past two, the engine is not loading without a tap. */
let elementProbeFailures = 0;

/** From a detached <audio>: any format the device plays, where it loads metadata unasked. */
function lengthFromElement(url: string): Promise<number | undefined> {
  if (elementProbeFailures >= 2) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const audio = new Audio();
    let settled = false;
    const finish = (seconds: number | undefined, timedOut = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      elementProbeFailures = timedOut ? elementProbeFailures + 1 : 0;
      audio.removeAttribute('src');
      audio.load();
      resolve(seconds);
    };
    const timer = setTimeout(() => finish(undefined, true), 8000);
    audio.preload = 'metadata';
    audio.addEventListener('loadedmetadata', () =>
      finish(isFinite(audio.duration) && audio.duration > 0 ? audio.duration : undefined)
    );
    audio.addEventListener('error', () => finish(undefined));
    audio.src = url;
  });
}

export async function measureDuration(url: string): Promise<number | undefined> {
  const seconds = (await lengthFromBytes(url)) ?? (await lengthFromElement(url));
  return seconds === undefined ? undefined : Math.round(seconds * 10) / 10;
}

/** Measures what the cache lacks, a few at a time, reporting each as it lands. */
export async function measureMissing(
  tracks: Track[],
  durations: Durations,
  onMeasured: (key: string, seconds: number | undefined) => void,
  cancelled: () => boolean
): Promise<void> {
  const urls = new Map<string, string>();
  for (const track of tracks) {
    const key = urlKey(track.url);
    if (durations[key] === undefined) urls.set(key, track.url);
  }
  await mapLimit([...urls], 3, async ([key, url]) => {
    if (cancelled()) return;
    onMeasured(key, await measureDuration(url));
  });
}

// ---------------------------------------------------------------------------
// The index's part

/**
 * Commands, and keeping the player on screen while it is wanted. The host closes
 * every floating widget on an Escape that reaches its document, and a float has no
 * "closed" event, so the index looks every few seconds and reopens a player that
 * went away on its own; the player resumes from what it saved. Index only.
 */
export function registerAudioPlaylist(plugin: ReactRNPlugin) {
  void plugin.app.registerCommand({
    id: audioPlaylistBranchCommandId,
    name: 'Audio Playlist: Play This Branch',
    description:
      'Play every audio under the selected rems, the rem with the cursor or the open document, one after the other, in a floating player that remembers where you stopped.',
    quickCode: 'apb',
    action: async () => playBranch(plugin),
  });
  void plugin.app.registerCommand({
    id: audioPlaylistTagCommandId,
    name: 'Audio Playlist: Play Rems Tagged With This Rem',
    description:
      'Play every audio in the rems tagged with the focused rem or the open document (a tag’s own page), across the knowledge base.',
    quickCode: 'apt',
    action: async () => playTagged(plugin),
  });
  void plugin.app.registerCommand({
    id: audioPlaylistOpenCommandId,
    name: 'Audio Playlist: Open Player',
    description: 'Open the audio playlist player on the playlist last heard, where it stopped.',
    quickCode: 'apo',
    action: async () => openAudioPlayer(plugin),
  });

  let floatId: string | undefined;
  let wanted = false;
  let running = Promise.resolve();
  const sync = () => {
    running = running
      .then(async () => {
        wanted = !!(await plugin.storage.getSession<boolean>(audioPlaylistWantedKey));
        const open = !!floatId && (await plugin.window.isFloatingWidgetOpen(floatId).catch(() => false));
        if (wanted && !open) {
          floatId = await plugin.window.openFloatingWidget(AUDIO_PLAYLIST_FLOAT, await playerPosition(plugin), undefined, false);
          await plugin.storage.setSession(audioPlaylistFloatIdKey, floatId);
        } else if (!wanted && open && floatId) {
          await plugin.window.closeFloatingWidget(floatId).catch(() => {});
          floatId = undefined;
          await plugin.storage.setSession(audioPlaylistFloatIdKey, null);
        }
      })
      .catch((err) => console.warn(LOG, 'could not open or close the player', err));
  };

  void (async () => {
    // A player left from before a plugin reload runs the old code and has no owner.
    const stale = await plugin.storage.getSession<string>(audioPlaylistFloatIdKey);
    if (stale) await plugin.window.closeFloatingWidget(stale).catch(() => {});
    await plugin.storage.setSession(audioPlaylistFloatIdKey, null);
    plugin.track(async (rp) => {
      await rp.storage.getSession(audioPlaylistWantedKey);
      sync();
    });
    setInterval(() => {
      if (wanted) sync();
    }, 4000);
  })();
}
