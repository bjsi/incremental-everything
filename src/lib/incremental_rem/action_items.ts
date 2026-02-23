import {
  RNPlugin,
  PluginRem,
  BuiltInPowerupCodes,
  RichTextElementRemInterface,
} from '@remnote/plugin-sdk';
import { RemAndType } from './types';
import { safeRemTextToString } from '../pdfUtils';
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
  } else if ((await rem.getSources()).length === 1) {
    const source = (await rem.getSources())[0];
    const isLink = await source.hasPowerup(BuiltInPowerupCodes.Link);
    const url = await source.getPowerupProperty<BuiltInPowerupCodes.Link>(
      BuiltInPowerupCodes.Link,
      'URL'
    );
    if (isLink && url && url.includes('youtube')) {
      const data = await remToActionItemType(plugin, source);
      if (data) {
        return {
          ...data,
          rem,
        };
      }
    } else {
      const data = await remToActionItemType(plugin, source);
      if (data) {
        return data;
      }
    }
    return { rem, type: 'rem' };
  } else {
    return { rem, type: 'rem' };
  }
};