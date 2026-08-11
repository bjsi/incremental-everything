// lib/local_storage_probe.ts
//
// What is the per-key ceiling on `storage.setLocal`?
//
// Nobody knows. The 896 KB UTF-16 figure this codebase relies on was measured by
// calibratePerKeyLimit in lib/synced_key_audit.ts, and that probes `setSynced`
// exclusively. Local storage is a different backend — unsynced, so none of the
// reasons a synced value must stay small apply to it — and the card-priority
// mirror was chunked at 2,000 rows purely because the synced ceiling was the only
// number available to size against.
//
// This matters for a concrete decision. The mirror is ~3.2 MB for a 45k-rem
// library. If one local key holds that comfortably, chunking can go and a persist
// becomes a single write. If the ceiling is near the synced one, chunking stays
// and the only question left is how big each chunk may be.
//
// WHY IT ALSO VERIFIES THE READ
//
// A write that is accepted is not the same as a value that survives. A backend
// can accept a large write and truncate it, or store it and fail to read it
// back. So every probe writes, reads back, and checks both length and the last
// character — a truncation that keeps the head would otherwise pass a length
// check on a repeated-character payload.
//
// The probe is deliberately manual. It writes megabytes repeatedly, and unlike
// the synced version it costs no sync traffic, but there is no reason to run it
// on a schedule.

import { RNPlugin } from '@remnote/plugin-sdk';

const LOCAL_PROBE_KEY = '__ie_local_size_probe__';

/** Stop bisecting when the bracket is this tight; further halvings buy nothing. */
const TOLERANCE_CHARS = 64 * 1024;
/** Ceiling on the search itself. Well past anything this plugin would store —
 *  if a key holds 64 MB the exact number stops mattering. */
const MAX_PROBE_CHARS = 64 * 1024 * 1024;

export interface LocalProbeStep {
  chars: number;
  approxMB: number;
  ok: boolean;
  /** Set when the write was accepted but the value did not survive intact. */
  corruption?: string;
  ms: number;
}

export interface LocalLimitReport {
  steps: LocalProbeStep[];
  /** Largest payload that wrote AND read back intact, in characters. */
  largestGood: number;
  /** Smallest payload that failed, or 0 if nothing failed up to the cap. */
  smallestBad: number;
  hitProbeCap: boolean;
  /** What the card-priority mirror needs today, for direct comparison. */
  mirrorApproxMB: number;
  verdict: string;
}

/**
 * Writes a payload, reads it back, and reports whether it survived.
 *
 * Returns a corruption message rather than throwing when the write is accepted
 * but the value is wrong — that outcome is the interesting one, and it must not
 * be conflated with a clean rejection.
 */
async function probeSize(
  plugin: RNPlugin,
  chars: number
): Promise<{ ok: boolean; corruption?: string; ms: number }> {
  const startedAt = Date.now();
  // A repeated character would let a truncating backend pass a spot check, so the
  // payload carries a distinct terminator to look for.
  const payload = 'x'.repeat(chars - 1) + 'Z';
  try {
    await plugin.storage.setLocal(LOCAL_PROBE_KEY, payload);
    const readBack = await plugin.storage.getLocal<string>(LOCAL_PROBE_KEY);
    const ms = Date.now() - startedAt;

    if (typeof readBack !== 'string') {
      return { ok: false, corruption: `read back as ${typeof readBack}`, ms };
    }
    if (readBack.length !== chars) {
      return {
        ok: false,
        corruption: `wrote ${chars.toLocaleString()} chars, read ${readBack.length.toLocaleString()}`,
        ms,
      };
    }
    if (!readBack.endsWith('Z')) {
      return { ok: false, corruption: 'tail marker missing — value truncated', ms };
    }
    return { ok: true, ms };
  } catch (err) {
    return { ok: false, corruption: undefined, ms: Date.now() - startedAt };
  }
}

/**
 * Finds the per-key ceiling on local storage by doubling then bisecting.
 *
 * @param mirrorRows how many rows the card-priority mirror currently holds, so
 *   the verdict can answer the actual question (does it fit in one key?) rather
 *   than reporting an abstract number.
 */
export async function probeLocalPerKeyLimit(
  plugin: RNPlugin,
  mirrorRows: number,
  onProgress?: (message: string) => void
): Promise<LocalLimitReport> {
  const steps: LocalProbeStep[] = [];
  // ~37 chars/row measured on the real store; ×2 for UTF-16.
  const mirrorApproxMB = (mirrorRows * 37 * 2) / 1024 / 1024;

  const attempt = async (chars: number) => {
    onProgress?.(`Testing ${(chars / 1024 / 1024).toFixed(1)}MB (${chars.toLocaleString()} chars)…`);
    const result = await probeSize(plugin, chars);
    steps.push({
      chars,
      approxMB: +((chars * 2) / 1024 / 1024).toFixed(2),
      ok: result.ok,
      corruption: result.corruption,
      ms: result.ms,
    });
    return result.ok;
  };

  let largestGood = 0;
  let smallestBad = 0;
  let hitProbeCap = false;

  try {
    // Double from a size we are confident about until something fails.
    let size = 256 * 1024; // 512KB UTF-16 — under even the synced ceiling
    while (size <= MAX_PROBE_CHARS) {
      if (await attempt(size)) {
        largestGood = size;
        size *= 2;
      } else {
        smallestBad = size;
        break;
      }
    }
    if (smallestBad === 0) hitProbeCap = true;

    // Bisect the bracket.
    if (smallestBad > 0) {
      let lo = largestGood;
      let hi = smallestBad;
      while (hi - lo > TOLERANCE_CHARS) {
        const mid = Math.floor((lo + hi) / 2);
        if (await attempt(mid)) lo = mid;
        else hi = mid;
      }
      largestGood = lo;
      smallestBad = hi;
    }
  } finally {
    // Leave nothing behind. Note that on synced storage nulling does not free the
    // key slot (see testNullFreesSlot); local storage has no such slot budget, so
    // this is purely about not leaving megabytes on disk.
    try {
      await plugin.storage.setLocal(LOCAL_PROBE_KEY, null);
    } catch {
      /* best effort */
    }
  }

  const largestGoodMB = (largestGood * 2) / 1024 / 1024;
  let verdict: string;
  if (largestGood === 0) {
    verdict =
      'Could not write even 512KB to a local key — unexpected, and worth re-running before ' +
      'drawing any conclusion from it.';
  } else if (hitProbeCap) {
    verdict =
      `No ceiling found up to ${(MAX_PROBE_CHARS * 2) / 1024 / 1024}MB. Local storage is not the ` +
      `constraint: the ${mirrorApproxMB.toFixed(1)}MB card-priority mirror fits in one key with ` +
      'room to spare, and chunking it buys nothing on size grounds.';
  } else if (largestGoodMB > mirrorApproxMB * 2) {
    verdict =
      `Ceiling is between ${largestGoodMB.toFixed(1)}MB and ${((smallestBad * 2) / 1024 / 1024).toFixed(1)}MB ` +
      `(UTF-16). The ${mirrorApproxMB.toFixed(1)}MB mirror fits in a single key with over 2x headroom.`;
  } else if (largestGoodMB > mirrorApproxMB) {
    verdict =
      `Ceiling is around ${largestGoodMB.toFixed(1)}MB (UTF-16). The ${mirrorApproxMB.toFixed(1)}MB ` +
      'mirror fits, but the margin is thin enough that a growing library would eventually hit it — ' +
      'keep chunking.';
  } else {
    verdict =
      `Ceiling is around ${largestGoodMB.toFixed(1)}MB (UTF-16), BELOW the ${mirrorApproxMB.toFixed(1)}MB ` +
      'the mirror needs. Chunking is mandatory; this only tells us how large each chunk may be.';
  }

  return { steps, largestGood, smallestBad, hitProbeCap, mirrorApproxMB, verdict };
}
