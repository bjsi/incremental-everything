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
 * The bar with Done belongs to this frame; the page is drawn by the host. Done, or Esc
 * once the editor has let go of it, closes the panel. Drag the bar to move it. The
 * index closes it too, when the queue leaves the card (lib/extract_editor.ts).
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
  const BAR = compact ? 44 : 34;

  // The bar with Done, which is also the drag handle. On a computer it is the header.
  // On a phone it is at the BOTTOM: RemNote's mobile document page draws its own top
  // bar (back arrow and title) over the first 40 px of the panel, and a header there
  // is covered, Done included.
  const bar = (
    <div
      onPointerDown={startDrag}
      style={{
        flex: 'none',
        height: BAR,
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: compact ? '0 6px 0 10px' : '0 6px 0 12px',
        background: 'var(--rn-clr-background-secondary)',
        [compact ? 'borderTop' : 'borderBottom']: '1px solid var(--rn-clr-border-primary)',
        cursor: 'move',
        touchAction: 'none',
        userSelect: 'none',
        fontSize: 12,
      }}
    >
      <span style={{ fontWeight: 600, color: 'var(--rn-clr-content-accent, #3b82f6)', flex: 'none' }}>
        {compact ? '⠿ ✎ Editing' : '✎ Editing'}
      </span>
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
          height: compact ? 34 : 24,
          padding: compact ? '0 18px' : '0 12px',
          borderRadius: 6,
          border: 'none',
          background: 'var(--rn-clr-content-accent, #3b82f6)',
          color: 'white',
          fontSize: compact ? 14 : 12,
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        Done
      </button>
    </div>
  );

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
      {!compact && bar}
      {/* The host draws the page over this box, at this size. */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <DocumentViewer
          key={target.remId}
          documentId={target.remId as RemId}
          width="100%"
          height={height - BAR - 2}
        />
      </div>
      {compact && bar}
    </div>
  );
}

renderWidget(ExtractEditorFloat);
