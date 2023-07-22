import { RNPlugin, Rem, BuiltInPowerupCodes } from '@remnote/plugin-sdk';
import { RemAndType } from './types';

export const remToActionItemType = async (
  plugin: RNPlugin,
  rem: Rem
): Promise<RemAndType | null> => {
  if (await rem.hasPowerup(BuiltInPowerupCodes.PDFHighlight)) {
    const pdfId = await rem.getPowerupProperty<BuiltInPowerupCodes.PDFHighlight>(
      BuiltInPowerupCodes.PDFHighlight,
      'PdfId'
    );
    const pdf = await plugin.rem.findOne(pdfId);
    if (!pdf) {
      await plugin.app.toast('PDF not found for extract. Skipping.');
      return null;
    } else {
      return { extract: rem, type: 'pdf-highlight', rem: pdf };
    }
  } else if (await rem.hasPowerup(BuiltInPowerupCodes.HTMLHighlight)) {
    const html = await rem.getPowerupProperty<BuiltInPowerupCodes.HTMLHighlight>(
      BuiltInPowerupCodes.HTMLHighlight,
      'HTMLId'
    );
    const htmlRem = await plugin.rem.findOne(html);
    if (!htmlRem) {
      await plugin.app.toast('HTML not found for extract. Skipping.');
      return null;
    } else {
      return { extract: rem, type: 'html-highlight', rem: htmlRem };
    }
  } else if (await rem.hasPowerup(BuiltInPowerupCodes.UploadedFile)) {
    return { rem, type: 'pdf' };
  } else if (
    (await rem.hasPowerup(BuiltInPowerupCodes.Link)) &&
    (await rem.getPowerupProperty<BuiltInPowerupCodes.Link>(BuiltInPowerupCodes.Link, 'URL'))
  ) {
    const url = await rem.getPowerupProperty<BuiltInPowerupCodes.Link>(
      BuiltInPowerupCodes.Link,
      'URL'
    );
    if (url.includes('youtube')) {
      return {
        type: 'youtube',
        rem,
      };
    } else {
      return {
        type: 'html',
        rem,
      };
    }
  } else {
    return { rem, type: 'rem' };
  }
};
