import { usePlugin, useTrackerPlugin, WidgetLocation } from '@remnote/plugin-sdk';
import React from 'react';
import {
  editorReviewTimerRemIdKey,
  editorReviewTimerStartKey,
  localVideoQueueNotesKey,
} from '../lib/consts';
import { LocalVideoActionItem, LocalVideoHighlightActionItem } from '../lib/incremental_rem/types';
import { localVideoItemForRem } from '../lib/local_video';
import { LocalVideoViewer, QUEUE_NOTES_REFRESH_MS } from './LocalVideoViewer';

// The player of a local video under its document's title, so it plays in the
// editor (Review in Editor, or just opening the Rem). Mounted by two widgets,
// one per powerup filter: the Local Video Rem and its extracts.
//
// The queue's notes pane is a DocumentViewer of the same Rem and hosts this
// widget too, beside the queue's own player. The widget context is only
// { documentId }, so the queue's player announces the Rem of its notes
// (localVideoQueueNotesKey) and the widget stays empty for it.

type Item = LocalVideoActionItem | LocalVideoHighlightActionItem;

/** An announcement older than this is from a queue player that's gone. */
const QUEUE_NOTES_STALE_MS = QUEUE_NOTES_REFRESH_MS * 3;

export function LocalVideoEditorPlayer() {
  const plugin = usePlugin();
  const [state, setState] = React.useState<{
    documentId: string;
    item: Item;
    autoplay: boolean;
  } | null>(null);
  // Re-reads the announcement when it may have gone stale.
  const [now, setNow] = React.useState(Date.now());

  React.useEffect(() => {
    (async () => {
      const ctx = await plugin.widget.getWidgetContext<WidgetLocation.DocumentBelowTitle>();
      const rem = ctx?.documentId ? await plugin.rem.findOne(ctx.documentId) : undefined;
      const item = rem ? await localVideoItemForRem(plugin, rem) : null;
      if (!item) return;
      // Play at once only for a review of this Rem; opening it otherwise stays quiet.
      const [reviewRemId, reviewStart] = await Promise.all([
        plugin.storage.getSession<string>(editorReviewTimerRemIdKey),
        plugin.storage.getSession<number>(editorReviewTimerStartKey),
      ]);
      setState({
        documentId: ctx.documentId,
        item,
        autoplay: !!reviewStart && reviewRemId === ctx.documentId,
      });
    })().catch((e) => console.error('[LocalVideoEditor]', e));
  }, []);

  const queueNotes = useTrackerPlugin(
    (rp) => rp.storage.getSession<{ remId: string; at: number } | null>(localVideoQueueNotesKey),
    []
  );
  const inQueue =
    !!state && queueNotes?.remId === state.documentId && now - queueNotes.at < QUEUE_NOTES_STALE_MS;

  React.useEffect(() => {
    if (!inQueue) return;
    const timer = setTimeout(() => setNow(Date.now()), QUEUE_NOTES_STALE_MS);
    return () => clearTimeout(timer);
  }, [inQueue, queueNotes?.at, now]);

  if (!state || inQueue) return null;
  return (
    <div style={{ padding: '4px 0 8px' }}>
      <LocalVideoViewer actionItem={state.item} inEditor autoplay={state.autoplay} />
    </div>
  );
}
