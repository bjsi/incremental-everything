import { DocumentViewer, RemId, renderWidget, usePlugin, useTrackerPlugin, WidgetLocation } from '@remnote/plugin-sdk';
import React, { useEffect, useRef, useState } from 'react';
import '../style.css';
import '../App.css';
import '../rn_theme_vars.css';
import { extractEditorTargetKey } from '../lib/consts';
import { closeExtractEditor, ExtractEditorTarget } from '../lib/extract_editor';
import { FloatingPosition, useFloatingWidgetDrag } from '../lib/floating_widget_drag';

/**
 * The Extract Editor (lib/extract_editor.ts has the why): RemNote's own document page
 * for the Incremental Rem under review, in a floating panel laid over the queue's
 * read-only Extract Viewer. Everything below the header is a DocumentViewer embed, so
 * it is a normal RemNote editor: formatting, clozes, `/`, references, and the plugin's
 * own commands on the focused Rem (Create Cloze Deletion, Extract, priorities).
 *
 * The header belongs to this frame; the page under it is drawn by the host. Done, or
 * Esc once the editor has let go of it, closes the panel. Drag the header to move it.
 */
function ExtractEditorFloat() {
  const plugin = usePlugin();
  const target = useTrackerPlugin(
    (rp) => rp.storage.getSession<ExtractEditorTarget>(extractEditorTargetKey),
    []
  );

  const [floatingWidgetId, setFloatingWidgetId] = useState<string | null>(null);
  const positionRef = useRef<FloatingPosition | null>(null);
  useEffect(() => {
    plugin.widget
      .getWidgetContext<WidgetLocation.FloatingWidget>()
      .then((ctx) => setFloatingWidgetId(ctx?.floatingWidgetId ?? null))
      .catch(() => {});
  }, [plugin]);
  // The opener placed the panel; the drag starts from there.
  useEffect(() => {
    if (target?.position) positionRef.current = { ...target.position };
  }, [target?.at]);
  const startDrag = useFloatingWidgetDrag(plugin, floatingWidgetId, positionRef);

  if (!target) return null;
  const { width, height, compact } = target;
  const HEADER = compact ? 38 : 34;

  return (
    <div
      style={{
        width,
        height,
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--rn-clr-background-primary)',
        color: 'var(--rn-clr-content-primary)',
        border: '1px solid var(--rn-clr-content-accent, #3b82f6)',
        borderRadius: 12,
        boxShadow: '0 8px 28px rgba(0,0,0,0.22)',
        overflow: 'hidden',
      }}
    >
      <div
        onPointerDown={startDrag}
        style={{
          flex: 'none',
          height: HEADER,
          boxSizing: 'border-box',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 6px 0 12px',
          background: 'var(--rn-clr-background-secondary)',
          borderBottom: '1px solid var(--rn-clr-border-primary)',
          cursor: 'move',
          touchAction: 'none',
          userSelect: 'none',
          fontSize: 12,
        }}
      >
        <span style={{ fontWeight: 600, color: 'var(--rn-clr-content-accent, #3b82f6)', flex: 'none' }}>✎ Editing</span>
        <span
          title={target.title}
          style={{ flex: 1, minWidth: 0, color: 'var(--rn-clr-content-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {target.title}
        </span>
        {!compact && (
          <span style={{ flex: 'none', color: 'var(--rn-clr-content-tertiary)', fontSize: 11 }}>
            click the text to type · the queue's keys are off while you edit
          </span>
        )}
        <button
          onClick={() => void closeExtractEditor(plugin)}
          title="Close the editor and go back to the queue"
          style={{
            flex: 'none',
            height: compact ? 30 : 24,
            padding: '0 12px',
            borderRadius: 6,
            border: 'none',
            background: 'var(--rn-clr-content-accent, #3b82f6)',
            color: 'white',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Done
        </button>
      </div>
      {/* The host draws the page over this box, at this size. */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <DocumentViewer
          key={target.remId}
          documentId={target.remId as RemId}
          width="100%"
          height={height - HEADER - 2}
        />
      </div>
    </div>
  );
}

renderWidget(ExtractEditorFloat);
