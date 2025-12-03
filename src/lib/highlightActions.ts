import {
  BuiltInPowerupCodes,
  PluginRem,
  ReactRNPlugin,
  RemId,
  RichTextElementRemInterface,
} from '@remnote/plugin-sdk';
import { parentSelectorWidgetId, powerupCode } from './consts';
import { findAllRemsForPDF } from './pdfUtils';
import { initIncrementalRem } from './incremental_rem';
import { removeIncrementalRemCache } from './incremental_rem/cache';

type CreateRemFromHighlightOptions = {
  makeIncremental: boolean;
  sourceDocumentId?: RemId;
};

type ParentSelectorCandidate = {
  remId: RemId;
  name: string;
  isIncremental: boolean;
};

const buildContextForSelector = (
  pdfRemId: RemId,
  extractRem: PluginRem,
  candidates: ParentSelectorCandidate[],
  makeIncremental: boolean
) => ({
  pdfRemId,
  extractRemId: extractRem._id,
  extractContent: extractRem.text || [],
  candidates,
  makeIncremental,
});

const resolveSourceDocument = async (
  plugin: ReactRNPlugin,
  highlightRem: PluginRem,
  explicitSourceId?: RemId
) => {
  if (explicitSourceId) {
    const explicitSource = await plugin.rem.findOne(explicitSourceId);
    if (explicitSource) return explicitSource;
  }

  if (await highlightRem.hasPowerup(BuiltInPowerupCodes.PDFHighlight)) {
    const pdfId = (
      (
        await highlightRem.getPowerupPropertyAsRichText<BuiltInPowerupCodes.PDFHighlight>(
          BuiltInPowerupCodes.PDFHighlight,
          'PdfId'
        )
      )[0] as RichTextElementRemInterface
    )?._id;
    if (pdfId) {
      const pdfRem = await plugin.rem.findOne(pdfId);
      if (pdfRem) return pdfRem;
    }
  }

  if (await highlightRem.hasPowerup(BuiltInPowerupCodes.HTMLHighlight)) {
    const htmlId = (
      (
        await highlightRem.getPowerupPropertyAsRichText<BuiltInPowerupCodes.HTMLHighlight>(
          BuiltInPowerupCodes.HTMLHighlight,
          'HTMLId'
        )
      )[0] as RichTextElementRemInterface
    )?._id;
    if (htmlId) {
      const htmlRem = await plugin.rem.findOne(htmlId);
      if (htmlRem) return htmlRem;
    }
  }

  if (highlightRem.parent) {
    const parentRem = await plugin.rem.findOne(highlightRem.parent);
    if (parentRem) return parentRem;
  }

  return null;
};

const createRemUnderParent = async (
  plugin: ReactRNPlugin,
  highlightRem: PluginRem,
  parentId: RemId,
  makeIncremental: boolean,
  parentName?: string
) => {
  const newRem = await plugin.rem.createRem();
  if (!newRem) {
    await plugin.app.toast('Failed to create rem');
    return;
  }

  const sourceLink = { i: 'q' as const, _id: highlightRem._id, pin: true };
  const contentWithReference = [...(highlightRem.text || []), ' ', sourceLink];

  await newRem.setText(contentWithReference);
  await newRem.setParent(parentId);

  if (makeIncremental) {
    await initIncrementalRem(plugin, newRem);
  }

  await removeIncrementalRemCache(plugin, highlightRem._id);
  await highlightRem.removePowerup(powerupCode);
  await highlightRem.setHighlightColor('Yellow');

  const actionText = makeIncremental ? 'incremental rem' : 'rem';
  const parentSuffix = parentName ? ` under "${parentName.slice(0, 30)}..."` : ' under source';
  await plugin.app.toast(`Created ${actionText}${parentSuffix}`);
};

export const createRemFromHighlight = async (
  plugin: ReactRNPlugin,
  highlightRem: PluginRem,
  options: CreateRemFromHighlightOptions
) => {
  const { makeIncremental, sourceDocumentId } = options;

  const sourceDocument = await resolveSourceDocument(plugin, highlightRem, sourceDocumentId);
  if (!sourceDocument) {
    await plugin.app.toast('Could not find the source document for this highlight');
    return;
  }

  const isPdfSource = await sourceDocument.hasPowerup(BuiltInPowerupCodes.UploadedFile);
  const candidates: ParentSelectorCandidate[] = isPdfSource
    ? await findAllRemsForPDF(plugin, sourceDocument._id)
    : [];

  if (!isPdfSource || candidates.length === 0) {
    await createRemUnderParent(plugin, highlightRem, sourceDocument._id, makeIncremental);
    return;
  }

  if (candidates.length === 1) {
    const [parent] = candidates;
    await createRemUnderParent(plugin, highlightRem, parent.remId, makeIncremental, parent.name);
    return;
  }

  const context = buildContextForSelector(
    sourceDocument._id,
    highlightRem,
    candidates,
    makeIncremental
  );
  await plugin.storage.setSession('parentSelectorContext', context);
  await plugin.widget.openPopup(parentSelectorWidgetId);
};
