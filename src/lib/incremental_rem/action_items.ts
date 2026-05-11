import {
  RNPlugin,
  PluginRem,
  BuiltInPowerupCodes,
  RichTextElementRemInterface,
} from '@remnote/plugin-sdk';
import { RemAndType } from './types';
import { safeRemTextToString, getActivePdfKey } from '../pdfUtils';
import {
  videoExtractPowerupCode,
  videoExtractUrlSlotCode,
  videoExtractStartSlotCode,
  videoExtractEndSlotCode,
} from '../consts';

export const remToActionItemType = async (
  plugin: RNPlugin,
  rem: PluginRem
): Promise<RemAndType | null> => {
  // Check if this rem has a tag reference to "extractviewer"
  try {
    const tags = await rem.getTagRems();

    for (const tagRem of tags) {
      if (!tagRem.text) continue;
      const tagText = await safeRemTextToString(plugin, tagRem.text);

      if (tagText.toLowerCase() === 'extractviewer' ||
        tagText.toLowerCase() === 'extract viewer') {
        return { rem, type: 'rem' };
      }
    }
  } catch (error) {
    // Ignore errors
  }

  // Check for VideoExtract powerup (YouTube video segment)
  if (await rem.hasPowerup(videoExtractPowerupCode)) {
    try {
      const videoUrl = await rem.getPowerupProperty(videoExtractPowerupCode, videoExtractUrlSlotCode);
      const startTime = await rem.getPowerupProperty(videoExtractPowerupCode, videoExtractStartSlotCode);
      const endTime = await rem.getPowerupProperty(videoExtractPowerupCode, videoExtractEndSlotCode);

      if (videoUrl && startTime != null && endTime != null) {
        // Find the parent video Rem
        const parentId = rem.parent;
        const parentRem = parentId ? await plugin.rem.findOne(parentId) : null;

        return {
          type: 'youtube-highlight',
          rem: parentRem || rem, // parent video Rem (fallback to self)
          extract: rem,
          url: String(videoUrl),
          startTime: Number(startTime),
          endTime: Number(endTime),
        };
      }
    } catch (error) {
      console.error('[action_items] Error reading VideoExtract powerup:', error);
    }
  }

  if (await rem.hasPowerup(BuiltInPowerupCodes.PDFHighlight)) {
    const pdfId = (
      (
        await rem.getPowerupPropertyAsRichText<BuiltInPowerupCodes.PDFHighlight>(
          BuiltInPowerupCodes.PDFHighlight,
          'PdfId'
        )
      )[0] as RichTextElementRemInterface
    )?._id;
    const pdf = await plugin.rem.findOne(pdfId);
    if (!pdf) {
      await plugin.app.toast('PDF not found for extract. Skipping.');
      return null;
    } else {
      return { extract: rem, type: 'pdf-highlight', rem: pdf };
    }
  } else if (await rem.hasPowerup(BuiltInPowerupCodes.HTMLHighlight)) {
    const html = (
      (
        await rem.getPowerupPropertyAsRichText<BuiltInPowerupCodes.HTMLHighlight>(
          BuiltInPowerupCodes.HTMLHighlight,
          'HTMLId'
        )
      )[0] as RichTextElementRemInterface
    )?._id;
    const htmlRem = await plugin.rem.findOne(html);
    if (!htmlRem) {
      await plugin.app.toast('HTML not found for extract. Skipping.');
      return null;
    } else {
      return { extract: rem, type: 'html-highlight', rem: htmlRem };
    }
  } else if (await rem.hasPowerup(BuiltInPowerupCodes.UploadedFile)) {
    return { rem, type: 'pdf' };
  } else if (await rem.hasPowerup('vi')) {
    return { rem, type: 'video' };
  } else if (
    (await rem.hasPowerup(BuiltInPowerupCodes.Link)) &&
    (await rem.getPowerupProperty<BuiltInPowerupCodes.Link>(BuiltInPowerupCodes.Link, 'URL'))
  ) {
    const url = await rem.getPowerupProperty<BuiltInPowerupCodes.Link>(
      BuiltInPowerupCodes.Link,
      'URL'
    );
    if (['youtube', 'youtu.be'].some((x) => url.includes(x))) {
      return {
        type: 'youtube',
        url,
        rem,
      };
    } else {
      return {
        type: 'html',
        rem,
      };
    }
   } else {
    const sources = await rem.getSources();
    let selectedSource: PluginRem | null = null;

    console.log('[action_items] Source resolution for rem', rem._id, '- found', sources.length, 'sources');

    if (sources.length === 1) {
      selectedSource = sources[0];
    } else if (sources.length > 1) {
      // An explicit per-IncRem PDF pin trumps the #preferthispdf tag scan.
      // (No pin → existing tag-based behavior is preserved verbatim.)
      const pinnedPdfId = await plugin.storage.getSynced<string>(getActivePdfKey(rem._id));
      if (pinnedPdfId) {
        const pinned = sources.find((s) => s._id === pinnedPdfId);
        if (pinned) {
          selectedSource = pinned;
        }
      }

      if (!selectedSource) {
        const preferredSources: PluginRem[] = [];
        for (const source of sources) {
          try {
            const tags = await source.getTagRems();
            for (const tagRem of tags) {
              if (!tagRem.text) continue;
              const tagText = await safeRemTextToString(plugin, tagRem.text);
              const tagLower = tagText.toLowerCase().replace(/\s+/g, '');
              if (tagLower === 'preferthispdf') {
                preferredSources.push(source);
                break;
              }
            }
          } catch (e) {
            // Ignore errors reading tags
          }
        }

        if (preferredSources.length === 1) {
          selectedSource = preferredSources[0];
        } else if (preferredSources.length > 1) {
          await plugin.app.toast('Multiple PDFs have the #preferthispdf tag. Opening in standard Rem view instead of Reader.');
        }
      }
    }

    if (selectedSource) {
      const isLink = await selectedSource.hasPowerup(BuiltInPowerupCodes.Link);
      let url = undefined;
      try {
        if (isLink) {
          url = await selectedSource.getPowerupProperty<BuiltInPowerupCodes.Link>(
            BuiltInPowerupCodes.Link,
            'URL'
          );
        }
      } catch (e) {}

      console.log('[action_items] Source resolution:', {
        sourceRemId: selectedSource._id,
        isLink,
        url: url?.substring(0, 60),
        originalRemId: rem._id,
      });

      if (isLink && url && url.includes('youtube')) {
        const data = await remToActionItemType(plugin, selectedSource);
        if (data) {
          return {
            ...data,
            rem,
          };
        }
      } else {
        const data = await remToActionItemType(plugin, selectedSource);
        console.log('[action_items] ⚠️ Non-YouTube source resolved to:', {
          type: data?.type,
          returnedRemId: data?.rem?._id,
          originalRemId: rem._id,
          NOTE: 'If type is html, rem._id here is the SOURCE, not the incremental rem!',
        });
        if (data) {
          return data;
        }
      }
    }
    
    return { rem, type: 'rem' };
  }
};