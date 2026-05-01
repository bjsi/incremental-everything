// widgets/increm_notes_sidebar.tsx
// Right-sidebar widget that shows a DocumentViewer for the current IncRem being reviewed.
// Reads two existing session keys:
//   - currentIncRemKey: the IncRem ID (set by QueueComponent on mount, stale during flashcard turns)
//   - incrementalQueueActiveKey: true only while QueueComponent is mounted (IncRem turn)
// Only renders when BOTH signals are present, which correctly hides during flashcard turns.

import React from 'react';
import { DocumentViewer, RemId, renderWidget, usePlugin, useSessionStorageState } from '@remnote/plugin-sdk';
import { currentIncRemKey, incrementalQueueActiveKey } from '../lib/consts';

function IncremNotesSidebar() {
  const plugin = usePlugin();

  // currentIncRemKey holds the IncRem ID but is NOT cleared during flashcard turns
  // (QueueComponent simply doesn't mount for regular flashcards).
  const [currentIncRemId] = useSessionStorageState<string | null>(currentIncRemKey, null);

  // incrementalQueueActiveKey is true only while QueueComponent is mounted (IncRem turn),
  // and false when it unmounts (flashcard turn) or the queue exits.
  const [isQueueActive] = useSessionStorageState<boolean>(incrementalQueueActiveKey, false);

  // Debug: log both values to understand why the widget doesn't update during flashcard turns
  React.useEffect(() => {
    console.log('[IncremNotesSidebar] currentIncRemId:', currentIncRemId, '| isQueueActive:', isQueueActive);
  }, [currentIncRemId, isQueueActive]);

  // Only show the DocumentViewer when an IncRem is actively being reviewed.
  const remId = isQueueActive && currentIncRemId ? currentIncRemId : null;

  if (!remId) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          gap: '8px',
          color: 'var(--rn-clr-content-tertiary)',
          fontSize: '13px',
          padding: '24px',
          textAlign: 'center',
        }}
      >
        <span style={{ fontSize: '24px' }}>📝</span>
        <span>No IncRem being reviewed.<br />Click 📝 while reviewing an IncRem to open its notes here.</span>
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height: '100%', overflow: 'hidden' }}>
      <DocumentViewer
        key={remId}
        documentId={remId as RemId}
        width="100%"
        height="100%"
      />
    </div>
  );
}

renderWidget(IncremNotesSidebar);
