import { RNPlugin, RemId } from '@remnote/plugin-sdk';
import { initIncrementalRem } from './incremental_rem';
import { showPriorityPopupForRem } from './highlightActions';
import {
  videoExtractPowerupCode,
  videoExtractUrlSlotCode,
  videoExtractStartSlotCode,
  videoExtractEndSlotCode,
} from './consts';
import { getTranscriptForRange, extractVideoId } from './youtube_transcript';
import { formatVideoTime } from './video_snapshot';

/**
 * Creates a Video Extract: an Incremental child of the video Rem with the
 * VideoExtract powerup (URL, start, end), followed by the range's transcript
 * as child Rems when YouTube has one, then the priority popup. The same for
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

    // Fetch transcript and add segments as children Rems
    const videoId = extractVideoId(url);
    try {
      console.log('[VideoExtract] Attempting transcript fetch for videoId:', videoId, 'range:', startTime, '-', endTime);
      if (videoId) {
        const segments = await getTranscriptForRange(videoId, startTime, endTime);
        if (segments.length > 0) {
          // Consolidate segments into larger chunks (~300 chars each)
          const MAX_CHUNK_CHARS = 300;
          const chunks: string[] = [];
          let current = '';

          for (const seg of segments) {
            const candidate = current ? `${current} ${seg.text}` : seg.text;
            if (current && candidate.length > MAX_CHUNK_CHARS) {
              chunks.push(current);
              current = seg.text;
            } else {
              current = candidate;
            }
          }
          if (current) chunks.push(current);

          for (const chunk of chunks) {
            const childRem = await plugin.rem.createRem();
            if (childRem) {
              await childRem.setText([chunk]);
              await childRem.setParent(newRem._id);
            }
          }
          await plugin.app.toast(`📝 Added transcript (${chunks.length} block${chunks.length > 1 ? 's' : ''})`);
        } else {
          await plugin.app.toast('ℹ️ No transcript segments found for this range');
        }
      }
    } catch (transcriptErr) {
      console.warn('[VideoExtract] Could not fetch transcript:', transcriptErr);
      await plugin.app.toast('⚠️ Transcript unavailable (see console for details)');
    }

    // Show priority popup
    setTimeout(async () => {
      await showPriorityPopupForRem(plugin as any, newRem._id);
    }, 300);
  } catch (error) {
    console.error('[VideoExtract] Error creating video extract:', error);
    await plugin.app.toast('Error creating video extract');
  }
}
