import {
  RNPlugin,
  PluginRem,
  RemId,
  RichTextInterface,
  BuiltInPowerupCodes,
} from '@remnote/plugin-sdk';
import {
  hasImagePowerupCode,
  hasImagePowerupName,
  pdfAreaHighlightPowerupCode,
  pdfAreaHighlightPowerupName,
  pendingImageScanJobsKey,
  noticesKey,
} from './consts';
import { SuppressionLease } from './operation_suppression';
import { showNotice } from './notice';

/**
 * Scanning for images and marking what is found with the HasImage powerup.
 *
 * Why this exists: RemNote's search indexes text. An image element contributes
 * no searchable token, so neither Ctrl+F nor the query language can isolate the
 * images inside a document. Marking them with a tag turns the problem into one
 * RemNote's own document Filter — and Search Portals — already solve.
 *
 * An image is a rich-text element with `i: 'i'` (RICH_TEXT_ELEMENT_TYPE.IMAGE).
 * Both `text` and `backText` are checked, so an image sitting only on the back
 * of a flashcard still counts.
 */

/** What to walk: one rem's subtree, or every rem in the knowledge base. */
export type ImageScanScope = { kind: 'rem'; remId: RemId } | { kind: 'kb' };

export interface ImageScanResult {
  /** Rems visited. */
  scanned: number;
  /** Rems found to hold at least one image. */
  withImages: number;
  /** Rems that gained the tag on this run. */
  tagged: number;
  /** Rems that carried the tag but no longer hold an image, so it was removed. */
  untagged: number;
  /** Rems whose tag write threw; counted rather than aborting the whole scan. */
  failed: number;
  /** Image-only rems confirmed to be PDF/HTML area highlights. */
  areaHighlights: number;
  /** Of those, the ones that gained the PdfAreaHighlight tag on this run. */
  areaTagged: number;
  /** Rems that carried it but no longer qualify — a caption was added, say. */
  areaUntagged: number;
  /** Where the wall clock actually went. */
  timing: ImageScanTiming;
}

/**
 * Where the time goes, split so a slow run can be attributed rather than
 * guessed at.
 *
 * This exists because a measured whole-KB run — 413,439 rems, 22,916 writes, ~90
 * minutes — matched none of the plausible explanations. Attributing it to the
 * writes implies ~234ms per addPowerup; attributing it to the event-loop yields
 * implies ~2.6s per yield, which is beyond even Chrome's worst timer throttling.
 * The observed rate was also near-CONSTANT per rem, which a write-bound loop
 * should not be: only 5.6% of rems are written and images cluster by document,
 * so throughput should visibly lump.
 *
 * A constant per-rem cost points instead at the supposedly-free part: the
 * synchronous predicate. If `getAll()` returns reactive proxies rather than
 * plain snapshots, then `rem.text` is not a field read and the "walk" is where
 * the time is. `walkMs` is what settles that.
 */
export interface ImageScanTiming {
  /** The bulk enumeration, before the walk starts. */
  collectMs: number;
  /** The one taggedRem() membership read. */
  membershipMs: number;
  /**
   * Summed time inside addPowerup/removePowerup across all writes. With writes
   * running concurrently this EXCEEDS wall clock, which is the point: divided by
   * writeCount it gives per-write LATENCY, independent of how many are in flight.
   */
  writeMs: number;
  /** How many writes that covers, so a per-write cost can be derived. */
  writeCount: number;
  /**
   * Wall clock spent on the write phase. Paired with writeMs this separates the
   * two things concurrency changes in opposite directions: latency per write
   * (writeMs / writeCount, expected to stay flat or rise slightly) and
   * throughput (writeCount / writeWallMs, the number that should climb).
   */
  writeWallMs: number;
  /** How many writes were kept in flight, so a logged figure can be reproduced. */
  concurrency: number;
  /** Cumulative time parked in the event-loop yields, and how many there were. */
  yieldMs: number;
  yieldCount: number;
  /**
   * The area-highlight confirmation pass: bridge READS, not writes, and only for
   * rems whose text is nothing but an image. Kept separate because it is the one
   * phase whose cost scales with figures rather than with rems.
   */
  probeMs: number;
  probeCount: number;
  /** Cumulative time renewing the suppression lease. */
  leaseMs: number;
  /**
   * Everything else in the loop — dominated by remHasImage. Derived by
   * subtraction rather than timed per rem, which keeps the measurement itself
   * off the hot path.
   */
  walkMs: number;
  /** Wall clock for the whole call. */
  totalMs: number;
}

export interface ImageTagRemovalResult {
  /** Rems that carried the tag within the scope, i.e. removal candidates. */
  considered: number;
  /** Rems the tag was actually taken off. */
  removed: number;
  /** Rems whose removal threw; counted rather than aborting the whole run. */
  failed: number;
  timing: ImageScanTiming;
}

/** Progress callback: a human-readable line, plus counts once the walk starts. */
export type ImageScanProgress = (message: string, done?: number, total?: number) => void;

/**
 * How often the walk yields to the event loop.
 *
 * Without a yield the popup's progress line never repaints — the scan holds the
 * widget's single thread from start to finish, which looks exactly like a hang.
 *
 * The count is high on purpose. `setTimeout(0)` is never actually 0: browsers
 * clamp it to ~4ms, and up to 1s under intensive throttling of a hidden frame.
 * At 200 the whole-KB run paid that toll 2,067 times, which in the throttled
 * case is over half an hour of pure waiting. The work between yields is
 * microseconds per rem, so 5,000 rems blocks the thread for single-digit
 * milliseconds — imperceptible — while cutting the toll 25x.
 */
const YIELD_EVERY = 5000;

/**
 * Progress cadence for the write phase, where every step costs a round trip.
 *
 * Separate from YIELD_EVERY because the two loops are nothing alike: the walk
 * does 5,000 sub-microsecond iterations between reports, while the write phase
 * spends tens of milliseconds on each one. Reporting every few hundred writes
 * keeps the popup's numbers moving without making the report itself the load.
 */
const PROGRESS_EVERY = 250;

/**
 * How many tag writes are kept in flight.
 *
 * Measured, on a 413k-rem knowledge base: a write costs ~74ms of LATENCY, which
 * sequentially is 13.5 writes/s — against a plugin bridge measured at ~1,800-2,000
 * calls/s. The pipe therefore sits ~99% idle, waiting. Overlapping writes should
 * convert almost all of that idle time into throughput.
 *
 * MEASURED, AND IT DOES NOT WORK. Do not raise this again without new evidence.
 *
 * The reasoning above predicted a near-linear speedup, and it was wrong. Two runs
 * of 1,173 writes on the same document, at 16 in flight:
 *
 *   sequential   74ms per write    13.5 writes/s
 *   16 in flight  1,116-1,237ms      13-14 writes/s
 *
 * Latency rose by almost exactly 16x (74 x 16 = 1,184) while throughput did not
 * move at all. That is the signature of complete serialization: RemNote applies
 * tag writes one at a time, so the extra requests only queue behind each other
 * and every one of them waits out the whole queue. There is no idle capacity on
 * this path to reclaim — the bridge is idle, but the writer behind it is not.
 *
 * So the conclusion in lib/updated_at_probe.ts holds after all, for a different
 * reason than it was originally reached: overlapping plugin calls does not help,
 * whether the loop looks throughput-bound or latency-bound.
 *
 * Left at 1, which is plain sequential execution. The pool is kept because the
 * walk/write split it enabled is worth having on its own — progress can count
 * writes, which are the only slow part — and because a future SDK with a real
 * bulk tag API would slot in here. There is no such API today: the only
 * `addTags` in the SDK typings is a UI-location enum member.
 */
const WRITE_CONCURRENCY = 1;

const emptyTiming = (): ImageScanTiming => ({
  collectMs: 0,
  membershipMs: 0,
  writeMs: 0,
  writeCount: 0,
  writeWallMs: 0,
  concurrency: 0,
  yieldMs: 0,
  yieldCount: 0,
  probeMs: 0,
  probeCount: 0,
  leaseMs: 0,
  walkMs: 0,
  totalMs: 0,
});

/** A cheap monotonic clock, falling back to Date.now() where absent. */
const now = (): number =>
  typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

/**
 * Formats the breakdown for the console log at the end of a run.
 *
 * Console rather than the popup: this is developer diagnostics — it is what
 * attributed a 90-minute whole-KB run to its writes rather than its walk — and
 * "walk 0.0s · writes 1173 91.5s" means nothing to someone who just wants their
 * images tagged. The popup reports elapsed time and counts.
 */
const formatScanTiming = (t: ImageScanTiming): string => {
  const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  let writes = `writes ${t.writeCount}`;
  if (t.writeCount > 0) {
    // Latency and throughput both, because concurrency moves them independently:
    // "74ms ea" can stay put while the per-second figure multiplies.
    const perWrite = Math.round(t.writeMs / t.writeCount);
    const perSec = t.writeWallMs > 0 ? Math.round(t.writeCount / (t.writeWallMs / 1000)) : 0;
    writes += ` ${s(t.writeWallMs)} (${perWrite}ms ea, ${perSec}/s, x${t.concurrency})`;
  }
  const probes = t.probeCount > 0 ? `probes ${t.probeCount} ${s(t.probeMs)} · ` : '';
  return (
    `walk ${s(t.walkMs)} · ` +
    `${probes}` +
    `${writes} · ` +
    `yields ${t.yieldCount} ${s(t.yieldMs)} · ` +
    `collect ${s(t.collectMs)} · tags ${s(t.membershipMs)}`
  );
};

/**
 * Runs `write` over every item with a bounded number in flight, accumulating
 * timing and reporting progress as it goes.
 *
 * A fixed pool of workers pulling from a shared cursor, rather than chunked
 * `Promise.all` batches: a batch only advances when its slowest member settles,
 * so a single slow write idles the whole batch. Workers keep the pipe full.
 *
 * No explicit event-loop yields are needed here — every worker awaits a real
 * bridge call, which hands control back on its own, so the popup repaints.
 *
 * Per-item failures are counted by the caller's `onError` and never abort the
 * run: on a 20k-write pass, aborting on one bad rem would throw away everything
 * already done.
 */
async function runWriteQueue<T>(
  items: T[],
  write: (item: T) => Promise<void>,
  onError: (item: T, error: unknown) => void,
  opts: {
    concurrency: number;
    timing: ImageScanTiming;
    lease: SuppressionLease;
    onTick: (done: number) => void;
  }
): Promise<void> {
  const { concurrency, timing, lease, onTick } = opts;
  timing.concurrency = concurrency;

  let cursor = 0;
  let done = 0;
  const phaseStart = now();

  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const item = items[cursor++];

      const tWrite = now();
      try {
        await write(item);
      } catch (e) {
        onError(item, e);
      }
      timing.writeMs += now() - tWrite;
      timing.writeCount++;

      done++;
      if (done % PROGRESS_EVERY === 0) {
        timing.writeWallMs = now() - phaseStart;
        onTick(done);
        const tLease = now();
        await lease.renew();
        timing.leaseMs += now() - tLease;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker)
  );
  timing.writeWallMs = now() - phaseStart;
}

/**
 * True when a rich text array holds at least one image element.
 *
 * RichTextInterface entries are either plain strings or element objects, so the
 * string case has to be excluded before reading `.i` — otherwise a rem whose
 * text is a bare string would throw on a property access.
 */
const richTextHasImage = (text: RichTextInterface | undefined): boolean =>
  !!text?.some((el) => typeof el !== 'string' && (el as { i?: string }).i === 'i');

/** True when the rem holds an image in its text or its back text. */
export const remHasImage = (rem: PluginRem): boolean =>
  richTextHasImage(rem.text) || richTextHasImage(rem.backText);

/**
 * True when the rem's front text is an image and NOTHING else.
 *
 * This is the discriminator the `HasImage` + `pdf-highlight` pair could not
 * provide: adding a figure to an ordinary TEXT highlight satisfies both of those
 * yet is not an area highlight. An area highlight is one where RemNote stored the
 * clipped image *in place of* the text, so its front text holds the image alone.
 *
 * Whitespace-only strings are tolerated (RemNote leaves padding around inline
 * nodes); anything else — prose, a reference, LaTeX, a caption you added — makes
 * it not image-only. Back text is deliberately ignored: a rem with a back is a
 * flashcard, not a highlight.
 *
 * Synchronous, so it costs nothing where it runs — the same Phase 1 walk that
 * already calls remHasImage.
 */
export const remIsImageOnly = (rem: PluginRem): boolean => {
  const text = rem.text;
  if (!richTextHasImage(text)) return false;
  return !text!.some((el) =>
    typeof el === 'string' ? el.trim().length > 0 : (el as { i?: string }).i !== 'i'
  );
};

/**
 * Confirms an image-only rem really is a clipping from a source document rather
 * than a bare figure pasted into your own notes.
 *
 * The powerup test is the whole test. RemNote models both highlight kinds with a
 * single PDFHighlight / HTMLHighlight powerup — there is no area-specific code —
 * and an area highlight carries it just as a text highlight does. That was the
 * one thing this could not be sure of when it was written, so it also walked to
 * the parent to look for a `Page N` node (PDFPageNumber) inside the PDF's
 * managed "Highlights" container. A DOM inspection settled it: an area
 * highlight's container renders `data-rem-tags="pdfareahighlight pdf-highlight"`,
 * the second of which is RemNote's own. The structural fallback was therefore
 * unreachable in practice and is gone, along with the extra read it cost every
 * image-only rem that was NOT a highlight.
 *
 * Reads only, ~0.5ms each against ~74ms for a write, and only image-only rems
 * ever reach here.
 */
async function confirmAreaHighlight(plugin: RNPlugin, rem: PluginRem): Promise<boolean> {
  try {
    if (await rem.hasPowerup(BuiltInPowerupCodes.PDFHighlight)) return true;
    return await rem.hasPowerup(BuiltInPowerupCodes.HTMLHighlight);
  } catch (e) {
    console.warn('[ImageScan] highlight powerup probe failed for', rem._id, e);
    return false;
  }
}

/**
 * Resolves the rems a scope covers.
 *
 * The whole-KB branch leans on `plugin.rem.getAll()`. That call has been removed
 * from the plugin API before and could be again (see lib/synced_key_audit.ts),
 * so the failure is re-thrown with a sentence the popup can show rather than
 * being left as an opaque bridge error.
 */
async function collectScopeRems(
  plugin: RNPlugin,
  scope: ImageScanScope,
  onProgress?: ImageScanProgress
): Promise<PluginRem[]> {
  if (scope.kind === 'kb') {
    onProgress?.('Enumerating every Rem in the knowledge base…');
    try {
      return await plugin.rem.getAll();
    } catch (e) {
      console.error('[ImageScan] plugin.rem.getAll() failed:', e);
      throw new Error(
        'RemNote would not enumerate the knowledge base (plugin.rem.getAll is unavailable in this build). Scan a document instead.'
      );
    }
  }

  const root = await plugin.rem.findOne(scope.remId);
  if (!root) throw new Error('The Rem to scan no longer exists.');
  onProgress?.('Collecting descendants…');
  return [root, ...(await root.getDescendants())];
}

/**
 * Walks the scope, applying the HasImage powerup to every rem that holds an
 * image and removing it from every rem in the same scope that carries the tag
 * but no longer holds one — so re-running after deleting an image leaves no
 * stale marks behind.
 *
 * Membership is resolved with ONE `taggedRem()` call rather than a `hasPowerup`
 * per rem: the latter is a round trip across the plugin bridge for every rem in
 * the scope, which is exactly the pattern that saturates it on large subtrees.
 * Only rems whose state actually changes are written to.
 *
 * With a `rem` scope, rems outside the subtree are never touched, so tags
 * applied to other documents survive a scan run here.
 */
export async function scanAndTagImages(
  plugin: RNPlugin,
  scope: ImageScanScope,
  onProgress?: ImageScanProgress
): Promise<ImageScanResult> {
  const t0 = now();
  const timing = emptyTiming();

  const tCollect = now();
  const rems = await collectScopeRems(plugin, scope, onProgress);
  timing.collectMs = now() - tCollect;

  // One read of each tag's current members, turned into sets for O(1) tests.
  const tMembership = now();
  const powerup = await plugin.powerup.getPowerupByCode(hasImagePowerupCode);
  const alreadyTagged = new Set(
    powerup ? (await powerup.taggedRem()).map((r) => r._id) : []
  );
  const areaPowerup = await plugin.powerup.getPowerupByCode(pdfAreaHighlightPowerupCode);
  const alreadyArea = new Set(
    areaPowerup ? (await areaPowerup.taggedRem()).map((r) => r._id) : []
  );
  timing.membershipMs = now() - tMembership;

  const result: ImageScanResult = {
    scanned: rems.length,
    withImages: 0,
    tagged: 0,
    untagged: 0,
    failed: 0,
    areaHighlights: 0,
    areaTagged: 0,
    areaUntagged: 0,
    timing,
  };

  // Every tag write fires GlobalRemChanged straight back into this plugin's own
  // listener, which per event costs a findOne, session reads, and a debounced
  // tail — work that is pointless for a write we just made ourselves. Every
  // other bulk operation here suppresses it (tracker.ts, extract.ts,
  // priority_bands.ts, outline_restructure.ts); this one did not.
  //
  // A renewable lease rather than a bare `true`, because this scan runs in a
  // popup the user is invited to close, and a torn-down iframe never reaches the
  // `finally`. See lib/operation_suppression.ts.
  const lease = new SuppressionLease(plugin);
  const tLeaseStart = now();
  await lease.start();
  timing.leaseMs += now() - tLeaseStart;

  try {
    // PHASE 1 — decide, writing nothing. Measured at 0.24us per rem (413k rems
    // in 0.1s), so planning the whole knowledge base up front is free. Splitting
    // it from the writes buys two things the interleaved version could not have:
    // the exact number of writes is known before the first one is issued, so
    // progress counts what is actually slow, and the writes become an
    // order-independent set that can be run concurrently.
    const tWalk = now();
    const pending: Array<{ rem: PluginRem; code: string; add: boolean }> = [];
    // Image-only rems not already known to be area highlights. Confirmed in
    // Phase 1.5 rather than here, because confirmation needs the bridge and this
    // loop must stay synchronous. `isTagged` rides along so the confirmation can
    // settle BOTH tags without re-reading the membership set.
    const areaCandidates: Array<{ rem: PluginRem; isTagged: boolean }> = [];
    for (let i = 0; i < rems.length; i++) {
      if (i > 0 && i % YIELD_EVERY === 0) {
        onProgress?.(`Scanning ${i} / ${rems.length} Rems…`, i, rems.length);
        const tYield = now();
        await new Promise((r) => setTimeout(r, 0));
        timing.yieldMs += now() - tYield;
        timing.yieldCount++;
      }

      const rem = rems[i];
      const hasImage = remHasImage(rem);
      const isTagged = alreadyTagged.has(rem._id);
      if (hasImage) result.withImages++;

      // The two tags are MUTUALLY EXCLUSIVE: an area highlight carries
      // PdfAreaHighlight and not HasImage. Both would be more useful to filter on
      // — an area highlight does hold an image — but RemNote collapses two or
      // more tags into a "2 tags" chip that no rule of ours can hide safely, and
      // that clutter costs more than the second filter is worth on Rems that are
      // rarely filtered. So each Rem gets exactly one of them, or neither.
      const wasArea = alreadyArea.has(rem._id);

      if (hasImage && remIsImageOnly(rem)) {
        // Shape matches an area highlight; only its provenance is still open.
        if (wasArea) {
          // Already confirmed on a previous run — no probe. This is what keeps a
          // re-scan of an unchanged document free of reads as well as writes.
          result.areaHighlights++;
          if (isTagged) pending.push({ rem, code: hasImagePowerupCode, add: false });
        } else {
          // HasImage is deferred with it: an image-only Rem that turns out NOT to
          // be a clipping is an ordinary figure and does want HasImage.
          areaCandidates.push({ rem, isTagged });
        }
        continue;
      }

      // Not image-only, so it cannot be an area highlight — a caption may have
      // been added since the last run.
      if (wasArea) pending.push({ rem, code: pdfAreaHighlightPowerupCode, add: false });
      // Already in the right state — no write, which is what keeps a re-run cheap.
      if (hasImage !== isTagged) pending.push({ rem, code: hasImagePowerupCode, add: hasImage });
    }
    // Clamped: derived by subtraction, so accumulated float error can otherwise
    // print a negative tenth of a second on a run whose walk was ~0.
    timing.walkMs = Math.max(0, now() - tWalk - timing.yieldMs);
    // Everything later works from `pending` and `areaCandidates`. A whole-KB run
    // holds ~400k Rem objects here, and it runs in the index widget for up to an
    // hour of writes, so let them go now rather than when the call returns.
    rems.length = 0;

    // PHASE 1.5 — confirm which image-only rems are clippings from a source.
    // Reads only, and only for candidates, so this is bounded by the number of
    // figures rather than the size of the scope. Each await hands control back to
    // the event loop on its own, so the popup keeps repainting without explicit
    // yields.
    if (areaCandidates.length > 0) {
      const tProbe = now();
      for (let i = 0; i < areaCandidates.length; i++) {
        if (i > 0 && i % PROGRESS_EVERY === 0) {
          onProgress?.(
            `Checking ${i} / ${areaCandidates.length} image Rems…`,
            i,
            areaCandidates.length
          );
        }
        const { rem, isTagged } = areaCandidates[i];
        timing.probeCount++;
        if (await confirmAreaHighlight(plugin, rem)) {
          result.areaHighlights++;
          pending.push({ rem, code: pdfAreaHighlightPowerupCode, add: true });
          // Exclusive: shed HasImage if an earlier run (or an earlier version of
          // this command) put it there.
          if (isTagged) pending.push({ rem, code: hasImagePowerupCode, add: false });
        } else if (!isTagged) {
          // Image-only but not from a source document — an ordinary figure.
          pending.push({ rem, code: hasImagePowerupCode, add: true });
        }
      }
      timing.probeMs = now() - tProbe;
    }

    // PHASE 2 — the expensive part, overlapped.
    await runWriteQueue(
      pending,
      async ({ rem, code, add }) => {
        if (add) {
          await rem.addPowerup(code);
          if (code === hasImagePowerupCode) result.tagged++;
          else result.areaTagged++;
        } else {
          await rem.removePowerup(code);
          if (code === hasImagePowerupCode) result.untagged++;
          else result.areaUntagged++;
        }
      },
      ({ rem }, e) => {
        result.failed++;
        console.error('[ImageScan] tag write failed for', rem._id, e);
      },
      {
        concurrency: WRITE_CONCURRENCY,
        timing,
        lease,
        onTick: (writesDone) =>
          onProgress?.(`Tagging ${writesDone} / ${pending.length} Rems…`, writesDone, pending.length),
      }
    );
  } finally {
    await lease.release();
  }

  timing.totalMs = now() - t0;
  console.log(`[ImageScan] ${formatScanTiming(timing)} · total ${(timing.totalMs / 1000).toFixed(1)}s`);

  onProgress?.(`Scanned ${result.scanned} Rems.`, result.scanned, result.scanned);
  return result;
}

/**
 * Takes the HasImage tag off every rem that carries it within the scope.
 *
 * The cleanup half of the feature: the scan can mark 20k+ rems, and a user who
 * decides they no longer want the tag has no way to undo that in bulk from
 * RemNote's own UI. Nothing is lost — the tag is derived from the images
 * themselves, so re-running the scan rebuilds it exactly, which is also why this
 * needs no undo of its own. Same relationship "Remove All Priority Band Tags"
 * has to "Refresh Priority Badges".
 *
 * Membership comes from ONE `taggedRem()` call, so a whole-KB cleanup never
 * enumerates the knowledge base at all — it asks the tag who its members are.
 * Only a rem-scoped cleanup pays for a descendant walk, and even then just to
 * build the set it intersects against.
 *
 * Deliberately uses `removePowerup` rather than `removeTag(powerup._id)`, even
 * though the latter skips a code→rem resolution per write and is likely faster.
 * The point of this run is to measure the write cost against the tagging pass on
 * equal terms; changing the write API at the same time would leave two variables
 * moving at once, and the per-write cost is the open question here.
 */
export async function removeImageTags(
  plugin: RNPlugin,
  scope: ImageScanScope,
  onProgress?: ImageScanProgress
): Promise<ImageTagRemovalResult> {
  const t0 = now();
  const timing = emptyTiming();

  onProgress?.('Finding tagged Rems…');
  const tMembership = now();
  // Both tags come off together: PdfAreaHighlight is derived from the same scan,
  // so leaving it behind would strand a tag the user has no other way to clear.
  const powerup = await plugin.powerup.getPowerupByCode(hasImagePowerupCode);
  const areaPowerup = await plugin.powerup.getPowerupByCode(pdfAreaHighlightPowerupCode);
  let tagged: Array<{ rem: PluginRem; code: string }> = [
    ...(powerup ? await powerup.taggedRem() : []).map((rem) => ({
      rem,
      code: hasImagePowerupCode,
    })),
    ...(areaPowerup ? await areaPowerup.taggedRem() : []).map((rem) => ({
      rem,
      code: pdfAreaHighlightPowerupCode,
    })),
  ];
  timing.membershipMs = now() - tMembership;

  // A rem scope narrows the tagged list to the subtree. The descendant walk is
  // the only reason to touch the knowledge base here, and its result is used
  // purely as a membership set.
  if (scope.kind === 'rem') {
    const tCollect = now();
    const inScope = new Set((await collectScopeRems(plugin, scope, onProgress)).map((r) => r._id));
    timing.collectMs = now() - tCollect;
    tagged = tagged.filter((t) => inScope.has(t.rem._id));
  }

  const result: ImageTagRemovalResult = {
    considered: tagged.length,
    removed: 0,
    failed: 0,
    timing,
  };

  // Same reasoning as the tagging pass: every removal fires GlobalRemChanged
  // back into this plugin's own listener, and this popup may be closed mid-run.
  const lease = new SuppressionLease(plugin);
  const tLeaseStart = now();
  await lease.start();
  timing.leaseMs += now() - tLeaseStart;

  try {
    // Nothing to decide here — the tagged list IS the write list — so this is
    // the write phase and nothing else.
    await runWriteQueue(
      tagged,
      async ({ rem, code }) => {
        await rem.removePowerup(code);
        result.removed++;
      },
      ({ rem }, e) => {
        result.failed++;
        console.error('[ImageScan] tag removal failed for', rem._id, e);
      },
      {
        concurrency: WRITE_CONCURRENCY,
        timing,
        lease,
        onTick: (removed) =>
          onProgress?.(`Removing ${removed} / ${tagged.length} tags…`, removed, tagged.length),
      }
    );
  } finally {
    await lease.release();
  }

  timing.totalMs = now() - t0;
  console.log(
    `[ImageScan] removal: ${formatScanTiming(timing)} · total ${(timing.totalMs / 1000).toFixed(1)}s`
  );

  onProgress?.(`Removed ${result.removed} tags.`, tagged.length, tagged.length);
  return result;
}

// --- background jobs (whole knowledge base) ----------------------------------------

/**
 * Elapsed time for a report line. Minutes once a run is long enough for seconds
 * to stop being readable — a first whole-KB pass is measured in tens of minutes,
 * where "1704.3s" is a number nobody parses.
 */
export const formatElapsed = (ms: number): string => {
  const seconds = ms / 1000;
  if (seconds < 90) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  return `${mins}m ${Math.round(seconds - mins * 60)}s`;
};

/**
 * A whole-KB run handed off by the popup. Such a run takes up to an hour (a first
 * pass over 413k Rems wrote 22,916 tags at ~13/s), and inside the popup it died
 * with the popup. The tracker (register/tracker.ts, in the persistent index
 * widget) runs it instead, posts its progress as a notice and replaces that
 * notice with the result. Lives in this window's session: a reload of RemNote
 * drops a running job, which costs nothing but time — the run is idempotent, so
 * starting it again picks up where the writes stopped.
 */
export interface ImageScanJob {
  /** Unique per run, so a job the tracker reads twice runs once. */
  id: string;
  mode: 'tag' | 'remove';
  queuedAt: number;
}

export async function enqueueImageScanJob(plugin: RNPlugin, mode: ImageScanJob['mode']): Promise<void> {
  const job: ImageScanJob = {
    id: `image-scan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    mode,
    queuedAt: Date.now(),
  };
  const queue = (await plugin.storage.getSession<ImageScanJob[]>(pendingImageScanJobsKey)) || [];
  await plugin.storage.setSession(pendingImageScanJobsKey, [...queue, job]);
}

/** Progress notices are rewritten at most this often: each one is a session write. */
const PROGRESS_NOTICE_MS = 5000;

/** Index only: set while a whole-KB job runs, so a second one is refused, not interleaved. */
let activeImageScanJob: ImageScanJob['mode'] | null = null;

/** Run a whole-KB tag or cleanup pass and report it with notices. */
export async function runImageScanJob(plugin: RNPlugin, job: ImageScanJob): Promise<void> {
  const label = job.mode === 'remove' ? `Remove ${hasImagePowerupName} Tags` : 'Tag Rems With Images';
  const noticeId = `${job.id}-notice`;

  if (activeImageScanJob) {
    // Two passes over the same tags would race each other's writes, and the
    // second would only redo what the first is doing.
    await showNotice(plugin, {
      title: `${label}: not started`,
      message: `A whole-knowledge-base ${
        activeImageScanJob === 'remove' ? 'cleanup' : 'scan'
      } is already running. Its notice reports when it is done.`,
      tone: 'info',
    });
    return;
  }
  activeImageScanJob = job.mode;

  // Progress goes to one notice, rewritten in place. Throttled, serialized (each
  // write is a read-modify-write of the notice list), and stopped for good once
  // the user dismisses it: the result still arrives, but a progress card that
  // keeps coming back after being closed is a nag.
  let lastPost = 0;
  let posted = false;
  let dismissed = false;
  let chain = Promise.resolve();
  const onProgress: ImageScanProgress = (message) => {
    const t = Date.now();
    if (dismissed || t - lastPost < PROGRESS_NOTICE_MS) return;
    lastPost = t;
    chain = chain
      .then(async () => {
        if (posted) {
          const list = (await plugin.storage.getSession<Array<{ id: string }>>(noticesKey)) || [];
          if (!list.some((n) => n.id === noticeId)) {
            dismissed = true;
            return;
          }
        }
        posted = true;
        await showNotice(plugin, {
          id: noticeId,
          tone: 'info',
          title: `${label}: running…`,
          message: `Whole knowledge base — ${message}`,
          detail:
            'Runs in the background: keep working. A reload of RemNote stops it; anything already written stays, and running it again resumes the work.',
        });
      })
      .catch((e) => console.warn('[ImageScan] progress notice failed', e));
  };

  try {
    if (job.mode === 'remove') {
      const r = await removeImageTags(plugin, { kind: 'kb' }, onProgress);
      await chain;
      await showNotice(plugin, {
        id: noticeId,
        tone: r.failed ? 'info' : 'success',
        title: `${label}: done`,
        message:
          r.considered === 0
            ? 'Nothing in the knowledge base carried the tag, so there was nothing to clear.'
            : `Cleared ${r.removed} tag${r.removed === 1 ? '' : 's'} in the whole knowledge base. Took ${formatElapsed(r.timing.totalMs)}.`,
        detail: [
          r.failed ? `${r.failed} failed to write — see the console.` : '',
          'Run Tag Rems With Images at any time to rebuild the tag from scratch.',
        ]
          .filter(Boolean)
          .join(' '),
      });
    } else {
      const r = await scanAndTagImages(plugin, { kind: 'kb' }, onProgress);
      await chain;
      const area =
        r.areaHighlights > 0 || r.areaUntagged > 0
          ? `, ${r.areaHighlights} PDF area highlight${r.areaHighlights === 1 ? '' : 's'} (#${pdfAreaHighlightPowerupName}${
              r.areaTagged ? `, +${r.areaTagged}` : ''
            }${r.areaUntagged ? `, −${r.areaUntagged}` : ''})`
          : '';
      await showNotice(plugin, {
        id: noticeId,
        tone: r.failed ? 'info' : 'success',
        title: `${label}: done`,
        message:
          `Scanned ${r.scanned} Rems in the whole knowledge base: ${r.withImages} hold an image, ` +
          `${r.tagged} newly tagged, ${r.untagged} cleared${area}. Took ${formatElapsed(r.timing.totalMs)}.`,
        detail: [
          r.failed ? `${r.failed} failed to write — see the console.` : '',
          `To filter a document by it: Cmd/Ctrl+Shift+F, then pick ${hasImagePowerupName}.`,
        ]
          .filter(Boolean)
          .join(' '),
      });
    }
  } catch (e) {
    console.error('[ImageScan] background job failed:', e);
    await chain;
    await showNotice(plugin, {
      id: noticeId,
      tone: 'error',
      title: `${label}: stopped`,
      message: (e as any)?.message ?? String(e),
      detail:
        job.mode === 'remove'
          ? 'Tags already removed stay removed; running it again clears the rest.'
          : 'Anything already tagged stays; running it again resumes the work.',
    });
  } finally {
    activeImageScanJob = null;
  }
}
