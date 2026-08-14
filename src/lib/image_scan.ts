import { RNPlugin, PluginRem, RemId, RichTextInterface } from '@remnote/plugin-sdk';
import { hasImagePowerupCode } from './consts';

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
}

/** Progress callback: a human-readable line, plus counts once the walk starts. */
export type ImageScanProgress = (message: string, done?: number, total?: number) => void;

/**
 * How often the walk yields to the event loop. Without this the popup's progress
 * line never repaints — the scan holds the widget's single thread from start to
 * finish, which on a whole-KB run looks exactly like a hang.
 */
const YIELD_EVERY = 200;

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
  const rems = await collectScopeRems(plugin, scope, onProgress);

  // One read of the tag's current members, turned into a set for O(1) tests.
  const powerup = await plugin.powerup.getPowerupByCode(hasImagePowerupCode);
  const alreadyTagged = new Set(
    powerup ? (await powerup.taggedRem()).map((r) => r._id) : []
  );

  const result: ImageScanResult = {
    scanned: rems.length,
    withImages: 0,
    tagged: 0,
    untagged: 0,
    failed: 0,
  };

  for (let i = 0; i < rems.length; i++) {
    if (i % YIELD_EVERY === 0) {
      onProgress?.(`Scanning ${i} / ${rems.length} Rems…`, i, rems.length);
      await new Promise((r) => setTimeout(r, 0));
    }

    const rem = rems[i];
    const hasImage = remHasImage(rem);
    const isTagged = alreadyTagged.has(rem._id);
    if (hasImage) result.withImages++;

    // Already in the right state — no write, which is what keeps a re-run cheap.
    if (hasImage === isTagged) continue;

    try {
      if (hasImage) {
        await rem.addPowerup(hasImagePowerupCode);
        result.tagged++;
      } else {
        await rem.removePowerup(hasImagePowerupCode);
        result.untagged++;
      }
    } catch (e) {
      result.failed++;
      console.error('[ImageScan] tag write failed for', rem._id, e);
    }
  }

  onProgress?.(`Scanned ${rems.length} Rems.`, rems.length, rems.length);
  return result;
}
