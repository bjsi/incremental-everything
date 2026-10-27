import {
  AppEvents,
  useAPIEventListener,
  usePlugin,
  useTrackerPlugin,
  WidgetLocation,
} from '@remnote/plugin-sdk';
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
// editor (Review in Editor, or just opening the Rem): a Local Video Rem or an
// extract of one. Hosted by the Inc Rems counter (widgets/inc_rem_counter.tsx),
// the one widget mounted under every document's title, and empty elsewhere.
//
// Not a widget of its own with a powerup filter: RemNote works out a
// document's filtered widgets once, for the document the pane first showed,
// and keeps that list when the pane zooms to another document (only the
// context follows). The player stayed on after zooming out of a video and
// never came on after zooming into one. The context changes with no event of
// its own, so the document is read again on every URL, pane and focus change,
// and twice more shortly after mounting.
//
// The queue's notes pane is a DocumentViewer of the same Rem and hosts this
// too, beside the queue's own player. The widget context is only
// { documentId }, so the queue's player announces the Rem of its notes
// (localVideoQueueNotesKey) and this stays empty for it.

type Item = LocalVideoActionItem | LocalVideoHighlightActionItem;

/** Re-reads of the document after mounting, in ms. */
const SETTLE_REREADS_MS = [300, 1000];

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

  // The document this widget is under now; a newer read supersedes an older one.
  const shownId = React.useRef<string | undefined>();
  const readDocument = React.useCallback(async () => {
    try {
      const ctx = await plugin.widget.getWidgetContext<WidgetLocation.DocumentBelowTitle>();
      const documentId = ctx?.documentId;
      if (documentId === shownId.current) return;
      shownId.current = documentId;
      const rem = documentId ? await plugin.rem.findOne(documentId) : undefined;
      const item = rem ? await localVideoItemForRem(plugin, rem) : null;
      // Play at once only for a review of this Rem; opening it otherwise stays quiet.
      const [reviewRemId, reviewStart] = await Promise.all([
        plugin.storage.getSession<string>(editorReviewTimerRemIdKey),
        plugin.storage.getSession<number>(editorReviewTimerStartKey),
      ]);
      if (shownId.current !== documentId) return;
      setState(
        item && documentId
          ? { documentId, item, autoplay: !!reviewStart && reviewRemId === documentId }
          : null
      );
    } catch (e) {
      console.error('[LocalVideoEditor]', e);
    }
  }, []);

  React.useEffect(() => {
    readDocument();
    const timers = SETTLE_REREADS_MS.map((ms) => setTimeout(readDocument, ms));
    return () => timers.forEach(clearTimeout);
  }, []);
  useAPIEventListener(AppEvents.URLChange, undefined, readDocument);
  useAPIEventListener(AppEvents.CurrentWindowTreeChange, undefined, readDocument);
  useAPIEventListener(AppEvents.FocusedPaneChange, undefined, readDocument);

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
      <LocalVideoViewer
        key={state.documentId}
        actionItem={state.item}
        inEditor
        autoplay={state.autoplay}
      />
    </div>
  );
}
