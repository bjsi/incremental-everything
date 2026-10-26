import { usePlugin, WidgetLocation } from '@remnote/plugin-sdk';
import React from 'react';
import { editorReviewTimerRemIdKey, editorReviewTimerStartKey } from '../lib/consts';
import { LocalVideoActionItem, LocalVideoHighlightActionItem } from '../lib/incremental_rem/types';
import { localVideoItemForRem } from '../lib/local_video';
import { LocalVideoViewer } from './LocalVideoViewer';

// The player of a local video under its document's title, so it plays in the
// editor (Review in Editor, or just opening the Rem). Mounted by two widgets,
// one per powerup filter: the Local Video Rem and its extracts.
//
// The queue's notes pane is a DocumentViewer of the same Rem and hosts this
// widget too, beside the queue's own player; there it stays empty.

type Item = LocalVideoActionItem | LocalVideoHighlightActionItem;

export function LocalVideoEditorPlayer() {
  const plugin = usePlugin();
  const [state, setState] = React.useState<{ item: Item; autoplay: boolean } | null>(null);

  React.useEffect(() => {
    (async () => {
      if ((await plugin.window.getURL()).includes('/flashcards')) return;
      const ctx = await plugin.widget.getWidgetContext<WidgetLocation.DocumentBelowTitle>();
      const rem = ctx?.documentId ? await plugin.rem.findOne(ctx.documentId) : undefined;
      const item = rem ? await localVideoItemForRem(plugin, rem) : null;
      if (!item) return;
      // Play at once only for a review of this Rem; opening it otherwise stays quiet.
      const [reviewRemId, reviewStart] = await Promise.all([
        plugin.storage.getSession<string>(editorReviewTimerRemIdKey),
        plugin.storage.getSession<number>(editorReviewTimerStartKey),
      ]);
      setState({ item, autoplay: !!reviewStart && reviewRemId === ctx.documentId });
    })().catch((e) => console.error('[LocalVideoEditor]', e));
  }, []);

  if (!state) return null;
  return (
    <div style={{ padding: '4px 0 8px' }}>
      <LocalVideoViewer actionItem={state.item} inEditor autoplay={state.autoplay} />
    </div>
  );
}
