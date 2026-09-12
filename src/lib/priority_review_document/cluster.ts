import { RNPlugin, PluginRem } from '@remnote/plugin-sdk';

// Possible powerup codes for the Card Cluster built-in powerup.
// RemNote exposes it via the /cluster slash command but does not publish
// the code in BuiltInPowerupCodes, so we try several plausible variants.
const CARD_CLUSTER_POWERUP_CODES = ['cluster', 'cardCluster', 'card-cluster', 'card_cluster', 'cardcluster'];

/**
 * Returns true if `rem` carries the Card Cluster powerup.
 * Tries each known code variant first, then falls back to inspecting
 * the rem's tag-rems for text that contains "cluster" (case-insensitive).
 */
export async function hasCardClusterPowerup(plugin: RNPlugin, rem: PluginRem): Promise<boolean> {
  for (const code of CARD_CLUSTER_POWERUP_CODES) {
    try {
      if (await rem.hasPowerup(code)) {
        console.log(`[CardCluster] Detected via powerup code "${code}" on rem ${rem._id}`);
        return true;
      }
    } catch (_) {
      // ignore individual failures
    }
  }

  try {
    const tags = await rem.getTagRems();
    if (tags?.length) {
      for (const tag of tags) {
        const tagText = Array.isArray(tag.text)
          ? tag.text.join('')
          : typeof tag.text === 'string'
          ? tag.text
          : '';
        if (tagText.toLowerCase().includes('cluster')) {
          console.log(`[CardCluster] Detected via tag text "${tagText}" on rem ${rem._id}`);
          return true;
        }
      }
    }
  } catch (_) {
    // ignore
  }

  return false;
}
