/**
 * Audio Playlist, the parts with no SDK in them: finding the audio in a rem's rich
 * text, reading an MP3's length from its first bytes, and the arithmetic of playing
 * several files as one (lib/audio_playlist.ts builds the lists; the player is
 * widgets/audio_playlist_float.tsx). Tested in audio_playlist_core.test.ts.
 */

/** What a playlist is made from: a branch (or several), a tag, or a tag within branches. */
export interface PlaylistSpec {
  /** Rems whose subtrees are searched, in the order given. Absent = the whole knowledge base. */
  rootIds?: string[];
  /** Keep only audio in rems carrying this tag, or under a rem carrying it. */
  tagId?: string;
}

export interface Track {
  /** Stable across rebuilds: the rem, and which of its audios. */
  key: string;
  remId: string;
  url: string;
  title: string;
  /**
   * Where it sits: the names of the rems above the one the title came from, nearest
   * first, a few levels up. Nearest first so that a line cut short loses the far ones.
   */
  path?: string[];
}

/** How many levels above the titled rem a track's path names. */
export const PATH_LEVELS = 3;

/** A track's path on one line, nearest ancestor first. */
export const pathLine = (track: Pick<Track, 'path'>): string => (track.path ?? []).join(' ‹ ');

/** Tracks shorter than this are pronunciations and sound effects, left out by default. */
export const MIN_TRACK_SECONDS = 5;

const REMNOTE_FILE_HOST = 'https://remnote-user-data.s3.amazonaws.com/';
const LOCAL_FILE_PREFIX = '%LOCAL_FILE%';

export const specKey = (spec: PlaylistSpec): string =>
  `${(spec.rootIds ?? []).join(',')}|${spec.tagId ?? ''}`;

export const isValidSpec = (spec: PlaylistSpec | undefined | null): spec is PlaylistSpec =>
  !!spec && (!!spec.rootIds?.length || !!spec.tagId);

/**
 * The address an audio element plays from. A stored file is written either as
 * RemNote's own host or as `%LOCAL_FILE%<name>`; both are the same public file.
 * Anything else that is not http(s) (a blob:, a file:) cannot be played from a
 * plugin frame.
 */
export function playableUrl(url: unknown): string | undefined {
  if (typeof url !== 'string' || !url) return undefined;
  if (url.startsWith(LOCAL_FILE_PREFIX)) {
    const name = url.slice(LOCAL_FILE_PREFIX.length);
    return name ? REMNOTE_FILE_HOST + name : undefined;
  }
  return /^https?:\/\//i.test(url) ? url : undefined;
}

/** YouTube and Drive links sit in audio elements too, and are pages, not files. */
const NOT_A_FILE = /(^https?:\/\/(www\.)?(youtube\.com|youtu\.be|drive\.google\.com|vimeo\.com)\/)/i;

/** The playable audio addresses in one rich text, in reading order. */
export function audioUrlsIn(richText: unknown): string[] {
  if (!Array.isArray(richText)) return [];
  const out: string[] = [];
  for (const el of richText) {
    if (!el || typeof el !== 'object') continue;
    const item = el as { i?: string; url?: unknown; onlyAudio?: boolean };
    // An 'a' element without onlyAudio is a video.
    if (item.i !== 'a' || !item.onlyAudio) continue;
    const url = playableUrl(item.url);
    if (url && !NOT_A_FILE.test(url)) out.push(url);
  }
  return out;
}

/**
 * The written part of an audio rem's text: its caption. Formatting is dropped and
 * rem references are skipped (the caller resolves a full title when it needs one).
 */
export function captionOf(richText: unknown): string {
  if (!Array.isArray(richText)) return '';
  return richText
    .map((el) => {
      if (typeof el === 'string') return el;
      const item = el as { i?: string; text?: unknown };
      return item?.i === 'm' && typeof item.text === 'string' ? item.text : '';
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A caption that names the file rather than the content ("🔊 Áudio (Kore)", "Audio",
 * nothing at all): the track is then called after the rem it sits under.
 */
export function isGenericCaption(caption: string): boolean {
  const text = caption.trim();
  if (!text) return true;
  if (/^(🔊|🔉|🔈|🎧|🎵|▶️?)/u.test(text)) return true;
  // The bare word, with at most a number or a bracketed note after it.
  return /^(áudio|audio|recording|gravação|pronunciation|pronúncia)\s*(\d+|\([^)]*\))?\s*[:.]?$/i.test(text);
}

/** A short, stable name for an address, to key its cached length by. */
export function urlKey(url: string): string {
  if (url.startsWith(REMNOTE_FILE_HOST)) {
    // RemNote's names are 128 random characters; 20 are plenty.
    return url.slice(REMNOTE_FILE_HOST.length).split(/[?#]/)[0].slice(0, 20);
  }
  let hash = 5381;
  for (let i = 0; i < url.length; i++) hash = ((hash << 5) + hash + url.charCodeAt(i)) | 0;
  return `u${(hash >>> 0).toString(36)}${url.length.toString(36)}`;
}

// ---------------------------------------------------------------------------
// MP3 length from the head of the file

const BITRATES: Record<string, number[]> = {
  // kbit/s by bitrate index, for MPEG1 and MPEG2/2.5, layers I-III.
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG1
  2: [22050, 24000, 16000], // MPEG2
  0: [11025, 12000, 8000], // MPEG2.5
};

interface Mp3Frame {
  offset: number;
  /** 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5. */
  version: number;
  layer: number;
  bitrate: number; // bit/s
  sampleRate: number;
  mono: boolean;
  samples: number;
  size: number;
}

function frameAt(bytes: Uint8Array, offset: number): Mp3Frame | undefined {
  if (offset + 4 > bytes.length) return undefined;
  if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) return undefined;
  const version = (bytes[offset + 1] >> 3) & 3;
  const layerBits = (bytes[offset + 1] >> 1) & 3;
  if (version === 1 || layerBits === 0) return undefined;
  const layer = 4 - layerBits;
  const bitrateIndex = bytes[offset + 2] >> 4;
  const rateIndex = (bytes[offset + 2] >> 2) & 3;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return undefined;
  const padding = (bytes[offset + 2] >> 1) & 1;
  const bitrate = BITRATES[`${version === 3 ? 1 : 2}-${layer}`][bitrateIndex] * 1000;
  const sampleRate = SAMPLE_RATES[version][rateIndex];
  const samples = layer === 1 ? 384 : layer === 2 || version === 3 ? 1152 : 576;
  const size =
    layer === 1
      ? (Math.floor((12 * bitrate) / sampleRate) + padding) * 4
      : Math.floor(((samples / 8) * bitrate) / sampleRate) + padding;
  return {
    offset,
    version,
    layer,
    bitrate,
    sampleRate,
    mono: bytes[offset + 3] >> 6 === 3,
    samples,
    size,
  };
}

/** Bytes the ID3v2 tag at the start takes, 0 when there is none. */
export function id3v2Size(bytes: Uint8Array): number {
  if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0;
  const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
  return 10 + size + (bytes[5] & 0x10 ? 10 : 0);
}

const tagAt = (bytes: Uint8Array, at: number, tag: string) =>
  at + 4 <= bytes.length && [...tag].every((c, i) => bytes[at + i] === c.charCodeAt(0));
const uint32 = (bytes: Uint8Array, at: number) =>
  ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;

export type Mp3Length =
  | { seconds: number }
  /** The audio starts past the bytes given (a large ID3 tag): read again from here. */
  | { readFrom: number }
  | undefined;

/**
 * An MP3's length from the bytes at its start and the file's size: the frame count in
 * the Xing/Info or VBRI header when the encoder wrote one, otherwise size ÷ bitrate,
 * which is exact for the constant-bitrate files a TTS engine produces. `bytes` begins
 * at `bytesOffset` in the file. Undefined = not an MP3 this can read.
 */
export function mp3Length(bytes: Uint8Array, fileSize: number, bytesOffset = 0): Mp3Length {
  let start = 0;
  if (bytesOffset === 0) {
    const id3 = id3v2Size(bytes);
    if (id3 >= bytes.length - 256) return id3 < fileSize ? { readFrom: id3 } : undefined;
    start = id3;
  }
  // The first header that is followed by another one where its size says: a lone
  // 0xFFEx pair inside other data does not pass.
  const limit = Math.min(bytes.length - 4, start + 8192);
  for (let at = start; at <= limit; at++) {
    const frame = frameAt(bytes, at);
    if (!frame || frame.size < 24) continue;
    const next = at + frame.size;
    const confirmed = next + 4 <= bytes.length ? !!frameAt(bytes, next) : at === start;
    if (!confirmed) continue;

    const side = frame.version === 3 ? (frame.mono ? 17 : 32) : frame.mono ? 9 : 17;
    const xing = at + 4 + side;
    if (tagAt(bytes, xing, 'Xing') || tagAt(bytes, xing, 'Info')) {
      const flags = uint32(bytes, xing + 4);
      if (flags & 1 && xing + 12 <= bytes.length) {
        const frames = uint32(bytes, xing + 8);
        if (frames > 0) return { seconds: (frames * frame.samples) / frame.sampleRate };
      }
    }
    const vbri = at + 4 + 32;
    if (tagAt(bytes, vbri, 'VBRI') && vbri + 18 <= bytes.length) {
      const frames = uint32(bytes, vbri + 14);
      if (frames > 0) return { seconds: (frames * frame.samples) / frame.sampleRate };
    }
    const audioBytes = fileSize - (bytesOffset + at);
    return audioBytes > 0 ? { seconds: (audioBytes * 8) / frame.bitrate } : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Several files as one timeline

export interface Timeline {
  /** Where each track starts, in seconds from the start of the playlist. */
  starts: number[];
  total: number;
  /** Tracks whose length is not known yet; they count as 0 until it is. */
  unknown: number;
}

export function timelineOf(durations: (number | undefined)[]): Timeline {
  const starts: number[] = [];
  let total = 0;
  let unknown = 0;
  for (const d of durations) {
    starts.push(total);
    if (typeof d === 'number' && isFinite(d) && d > 0) total += d;
    else unknown++;
  }
  return { starts, total, unknown };
}

/** A moment in the playlist → the track holding it and the time within that track. */
export function locate(
  timeline: Timeline,
  durations: (number | undefined)[],
  globalTime: number
): { index: number; time: number } {
  const count = timeline.starts.length;
  if (!count) return { index: 0, time: 0 };
  const t = Math.min(Math.max(globalTime, 0), timeline.total);
  for (let i = count - 1; i >= 0; i--) {
    const d = durations[i];
    if (!(typeof d === 'number' && d > 0)) continue; // no length: nothing to land in
    if (t >= timeline.starts[i]) {
      // The very end belongs to the last track, a moment before it stops.
      return { index: i, time: Math.min(t - timeline.starts[i], Math.max(0, d - 0.25)) };
    }
  }
  return { index: 0, time: 0 };
}

export const globalTimeOf = (timeline: Timeline, index: number, time: number): number =>
  (timeline.starts[index] ?? 0) + Math.max(0, time);

export function formatClock(seconds: number | undefined): string {
  if (typeof seconds !== 'number' || !isFinite(seconds) || seconds < 0) return '–:––';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// ---------------------------------------------------------------------------
// What is remembered

export interface SavedPosition {
  spec: PlaylistSpec;
  title: string;
  /** The track playing when it was saved, and how far into it. */
  trackKey?: string;
  time: number;
  /** Seconds into the whole playlist and its length, for the list of recents. */
  globalTime?: number;
  total?: number;
  updatedAt: number;
}

export interface PlayerState {
  v: 1;
  /** Position per playlist, by specKey. */
  playlists: Record<string, SavedPosition>;
  /** The playlist last played. */
  last?: string;
  rate: number;
  includeShort: boolean;
  /** Tags used to build or filter a playlist, newest first. */
  tags: { id: string; name: string }[];
}

export const MAX_SAVED_PLAYLISTS = 20;
export const MAX_SAVED_TAGS = 8;

export const emptyPlayerState = (): PlayerState => ({
  v: 1,
  playlists: {},
  rate: 1,
  includeShort: false,
  tags: [],
});

export function normalizePlayerState(raw: unknown): PlayerState {
  const base = emptyPlayerState();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<PlayerState>;
  const playlists: Record<string, SavedPosition> = {};
  for (const [key, value] of Object.entries(r.playlists ?? {})) {
    if (value && isValidSpec(value.spec) && typeof value.updatedAt === 'number') {
      playlists[key] = { ...value, time: Number(value.time) || 0, title: String(value.title ?? '') };
    }
  }
  return {
    v: 1,
    playlists,
    last: typeof r.last === 'string' && playlists[r.last] ? r.last : undefined,
    rate: typeof r.rate === 'number' && r.rate >= 0.5 && r.rate <= 3 ? r.rate : 1,
    includeShort: !!r.includeShort,
    tags: Array.isArray(r.tags)
      ? r.tags.filter((t) => t && typeof t.id === 'string' && typeof t.name === 'string').slice(0, MAX_SAVED_TAGS)
      : [],
  };
}

/** The state with one playlist's position written, the oldest dropped past the limit. */
export function withPosition(state: PlayerState, position: SavedPosition): PlayerState {
  const key = specKey(position.spec);
  const playlists = { ...state.playlists, [key]: position };
  const keys = Object.keys(playlists).sort((a, b) => playlists[b].updatedAt - playlists[a].updatedAt);
  for (const old of keys.slice(MAX_SAVED_PLAYLISTS)) delete playlists[old];
  return { ...state, playlists, last: key };
}

export function withTag(state: PlayerState, tag: { id: string; name: string }): PlayerState {
  const tags = [tag, ...state.tags.filter((t) => t.id !== tag.id)].slice(0, MAX_SAVED_TAGS);
  return { ...state, tags };
}

/**
 * Where to resume in a rebuilt list: the saved track if it is still there, else the
 * start. The list may have gained or lost tracks since, so the track number is never
 * what is remembered.
 */
export function resumePoint(
  trackKeys: string[],
  saved: Pick<SavedPosition, 'trackKey' | 'time'> | undefined
): { index: number; time: number } {
  if (!saved?.trackKey) return { index: 0, time: 0 };
  const index = trackKeys.indexOf(saved.trackKey);
  return index < 0 ? { index: 0, time: 0 } : { index, time: Math.max(0, saved.time || 0) };
}
