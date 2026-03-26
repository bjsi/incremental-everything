// widgets/batch_card_priority.tsx
import {
  renderWidget,
  usePlugin,
  useTrackerPlugin,
  PluginRem,
} from '@remnote/plugin-sdk';
import React, { useState, useEffect } from 'react';
import { safeRemTextToString } from '../lib/pdfUtils';
import { getCardPriority } from '../lib/card_priority';
import { getIncrementalRemFromRem } from '../lib/incremental_rem';
import { powerupCode } from '../lib/consts';
import { updateCardPriorityCache } from '../lib/card_priority/cache';

type ScopeMode = 'tagged' | 'referenced' | 'both';

interface RemWithPriority {
  remId: string;
  rem: PluginRem;
  name: string;
  hasCardPriority: boolean;
  hasManualCardPriority: boolean;
  cardPriority: number | null;
  cardPrioritySource: string | null;
  hasIncRem: boolean;
  incRemPriority: number | null;
  isChecked: boolean;
}

function BatchCardPriority() {
  const plugin = usePlugin();

  // Get the anchor rem ID from session storage (formerly "tagRemId")
  const anchorRemId = useTrackerPlugin(
    async (rp) => {
      const id = await rp.storage.getSession<string>('batchCardPriorityTagRem');
      return id;
    },
    []
  );

  // State management
  const [scopeMode, setScopeMode] = useState<ScopeMode>('tagged');
  const [anchorName, setAnchorName] = useState<string>('');
  const [remsWithTag, setRemsWithTag] = useState<RemWithPriority[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [priorityMin, setPriorityMin] = useState<number>(1);
  const [priorityMax, setPriorityMax] = useState<number>(100);
  const [overwriteExisting, setOverwriteExisting] = useState(false);
  const [tagIncRemsWithCardPriority, setTagIncRemsWithCardPriority] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [successMessage, setSuccessMessage] = useState<string>('');
  const [isApplying, setIsApplying] = useState(false);

  // Separate rems into categories
  const remsWithManualCardPriority = remsWithTag.filter((r) => r.hasManualCardPriority);
  const remsWithIncRem = remsWithTag.filter((r) => r.hasIncRem && !r.hasManualCardPriority);
  const remsWithoutPriority = remsWithTag.filter(
    (r) => !r.hasManualCardPriority && !r.hasIncRem
  );

  // Count selected rems
  const selectedCount = remsWithTag.filter((r) => r.isChecked).length;

  // Load rems based on scope mode
  useEffect(() => {
    let isMounted = true;

    const loadRems = async () => {
      if (!anchorRemId) {
        if (isMounted) {
          setIsLoading(false);
          setErrorMessage('No anchor rem ID found in session');
        }
        return;
      }

      try {
        setIsLoading(true);
        setErrorMessage('');
        setSuccessMessage('');

        // Get the anchor rem
        const anchorRem = await plugin.rem.findOne(anchorRemId);
        if (!anchorRem) {
          if (isMounted) {
            setErrorMessage(`Could not find rem with ID: ${anchorRemId}`);
            setIsLoading(false);
          }
          return;
        }

        const anchorText = await safeRemTextToString(plugin, anchorRem.text);
        if (isMounted) {
          setAnchorName(anchorText);
        }

        // --- Collect rems based on scope ---
        let scopedRems: PluginRem[] = [];

        if (scopeMode === 'tagged' || scopeMode === 'both') {
          const tagged = await anchorRem.taggedRem();
          if (tagged) scopedRems.push(...tagged);
        }

        if (scopeMode === 'referenced' || scopeMode === 'both') {
          const referenced = await anchorRem.remsReferencingThis();
          if (referenced) scopedRems.push(...referenced);
        }

        // Deduplicate by rem._id
        const seen = new Set<string>();
        scopedRems = scopedRems.filter((r) => {
          if (seen.has(r._id)) return false;
          seen.add(r._id);
          return true;
        });

        if (scopedRems.length === 0) {
          if (isMounted) {
            const modeLabel =
              scopeMode === 'tagged' ? `tagged with "${anchorText}"` :
                scopeMode === 'referenced' ? `referencing "${anchorText}"` :
                  `tagged with or referencing "${anchorText}"`;
            setErrorMessage(`No rems found ${modeLabel}`);
            setIsLoading(false);
          }
          return;
        }

        // Process each rem
        const processedRems: RemWithPriority[] = [];

        for (const rem of scopedRems) {
          try {
            const remText = await safeRemTextToString(plugin, rem.text);

            const cardPriorityInfo = await getCardPriority(plugin, rem);
            const hasCardPriority = cardPriorityInfo !== null;
            const cardPriorityValue = cardPriorityInfo?.priority ?? null;
            const cardPrioritySource = cardPriorityInfo?.source ?? null;
            const hasManualCardPriority =
              hasCardPriority &&
              (cardPrioritySource === 'manual' || cardPrioritySource === 'incremental');

            const hasIncremental = await rem.hasPowerup(powerupCode);
            let incRemPriority = null;

            if (hasIncremental) {
              const incInfo = await getIncrementalRemFromRem(plugin, rem);
              if (incInfo && incInfo.priority !== undefined) {
                incRemPriority = incInfo.priority;
              }
            }

            processedRems.push({
              remId: rem._id,
              rem,
              name: remText,
              hasCardPriority,
              hasManualCardPriority,
              cardPriority: cardPriorityValue,
              cardPrioritySource,
              hasIncRem: hasIncremental,
              incRemPriority,
              isChecked: !hasManualCardPriority,
            });
          } catch (error) {
            console.error(`Error processing rem ${rem._id}:`, error);
          }
        }

        // Sort by name
        processedRems.sort((a, b) => a.name.localeCompare(b.name));

        if (isMounted) {
          setRemsWithTag(processedRems);
          setIsLoading(false);
        }
      } catch (error) {
        console.error('Error loading rems:', error);
        if (isMounted) {
          setErrorMessage('Failed to load rems');
          setIsLoading(false);
        }
      }
    };

    loadRems();

    return () => {
      isMounted = false;
    };
  }, [anchorRemId, scopeMode, plugin]);

  const toggleCheck = (remId: string) => {
    setRemsWithTag((prev) =>
      prev.map((r) => (r.remId === remId ? { ...r, isChecked: !r.isChecked } : r))
    );
  };

  const toggleAll = (category: 'withManualCardPriority' | 'withIncRem' | 'withoutPriority') => {
    setRemsWithTag((prev) => {
      const categoryRems =
        category === 'withManualCardPriority'
          ? remsWithManualCardPriority
          : category === 'withIncRem'
            ? remsWithIncRem
            : remsWithoutPriority;
      const allChecked = categoryRems.every((r) => r.isChecked);

      return prev.map((r) => {
        const isInCategory = categoryRems.some((cr) => cr.remId === r.remId);
        if (isInCategory) {
          return { ...r, isChecked: !allChecked };
        }
        return r;
      });
    });
  };

  const validateAndApply = async () => {
    if (priorityMin < 0 || priorityMin > 100) {
      setErrorMessage('Minimum priority must be between 0 and 100');
      return;
    }
    if (priorityMax < 0 || priorityMax > 100) {
      setErrorMessage('Maximum priority must be between 0 and 100');
      return;
    }
    if (priorityMin > priorityMax) {
      setErrorMessage('Minimum priority cannot be greater than maximum priority');
      return;
    }

    const selectedRems = remsWithTag.filter((r) => r.isChecked);
    if (selectedRems.length === 0) {
      setErrorMessage('Please select at least one rem');
      return;
    }

    const selectedWithManualCardPriority = selectedRems.filter((r) => r.hasManualCardPriority);
    if (selectedWithManualCardPriority.length > 0 && !overwriteExisting) {
      const confirmed = confirm(
        `${selectedWithManualCardPriority.length} selected rem(s) already have manual/incremental cardPriority.\n\n` +
        `Enable "Overwrite existing manual/incremental cardPriority" to update them.\n\n` +
        `Continue without updating these rems?`
      );
      if (!confirmed) return;
    }

    setIsApplying(true);
    setErrorMessage('');

    // Suppress GlobalRemChanged listener during bulk writes
    await plugin.storage.setSession('batch_priority_active', true);

    try {
      let appliedCount = 0;
      const batchSize = 10;

      for (let i = 0; i < selectedRems.length; i += batchSize) {
        const batch = selectedRems.slice(i, i + batchSize);

        await Promise.all(
          batch.map(async (remData) => {
            // Skip if it has manual cardPriority and overwrite is off
            if (remData.hasManualCardPriority && !overwriteExisting) {
              return;
            }

            // For IncRems with the option enabled, use their IncRem priority
            let priority: number;
            if (remData.hasIncRem && tagIncRemsWithCardPriority && remData.incRemPriority !== null) {
              priority = remData.incRemPriority;
            } else {
              // Generate random priority within range
              priority =
                Math.floor(Math.random() * (priorityMax - priorityMin + 1)) + priorityMin;
            }

            await remData.rem.addPowerup('cardPriority');
            await remData.rem.setPowerupProperty('cardPriority', 'priority', [priority.toString()]);
            await remData.rem.setPowerupProperty('cardPriority', 'prioritySource', ['manual']);
            await remData.rem.setPowerupProperty('cardPriority', 'lastUpdated', [
              new Date().toISOString(),
            ]);

            await updateCardPriorityCache(plugin, remData.remId);

            appliedCount++;
          })
        );

        // Show progress
        const progress = Math.min(appliedCount, selectedRems.length);
        setSuccessMessage(`Applied: ${progress}/${selectedRems.length}`);
      }

      setSuccessMessage(`✅ Successfully applied cardPriority to ${appliedCount} rem(s)`);

      setTimeout(() => {
        plugin.widget.closePopup();
      }, 2000);
    } catch (error) {
      console.error('Error applying priorities:', error);
      setErrorMessage('Failed to apply priorities. Check console for details.');
    } finally {
      setIsApplying(false);
      await plugin.storage.setSession('batch_priority_active', false);
    }
  };

  // Styles
  const styles = {
    container: {
      padding: '20px',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      maxWidth: '800px',
      margin: '0 auto',
    },
    header: {
      marginBottom: '20px',
    },
    title: {
      fontSize: '20px',
      fontWeight: 600,
      marginBottom: '8px',
    },
    subtitle: {
      fontSize: '14px',
      color: '#6b7280',
    },
    section: {
      marginBottom: '20px',
      padding: '16px',
      border: '1px solid #e5e7eb',
      borderRadius: '8px',
      backgroundColor: '#f9fafb',
    },
    sectionTitle: {
      fontSize: '16px',
      fontWeight: 600,
      marginBottom: '12px',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
    },
    priorityInputs: {
      display: 'flex',
      gap: '12px',
      alignItems: 'center',
      marginBottom: '16px',
    },
    input: {
      padding: '8px 12px',
      border: '1px solid #d1d5db',
      borderRadius: '6px',
      fontSize: '14px',
      width: '100px',
    },
    checkbox: {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      marginBottom: '12px',
    },
    remList: {
      maxHeight: '200px',
      overflowY: 'auto' as const,
      border: '1px solid #e5e7eb',
      borderRadius: '6px',
      backgroundColor: 'white',
      padding: '8px',
    },
    remItem: {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '6px 8px',
      borderBottom: '1px solid #f3f4f6',
      fontSize: '14px',
    },
    button: {
      padding: '10px 20px',
      borderRadius: '6px',
      border: 'none',
      fontWeight: 600,
      fontSize: '14px',
      cursor: 'pointer',
      transition: 'background-color 0.2s',
    },
    primaryButton: {
      backgroundColor: '#3b82f6',
      color: 'white',
    },
    secondaryButton: {
      backgroundColor: '#6b7280',
      color: 'white',
      marginLeft: '8px',
    },
    error: {
      color: '#ef4444',
      fontSize: '14px',
      marginTop: '8px',
    },
    success: {
      color: '#10b981',
      fontSize: '14px',
      marginTop: '8px',
    },
    badge: {
      padding: '2px 6px',
      borderRadius: '4px',
      fontSize: '11px',
      fontWeight: 600,
      marginLeft: '8px',
    },
    cardPriorityBadge: {
      backgroundColor: '#fbbf24',
      color: '#78350f',
    },
    incrementalBadge: {
      backgroundColor: '#86efac',
      color: '#14532d',
    },
    incRemBadge: {
      backgroundColor: '#60a5fa',
      color: '#1e3a8a',
    },
  };

  const scopeSubtitle =
    scopeMode === 'tagged' ? `Rems tagged with "${anchorName}"` :
      scopeMode === 'referenced' ? `Rems referencing "${anchorName}"` :
        `Rems tagged with or referencing "${anchorName}"`;

  if (isLoading) {
    return (
      <div style={styles.container}>
        <div>Loading rems for "{anchorName}"...</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div style={styles.title}>Batch Card Priority Assignment</div>
        <div style={styles.subtitle}>Anchor: {anchorName}</div>
        <div style={styles.subtitle}>{scopeSubtitle}</div>
      </div>

      {/* Scope Selector */}
      <div style={{ ...styles.section, marginBottom: '16px' }}>
        <div style={{ ...styles.sectionTitle, marginBottom: '8px' }}>Scope</div>
        <div style={{ display: 'flex', gap: '24px', fontSize: '14px' }}>
          {(['tagged', 'referenced', 'both'] as ScopeMode[]).map((mode) => (
            <label key={mode} style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: isApplying ? 'not-allowed' : 'pointer' }}>
              <input
                type="radio"
                name="scopeMode"
                value={mode}
                checked={scopeMode === mode}
                onChange={() => setScopeMode(mode)}
                disabled={isApplying}
              />
              {mode === 'tagged' ? 'Tagged Rems' : mode === 'referenced' ? 'Rem References' : 'Both'}
            </label>
          ))}
        </div>
      </div>

      {/* Priority Range Input */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Priority Range</div>
        <div style={styles.priorityInputs}>
          <label>
            Min:
            <input
              type="number"
              value={priorityMin}
              onChange={(e) => setPriorityMin(Number(e.target.value))}
              style={styles.input}
              min="0"
              max="100"
              disabled={isApplying}
            />
          </label>
          <label>
            Max:
            <input
              type="number"
              value={priorityMax}
              onChange={(e) => setPriorityMax(Number(e.target.value))}
              style={styles.input}
              min="0"
              max="100"
              disabled={isApplying}
            />
          </label>
          <span style={{ fontSize: '12px', color: '#6b7280' }}>
            (Random values will be assigned within this range)
          </span>
        </div>
      </div>

      {/* Rems with existing manual/incremental cardPriority */}
      {remsWithManualCardPriority.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>
            <input
              type="checkbox"
              checked={overwriteExisting}
              onChange={(e) => setOverwriteExisting(e.target.checked)}
              disabled={isApplying}
            />
            <span>Overwrite existing manual/incremental cardPriority ({remsWithManualCardPriority.length})</span>
            <button
              onClick={() => toggleAll('withManualCardPriority')}
              style={{ marginLeft: 'auto', fontSize: '12px', padding: '2px 8px' }}
              disabled={isApplying}
            >
              Toggle All
            </button>
          </div>
          <div style={styles.remList}>
            {remsWithManualCardPriority.map((rem) => (
              <div key={rem.remId} style={styles.remItem}>
                <input
                  type="checkbox"
                  checked={rem.isChecked}
                  onChange={() => toggleCheck(rem.remId)}
                  disabled={isApplying || !overwriteExisting}
                />
                <span>{rem.name}</span>
                <span style={{ ...styles.badge, ...(rem.cardPrioritySource === 'manual' ? styles.cardPriorityBadge : styles.incrementalBadge) }}>
                  {rem.cardPrioritySource === 'manual' ? 'Manual' : 'Incremental'} CP: {rem.cardPriority}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* IncRems without cardPriority */}
      {remsWithIncRem.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>
            <input
              type="checkbox"
              checked={tagIncRemsWithCardPriority}
              onChange={(e) => setTagIncRemsWithCardPriority(e.target.checked)}
              disabled={isApplying}
            />
            <span>Tag IncRems with their IncRem priority ({remsWithIncRem.length})</span>
            <button
              onClick={() => toggleAll('withIncRem')}
              style={{ marginLeft: 'auto', fontSize: '12px', padding: '2px 8px' }}
              disabled={isApplying}
            >
              Toggle All
            </button>
          </div>
          <div style={styles.remList}>
            {remsWithIncRem.map((rem) => (
              <div key={rem.remId} style={styles.remItem}>
                <input
                  type="checkbox"
                  checked={rem.isChecked}
                  onChange={() => toggleCheck(rem.remId)}
                  disabled={isApplying || !tagIncRemsWithCardPriority}
                />
                <span>{rem.name}</span>
                <span style={{ ...styles.badge, ...styles.incRemBadge }}>
                  IncRem: {rem.incRemPriority}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Rems without any priority */}
      {remsWithoutPriority.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>
            <span>Rems to assign priority ({remsWithoutPriority.length})</span>
            <button
              onClick={() => toggleAll('withoutPriority')}
              style={{ marginLeft: 'auto', fontSize: '12px', padding: '2px 8px' }}
              disabled={isApplying}
            >
              Toggle All
            </button>
          </div>
          <div style={styles.remList}>
            {remsWithoutPriority.map((rem) => (
              <div key={rem.remId} style={styles.remItem}>
                <input
                  type="checkbox"
                  checked={rem.isChecked}
                  onChange={() => toggleCheck(rem.remId)}
                  disabled={isApplying}
                />
                <span>{rem.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Summary and Actions */}
      <div style={{ marginTop: '20px' }}>
        <div style={{ fontSize: '14px', marginBottom: '12px' }}>
          <strong>Selected: {selectedCount} rem(s)</strong>
        </div>

        <button
          onClick={validateAndApply}
          style={{ ...styles.button, ...styles.primaryButton }}
          disabled={isApplying || selectedCount === 0}
        >
          {isApplying ? 'Applying...' : 'Apply Card Priorities'}
        </button>

        <button
          onClick={() => plugin.widget.closePopup()}
          style={{ ...styles.button, ...styles.secondaryButton }}
          disabled={isApplying}
        >
          Cancel
        </button>

        {errorMessage && <div style={styles.error}>{errorMessage}</div>}
        {successMessage && <div style={styles.success}>{successMessage}</div>}
      </div>
    </div>
  );
}

renderWidget(BatchCardPriority);
