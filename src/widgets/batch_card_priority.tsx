// widgets/batch_card_priority.tsx
import {
  renderWidget,
  usePlugin,
  useTrackerPlugin,
  PluginRem,
  RNPlugin,
} from '@remnote/plugin-sdk';
import React, { useState, useEffect, useMemo } from 'react';
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
  // hierarchy
  depth: number;
  pathIds: string[];
  originalIndex: number;
  // card presence
  hasCards: boolean; // true = this rem or any descendant has ≥1 card
}

// ── helper: depth + pathIds ──────────────────────────────────────────────────
async function getPathIds(
  plugin: RNPlugin,
  rem: PluginRem,
  stopAtIds: Set<string>
): Promise<{ depth: number; pathIds: string[] }> {
  const pathIds: string[] = [];
  let current: PluginRem | undefined = rem;

  while (current) {
    pathIds.unshift(current._id);
    if (stopAtIds.has(current._id) || !current.parent) break;
    current = await plugin.rem.findOne(current.parent);
  }

  // depth is how many ancestors are in our scoped list
  // We don't know that yet, so we just store the raw pathIds; depth is computed later.
  return { depth: pathIds.length - 1, pathIds };
}

// ── helper: does rem or any descendant have ≥1 card? ────────────────────────
async function remHasCardsRecursive(rem: PluginRem): Promise<boolean> {
  const ownCards = await rem.getCards();
  if (ownCards && ownCards.length > 0) return true;
  const descendants = await rem.getDescendants();
  for (const d of descendants) {
    const cards = await d.getCards();
    if (cards && cards.length > 0) return true;
  }
  return false;
}

function BatchCardPriority() {
  const plugin = usePlugin();

  const anchorRemId = useTrackerPlugin(
    async (rp) => rp.storage.getSession<string>('batchCardPriorityTagRem'),
    []
  );

  // ── state ──────────────────────────────────────────────────────────────────
  const [scopeMode, setScopeMode] = useState<ScopeMode>('tagged');
  const [anchorName, setAnchorName] = useState('');
  const [allRems, setAllRems] = useState<RemWithPriority[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [priorityMin, setPriorityMin] = useState(1);
  const [priorityMax, setPriorityMax] = useState(100);
  const [overwriteExisting, setOverwriteExisting] = useState(false);
  const [tagIncRemsWithCardPriority, setTagIncRemsWithCardPriority] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [isApplying, setIsApplying] = useState(false);
  // filters
  const [filterOnlyWithCards, setFilterOnlyWithCards] = useState(true);
  const [filterPriorityMin, setFilterPriorityMin] = useState(0);
  const [filterPriorityMax, setFilterPriorityMax] = useState(100);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());

  // ── derived: filtered list ─────────────────────────────────────────────────
  const displayedRems = useMemo(() => {
    return allRems.filter((r) => {
      if (filterOnlyWithCards && !r.hasCards) return false;
      const priority = r.cardPriority ?? r.incRemPriority;
      if (priority !== null) {
        if (priority < filterPriorityMin || priority > filterPriorityMax) return false;
      }
      return true;
    });
  }, [allRems, filterOnlyWithCards, filterPriorityMin, filterPriorityMax]);

  // ── categories (for section grouping) ─────────────────────────────────────
  const remsWithManualCardPriority = displayedRems.filter((r) => r.hasManualCardPriority);
  const remsWithIncRem = displayedRems.filter((r) => r.hasIncRem && !r.hasManualCardPriority);
  const remsWithoutPriority = displayedRems.filter(
    (r) => !r.hasManualCardPriority && !r.hasIncRem
  );

  const selectedCount = displayedRems.filter((r) => r.isChecked).length;

  // ── load ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    let isMounted = true;

    const loadRems = async () => {
      if (!anchorRemId) {
        if (isMounted) { setIsLoading(false); setErrorMessage('No anchor rem ID found in session'); }
        return;
      }
      try {
        setIsLoading(true);
        setErrorMessage('');
        setSuccessMessage('');

        const anchorRem = await plugin.rem.findOne(anchorRemId);
        if (!anchorRem) {
          if (isMounted) { setErrorMessage(`Could not find rem with ID: ${anchorRemId}`); setIsLoading(false); }
          return;
        }

        const frontText = anchorRem.text
          ? await plugin.richText.toString(anchorRem.text)
          : await safeRemTextToString(plugin, anchorRem.text);
        const backText = anchorRem.backText
          ? await plugin.richText.toString(anchorRem.backText)
          : '';
        const anchorText = backText
          ? `${frontText} → ${backText}`
          : frontText;
        if (isMounted) setAnchorName(anchorText);

        // Collect rems per scope
        let scopedRems: PluginRem[] = [];
        if (scopeMode === 'tagged' || scopeMode === 'both') {
          const tagged = await anchorRem.taggedRem();
          if (tagged) scopedRems.push(...tagged);
        }
        if (scopeMode === 'referenced' || scopeMode === 'both') {
          const refs = await anchorRem.remsReferencingThis();
          if (refs) scopedRems.push(...refs);
        }

        // Deduplicate
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

        // Build index map for document-order sorting
        const remIndexMap = new Map<string, number>();
        scopedRems.forEach((r, i) => remIndexMap.set(r._id, i));

        // All top-level IDs (to compute relative depth)
        const topLevelIds = new Set(scopedRems.map((r) => r._id));

        // Process each rem
        const processed: RemWithPriority[] = [];

        for (const rem of scopedRems) {
          try {
            const remFront = rem.text
              ? await plugin.richText.toString(rem.text)
              : await safeRemTextToString(plugin, rem.text);
            const remBack = rem.backText
              ? await plugin.richText.toString(rem.backText)
              : '';
            const remText = remBack ? `${remFront} → ${remBack}` : remFront;

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
              if (incInfo?.priority !== undefined) incRemPriority = incInfo.priority;
            }

            // Card presence (own + descendants)
            const hasCards = await remHasCardsRecursive(rem);

            // Hierarchy: depth relative to the top-level scoped rems
            const { pathIds } = await getPathIds(plugin, rem, topLevelIds);
            // depth = number of scoped-rem ancestors above this rem
            const depth = pathIds.filter((id, i) => i < pathIds.length - 1 && topLevelIds.has(id)).length;

            processed.push({
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
              depth,
              pathIds,
              originalIndex: remIndexMap.get(rem._id) ?? 0,
              hasCards,
            });
          } catch (err) {
            console.error(`Error processing rem ${rem._id}:`, err);
          }
        }

        // Sort by document order
        processed.sort((a, b) => a.originalIndex - b.originalIndex);

        if (isMounted) {
          setAllRems(processed);
          setExpandedNodes(new Set(processed.map((r) => r.remId)));
          setIsLoading(false);
        }
      } catch (error) {
        console.error('Error loading rems:', error);
        if (isMounted) { setErrorMessage('Failed to load rems'); setIsLoading(false); }
      }
    };

    loadRems();
    return () => { isMounted = false; };
  }, [anchorRemId, scopeMode, plugin]);

  // ── helpers ────────────────────────────────────────────────────────────────
  const toggleCheck = (remId: string) => {
    setAllRems((prev) => prev.map((r) => r.remId === remId ? { ...r, isChecked: !r.isChecked } : r));
  };

  const toggleAll = (rems: RemWithPriority[], checked: boolean) => {
    const ids = new Set(rems.map((r) => r.remId));
    setAllRems((prev) => prev.map((r) => ids.has(r.remId) ? { ...r, isChecked: checked } : r));
  };

  const toggleExpanded = (remId: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      next.has(remId) ? next.delete(remId) : next.add(remId);
      return next;
    });
  };

  const isNodeVisible = (remData: RemWithPriority): boolean => {
    // Check each ancestor in pathIds. If any ancestor in our list is collapsed, hide this node.
    for (let i = 0; i < remData.pathIds.length - 1; i++) {
      const anc = remData.pathIds[i];
      if (displayedRems.some((r) => r.remId === anc) && !expandedNodes.has(anc)) return false;
    }
    return true;
  };

  const hasChildren = (remId: string): boolean =>
    displayedRems.some((r) => r.pathIds.includes(remId) && r.remId !== remId);

  // ── apply ──────────────────────────────────────────────────────────────────
  const validateAndApply = async () => {
    if (priorityMin < 0 || priorityMin > 100) { setErrorMessage('Min priority must be 0–100'); return; }
    if (priorityMax < 0 || priorityMax > 100) { setErrorMessage('Max priority must be 0–100'); return; }
    if (priorityMin > priorityMax) { setErrorMessage('Min cannot exceed Max'); return; }

    const selectedRems = displayedRems.filter((r) => r.isChecked);
    if (selectedRems.length === 0) { setErrorMessage('Please select at least one rem'); return; }

    const selectedWithManual = selectedRems.filter((r) => r.hasManualCardPriority);
    if (selectedWithManual.length > 0 && !overwriteExisting) {
      const confirmed = confirm(
        `${selectedWithManual.length} selected rem(s) already have a manual/incremental cardPriority.\n\n` +
        `Enable "Overwrite existing" to update them.\n\nContinue without updating these?`
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
            if (remData.hasManualCardPriority && !overwriteExisting) return;

            // For IncRems with the option enabled, use their IncRem priority
            let priority: number;
            if (remData.hasIncRem && tagIncRemsWithCardPriority && remData.incRemPriority !== null) {
              priority = remData.incRemPriority;
            } else {
              // Generate random priority within range
              priority = Math.floor(Math.random() * (priorityMax - priorityMin + 1)) + priorityMin;
            }

            await remData.rem.addPowerup('cardPriority');
            await remData.rem.setPowerupProperty('cardPriority', 'priority', [priority.toString()]);
            await remData.rem.setPowerupProperty('cardPriority', 'prioritySource', ['manual']);
            await remData.rem.setPowerupProperty('cardPriority', 'lastUpdated', [new Date().toISOString()]);
            await updateCardPriorityCache(plugin, remData.remId);

            // Show progress
            appliedCount++;
          })
        );

        setSuccessMessage(`Applied: ${Math.min(appliedCount, selectedRems.length)}/${selectedRems.length}`);
      }

      setSuccessMessage(`✅ Applied cardPriority to ${appliedCount} rem(s)`);
      setTimeout(() => plugin.widget.closePopup(), 2000);
    } catch (error) {
      console.error('Error applying priorities:', error);
      setErrorMessage('Failed to apply priorities. Check console for details.');
    } finally {
      setIsApplying(false);
      await plugin.storage.setSession('batch_priority_active', false);
    }
  };

  // ── styles ─────────────────────────────────────────────────────────────────
  const s = {
    container: { padding: '16px', fontFamily: 'system-ui, -apple-system, sans-serif' },
    section: { marginBottom: '16px', padding: '12px', border: '1px solid #e5e7eb', borderRadius: '8px', backgroundColor: '#f9fafb' },
    sectionTitle: { fontSize: '14px', fontWeight: 600 as const, marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '8px' },
    input: { padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '13px', width: '80px' },
    btn: { padding: '8px 16px', borderRadius: '6px', border: 'none', fontWeight: 600 as const, fontSize: '13px', cursor: 'pointer' },
    badge: { padding: '1px 5px', borderRadius: '4px', fontSize: '10px', fontWeight: 600 as const, marginLeft: '4px' },
    // table
    tableWrap: { border: '1px solid #e5e7eb', borderRadius: '8px', overflow: 'hidden' },
    thead: { display: 'grid', gridTemplateColumns: '32px 1fr 90px 90px', backgroundColor: '#f3f4f6', fontWeight: 600 as const, fontSize: '12px', color: '#374151', padding: '6px 0' },
    theadCell: { padding: '4px 8px' },
    tbody: { maxHeight: '420px', overflowY: 'auto' as const },
    trow: (depth: number): React.CSSProperties => ({
      display: 'grid',
      gridTemplateColumns: '32px 1fr 90px 90px',
      borderTop: '1px solid #f3f4f6',
      fontSize: '13px',
      paddingLeft: `${depth * 18}px`,
      transition: 'background-color 0.1s',
    }),
    tcell: { padding: '5px 8px', display: 'flex', alignItems: 'center' },
  };

  // ── render helpers ─────────────────────────────────────────────────────────
  const priorityBadge = (r: RemWithPriority) => {
    // Manual or incremental — coloured
    if (r.hasManualCardPriority && r.cardPriority !== null) {
      const color = r.cardPrioritySource === 'incremental' ? '#86efac' : '#fbbf24';
      const text = r.cardPrioritySource === 'incremental' ? '#14532d' : '#78350f';
      return <span style={{ ...s.badge, backgroundColor: color, color: text }}>{r.cardPriority}</span>;
    }
    // Inherited — show value but visually subdued
    if (r.cardPriority !== null) {
      return <span style={{ ...s.badge, backgroundColor: '#f3f4f6', color: '#6b7280', border: '1px solid #d1d5db' }}>{r.cardPriority}</span>;
    }
    // IncRem (no card priority yet)
    if (r.hasIncRem && r.incRemPriority !== null) {
      return <span style={{ ...s.badge, backgroundColor: '#60a5fa', color: '#1e3a8a' }}>Inc {r.incRemPriority}</span>;
    }
    return <span style={{ ...s.badge, backgroundColor: '#e5e7eb', color: '#9ca3af' }}>—</span>;
  };

  const cardBadge = (r: RemWithPriority) =>
    r.hasCards
      ? <span style={{ ...s.badge, backgroundColor: '#d1fae5', color: '#065f46' }}>✓cards</span>
      : <span style={{ ...s.badge, backgroundColor: '#fee2e2', color: '#991b1b' }}>no cards</span>;

  const RemRow = ({ remData, disabled }: { remData: RemWithPriority; disabled?: boolean }) => {
    const visible = isNodeVisible(remData);
    if (!visible) return null;
    const expanded = expandedNodes.has(remData.remId);
    const childrenExist = hasChildren(remData.remId);
    return (
      <div
        style={s.trow(remData.depth)}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#f9fafb')}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
      >
        <div style={s.tcell}>
          <input
            type="checkbox"
            checked={remData.isChecked}
            onChange={() => toggleCheck(remData.remId)}
            disabled={isApplying || disabled}
          />
        </div>
        <div style={{ ...s.tcell, gap: '4px', minWidth: 0 }}>
          {childrenExist && (
            <span
              style={{ cursor: 'pointer', fontSize: '10px', color: '#6b7280', userSelect: 'none', flexShrink: 0 }}
              onClick={() => toggleExpanded(remData.remId)}
            >
              {expanded ? '▾' : '▸'}
            </span>
          )}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{remData.name}</span>
          {cardBadge(remData)}
        </div>
        <div style={s.tcell}>{priorityBadge(remData)}</div>
        <div style={{ ...s.tcell, fontSize: '11px', color: '#6b7280' }}>
          {remData.cardPrioritySource ?? (remData.hasIncRem ? 'inc-only' : '—')}
        </div>
      </div>
    );
  };

  const scopeSubtitle =
    scopeMode === 'tagged' ? `tagged with "${anchorName}"` :
    scopeMode === 'referenced' ? `referencing "${anchorName}"` :
    `tagged with or referencing "${anchorName}"`;

  // ── early returns ──────────────────────────────────────────────────────────
  if (isLoading) {
    return <div style={s.container}>Loading rems for "{anchorName}"…</div>;
  }

  // ── full render ────────────────────────────────────────────────────────────
  return (
    <div style={s.container}>
      {/* Header */}
      <div style={{ marginBottom: '16px' }}>
        <div style={{ fontSize: '18px', fontWeight: 600 }}>Batch Card Priority Assignment</div>
        <div style={{ fontSize: '13px', color: '#6b7280' }}>Anchor: <strong>{anchorName}</strong> — {scopeSubtitle}</div>
      </div>

      {/* Scope selector */}
      <div style={{ ...s.section, marginBottom: '12px' }}>
        <div style={{ ...s.sectionTitle, marginBottom: '8px' }}>Scope</div>
        <div style={{ display: 'flex', gap: '24px', fontSize: '13px' }}>
          {(['tagged', 'referenced', 'both'] as ScopeMode[]).map((mode) => (
            <label key={mode} style={{ display: 'flex', alignItems: 'center', gap: '5px', cursor: isApplying ? 'not-allowed' : 'pointer' }}>
              <input type="radio" name="scopeMode" value={mode} checked={scopeMode === mode} onChange={() => setScopeMode(mode)} disabled={isApplying} />
              {mode === 'tagged' ? 'Tagged Rems' : mode === 'referenced' ? 'Rem References' : 'Both'}
            </label>
          ))}
        </div>
      </div>

      {/* Filters */}
      <div style={{ ...s.section, marginBottom: '12px' }}>
        <div style={{ ...s.sectionTitle, marginBottom: '8px' }}>Filters</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', alignItems: 'center', fontSize: '13px' }}>
          {/* Only with cards */}
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
            <input type="checkbox" checked={filterOnlyWithCards} onChange={(e) => setFilterOnlyWithCards(e.target.checked)} disabled={isApplying} />
            Only rems with cards
          </label>
          {/* Priority range */}
          <span style={{ color: '#6b7280' }}>Priority:</span>
          <input type="number" value={filterPriorityMin} min={0} max={100} onChange={(e) => setFilterPriorityMin(Number(e.target.value))} style={s.input} disabled={isApplying} />
          <span style={{ color: '#6b7280' }}>–</span>
          <input type="number" value={filterPriorityMax} min={0} max={100} onChange={(e) => setFilterPriorityMax(Number(e.target.value))} style={s.input} disabled={isApplying} />
          <span style={{ fontSize: '11px', color: '#9ca3af' }}>(filters existing priorities; 0–100 = show all)</span>
        </div>
      </div>

      {/* Priority range for assignment */}
      <div style={{ ...s.section, marginBottom: '12px' }}>
        <div style={{ ...s.sectionTitle, marginBottom: '8px' }}>Assignment Range</div>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', fontSize: '13px' }}>
          <label>Min: <input type="number" value={priorityMin} onChange={(e) => setPriorityMin(Number(e.target.value))} style={s.input} min={0} max={100} disabled={isApplying} /></label>
          <label>Max: <input type="number" value={priorityMax} onChange={(e) => setPriorityMax(Number(e.target.value))} style={s.input} min={0} max={100} disabled={isApplying} /></label>
          <span style={{ fontSize: '12px', color: '#6b7280' }}>Random value within range</span>
        </div>
        <div style={{ marginTop: '8px', fontSize: '13px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
            <input type="checkbox" checked={overwriteExisting} onChange={(e) => setOverwriteExisting(e.target.checked)} disabled={isApplying} />
            Overwrite existing manual/incremental priorities
          </label>
        </div>
        <div style={{ marginTop: '6px', fontSize: '13px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
            <input type="checkbox" checked={tagIncRemsWithCardPriority} onChange={(e) => setTagIncRemsWithCardPriority(e.target.checked)} disabled={isApplying} />
            Use IncRem priority for Incremental Rems (instead of random)
          </label>
        </div>
      </div>

      {/* Tree table */}
      {displayedRems.length === 0 ? (
        <div style={{ padding: '16px', color: '#6b7280', fontSize: '13px', textAlign: 'center' }}>
          No rems match the current filters.
        </div>
      ) : (
        <div style={s.tableWrap}>
          {/* Header */}
          <div style={s.thead}>
            <div style={s.theadCell}>✓</div>
            <div style={s.theadCell}>
              Rem
              <button onClick={() => toggleAll(displayedRems, true)} style={{ marginLeft: '8px', fontSize: '10px', padding: '1px 6px', cursor: 'pointer' }} disabled={isApplying}>All</button>
              <button onClick={() => toggleAll(displayedRems, false)} style={{ marginLeft: '4px', fontSize: '10px', padding: '1px 6px', cursor: 'pointer' }} disabled={isApplying}>None</button>
            </div>
            <div style={s.theadCell}>Priority</div>
            <div style={s.theadCell}>Source</div>
          </div>
          {/* Body */}
          <div style={s.tbody}>
            {/* Section: has manual priority */}
            {remsWithManualCardPriority.length > 0 && (
              <>
                <div style={{ padding: '4px 8px', fontSize: '11px', fontWeight: 600, color: '#92400e', backgroundColor: '#fef3c7', borderTop: '1px solid #e5e7eb' }}>
                  Existing manual/incremental priority ({remsWithManualCardPriority.length})
                  <button onClick={() => toggleAll(remsWithManualCardPriority, !remsWithManualCardPriority.every(r => r.isChecked))} style={{ marginLeft: '8px', fontSize: '10px', padding: '1px 6px', cursor: 'pointer' }} disabled={isApplying || !overwriteExisting}>Toggle</button>
                </div>
                {remsWithManualCardPriority.map((r) => <RemRow key={r.remId} remData={r} disabled={!overwriteExisting} />)}
              </>
            )}
            {/* Section: IncRem only */}
            {remsWithIncRem.length > 0 && (
              <>
                <div style={{ padding: '4px 8px', fontSize: '11px', fontWeight: 600, color: '#1e40af', backgroundColor: '#dbeafe', borderTop: '1px solid #e5e7eb' }}>
                  Incremental Rems (no card priority) ({remsWithIncRem.length})
                  <button onClick={() => toggleAll(remsWithIncRem, !remsWithIncRem.every(r => r.isChecked))} style={{ marginLeft: '8px', fontSize: '10px', padding: '1px 6px', cursor: 'pointer' }} disabled={isApplying || !tagIncRemsWithCardPriority}>Toggle</button>
                </div>
                {remsWithIncRem.map((r) => <RemRow key={r.remId} remData={r} disabled={!tagIncRemsWithCardPriority} />)}
              </>
            )}
            {/* Section: no priority */}
            {remsWithoutPriority.length > 0 && (
              <>
                <div style={{ padding: '4px 8px', fontSize: '11px', fontWeight: 600, color: '#1f2937', backgroundColor: '#f3f4f6', borderTop: '1px solid #e5e7eb' }}>
                  Rems to assign priority ({remsWithoutPriority.length})
                  <button onClick={() => toggleAll(remsWithoutPriority, !remsWithoutPriority.every(r => r.isChecked))} style={{ marginLeft: '8px', fontSize: '10px', padding: '1px 6px', cursor: 'pointer' }} disabled={isApplying}>Toggle</button>
                </div>
                {remsWithoutPriority.map((r) => <RemRow key={r.remId} remData={r} />)}
              </>
            )}
          </div>
        </div>
      )}

      {/* Actions */}
      <div style={{ marginTop: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <button
          onClick={validateAndApply}
          style={{ ...s.btn, backgroundColor: '#3b82f6', color: 'white' }}
          disabled={isApplying || selectedCount === 0}
        >
          {isApplying ? 'Applying…' : `Apply to ${selectedCount} rem(s)`}
        </button>
        <button
          onClick={() => plugin.widget.closePopup()}
          style={{ ...s.btn, backgroundColor: '#6b7280', color: 'white' }}
          disabled={isApplying}
        >
          Cancel
        </button>
        <span style={{ fontSize: '13px', color: '#6b7280' }}>{selectedCount} selected / {displayedRems.length} shown / {allRems.length} total</span>
      </div>

      {errorMessage && <div style={{ color: '#ef4444', fontSize: '13px', marginTop: '8px' }}>{errorMessage}</div>}
      {successMessage && <div style={{ color: '#10b981', fontSize: '13px', marginTop: '8px' }}>{successMessage}</div>}
    </div>
  );
}

renderWidget(BatchCardPriority);
