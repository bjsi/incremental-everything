import {
  RNPlugin,
  PluginRem,
  BuiltInPowerupCodes,
  RichTextElementRemInterface,
} from '@remnote/plugin-sdk';
import { RemAndType } from './types';
import { safeRemTextToString } from './pdfUtils';

export const remToActionItemType = async (
  plugin: RNPlugin,
  rem: PluginRem
): Promise<RemAndType | null> => {
  console.log('📋 remToActionItemType CALLED for rem:', rem._id);
  
  // Check if this rem has a tag reference to "extractviewer"
  try {
    const tags = await rem.getTagRems();
    
    for (const tagRem of tags) {
      if (!tagRem.text) continue;
      const tagText = await safeRemTextToString(plugin, tagRem.text);
      
      if (tagText.toLowerCase() === 'extractviewer' || 
          tagText.toLowerCase() === 'extract viewer') {
        console.log('📋 remToActionItemType RETURNING: extractviewer (rem type)');
        return { rem, type: 'rem' };
      }
    }
  } catch (error) {
    console.log('Error checking for extractviewer tag:', error);
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
      console.log('📋 remToActionItemType RETURNING: null (PDF not found)');
      return null;
    } else {
      console.log('📋 remToActionItemType RETURNING: pdf-highlight');
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
      console.log('📋 remToActionItemType RETURNING: null (HTML not found)');
      return null;
    } else {
      console.log('📋 remToActionItemType RETURNING: html-highlight');
      return { extract: rem, type: 'html-highlight', rem: htmlRem };
    }
  } else if (await rem.hasPowerup(BuiltInPowerupCodes.UploadedFile)) {
    console.log('📋 remToActionItemType RETURNING: pdf (UploadedFile)');
    return { rem, type: 'pdf' };
  } else if (await rem.hasPowerup('vi')) {
    console.log('📋 remToActionItemType RETURNING: video (vi powerup)');
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
      console.log('📋 remToActionItemType RETURNING: youtube');
      return {
        type: 'youtube',
        url,
        rem,
      };
    } else {
      console.log('📋 remToActionItemType RETURNING: html (Link)');
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
        console.log('📋 remToActionItemType RETURNING: youtube from source');
        return {
          ...data,
          rem,
        };
      }
    } else {
      const data = await remToActionItemType(plugin, source);
      if (data) {
        console.log('📋 remToActionItemType RETURNING: data from source');
        return data;
      }
    }
    console.log('📋 remToActionItemType RETURNING: rem (has sources)');
    return { rem, type: 'rem' };
  } else {
    console.log('📋 remToActionItemType RETURNING: rem (default)');
    return { rem, type: 'rem' };
  }
};