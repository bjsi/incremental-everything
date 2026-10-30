// The one Embed Website Rem that shows every YouTube video the plugin plays.
//
// The plugin's own iframe can't run a YouTube player, so the queue shows our
// player page inside an Embed Website (`ew`) Rem that RemNote renders, and
// drives it over postMessage (lib/youtube_embed_bridge.ts). Rather than leave
// an embed Rem behind per video, there is a single player document per
// knowledge base: a document with one `ew` child whose URL is rewritten for
// each video. See findings/VIDEO_PLAYBACK.md.

import { BuiltInPowerupCodes, RemId, RNPlugin } from '@remnote/plugin-sdk';

const DOC_TITLE = '▶️ Incremental RemNote video player';

const playerRemKey = (kbId: string) => `video-player-rem_${kbId}`;

export interface PlayerRemIds {
  docId: RemId;
  embedId: RemId;
}

let pending: Promise<PlayerRemIds> | null = null;

async function findOrCreate(plugin: RNPlugin): Promise<PlayerRemIds> {
  const kbId = (await plugin.kb.getCurrentKnowledgeBaseData())._id;
  const stored = await plugin.storage.getSynced<PlayerRemIds>(playerRemKey(kbId));
  if (stored) {
    const [doc, embed] = await Promise.all([
      plugin.rem.findOne(stored.docId),
      plugin.rem.findOne(stored.embedId),
    ]);
    if (
      doc &&
      embed &&
      embed.parent === doc._id &&
      (await embed.hasPowerup(BuiltInPowerupCodes.EmbedWebsite))
    ) {
      return stored;
    }
    // Deleted or edited by hand: start over rather than repair it.
    await doc?.remove();
  }
  const doc = await plugin.rem.createRem();
  const embed = await plugin.rem.createRem();
  if (!doc || !embed) throw new Error('Could not create the video player Rem.');
  await doc.setText([DOC_TITLE]);
  await doc.setIsDocument(true);
  await embed.setParent(doc._id);
  await embed.addPowerup(BuiltInPowerupCodes.EmbedWebsite);
  const ids = { docId: doc._id, embedId: embed._id };
  await plugin.storage.setSynced(playerRemKey(kbId), ids);
  return ids;
}

/** The player document and its embed, created on first use. */
export function getPlayerRem(plugin: RNPlugin): Promise<PlayerRemIds> {
  if (!pending) {
    pending = findOrCreate(plugin).finally(() => {
      pending = null;
    });
  }
  return pending;
}

/**
 * Points the player at `url`. Rewriting the URL makes RemNote load the new page
 * in the same iframe; an unchanged URL is left alone so a playing video keeps
 * playing.
 */
export async function setPlayerUrl(plugin: RNPlugin, embedId: RemId, url: string): Promise<void> {
  const embed = await plugin.rem.findOne(embedId);
  if (!embed) return;
  const current = await embed.getPowerupProperty(BuiltInPowerupCodes.EmbedWebsite, 'URL');
  if (current !== url)
    await embed.setPowerupProperty(BuiltInPowerupCodes.EmbedWebsite, 'URL', [url]);
}

/**
 * Sets the embed's size in pixels. RemNote only reads WIDTH and HEIGHT when
 * both are set, and caps WIDTH at the document's width.
 */
export async function setPlayerSize(
  plugin: RNPlugin,
  embedId: RemId,
  width: number,
  height: number
): Promise<void> {
  const embed = await plugin.rem.findOne(embedId);
  if (!embed) return;
  await embed.setPowerupProperty(BuiltInPowerupCodes.EmbedWebsite, 'WIDTH', [
    `${Math.round(width)}`,
  ]);
  await embed.setPowerupProperty(BuiltInPowerupCodes.EmbedWebsite, 'HEIGHT', [
    `${Math.round(height)}`,
  ]);
}
