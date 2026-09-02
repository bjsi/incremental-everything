import { BuiltInPowerupCodes, PluginRem, RNPlugin } from '@remnote/plugin-sdk';
import { prqTagSidebarPinnedKey } from '../consts';

/**
 * Pinning a Rem to RemNote's left sidebar.
 *
 * "Pin To Sidebar" — the star in the document header — is not a powerup of its
 * own. It is the built-in **Document** powerup (`BuiltInPowerupCodes.Document`,
 * code `o`) plus its hidden **`Status`** slot, an enum of `Draft` / `Finished` /
 * `Pinned` that defaults to `Draft`. The sidebar builds its sections straight
 * off that enum: the "Pinned" section is every document whose Status is
 * `Pinned`. RemNote's own handler is exactly the two calls below — make it a
 * document, then set the Status enum — so a plugin gets the identical result
 * with public SDK calls; the SDK maps the slot NAME (`'Status'`) to its wire
 * code for us.
 *
 * Why the plugin cares: the sidebar is the only surface that survives on a
 * phone, where the plugin panel and the hub — the two places that offer to open
 * the Priority Review Queue — are not rendered at all. Unpinned, the queue is a
 * document you have to remember the name of and search for.
 *
 * Only the *tag* Rem is ever pinned. The review documents themselves are not:
 * RemNote lists them under the tag as instances either way, so pinning each one
 * would add a timestamped sidebar entry per session and buy nothing.
 */

/** Values of the Document powerup's `Status` enum. Written as plain text. */
export const DOCUMENT_STATUS_PINNED = 'Pinned';
export const DOCUMENT_STATUS_DRAFT = 'Draft';

/**
 * Pins `rem` to the sidebar's "Pinned" section, unless it is already there.
 *
 * Idempotent and non-throwing: pinning is a convenience, never a reason to fail
 * the operation that asked for it.
 *
 * @returns True if the Rem ends up pinned (including when it already was).
 */
export async function pinRemToSidebar(rem: PluginRem): Promise<boolean> {
  try {
    const status = await rem.getPowerupProperty<BuiltInPowerupCodes.Document>(
      BuiltInPowerupCodes.Document,
      'Status'
    );
    if (status === DOCUMENT_STATUS_PINNED) {
      return true;
    }

    // Both calls are required, and in this order: the sidebar only lists
    // documents, so a Status set on a non-document Rem would go nowhere.
    await rem.setIsDocument(true);
    await rem.setPowerupProperty<BuiltInPowerupCodes.Document>(
      BuiltInPowerupCodes.Document,
      'Status',
      [DOCUMENT_STATUS_PINNED]
    );
    return true;
  } catch (e) {
    console.warn('[SidebarPin] Could not pin Rem to the sidebar', rem?._id, e);
    return false;
  }
}

/**
 * Pins the "Priority Review Queue" tag Rem to the sidebar — **once per
 * knowledge base, ever**.
 *
 * The tag Rem is the one door to every Priority Review Document the user has
 * made, so it is worth a permanent sidebar slot; but it is the user's sidebar,
 * and a user who unpins it has said what they want. The synced flag is what
 * makes that stick: it is written on the first attempt and never cleared, so
 * the pin is offered once and never re-asserted. It is synced rather than local
 * so the one pin does not repeat on each new device.
 */
export async function ensureReviewQueueTagPinnedOnce(
  plugin: RNPlugin,
  tagRem: PluginRem
): Promise<void> {
  try {
    const alreadyDone = await plugin.storage.getSynced<boolean>(prqTagSidebarPinnedKey);
    if (alreadyDone) {
      return;
    }

    const pinned = await pinRemToSidebar(tagRem);
    // Only burn the flag on success: a failed write should be retried the next
    // time a Priority Review Document is built, not silently given up on.
    if (pinned) {
      await plugin.storage.setSynced(prqTagSidebarPinnedKey, true);
    }
  } catch (e) {
    console.warn('[SidebarPin] Could not pin the Priority Review Queue tag', e);
  }
}
