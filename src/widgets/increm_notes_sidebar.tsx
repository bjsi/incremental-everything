// widgets/increm_notes_sidebar.tsx
// Right-sidebar widget that shows a DocumentViewer for the current IncRem being reviewed.
// Uses three existing session keys as signals:
//   - currentIncRemKey: the IncRem ID (stale during flashcard turns)
//   - incrementalQueueActiveKey: true only while QueueComponent is mounted
//   - currentIncrementalRemTypeKey: the action item type (pdf, html, rem, youtube, etc.)
// Only renders for PDF/HTML types where a side-by-side document view is useful.

import React from 'react';
import { DocumentViewer, RemId, renderWidget, usePlugin, useTrackerPlugin } from '@remnote/plugin-sdk';
import { currentIncRemKey, incrementalQueueActiveKey, currentIncrementalRemTypeKey } from '../lib/consts';

// Types where showing the document notes sidebar makes sense
const DOCUMENT_TYPES = new Set(['pdf', 'html', 'pdf-highlight', 'html-highlight']);

function IncremNotesSidebar() {
  const plugin = usePlugin();

  const currentIncRemId = useTrackerPlugin(
    (rp) => rp.storage.getSession<string>(currentIncRemKey),
    []
  );
  
  const isQueueActive = useTrackerPlugin(
    (rp) => rp.storage.getSession<boolean>(incrementalQueueActiveKey),
    []
  );

  const remType = useTrackerPlugin(
    (rp) => rp.storage.getSession<string>(currentIncrementalRemTypeKey),
    []
  );

  // Only show DocumentViewer when:
  // 1. QueueComponent is mounted (IncRem turn, not flashcard)
  // 2. We have an IncRem ID
  // 3. The current item is a PDF/HTML type (not an extract rem, video, etc.)
  const isDocumentType = remType != null && DOCUMENT_TYPES.has(remType);
  const remId = isQueueActive && currentIncRemId && isDocumentType ? currentIncRemId : null;

  console.log("IncremNotesSidebar state:", { 
    currentIncRemId, 
    isQueueActive, 
    remType, 
    isDocumentType, 
    remId 
  });

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
        <span>No document being reviewed.<br />Click 📝 while reviewing a PDF/HTML to open its notes here.</span>
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
