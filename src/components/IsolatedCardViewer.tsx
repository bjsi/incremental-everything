import React, { useState, useEffect, useCallback } from 'react';
import { PluginRem, RNPlugin, RemId, ReactRNPlugin } from '@remnote/plugin-sdk';
import { safeRemTextToString } from '../lib/pdfUtils';
import { initIncrementalRem } from '../lib/incremental_rem';
import { removeIncrementalRemCache } from '../lib/incremental_rem/cache';
import { powerupCode } from '../lib/consts';

interface IsolatedCardViewerProps {
  rem: PluginRem;
  plugin: RNPlugin;
  sourceDocumentName?: string;
  sourceDocumentId?: RemId;
  onViewInContext?: () => void;
}

interface AncestorBreadcrumb {
  text: string;
  id: RemId;
}

// Content can be either text or an image
interface RemContent {
  type: 'text' | 'image';
  value: string; // text content or image URL
}

export function IsolatedCardViewer({
  rem,
  plugin,
  sourceDocumentName,
  sourceDocumentId,
  onViewInContext
}: IsolatedCardViewerProps) {
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [ancestors, setAncestors] = useState<AncestorBreadcrumb[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [content, setContent] = useState<RemContent>({ type: 'text', value: '' });
  const [isCreatingRem, setIsCreatingRem] = useState(false);

  // Dark mode detection
  useEffect(() => {
    const checkDarkMode = () => {
      const htmlHasDark = document.documentElement.classList.contains('dark');
      const bodyHasDark = document.body?.classList.contains('dark');

      let parentHasDark = false;
      try {
        if (window.parent && window.parent !== window) {
          parentHasDark = window.parent.document.documentElement.classList.contains('dark');
        }
      } catch (e) {}

      const backgroundColor = window.getComputedStyle(document.body).backgroundColor;
      let isDarkByColor = false;

      if (backgroundColor && backgroundColor.startsWith('rgb')) {
        const matches = backgroundColor.match(/\d+/g);
        if (matches && matches.length >= 3) {
          const [r, g, b] = matches.map(Number);
          isDarkByColor = (r + g + b) / 3 < 128;
        }
      }

      setIsDarkMode(Boolean(htmlHasDark || bodyHasDark || parentHasDark || isDarkByColor));
    };

    checkDarkMode();
    const interval = setInterval(checkDarkMode, 2000);
    return () => clearInterval(interval);
  }, []);

  // Load ancestors for breadcrumb
  useEffect(() => {
    const loadAncestors = async () => {
      setIsLoading(true);
      const ancestorList: AncestorBreadcrumb[] = [];
      let currentParent = rem.parent;
      let depth = 0;
      const maxDepth = 5;

      while (currentParent && depth < maxDepth) {
        try {
          const parentRem = await plugin.rem.findOne(currentParent);
          if (!parentRem || !parentRem.text) break;

          const parentText = await safeRemTextToString(plugin, parentRem.text);

          ancestorList.unshift({
            text: parentText.slice(0, 40) + (parentText.length > 40 ? '...' : ''),
            id: currentParent
          });

          currentParent = parentRem.parent;
          depth++;
        } catch (error) {
          break;
        }
      }

      setAncestors(ancestorList);
      setIsLoading(false);
    };

    loadAncestors();
  }, [rem._id, plugin]);

  // Load rem content (text or image)
  useEffect(() => {
    const loadRemContent = async () => {
      if (!rem.text || !Array.isArray(rem.text)) {
        setContent({ type: 'text', value: '' });
        return;
      }

      // Check if the content contains an image (PDF area highlight)
      let imageItem: any = null;
      for (const item of rem.text) {
        if (item && typeof item === 'object' && item.i === 'i') {
          imageItem = item;
          break;
        }
      }

      if (imageItem?.url) {
        // For %LOCAL_FILE% URLs, resolve the actual S3 URL
        // Call safeRemTextToString with only the image item to avoid concatenation issues
        const resolvedUrl = await safeRemTextToString(plugin, [imageItem]);
        if (resolvedUrl.startsWith('http')) {
          setContent({ type: 'image', value: resolvedUrl });
          return;
        }
      }

      // Fallback: Get the text representation
      const text = await safeRemTextToString(plugin, rem.text);
      setContent({ type: 'text', value: text });
    };
    loadRemContent();
  }, [rem._id, rem.text, plugin]);

  const handleAncestorClick = useCallback(async (ancestorId: RemId) => {
    const ancestorRem = await plugin.rem.findOne(ancestorId);
    if (ancestorRem) {
      await plugin.window.openRem(ancestorRem);
    }
  }, [plugin]);

  const handleCreateRem = useCallback(async () => {
    if (isCreatingRem) return;

    setIsCreatingRem(true);
    try {
      // Create a new rem with the content of the extract
      const newRem = await plugin.rem.createRem();
      if (newRem) {
        // Build content with original extract content plus a pin reference to the source
        // Using rem reference format with pin: true to show as icon
        const sourceLink = {
          i: 'q' as const,
          _id: rem._id,
          pin: true
        };
        const originalContent = rem.text || [];
        const contentWithReference = [
          ...originalContent,
          ' ',
          sourceLink
        ];
        await newRem.setText(contentWithReference);

        // Set the new rem as a child of the source document (PDF) if available,
        // otherwise as a child of the extract itself
        const parentId = sourceDocumentId || rem._id;
        await newRem.setParent(parentId);

        // Remove incremental status from the original extract
        await removeIncrementalRemCache(plugin, rem._id);
        await rem.removePowerup(powerupCode);

        // Open the new rem for editing
        await plugin.window.openRem(newRem);
      }
    } catch (error) {
      console.error('Error creating rem:', error);
    } finally {
      setIsCreatingRem(false);
    }
  }, [plugin, rem._id, rem.text, sourceDocumentId, isCreatingRem]);

  const handleCreateIncrementalRem = useCallback(async () => {
    if (isCreatingRem) return;

    setIsCreatingRem(true);
    try {
      // Create a new rem with the content of the extract
      const newRem = await plugin.rem.createRem();
      if (newRem) {
        // Build content with original extract content plus a pin reference to the source
        const sourceLink = {
          i: 'q' as const,
          _id: rem._id,
          pin: true
        };
        const originalContent = rem.text || [];
        const contentWithReference = [
          ...originalContent,
          ' ',
          sourceLink
        ];
        await newRem.setText(contentWithReference);

        // Set the new rem as a child of the source document (PDF) if available
        const parentId = sourceDocumentId || rem._id;
        await newRem.setParent(parentId);

        // Make the new rem incremental BEFORE removing from original
        await initIncrementalRem(plugin as ReactRNPlugin, newRem);

        // Remove incremental status from the original extract
        await removeIncrementalRemCache(plugin, rem._id);
        await rem.removePowerup(powerupCode);

        // Open the new rem for editing
        await plugin.window.openRem(newRem);
      }
    } catch (error) {
      console.error('Error creating incremental rem:', error);
    } finally {
      setIsCreatingRem(false);
    }
  }, [plugin, rem._id, rem.text, sourceDocumentId, isCreatingRem]);

  // Use CSS variables with fallbacks for isolated context
  const cssVar = (varName: string, fallbackLight: string, fallbackDark: string) => {
    return `var(${varName}, ${isDarkMode ? fallbackDark : fallbackLight})`;
  };

  // Styles using RemNote CSS variables
  const containerStyle: React.CSSProperties = {
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px',
    backgroundColor: cssVar('--rn-clr-background-primary', '#f8fafc', '#0f172a'),
    overflow: 'hidden',
  };

  const cardStyle: React.CSSProperties = {
    maxWidth: '800px',
    width: '100%',
    backgroundColor: cssVar('--rn-clr-background-secondary', '#ffffff', '#1e293b'),
    borderRadius: '12px',
    border: `1px solid ${cssVar('--rn-clr-border-primary', '#e2e8f0', '#334155')}`,
    boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    maxHeight: '80vh',
  };

  const headerStyle: React.CSSProperties = {
    padding: '12px 16px',
    borderBottom: `1px solid ${cssVar('--rn-clr-border-primary', '#e2e8f0', '#334155')}`,
    backgroundColor: cssVar('--rn-clr-background-secondary', '#f8fafc', '#1e293b'),
  };

  const breadcrumbStyle: React.CSSProperties = {
    fontSize: '11px',
    color: cssVar('--rn-clr-content-tertiary', '#64748b', '#94a3b8'),
    marginBottom: sourceDocumentName ? '6px' : '0',
  };

  const sourceStyle: React.CSSProperties = {
    fontSize: '11px',
    color: cssVar('--rn-clr-content-tertiary', '#94a3b8', '#64748b'),
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  };

  const contentStyle: React.CSSProperties = {
    padding: '24px 16px',
    flex: 1,
    overflow: 'auto',
    minHeight: 0,
    backgroundColor: cssVar('--rn-clr-background-primary', '#ffffff', '#0f172a'),
  };

  const remViewerContainerStyle: React.CSSProperties = {
    fontSize: '16px',
    lineHeight: '1.7',
    color: cssVar('--rn-clr-content-primary', '#1e293b', '#e2e8f0'),
  };

  const footerStyle: React.CSSProperties = {
    padding: '12px 16px',
    borderTop: `1px solid ${cssVar('--rn-clr-border-primary', '#e2e8f0', '#334155')}`,
    backgroundColor: cssVar('--rn-clr-background-secondary', '#f8fafc', '#1e293b'),
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '8px',
  };

  const buttonStyle: React.CSSProperties = {
    padding: '8px 14px',
    fontSize: '12px',
    fontWeight: 500,
    borderRadius: '6px',
    border: `1px solid ${cssVar('--rn-clr-border-primary', '#e2e8f0', '#334155')}`,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    transition: 'all 0.15s ease',
    backgroundColor: cssVar('--rn-clr-background-primary', '#ffffff', '#1e293b'),
    color: cssVar('--rn-clr-content-secondary', '#475569', '#94a3b8'),
  };

  const primaryButtonStyle: React.CSSProperties = {
    ...buttonStyle,
    backgroundColor: '#3b82f6',
    border: 'none',
    color: '#ffffff',
  };

  return (
    <div style={containerStyle}>
      <div style={cardStyle}>
        {/* Header with breadcrumbs */}
        <div style={headerStyle}>
          {!isLoading && ancestors.length > 0 && (
            <div style={breadcrumbStyle}>
              {ancestors.map((ancestor, index) => (
                <span
                  key={ancestor.id}
                  onClick={() => handleAncestorClick(ancestor.id)}
                  style={{ cursor: 'pointer' }}
                >
                  {ancestor.text}
                  {index < ancestors.length - 1 && ' › '}
                </span>
              ))}
            </div>
          )}
          {sourceDocumentName && (
            <div style={sourceStyle}>
              <span>📄</span>
              <span>From: {sourceDocumentName}</span>
            </div>
          )}
        </div>

        {/* Main content */}
        <div style={contentStyle}>
          {content.type === 'image' ? (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', width: '100%' }}>
              <img
                src={content.value}
                alt="PDF area highlight"
                style={{
                  maxWidth: '100%',
                  maxHeight: '100%',
                  objectFit: 'contain',
                  borderRadius: '8px',
                }}
              />
            </div>
          ) : (
            <div style={remViewerContainerStyle}>
              {content.value || 'Loading...'}
            </div>
          )}
        </div>

        {/* Footer with actions */}
        <div style={footerStyle}>
          {onViewInContext && (
            <>
              <button
                style={buttonStyle}
                onClick={handleCreateRem}
                disabled={isCreatingRem}
              >
                <span>✏️</span>
                <span>{isCreatingRem ? 'Creating...' : 'Create Rem'}</span>
              </button>
              <button
                style={buttonStyle}
                onClick={handleCreateIncrementalRem}
                disabled={isCreatingRem}
              >
                <span>🔄</span>
                <span>{isCreatingRem ? 'Creating...' : 'Create Inc Rem'}</span>
              </button>
              <button
                style={primaryButtonStyle}
                onClick={onViewInContext}
              >
                <span>📖</span>
                <span>View in Context</span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
