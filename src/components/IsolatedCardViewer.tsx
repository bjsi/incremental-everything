import React, { useState, useEffect, useCallback } from 'react';
import { PluginRem, RNPlugin, RemId } from '@remnote/plugin-sdk';
import { safeRemTextToString } from '../lib/pdfUtils';

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
      let hasImage = false;
      for (const item of rem.text) {
        if (item && typeof item === 'object' && item.i === 'i') {
          hasImage = true;
          break;
        }
      }

      // Get the text representation (which contains the real URL for images)
      const text = await safeRemTextToString(plugin, rem.text);

      if (hasImage && text.startsWith('http')) {
        // It's an image - the text is the actual URL
        setContent({ type: 'image', value: text });
      } else {
        setContent({ type: 'text', value: text });
      }
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
        // Open the new rem for editing
        await plugin.window.openRem(newRem);
      }
    } catch (error) {
      console.error('Error creating rem:', error);
    } finally {
      setIsCreatingRem(false);
    }
  }, [plugin, rem._id, rem.text, sourceDocumentId, isCreatingRem]);

  // Styles
  const containerStyle: React.CSSProperties = {
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px',
    backgroundColor: isDarkMode ? '#0f172a' : '#f8fafc',
    overflow: 'hidden',
  };

  const cardStyle: React.CSSProperties = {
    maxWidth: '800px',
    width: '100%',
    backgroundColor: isDarkMode ? '#1e293b' : '#ffffff',
    borderRadius: '16px',
    boxShadow: isDarkMode
      ? '0 25px 50px -12px rgba(0, 0, 0, 0.5)'
      : '0 25px 50px -12px rgba(0, 0, 0, 0.15)',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    maxHeight: '80vh',
  };

  const headerStyle: React.CSSProperties = {
    padding: '16px 24px',
    borderBottom: isDarkMode ? '1px solid #334155' : '1px solid #e2e8f0',
    backgroundColor: isDarkMode ? '#1e293b' : '#f8fafc',
  };

  const breadcrumbStyle: React.CSSProperties = {
    fontSize: '12px',
    color: isDarkMode ? '#94a3b8' : '#64748b',
    marginBottom: sourceDocumentName ? '8px' : '0',
  };

  const sourceStyle: React.CSSProperties = {
    fontSize: '11px',
    color: isDarkMode ? '#64748b' : '#94a3b8',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  };

  const contentStyle: React.CSSProperties = {
    padding: '32px 24px',
    flex: 1,
    overflow: 'auto',
    minHeight: 0,
  };

  const remViewerContainerStyle: React.CSSProperties = {
    fontSize: '18px',
    lineHeight: '1.7',
    color: isDarkMode ? '#e2e8f0' : '#1e293b',
  };

  const footerStyle: React.CSSProperties = {
    padding: '12px 24px',
    borderTop: isDarkMode ? '1px solid #334155' : '1px solid #e2e8f0',
    backgroundColor: isDarkMode ? '#1e293b' : '#f8fafc',
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '8px',
  };

  const buttonStyle: React.CSSProperties = {
    padding: '8px 16px',
    fontSize: '13px',
    borderRadius: '8px',
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    transition: 'all 0.15s ease',
    backgroundColor: isDarkMode ? '#334155' : '#e2e8f0',
    color: isDarkMode ? '#e2e8f0' : '#475569',
  };

  const primaryButtonStyle: React.CSSProperties = {
    ...buttonStyle,
    backgroundColor: isDarkMode ? '#3b82f6' : '#2563eb',
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
          <button
            style={buttonStyle}
            onClick={handleCreateRem}
            disabled={isCreatingRem}
          >
            <span>✏️</span>
            <span>{isCreatingRem ? 'Creating...' : 'Create Rem'}</span>
          </button>
          {onViewInContext && (
            <button
              style={primaryButtonStyle}
              onClick={onViewInContext}
            >
              <span>📖</span>
              <span>View in Context</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
