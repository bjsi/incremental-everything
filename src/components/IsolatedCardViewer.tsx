import React, { useState, useEffect, useCallback } from 'react';
import { PluginRem, RNPlugin, RemId, ReactRNPlugin, BuiltInPowerupCodes } from '@remnote/plugin-sdk';
import { safeRemTextToString, findIncrementalRemForPDF, findAllRemsForPDF } from '../lib/pdfUtils';
import { initIncrementalRem } from '../lib/incremental_rem';
import { removeIncrementalRemCache } from '../lib/incremental_rem/cache';
import { powerupCode, parentSelectorWidgetId } from '../lib/consts';
import { ActionItemType } from '../lib/incremental_rem/types';
import { TypeBadge } from './TypeBadge';
import { ParentSelectorContext } from '../widgets/parent_selector';

interface IsolatedCardViewerProps {
  rem: PluginRem;
  plugin: RNPlugin;
  sourceDocumentName?: string;
  sourceDocumentId?: RemId;
  sourceType?: ActionItemType;
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
  sourceType,
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
            text: parentText,
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

  // Helper to find all rems (including non-incremental) that have the PDF as a source
  // Uses findAllRemsForPDF which doesn't depend on pageRangeContext
  const findRemsForPDF = useCallback(async (pdfRemId: RemId): Promise<Array<{remId: RemId; name: string; isIncremental: boolean}>> => {
    try {
      return await findAllRemsForPDF(plugin, pdfRemId);
    } catch (error) {
      console.error('Error finding rems for PDF:', error);
      return [];
    }
  }, [plugin]);

  // Core function to create rem with parent selection logic
  const createRemWithParentSelection = useCallback(async (makeIncremental: boolean) => {
    if (isCreatingRem || !sourceDocumentId) return;

    setIsCreatingRem(true);
    try {
      // Find all rems that have this PDF as a source (including Done/untagged ones)
      const candidates = await findRemsForPDF(sourceDocumentId);

      if (candidates.length === 0) {
        // No incremental rems found - fall back to original behavior (parent to PDF)
        const newRem = await plugin.rem.createRem();
        if (newRem) {
          const sourceLink = {
            i: 'q' as const,
            _id: rem._id,
            pin: true
          };
          const originalContent = rem.text || [];
          const contentWithReference = [...originalContent, ' ', sourceLink];
          await newRem.setText(contentWithReference);
          await newRem.setParent(sourceDocumentId);

          if (makeIncremental) {
            await initIncrementalRem(plugin as ReactRNPlugin, newRem);
          }

          await removeIncrementalRemCache(plugin, rem._id);
          await rem.removePowerup(powerupCode);
          await rem.setHighlightColor('Yellow');

          const actionText = makeIncremental ? 'incremental rem' : 'rem';
          await plugin.app.toast(`Created ${actionText} under PDF`);
        }
      } else if (candidates.length === 1) {
        // Single incremental rem found - use it directly
        const parentRem = candidates[0];
        const newRem = await plugin.rem.createRem();
        if (newRem) {
          const sourceLink = {
            i: 'q' as const,
            _id: rem._id,
            pin: true
          };
          const originalContent = rem.text || [];
          const contentWithReference = [...originalContent, ' ', sourceLink];
          await newRem.setText(contentWithReference);
          await newRem.setParent(parentRem.remId);

          if (makeIncremental) {
            await initIncrementalRem(plugin as ReactRNPlugin, newRem);
          }

          await removeIncrementalRemCache(plugin, rem._id);
          await rem.removePowerup(powerupCode);
          await rem.setHighlightColor('Yellow');

          const actionText = makeIncremental ? 'incremental rem' : 'rem';
          await plugin.app.toast(`Created ${actionText} under "${parentRem.name.slice(0, 30)}..."`);
        }
      } else {
        // Multiple incremental rems found - open selector popup
        const context: ParentSelectorContext = {
          pdfRemId: sourceDocumentId,
          extractRemId: rem._id,
          extractContent: rem.text || [],
          candidates,
          makeIncremental
        };
        await plugin.storage.setSession('parentSelectorContext', context);
        await plugin.widget.openPopup(parentSelectorWidgetId);
      }
    } catch (error) {
      console.error('Error creating rem:', error);
    } finally {
      setIsCreatingRem(false);
    }
  }, [plugin, rem._id, rem.text, sourceDocumentId, isCreatingRem, findRemsForPDF]);

  const handleCreateRem = useCallback(async () => {
    await createRemWithParentSelection(false);
  }, [createRemWithParentSelection]);

  const handleCreateIncrementalRem = useCallback(async () => {
    await createRemWithParentSelection(true);
  }, [createRemWithParentSelection]);

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
    wordBreak: 'break-word',
    lineHeight: '1.4',
  };

  const sourceStyle: React.CSSProperties = {
    fontSize: '11px',
    color: cssVar('--rn-clr-content-tertiary', '#94a3b8', '#64748b'),
    display: 'flex',
    alignItems: 'flex-start',
    gap: '6px',
    wordBreak: 'break-word',
    lineHeight: '1.4',
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
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '8px',
  };

  const buttonStyle: React.CSSProperties = {
    padding: '8px 12px',
    fontSize: '12px',
    fontWeight: 500,
    borderRadius: '6px',
    border: `1px solid ${cssVar('--rn-clr-border-primary', '#e2e8f0', '#334155')}`,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    transition: 'all 0.15s ease',
    backgroundColor: cssVar('--rn-clr-background-primary', '#ffffff', '#1e293b'),
    color: cssVar('--rn-clr-content-secondary', '#475569', '#94a3b8'),
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
              <span>{sourceDocumentName}</span>
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
          {/* Left side - Type badge */}
          <div>
            {sourceType && <TypeBadge type={sourceType} mini />}
          </div>

          {/* Right side - Action buttons */}
          {onViewInContext && (
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                style={buttonStyle}
                onClick={handleCreateRem}
                disabled={isCreatingRem}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = cssVar('--rn-clr-background-tertiary', '#f1f5f9', '#334155');
                  e.currentTarget.style.borderColor = cssVar('--rn-clr-border-secondary', '#cbd5e1', '#475569');
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = cssVar('--rn-clr-background-primary', '#ffffff', '#1e293b');
                  e.currentTarget.style.borderColor = cssVar('--rn-clr-border-primary', '#e2e8f0', '#334155');
                }}
              >
                <span>✏️</span>
                <span>{isCreatingRem ? 'Creating...' : 'Create Rem'}</span>
              </button>
              <button
                style={buttonStyle}
                onClick={handleCreateIncrementalRem}
                disabled={isCreatingRem}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = cssVar('--rn-clr-background-tertiary', '#f1f5f9', '#334155');
                  e.currentTarget.style.borderColor = cssVar('--rn-clr-border-secondary', '#cbd5e1', '#475569');
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = cssVar('--rn-clr-background-primary', '#ffffff', '#1e293b');
                  e.currentTarget.style.borderColor = cssVar('--rn-clr-border-primary', '#e2e8f0', '#334155');
                }}
              >
                <span>🔄</span>
                <span>{isCreatingRem ? 'Creating...' : 'Create Inc Rem'}</span>
              </button>
              <button
                style={buttonStyle}
                onClick={onViewInContext}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = cssVar('--rn-clr-background-tertiary', '#f1f5f9', '#334155');
                  e.currentTarget.style.borderColor = cssVar('--rn-clr-border-secondary', '#cbd5e1', '#475569');
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = cssVar('--rn-clr-background-primary', '#ffffff', '#1e293b');
                  e.currentTarget.style.borderColor = cssVar('--rn-clr-border-primary', '#e2e8f0', '#334155');
                }}
              >
                <span>📖</span>
                <span>View in Context</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
