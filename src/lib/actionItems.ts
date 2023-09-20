import {
  RNPlugin,
  Rem,
  BuiltInPowerupCodes,
  RichTextElementRemInterface,
} from '@remnote/plugin-sdk';
import { RemAndType } from './types';

export const remToActionItemType = async (
  plugin: RNPlugin,
  rem: Rem
): Promise<RemAndType | null> => {
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
      // handles PDF/HTML sources
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
