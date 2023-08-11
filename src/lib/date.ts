import { RNPlugin } from '@remnote/plugin-sdk';

export async function getDailyDocReferenceForDate(plugin: RNPlugin, date: Date) {
  const dailyDoc = await plugin.date.getDailyDoc(date);
  if (!dailyDoc) {
    return;
  }
  const dateRef = await plugin.richText.rem(dailyDoc).value();
  return dateRef;
}
