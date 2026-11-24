import { BuiltInPowerupCodes, PluginRem, RemType, RNPlugin } from '@remnote/plugin-sdk';
import { clusterExtraDetailCssId, clusterExtraDetailOverrideKey } from './consts';

/* Extra Card Details for the Card Cluster member that is actually being tested.

   RemNote draws a card's Extra details for `this.props.quantum`, the Rem whose card
   the queue loaded. A Card Cluster starts on its first due member in cluster order
   and moves through the others, but never re-points that block, so every member
   shows the loaded member's ECD (findings/QUEUE_AND_PRACTICE.md, "Card Cluster
   Extra Details come from the loaded member"). The FlashcardExtraDetail widget
   context has the same split: `remId` is the loaded member, `cardId` the tested one.

   The cluster_extra_detail widget compares the two. On a mismatch it draws the
   tested member's ECDs and sets the session key below; index.tsx then hides
   RemNote's block. registerCSS only works from index (see consts). The rule is
   also gated on the widget's iframe being on the page, so a key left set by a
   torn-down widget hides nothing once the slot is gone. */

export const CLUSTER_EXTRA_DETAIL_WIDGET = 'cluster_extra_detail';

const IFRAME = `iframe[data-plugin-id="incremental-everything"][src*="widgetName=${CLUSTER_EXTRA_DETAIL_WIDGET}&"]`;

export function buildClusterExtraDetailCss(override: boolean): string {
  if (!override) return '';
  return `
  body:has(${IFRAME}) .extra-card-detail {
    display: none !important;
  }`;
}

export async function registerClusterExtraDetailCss(plugin: RNPlugin, override: boolean | undefined) {
  await plugin.app.registerCSS(clusterExtraDetailCssId, buildClusterExtraDetailCss(!!override));
}

/** The widget's switch for RemNote's own block. Writes only on a change, because
    every setSession is broadcast to all realms and re-runs index's tracker. */
export async function setClusterExtraDetailOverride(plugin: RNPlugin, override: boolean) {
  const current = !!(await plugin.storage.getSession<boolean>(clusterExtraDetailOverrideKey));
  if (current !== override) await plugin.storage.setSession(clusterExtraDetailOverrideKey, override);
}

/** The Rems RemNote shows as a Rem's Extra details, in the same order: children with
    the Extra Card Detail powerup, and the ECD Rems a child portal includes (only the
    top-level ones, as RemNote does). */
export async function extraCardDetailsOf(rem: PluginRem): Promise<PluginRem[]> {
  const out: PluginRem[] = [];
  for (const child of await rem.getChildrenRem()) {
    if (await child.hasPowerup(BuiltInPowerupCodes.ExtraCardDetail)) {
      out.push(child);
    } else if ((await child.getType()) === RemType.PORTAL) {
      const included = await child.getPortalDirectlyIncludedRem();
      const ids = new Set(included.map((r) => r._id));
      for (const r of included) {
        if (r.parent && ids.has(r.parent)) continue;
        if (await r.hasPowerup(BuiltInPowerupCodes.ExtraCardDetail)) out.push(r);
      }
    }
  }
  return out;
}
