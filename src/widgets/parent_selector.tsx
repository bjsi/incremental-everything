// widgets/parent_selector.tsx
import {
  renderWidget,
  usePlugin,
  useTrackerPlugin,
  RemId,
  ReactRNPlugin,
} from '@remnote/plugin-sdk';
import React, { useState, useEffect, useCallback } from 'react';
import { powerupCode, prioritySlotCode, allIncrementalRemKey } from '../lib/consts';
import { calculateRelativePercentile } from '../lib/utils';
import { IncrementalRem, initIncrementalRem } from '../lib/incremental_rem';
import { removeIncrementalRemCache } from '../lib/incremental_rem/cache';

interface ParentOption {
  remId: RemId;
  name: string;
  priority: number | null;
  percentile: number | null;
  isIncremental: boolean;
}

export interface ParentSelectorContext {
  pdfRemId: RemId;
  extractRemId: RemId;  // The highlight rem
  extractContent: any[];  // The richText content to copy
  candidates: Array<{remId: RemId; name: string; isIncremental: boolean}>;
  makeIncremental: boolean;  // Whether to make the new rem incremental
}

function ParentSelectorWidget() {
  const plugin = usePlugin();

  const contextData = useTrackerPlugin(
    async (rp) => rp.storage.getSession<ParentSelectorContext>('parentSelectorContext'),
    []
  );

  const allIncrementalRems = useTrackerPlugin(
    (rp) => rp.storage.getSession<IncrementalRem[]>(allIncrementalRemKey),
    []
  );

  const [options, setOptions] = useState<ParentOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Load and enrich options with priority data
  useEffect(() => {
    const loadOptions = async () => {
      if (!contextData?.candidates) {
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      const enrichedOptions: ParentOption[] = [];

      for (const candidate of contextData.candidates) {
        let priority: number | null = null;
        let percentile: number | null = null;

        if (candidate.isIncremental) {
          const rem = await plugin.rem.findOne(candidate.remId);
          if (rem) {
            const priorityProp = await rem.getPowerupProperty(powerupCode, prioritySlotCode);
            if (priorityProp && Array.isArray(priorityProp) && priorityProp.length > 0) {
              priority = parseInt(priorityProp[0] as string);
            }
            if (allIncrementalRems && allIncrementalRems.length > 0) {
              percentile = calculateRelativePercentile(allIncrementalRems, candidate.remId);
            }
          }
        }

        enrichedOptions.push({
          remId: candidate.remId,
          name: candidate.name,
          priority,
          percentile,
          isIncremental: candidate.isIncremental,
        });
      }

      // Sort: incremental first, then by priority (higher first), then alphabetically
      enrichedOptions.sort((a, b) => {
        if (a.isIncremental !== b.isIncremental) {
          return a.isIncremental ? -1 : 1;
        }
        if (a.priority !== null && b.priority !== null) {
          return b.priority - a.priority;
        }
        if (a.priority !== null) return -1;
        if (b.priority !== null) return 1;
        return a.name.localeCompare(b.name);
      });

      setOptions(enrichedOptions);
      setIsLoading(false);
    };

    loadOptions();
  }, [contextData?.candidates, plugin, allIncrementalRems]);

  const handleSelect = useCallback(async (option: ParentOption) => {
    if (!contextData || isCreating) return;

    setIsCreating(true);
    try {
      const { extractRemId, extractContent, makeIncremental } = contextData;

      // Create a new rem
      const newRem = await plugin.rem.createRem();
      if (!newRem) {
        await plugin.app.toast('Failed to create rem');
        return;
      }

      // Build content: original content + pin reference to the highlight
      const sourceLink = {
        i: 'q' as const,
        _id: extractRemId,
        pin: true
      };
      const contentWithReference = [
        ...extractContent,
        ' ',
        sourceLink
      ];
      await newRem.setText(contentWithReference);

      // Set parent to the selected incremental rem
      await newRem.setParent(option.remId);

      if (makeIncremental) {
        await initIncrementalRem(plugin as ReactRNPlugin, newRem);
      }

      // Remove incremental status from original extract
      const extractRem = await plugin.rem.findOne(extractRemId);
      if (extractRem) {
        await removeIncrementalRemCache(plugin, extractRemId);
        await extractRem.removePowerup(powerupCode);
      }

      // Close popup - queue will advance to next card automatically
      plugin.widget.closePopup();

      const actionText = makeIncremental ? 'incremental rem' : 'rem';
      await plugin.app.toast(`Created ${actionText} under "${option.name.slice(0, 30)}..."`);
    } catch (error) {
      console.error('Error creating rem:', error);
      await plugin.app.toast('Error creating rem');
    } finally {
      setIsCreating(false);
    }
  }, [contextData, isCreating, plugin]);

  const handleClose = () => plugin.widget.closePopup();

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isLoading || isCreating) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(prev => Math.min(prev + 1, options.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(prev => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (options[selectedIndex]) {
          handleSelect(options[selectedIndex]);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [options, selectedIndex, isLoading, isCreating, handleSelect]);

  if (isLoading) {
    return (
      <div className="p-4" style={{ backgroundColor: 'var(--rn-clr-background-primary)' }}>
        <div style={{ color: 'var(--rn-clr-content-secondary)' }}>Loading...</div>
      </div>
    );
  }

  if (!contextData || options.length === 0) {
    return (
      <div className="p-4" style={{ backgroundColor: 'var(--rn-clr-background-primary)' }}>
        <div style={{ color: 'var(--rn-clr-content-secondary)' }}>
          No incremental rems found for this PDF.
        </div>
        <button
          onClick={handleClose}
          className="mt-3 px-3 py-1.5 text-xs rounded"
          style={{
            backgroundColor: 'var(--rn-clr-background-secondary)',
            border: '1px solid var(--rn-clr-border-primary)',
            color: 'var(--rn-clr-content-primary)',
          }}
        >
          Close
        </button>
      </div>
    );
  }

  const actionText = contextData.makeIncremental ? 'Create Incremental Rem' : 'Create Rem';

  return (
    <div
      className="flex flex-col"
      style={{
        backgroundColor: 'var(--rn-clr-background-primary)',
        minWidth: '350px',
        maxWidth: '450px',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3"
        style={{
          borderBottom: '1px solid var(--rn-clr-border-primary)',
          backgroundColor: 'var(--rn-clr-background-secondary)',
        }}
      >
        <div className="flex items-center gap-2">
          <span className="text-base">📁</span>
          <span className="font-semibold text-sm" style={{ color: 'var(--rn-clr-content-primary)' }}>
            Select Parent Rem
          </span>
        </div>
        <button
          onClick={handleClose}
          className="p-1 rounded transition-colors text-xs"
          style={{ color: 'var(--rn-clr-content-tertiary)' }}
          onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
          title="Close (Esc)"
        >
          ✕
        </button>
      </div>

      {/* Description */}
      <div className="px-4 py-2" style={{ borderBottom: '1px solid var(--rn-clr-border-primary)' }}>
        <p className="text-xs" style={{ color: 'var(--rn-clr-content-secondary)' }}>
          Choose where to create the new {contextData.makeIncremental ? 'incremental ' : ''}rem.
          The highlight content will be copied with a pin back to the source.
        </p>
      </div>

      {/* Options List */}
      <div className="flex-1 overflow-y-auto py-2" style={{ maxHeight: '300px' }}>
        {options.map((option, index) => (
          <div
            key={option.remId}
            onClick={() => handleSelect(option)}
            className="px-4 py-2 cursor-pointer transition-colors"
            style={{
              backgroundColor: index === selectedIndex
                ? 'var(--rn-clr-background-tertiary)'
                : 'transparent',
              borderLeft: index === selectedIndex
                ? '3px solid #3b82f6'
                : '3px solid transparent',
            }}
            onMouseEnter={() => setSelectedIndex(index)}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                {option.isIncremental && (
                  <span className="text-xs" title="Incremental Rem">⚡</span>
                )}
                <span
                  className="text-sm truncate"
                  style={{ color: 'var(--rn-clr-content-primary)' }}
                  title={option.name}
                >
                  {option.name.length > 40 ? option.name.slice(0, 40) + '...' : option.name}
                </span>
              </div>
              {option.priority !== null && (
                <div className="flex items-center gap-2 shrink-0 ml-2">
                  <span
                    className="text-xs px-1.5 py-0.5 rounded"
                    style={{
                      backgroundColor: getPriorityColor(option.priority),
                      color: 'white',
                    }}
                  >
                    P{option.priority}
                  </span>
                  {option.percentile !== null && (
                    <span
                      className="text-xs"
                      style={{ color: 'var(--rn-clr-content-tertiary)' }}
                    >
                      {Math.round(option.percentile)}%
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div
        className="flex items-center justify-between px-4 py-2"
        style={{
          borderTop: '1px solid var(--rn-clr-border-primary)',
          backgroundColor: 'var(--rn-clr-background-secondary)',
        }}
      >
        <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
          <kbd className="px-1.5 py-0.5 rounded font-mono" style={{ backgroundColor: 'var(--rn-clr-background-tertiary)', border: '1px solid var(--rn-clr-border-primary)', fontSize: '10px' }}>↑↓</kbd>
          <span>navigate</span>
          <kbd className="px-1.5 py-0.5 rounded font-mono" style={{ backgroundColor: 'var(--rn-clr-background-tertiary)', border: '1px solid var(--rn-clr-border-primary)', fontSize: '10px' }}>Enter</kbd>
          <span>select</span>
        </div>
        {isCreating && (
          <span className="text-xs" style={{ color: 'var(--rn-clr-content-secondary)' }}>
            Creating...
          </span>
        )}
      </div>
    </div>
  );
}

// Helper function to get priority color
function getPriorityColor(priority: number): string {
  if (priority >= 80) return '#22c55e'; // green
  if (priority >= 60) return '#84cc16'; // lime
  if (priority >= 40) return '#eab308'; // yellow
  if (priority >= 20) return '#f97316'; // orange
  return '#ef4444'; // red
}

renderWidget(ParentSelectorWidget);
