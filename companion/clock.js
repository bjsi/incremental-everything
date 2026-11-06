// The reading clock's arithmetic, shared by the page (which counts) and the panel
// (which shows and records). Time is kept as segments of active reading,
// [start, end] in epoch ms, so time already recorded elsewhere can be taken out.
//
// Two storage keys per knowledge base and document, each with a single writer:
//   clock:<kbId>:<docId>  the page:  { url, title, segments }
//   cover:<kbId>:<docId>  the panel: { clearedUntil, windows, keptAt }
// `cover` says what is no longer unrecorded: everything up to clearedUntil (a
// review the Companion recorded, or a discard), and each window, the span of a
// review recorded in RemNote while the page was being read.
(function (root) {
  /** No scroll, key, click or selection for this long, and the clock stops. */
  const IDLE_MS = 3 * 60 * 1000;
  /** A session idle for this long is a past one, which the panel offers to record. */
  const PAST_AFTER_MS = 30 * 60 * 1000;
  /** Below this, a past session is not worth asking about. */
  const PAST_MIN_MS = 60 * 1000;
  /** Two segments this close become one, so a session keeps a short list. */
  const JOIN_MS = 5000;
  const MAX_SEGMENTS = 400;
  const MAX_WINDOWS = 50;

  const clockKey = (kbId, docId) => `clock:${kbId}:${docId}`;
  const coverKey = (kbId, docId) => `cover:${kbId}:${docId}`;
  const targetKey = (kbId, url) => `${kbId}|${String(url).split('#')[0]}`;

  /** The segments with from..to added, joined to the last one when they touch. */
  function addTime(segments, from, to) {
    if (!(to > from)) return segments;
    const list = segments.slice();
    const last = list[list.length - 1];
    if (last && from - last[1] <= JOIN_MS && from >= last[0]) list[list.length - 1] = [last[0], Math.max(last[1], to)];
    else list.push([from, to]);
    // Very long histories lose their oldest detail, never their time: the two
    // oldest segments merge into one that spans both.
    while (list.length > MAX_SEGMENTS) {
      const [a, b] = list.splice(0, 2);
      const kept = a[1] - a[0] + (b[1] - b[0]);
      list.unshift([b[1] - kept, b[1]]);
    }
    return list;
  }

  /** The segments minus everything the cover says is recorded. */
  function uncovered(segments, cover) {
    let list = (segments ?? []).filter(([, end]) => end > (cover?.clearedUntil ?? 0));
    list = list.map(([start, end]) => [Math.max(start, cover?.clearedUntil ?? 0), end]);
    for (const [a, b] of cover?.windows ?? []) {
      list = list.flatMap(([start, end]) => {
        if (b <= start || a >= end) return [[start, end]];
        const parts = [];
        if (a > start) parts.push([start, a]);
        if (b < end) parts.push([b, end]);
        return parts;
      });
    }
    return list;
  }

  const totalMs = (segments) => (segments ?? []).reduce((sum, [start, end]) => sum + (end - start), 0);
  const lastEnd = (segments) => (segments?.length ? segments[segments.length - 1][1] : undefined);
  const firstStart = (segments) => (segments?.length ? segments[0][0] : undefined);

  /**
   * The spans of reviews recorded in RemNote, from the end of each back over its
   * time. A queue review handed to the Companion spans from the hand-off on as
   * well, since the Companion's reading after it is now part of that review.
   */
  function windowsOf(reviews) {
    return (reviews ?? [])
      .filter((review) => review.reviewTimeSeconds > 0 || review.companionHandoffAt)
      .map((review) => {
        const start = review.date - (review.reviewTimeSeconds ?? 0) * 1000;
        return [review.companionHandoffAt ? Math.min(start, review.companionHandoffAt) : start, review.date];
      });
  }

  /** The parts of the segments between from and to. */
  function within(segments, from, to) {
    return (segments ?? [])
      .map(([start, end]) => [Math.max(start, from), Math.min(end, to)])
      .filter(([start, end]) => end > start);
  }

  /** The cover with more windows, once each, newest kept. */
  function withWindows(cover, windows) {
    const known = new Set((cover?.windows ?? []).map((w) => w.join('-')));
    const added = windows.filter((w) => !known.has(w.join('-')));
    if (!added.length) return null;
    return { ...cover, windows: [...(cover?.windows ?? []), ...added].slice(-MAX_WINDOWS) };
  }

  /** 12:34, or 1:05:20 past an hour. */
  function format(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const two = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
  }

  /** 45 s, 12 min, 2 h 05 min. */
  function formatShort(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
  }

  const api = {
    IDLE_MS,
    PAST_AFTER_MS,
    PAST_MIN_MS,
    clockKey,
    coverKey,
    targetKey,
    addTime,
    uncovered,
    totalMs,
    lastEnd,
    firstStart,
    windowsOf,
    within,
    withWindows,
    format,
    formatShort,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.IEClock = api;
})(globalThis);
