import { RNPlugin, RemId } from '@remnote/plugin-sdk';
import { initIncrementalRem } from './incremental_rem';
import { showPriorityPopupForRem } from './highlightActions';
import {
  videoExtractPowerupCode,
  videoExtractUrlSlotCode,
  videoExtractStartSlotCode,
  videoExtractEndSlotCode,
} from './consts';
import { addVideoTranscript } from './video_transcript';
import { showMessageDialog } from './message_dialog';
import { checkVideoHelper, formatVideoTime } from './video_snapshot';

/**
 * The extract's range of the transcript, as child Rems, when the helper can
 * fetch it; without the helper this is skipped (📜 in the players says what's
 * missing). Returns false when a fetch failed, after a dialog saying so: a
 * second toast right after "Created video extract" would go unseen.
 */
async function addExtractTranscript(
  plugin: RNPlugin,
  extractId: RemId,
  url: string,
  start: number,
  end: number
): Promise<boolean> {
  if (!(await checkVideoHelper()).transcripts) {
    console.log('[VideoExtract] No transcript: the helper is not running or has no transcript support.');
    return true;
  }
  try {
    const { blocks } = await addVideoTranscript(plugin, { parentId: extractId, url, range: { start, end } });
    await plugin.app.toast(`📝 Added transcript (${blocks} block${blocks > 1 ? 's' : ''})`);
    return true;
  } catch (e) {
    console.warn('[VideoExtract] Could not fetch transcript:', e);
    await showMessageDialog(plugin, {
      title: 'Extract created without its transcript',
      message: e instanceof Error ? e.message : String(e),
      detail:
        "Try again later with 📜 in the extract's player or the Add Video Transcript command (avt). " +
        "Set the extract's priority with Set Priority (⌥P).",
      tone: 'error',
    });
    return false;
  }
}

/**
 * Creates a Video Extract: an Incremental child of the video Rem with the
 * VideoExtract powerup (URL, start, end), followed by the range's transcript
 * as child Rems when the video has captions, then the priority popup. The same for
 * extracts taken in the plugin's player and in RemNote's.
 */
export async function createVideoExtract(
  plugin: RNPlugin,
  opts: { parentId: RemId; url: string; startTime: number; endTime: number }
): Promise<void> {
  const { parentId, url, startTime, endTime } = opts;
  const range = `${formatVideoTime(startTime)} – ${formatVideoTime(endTime)}`;
  try {
    // Create a new child Rem under the video Rem
    const newRem = await plugin.rem.createRem();
    if (!newRem) {
      await plugin.app.toast('Failed to create extract rem');
      return;
    }

    // Set the text to describe the extract
    await newRem.setText([`Video Extract [${range}]`]);
    await newRem.setParent(parentId);

    // Apply the VideoExtract powerup and set slots
    await newRem.addPowerup(videoExtractPowerupCode);
    await newRem.setPowerupProperty(videoExtractPowerupCode, videoExtractUrlSlotCode, [url]);
    await newRem.setPowerupProperty(videoExtractPowerupCode, videoExtractStartSlotCode, [startTime.toString()]);
    await newRem.setPowerupProperty(videoExtractPowerupCode, videoExtractEndSlotCode, [endTime.toString()]);

    // Make it incremental — pass explicitParentId so priority inheritance
    // can walk ancestors correctly (the local `newRem` object's .parent is
    // stale after setParent, same pattern as highlightActions.ts reload).
    await initIncrementalRem(plugin as any, newRem, { explicitParentId: parentId });

    await plugin.app.toast(`✅ Created video extract [${range}]`);

    // A failed transcript says so in a dialog, which takes the place of the
    // priority popup (one popup at a time).
    if (!(await addExtractTranscript(plugin, newRem._id, url, startTime, endTime))) return;

    // Show priority popup
    setTimeout(async () => {
      await showPriorityPopupForRem(plugin as any, newRem._id);
    }, 300);
  } catch (error) {
    console.error('[VideoExtract] Error creating video extract:', error);
    await plugin.app.toast('Error creating video extract');
  }
}
