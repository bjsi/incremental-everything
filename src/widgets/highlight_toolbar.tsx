import { renderWidget, usePlugin, WidgetLocation } from '@remnote/plugin-sdk';
import React, { useState, useEffect } from 'react';
import { powerupCode } from '../lib/consts';
import {
  handleCreateExtract,
  handleToggleIncremental,
  handleOpenBookmarkPopup,
} from '../lib/highlightToolbarActions';

export function HighlightToolbar() {
  const plugin = usePlugin();
  const [remId, setRemId] = useState<string | null>(null);
  const [isIncremental, setIsIncremental] = useState<boolean | null>(null);

  useEffect(() => {
    const init = async () => {
      const ctx = await plugin.widget.getWidgetContext<WidgetLocation.PDFHighlightToolbarLocation>();
      if (!ctx?.remId) return;
      setRemId(ctx.remId);
      const rem = await plugin.rem.findOne(ctx.remId);
      if (rem) {
        setIsIncremental(await rem.hasPowerup(powerupCode));
      }
    };
    init();
  }, [plugin]);

  if (!remId) return null;

  // Always re-read context at click time so a reused (not-remounted) widget
  // never operates on a stale remId from a previous highlight selection.
  const getFreshRemId = async () => {
    const ctx = await plugin.widget.getWidgetContext<WidgetLocation.PDFHighlightToolbarLocation>();
    return ctx?.remId ?? remId;
  };

  const onCreateExtract = async () => {
    const id = await getFreshRemId();
    if (id) await handleCreateExtract(plugin as any, id);
  };

  const onToggleIncremental = async () => {
    const id = await getFreshRemId();
    if (!id) return;
    const nowIncremental = await handleToggleIncremental(plugin as any, id);
    setIsIncremental(nowIncremental);
  };

  const onOpenBookmark = async () => {
    const id = await getFreshRemId();
    if (id) await handleOpenBookmarkPopup(plugin as any, id);
  };

  const toggleTooltip = isIncremental
    ? 'Remove Incremental tag from this highlight'
    : 'Tag this highlight as an Incremental Rem (auto-bookmarks position)';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
      <BookmarkButton onClick={onOpenBookmark} />
      <ExtractButton onClick={onCreateExtract} />
      <ToggleButton
        onClick={onToggleIncremental}
        isIncremental={isIncremental}
        title={toggleTooltip}
      />
    </div>
  );
}

function BookmarkButton({ onClick }: { onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      style={{
        padding: '2px 6px',
        cursor: 'pointer',
        fontSize: '15px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '4px',
        color: 'var(--rn-clr-content-primary)',
        transition: 'box-shadow 0.15s ease, background-color 0.15s ease, transform 0.1s ease',
        boxShadow: hovered ? '0 2px 8px rgba(0,0,0,0.18)' : 'none',
        backgroundColor: hovered
          ? 'var(--rn-clr-background-secondary, rgba(0,0,0,0.06))'
          : 'transparent',
        transform: hovered ? 'translateY(-1px)' : 'none',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
      title="Bookmark Position — save & jump to your reading position"
    >
      🔖
    </div>
  );
}

function ExtractButton({ onClick }: { onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      style={{
        padding: '2px 6px',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '4px',
        color: 'var(--rn-clr-content-primary)',
        transition: 'box-shadow 0.15s ease, background-color 0.15s ease, transform 0.1s ease',
        boxShadow: hovered ? '0 2px 8px rgba(0,0,0,0.18)' : 'none',
        backgroundColor: hovered
          ? 'var(--rn-clr-background-secondary, rgba(0,0,0,0.06))'
          : 'transparent',
        transform: hovered ? 'translateY(-1px)' : 'none',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
      title="Create a standalone Incremental Rem from this highlight"
    >
      <img
        src="icon-extract.png"
        alt="Create Incremental Rem"
        style={{
          width: '16px',
          height: '16px',
          opacity: hovered ? 1 : 0.85,
          transition: 'opacity 0.15s ease',
        }}
      />
    </div>
  );
}

function ToggleButton({
  onClick,
  isIncremental,
  title,
}: {
  onClick: () => void;
  isIncremental: boolean | null;
  title: string;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      style={{
        padding: '2px 6px',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '4px',
        color: 'var(--rn-clr-content-primary)',
        transition: 'box-shadow 0.15s ease, background-color 0.15s ease, transform 0.1s ease',
        boxShadow: hovered ? '0 2px 8px rgba(0,0,0,0.22)' : '0 1px 3px rgba(0,0,0,0.10)',
        backgroundColor: isIncremental
          ? hovered ? 'rgba(59, 130, 246, 0.28)' : 'rgba(59, 130, 246, 0.15)'
          : hovered ? 'rgba(239, 68, 68, 0.28)' : 'rgba(239, 68, 68, 0.15)',
        transform: hovered ? 'translateY(-1px)' : 'none',
        border: isIncremental
          ? '1px solid rgba(59, 130, 246, 0.35)'
          : '1px solid rgba(239, 68, 68, 0.35)',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
      title={title}
    >
      <img
        src="icon-toggle-inc.png"
        alt="Toggle Incremental Rem"
        style={{
          width: '16px',
          height: '16px',
          opacity: hovered ? 1 : isIncremental === true ? 1 : 0.7,
          transition: 'opacity 0.15s ease',
          filter: isIncremental === true ? 'none' : 'grayscale(30%)',
        }}
      />
    </div>
  );
}

renderWidget(HighlightToolbar);
