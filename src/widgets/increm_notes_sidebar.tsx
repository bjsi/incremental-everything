// widgets/increm_notes_sidebar.tsx
// Right-sidebar widget that shows a DocumentViewer for the current IncRem being reviewed.
// Uses three existing session keys as signals:
//   - currentIncRemKey: the IncRem ID (stale during flashcard turns)
//   - incrementalQueueActiveKey: true only while QueueComponent is mounted
//   - currentIncrementalRemTypeKey: the action item type (pdf, html, rem, youtube, etc.)
// Only renders for PDF/HTML types where a side-by-side document view is useful.
//
// For pdf-highlight / html-highlight types, the currentIncRemKey points to the
// extract Rem (which has no useful children). Instead, we discover all IncRems
// that read the same host PDF/HTML and show a selector so the user can pick
// which IncRem's notes to view.

import React, { useEffect, useState, useCallback } from 'react';
import { DocumentViewer, RemId, renderWidget, usePlugin, useTrackerPlugin, RNPlugin } from '@remnote/plugin-sdk';
import {
  currentIncRemKey,
  incrementalQueueActiveKey,
  currentIncrementalRemTypeKey,
  currentHostDocumentIdKey,
} from '../lib/consts';
import { findAllRemsForPDF, findAllRemsForHTML, isHtmlSource } from '../lib/pdfUtils';

// Types where showing the document notes sidebar makes sense
const DOCUMENT_TYPES = new Set(['pdf', 'html', 'pdf-highlight', 'html-highlight']);
const HIGHLIGHT_TYPES = new Set(['pdf-highlight', 'html-highlight']);

interface DiscoveredIncRem {
  remId: string;
  name: string;
  isIncremental: boolean;
}

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

  const hostDocId = useTrackerPlugin(
    (rp) => rp.storage.getSession<string>(currentHostDocumentIdKey),
    []
  );

  // State for highlight IncRem discovery & selector
  const [discoveredRems, setDiscoveredRems] = useState<DiscoveredIncRem[]>([]);
  const [selectedRemId, setSelectedRemId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isDocumentType = remType != null && DOCUMENT_TYPES.has(remType);
  const isHighlightType = remType != null && HIGHLIGHT_TYPES.has(remType);

  // Whether we have a valid document review happening.
  // NOTE: we intentionally do NOT gate on isQueueActive here.
  // incrementalQueueActiveKey is unreliable — callbacks.ts sets it false on flashcard
  // turns and the write races with QueueComponent's mount effect. Instead, the presence
  // of currentIncRemId + a document remType is sufficient evidence.
  const hasActiveDocument = !!currentIncRemId && isDocumentType;

  // For non-highlight types, use currentIncRemId directly
  const directRemId = hasActiveDocument && !isHighlightType
    ? currentIncRemId
    : null;

  // For highlights, discover IncRems associated with the host document
  useEffect(() => {
    if (!hasActiveDocument || !isHighlightType || !hostDocId) {
      setDiscoveredRems([]);
      setSelectedRemId(null);
      return;
    }

    let cancelled = false;
    const discover = async () => {
      setLoading(true);
      try {
        const hostRem = await plugin.rem.findOne(hostDocId as RemId);
        if (!hostRem || cancelled) { setLoading(false); return; }

        const isHtml = await isHtmlSource(hostRem);
        const allRems = isHtml
          ? await findAllRemsForHTML(plugin as unknown as RNPlugin, hostDocId)
          : await findAllRemsForPDF(plugin as unknown as RNPlugin, hostDocId);

        if (cancelled) return;

        // Only show incremental rems (the ones the user actively reads)
        const incremental = allRems.filter(r => r.isIncremental);
        setDiscoveredRems(incremental);

        // Auto-select if exactly one
        if (incremental.length === 1) {
          setSelectedRemId(incremental[0].remId);
        } else {
          setSelectedRemId(null);
        }
      } catch (err) {
        console.error('[IncremNotesSidebar] Error discovering IncRems:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    discover();

    return () => { cancelled = true; };
  }, [hasActiveDocument, isHighlightType, hostDocId, plugin]);

  // Reset selection when the host doc changes
  useEffect(() => {
    setSelectedRemId(null);
  }, [hostDocId]);

  const handleSelect = useCallback((remId: string) => {
    setSelectedRemId(remId);
  }, []);

  const handleBack = useCallback(() => {
    setSelectedRemId(null);
  }, []);

  // Determine which remId to show in the DocumentViewer
  const viewerRemId = directRemId || selectedRemId;

  // Debug: log every render with all signal values
  console.log("[IncremNotesSidebar] render:", {
    currentIncRemId,
    isQueueActive,
    remType,
    hostDocId,
    isDocumentType,
    isHighlightType,
    hasActiveDocument,
    directRemId,
    selectedRemId,
    discoveredRems: discoveredRems.length,
    viewerRemId,
  });

  // Debug: track individual signal changes to detect stuck/stale values
  useEffect(() => {
    console.log("[IncremNotesSidebar] ⚡ currentIncRemId changed:", currentIncRemId);
  }, [currentIncRemId]);
  useEffect(() => {
    console.log("[IncremNotesSidebar] ⚡ isQueueActive changed:", isQueueActive);
  }, [isQueueActive]);
  useEffect(() => {
    console.log("[IncremNotesSidebar] ⚡ remType changed:", remType);
  }, [remType]);
  useEffect(() => {
    console.log("[IncremNotesSidebar] ⚡ hostDocId changed:", hostDocId);
  }, [hostDocId]);

  // --- Empty state: no document being reviewed ---
  if (!hasActiveDocument) {
    return (
      <div style={emptyStateStyle}>
        <span style={{ fontSize: '24px' }}>📝</span>
        <span>No document being reviewed.<br />Click 📝 while reviewing a PDF/HTML to open its notes here.</span>
      </div>
    );
  }

  // --- Highlight: loading discovery ---
  if (isHighlightType && loading) {
    return (
      <div style={emptyStateStyle}>
        <span style={{ fontSize: '24px' }}>🔍</span>
        <span>Discovering related documents…</span>
      </div>
    );
  }

  // --- Highlight: no IncRems found for this document ---
  if (isHighlightType && !loading && discoveredRems.length === 0) {
    return (
      <div style={emptyStateStyle}>
        <span style={{ fontSize: '24px' }}>📄</span>
        <span>No Incremental Rems found for this document's source.<br />Create one to see its notes here.</span>
      </div>
    );
  }

  // --- Highlight: multiple IncRems, show selector ---
  if (isHighlightType && !selectedRemId && discoveredRems.length > 1) {
    return (
      <div style={{ padding: '16px', height: '100%', overflow: 'auto' }}>
        <div style={{
          fontSize: '13px',
          fontWeight: 600,
          color: 'var(--rn-clr-content-primary)',
          marginBottom: '4px',
        }}>
          📝 Document Notes
        </div>
        <div style={{
          fontSize: '11px',
          color: 'var(--rn-clr-content-tertiary)',
          marginBottom: '12px',
        }}>
          This highlight belongs to a document with multiple Incremental Rems. Select which one to view:
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {discoveredRems.map((rem) => (
            <button
              key={rem.remId}
              onClick={() => handleSelect(rem.remId)}
              style={selectorButtonStyle}
              onMouseOver={(e) => {
                e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-modifier-hover)';
                e.currentTarget.style.borderColor = 'var(--rn-clr-blue, #3b82f6)';
              }}
              onMouseOut={(e) => {
                e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-secondary)';
                e.currentTarget.style.borderColor = 'var(--rn-clr-border-primary)';
              }}
            >
              <span style={{ fontSize: '12px' }}>📖</span>
              <span style={{
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {rem.name || 'Untitled'}
              </span>
              <span style={{ fontSize: '10px', color: 'var(--rn-clr-content-tertiary)' }}>→</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // --- Show DocumentViewer ---
  if (!viewerRemId) {
    return (
      <div style={emptyStateStyle}>
        <span style={{ fontSize: '24px' }}>📝</span>
        <span>No document being reviewed.<br />Click 📝 while reviewing a PDF/HTML to open its notes here.</span>
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      {/* Back button when a highlight selector chose a specific IncRem */}
      {isHighlightType && discoveredRems.length > 1 && selectedRemId && (
        <div style={{
          padding: '6px 12px',
          borderBottom: '1px solid var(--rn-clr-border-primary)',
          backgroundColor: 'var(--rn-clr-background-secondary)',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          flexShrink: 0,
        }}>
          <button
            onClick={handleBack}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: '12px',
              color: 'var(--rn-clr-blue, #3b82f6)',
              padding: '2px 4px',
              borderRadius: '4px',
              fontWeight: 500,
            }}
            onMouseOver={(e) => e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-modifier-hover)'}
            onMouseOut={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
          >
            ← Switch
          </button>
          <span style={{
            fontSize: '11px',
            color: 'var(--rn-clr-content-tertiary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
          }}>
            {discoveredRems.find(r => r.remId === selectedRemId)?.name || ''}
          </span>
        </div>
      )}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <DocumentViewer
          key={viewerRemId}
          documentId={viewerRemId as RemId}
          width="100%"
          height="100%"
        />
      </div>
    </div>
  );
}

// --- Shared Styles ---
const emptyStateStyle: React.CSSProperties = {
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
};

const selectorButtonStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '8px 10px',
  borderRadius: '6px',
  border: '1px solid var(--rn-clr-border-primary)',
  backgroundColor: 'var(--rn-clr-background-secondary)',
  color: 'var(--rn-clr-content-primary)',
  cursor: 'pointer',
  fontSize: '12px',
  textAlign: 'left',
  transition: 'all 0.15s ease',
  fontWeight: 500,
  width: '100%',
};

renderWidget(IncremNotesSidebar);
