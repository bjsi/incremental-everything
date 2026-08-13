/**
 * Queue Selection Odds — head-to-head panel at the bottom of the Weighted
 * Shield popup (`wsh`).
 *
 * Answers "how much more likely is an item at priority X to be drawn into a
 * priority-sorted queue than an item at priority Y?" for one chosen universe
 * (Incremental Rems / Cards × Knowledge Base / Document scope).
 *
 * The odds come from the very curve the queue's priority-weighted lottery uses
 * (see `applyPriorityWeightedLottery` in lib/sorting.ts): an item's ticket count
 * is W = e^(−k · p/100), with `p` its relative percentile in the universe and
 * `k` the user's configured `weightSelectionK`. So the ratio of two items'
 * weights IS their ratio of draw odds, and it depends only on the *gap* between
 * their percentiles.
 *
 * Either side can be entered as a relative percentile or as an absolute
 * priority; the panel converts between the two using the same sorted universe
 * the bucket tables above are built from, and pulls a real sample item at that
 * priority out of the session caches so the numbers have a face.
 */

import { RNPlugin, usePlugin } from '@remnote/plugin-sdk';
import React from 'react';
import {
  allCardPriorityInfoKey,
  allIncrementalRemKey,
  allIncrementalRemSlimKey,
  priorityCalcScopeRemIdsKey,
} from '../lib/consts';
import { CardPriorityInfo } from '../lib/card_priority/types';
import { DEFAULT_WEIGHT_K, getCardRandomness, getSortingRandomness, getWeightSelectionK } from '../lib/sorting';
import { RemText } from './RemText';

export type OddsItemKind = 'incRem' | 'card';
export type OddsScope = 'kb' | 'doc';

export interface OddsUniverse {
  /** Stable id, e.g. "card-kb". */
  key: string;
  /** Dropdown label, e.g. "🃏 Cards · 🌐 Knowledge Base". */
  label: string;
  kind: OddsItemKind;
  scope: OddsScope;
  /** Same array the bucket table / threshold slider use: priority ascending. */
  sortedItems: { priority: number; isDue: boolean }[];
}

type InputMode = 'percentile' | 'absolute';

interface SideInput {
  mode: InputMode;
  value: number;
}

interface ResolvedSide {
  /** Relative percentile in [0, 100] used for the weight. */
  percentile: number;
  /** Absolute priority this percentile maps to (or the one the user typed). */
  priority: number;
  /** W = e^(−k · p/100). */
  weight: number;
  /** True when the typed absolute priority sits below every item's priority. */
  belowUniverse: boolean;
}

/** Number of items with priority <= p, over a priority-ascending array. */
function countAtOrAbove(sortedItems: { priority: number }[], p: number): number {
  let lo = 0;
  let hi = sortedItems.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedItems[mid].priority <= p) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function resolveSide(
  universe: OddsUniverse,
  input: SideInput,
  weightK: number
): ResolvedSide | null {
  const sorted = universe.sortedItems;
  const N = sorted.length;
  if (N === 0 || !Number.isFinite(input.value)) return null;

  let percentile: number;
  let priority: number;
  let belowUniverse = false;

  if (input.mode === 'percentile') {
    percentile = Math.min(100, Math.max(0, input.value));
    // Rank of the item sitting at that percentile: percentile p corresponds to
    // index ceil(p/100 * N) − 1 under the ((i+1)/N)*100 convention used
    // everywhere else in the shield.
    const idx = Math.min(N - 1, Math.max(0, Math.ceil((percentile / 100) * N) - 1));
    priority = sorted[idx].priority;
  } else {
    priority = input.value;
    const count = countAtOrAbove(sorted, priority);
    belowUniverse = count === 0;
    // The percentile of an absolute priority is the rank of the LAST item at or
    // above it — the same definition the threshold slider's "Rel %ile" uses.
    percentile = belowUniverse ? 0 : (count / N) * 100;
  }

  return {
    percentile,
    priority,
    weight: Math.exp((-weightK * percentile) / 100),
    belowUniverse,
  };
}

// --- Sample-item pools ----------------------------------------------------

interface PoolEntry {
  remId: string;
  priority: number;
}

interface Pool {
  /** priority → rem ids, for O(1) sampling at an exact priority. */
  byPriority: Map<number, string[]>;
  /** Ascending list of the priorities present, for nearest-priority fallback. */
  priorities: number[];
  /** False when a doc-scoped pool had to fall back to the whole KB. */
  scopeExact: boolean;
}

function buildPool(entries: PoolEntry[], scopeExact: boolean): Pool {
  const byPriority = new Map<number, string[]>();
  for (const e of entries) {
    const list = byPriority.get(e.priority);
    if (list) list.push(e.remId);
    else byPriority.set(e.priority, [e.remId]);
  }
  return {
    byPriority,
    priorities: [...byPriority.keys()].sort((a, b) => a - b),
    scopeExact,
  };
}

/**
 * A rem id at (or nearest to) `priority`, chosen at random among the ties.
 * `excludeRemId` is the id currently on screen: it is skipped when another
 * candidate exists, so pressing 🎲 always visibly draws something else.
 */
function sampleAtPriority(
  pool: Pool,
  priority: number,
  excludeRemId?: string | null
): { remId: string; exact: boolean } | null {
  if (pool.priorities.length === 0) return null;
  let target = priority;
  let exact = pool.byPriority.has(priority);
  if (!exact) {
    let best = pool.priorities[0];
    let bestDist = Math.abs(best - priority);
    for (const p of pool.priorities) {
      const d = Math.abs(p - priority);
      if (d < bestDist) {
        best = p;
        bestDist = d;
      }
    }
    target = best;
  }
  const all = pool.byPriority.get(target)!;
  const ids =
    excludeRemId && all.length > 1 ? all.filter((id) => id !== excludeRemId) : all;
  return { remId: ids[Math.floor(Math.random() * ids.length)], exact };
}

// --- Panel ----------------------------------------------------------------

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--rn-clr-background-tertiary)',
  borderRadius: '6px',
  background: 'var(--rn-clr-background-primary)',
  padding: '8px 10px',
};

const labelStyle: React.CSSProperties = {
  fontSize: '10px',
  color: 'var(--rn-clr-content-tertiary)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  fontWeight: 600,
};

export function SelectionOddsPanel({
  universes,
  compact,
}: {
  universes: OddsUniverse[];
  /** Narrow popup — stack the two sides instead of placing them side by side. */
  compact?: boolean;
}) {
  const plugin = usePlugin();

  const [universeKey, setUniverseKey] = React.useState<string>(universes[0]?.key ?? '');
  const universe = universes.find((u) => u.key === universeKey) ?? universes[0];

  const [sideA, setSideA] = React.useState<SideInput>({ mode: 'percentile', value: 15 });
  const [sideB, setSideB] = React.useState<SideInput>({ mode: 'percentile', value: 35 });

  const [weightK, setWeightK] = React.useState<number>(DEFAULT_WEIGHT_K);
  const [randomness, setRandomness] = React.useState<{ incRem: number; card: number } | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const [k, incRem, card] = await Promise.all([
        getWeightSelectionK(plugin),
        getSortingRandomness(plugin),
        getCardRandomness(plugin),
      ]);
      if (cancelled) return;
      setWeightK(k);
      setRandomness({ incRem, card });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Sample pools, loaded lazily per (kind, scope) and cached for the session.
  const [pools, setPools] = React.useState<Record<string, Pool>>({});
  const loadingRef = React.useRef<Set<string>>(new Set());

  React.useEffect(() => {
    if (!universe) return;
    const { key, kind, scope } = universe;
    // loadingRef alone guards against duplicate loads — no cancellation, so a
    // pool whose universe was switched away mid-load still lands in the cache
    // instead of being lost with its loadingRef entry left behind.
    if (loadingRef.current.has(key)) return;
    loadingRef.current.add(key);
    (async () => {
      const pool = await loadPool(plugin, kind, scope);
      setPools((prev) => (prev[key] ? prev : { ...prev, [key]: pool }));
    })();
  }, [universe?.key]);

  // One nonce PER SIDE: a shared one would make either 🎲 invalidate both
  // memos, re-rolling the other side's sample too. The resolved priorities are
  // also memo keys, so editing an input re-samples that side on its own.
  const [rerollA, setRerollA] = React.useState(0);
  const [rerollB, setRerollB] = React.useState(0);

  const resolvedA = universe ? resolveSide(universe, sideA, weightK) : null;
  const resolvedB = universe ? resolveSide(universe, sideB, weightK) : null;

  const pool = universe ? pools[universe.key] : undefined;
  // Remembers what each side is currently showing so a re-draw can avoid it.
  const lastSampleA = React.useRef<string | null>(null);
  const lastSampleB = React.useRef<string | null>(null);
  const sampleA = React.useMemo(() => {
    const s = pool && resolvedA ? sampleAtPriority(pool, resolvedA.priority, lastSampleA.current) : null;
    lastSampleA.current = s?.remId ?? null;
    return s;
  }, [pool, resolvedA?.priority, rerollA]);
  const sampleB = React.useMemo(() => {
    const s = pool && resolvedB ? sampleAtPriority(pool, resolvedB.priority, lastSampleB.current) : null;
    lastSampleB.current = s?.remId ?? null;
    return s;
  }, [pool, resolvedB?.priority, rerollB]);

  if (!universe || universes.length === 0) return null;

  const ratio =
    resolvedA && resolvedB && resolvedB.weight > 0 ? resolvedA.weight / resolvedB.weight : null;
  const favoursA = ratio != null && ratio >= 1;
  const displayRatio = ratio == null ? null : favoursA ? ratio : 1 / ratio;
  const evenOdds = displayRatio != null && displayRatio < 1.005;
  const shareA =
    resolvedA && resolvedB ? (resolvedA.weight / (resolvedA.weight + resolvedB.weight)) * 100 : null;

  const activeRandomness =
    randomness == null ? null : universe.kind === 'card' ? randomness.card : randomness.incRem;

  const renderSide = (
    name: 'A' | 'B',
    input: SideInput,
    setInput: (v: SideInput) => void,
    resolved: ResolvedSide | null,
    sample: { remId: string; exact: boolean } | null,
    onReroll: () => void,
    accent: string
  ) => (
    <div style={{ ...cardStyle, borderTop: `3px solid ${accent}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
        <span style={{ fontSize: '12px', fontWeight: 700, color: accent }}>Item {name}</span>
        <div style={{ display: 'flex', gap: '2px', marginLeft: 'auto' }}>
          {(['percentile', 'absolute'] as InputMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setInput({ ...input, mode: m })}
              style={{
                fontSize: '10px',
                padding: '2px 6px',
                borderRadius: '4px',
                cursor: 'pointer',
                border: '1px solid var(--rn-clr-background-tertiary)',
                background:
                  input.mode === m ? 'var(--rn-clr-background-tertiary)' : 'transparent',
                fontWeight: input.mode === m ? 700 : 500,
                color: 'var(--rn-clr-content-secondary)',
              }}
            >
              {m === 'percentile' ? 'Rel %ile' : 'Abs priority'}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <input
          type="range"
          min={0}
          max={100}
          step={input.mode === 'percentile' ? 0.5 : 1}
          value={Math.min(100, Math.max(0, input.value))}
          onChange={(e) => setInput({ ...input, value: parseFloat(e.target.value) })}
          style={{ flex: 1 }}
        />
        <input
          type="number"
          min={0}
          max={100}
          step={input.mode === 'percentile' ? 0.5 : 1}
          value={input.value}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            setInput({ ...input, value: Number.isFinite(v) ? v : 0 });
          }}
          style={{
            width: '62px',
            fontSize: '12px',
            fontFamily: 'monospace',
            padding: '2px 4px',
            borderRadius: '4px',
            border: '1px solid var(--rn-clr-background-tertiary)',
            background: 'var(--rn-clr-background-primary)',
            color: 'var(--rn-clr-content-primary)',
          }}
        />
        <span style={{ fontSize: '11px', color: 'var(--rn-clr-content-tertiary)' }}>
          {input.mode === 'percentile' ? '%' : 'pri'}
        </span>
      </div>

      {resolved && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: '6px',
            marginBottom: '8px',
          }}
        >
          <div>
            <div style={labelStyle}>Rel %ile</div>
            <div style={{ fontSize: '12px', fontWeight: 700 }}>
              {resolved.percentile.toFixed(1)}%
            </div>
          </div>
          <div>
            <div style={labelStyle}>Abs priority</div>
            <div style={{ fontSize: '12px', fontWeight: 700 }}>{resolved.priority}</div>
          </div>
          <div>
            <div style={labelStyle} title="Lottery tickets: W = e^(−k × p/100)">
              Weight W
            </div>
            <div style={{ fontSize: '12px', fontWeight: 700, fontFamily: 'monospace' }}>
              {resolved.weight.toFixed(3)}
            </div>
          </div>
        </div>
      )}

      {resolved?.belowUniverse && (
        <div style={{ fontSize: '10px', color: '#eab308', marginBottom: '6px' }}>
          No item is prioritized at ≤ {resolved.priority} in this universe — treated as top rank.
        </div>
      )}

      <div
        style={{
          borderTop: '1px dashed var(--rn-clr-background-tertiary)',
          paddingTop: '6px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }}>
          <span style={labelStyle}>Sample item</span>
          <button
            type="button"
            title="Draw another item at this priority"
            onClick={onReroll}
            style={{
              marginLeft: 'auto',
              fontSize: '11px',
              lineHeight: 1,
              padding: '2px 5px',
              borderRadius: '4px',
              cursor: 'pointer',
              border: '1px solid var(--rn-clr-background-tertiary)',
              background: 'transparent',
            }}
          >
            🎲
          </button>
        </div>
        {sample ? (
          <div
            onClick={async () => {
              const rem = await plugin.rem.findOne(sample.remId);
              if (rem) await plugin.window.openRem(rem);
            }}
            title={
              (sample.exact ? '' : 'Nearest available priority. ') +
              (pool && !pool.scopeExact ? 'Sampled from the KB pool — document scope ids unavailable. ' : '') +
              'Click to open this rem.'
            }
            style={{
              fontSize: '11.5px',
              lineHeight: '1.35',
              color: 'var(--rn-clr-content-secondary)',
              cursor: 'pointer',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {sample.exact ? '' : '≈ '}
            <RemText remId={sample.remId} />
          </div>
        ) : (
          <div style={{ fontSize: '11px', color: 'var(--rn-clr-content-tertiary)' }}>
            {pool ? 'No sample available' : 'Loading…'}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div
      style={{
        marginTop: '16px',
        paddingTop: '12px',
        borderTop: '2px solid var(--rn-clr-background-tertiary)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '10px',
          marginBottom: '4px',
        }}
      >
        <span style={{ fontSize: '15px', fontWeight: 700 }}>🎲 Queue Selection Odds</span>
        <select
          value={universe.key}
          onChange={(e) => setUniverseKey(e.target.value)}
          style={{
            fontSize: '12px',
            padding: '3px 6px',
            borderRadius: '4px',
            border: '1px solid var(--rn-clr-background-tertiary)',
            background: 'var(--rn-clr-background-primary)',
            color: 'var(--rn-clr-content-primary)',
          }}
        >
          {universes.map((u) => (
            <option key={u.key} value={u.key}>
              {u.label}
            </option>
          ))}
        </select>
        <span style={{ fontSize: '11px', color: 'var(--rn-clr-content-tertiary)' }}>
          {universe.sortedItems.length.toLocaleString()} items · k ={' '}
          <b style={{ fontFamily: 'monospace' }}>{weightK.toFixed(3)}</b>
          {activeRandomness != null && (
            <> · randomness {Math.round(activeRandomness * 100)}%</>
          )}
        </span>
      </div>

      <div
        style={{
          fontSize: '11px',
          color: 'var(--rn-clr-content-tertiary)',
          lineHeight: '1.5',
          marginBottom: '10px',
        }}
      >
        How much more often the queue's priority-weighted lottery draws one item over another.
        Each item holds W = e^(−k × p/100) tickets, so the odds ratio is e^(k × Δp/100) — it
        depends only on the <i>gap</i> between the two relative percentiles.
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: compact ? '1fr' : '1fr 190px 1fr',
          gap: '12px',
          alignItems: 'center',
        }}
      >
        {renderSide('A', sideA, setSideA, resolvedA, sampleA, () => setRerollA((n) => n + 1), '#3b82f6')}

        <div style={{ textAlign: 'center' }}>
          {displayRatio != null ? (
            <>
              <div
                style={{
                  fontSize: '26px',
                  fontWeight: 800,
                  fontFamily: 'monospace',
                  color: evenOdds ? 'var(--rn-clr-content-secondary)' : favoursA ? '#3b82f6' : '#f97316',
                  lineHeight: 1.1,
                }}
              >
                {displayRatio < 100 ? displayRatio.toFixed(2) : displayRatio.toFixed(0)}×
              </div>
              <div style={{ fontSize: '11.5px', color: 'var(--rn-clr-content-secondary)', marginTop: '2px' }}>
                {evenOdds ? (
                  <>Even odds — same percentile</>
                ) : (
                  <>
                    <b style={{ color: favoursA ? '#3b82f6' : '#f97316' }}>
                      Item {favoursA ? 'A' : 'B'}
                    </b>{' '}
                    is more likely to be drawn
                  </>
                )}
              </div>
              {shareA != null && (
                <div
                  style={{
                    marginTop: '6px',
                    fontSize: '11px',
                    color: 'var(--rn-clr-content-tertiary)',
                  }}
                >
                  Head-to-head:{' '}
                  <b style={{ color: '#3b82f6' }}>{shareA.toFixed(1)}%</b> /{' '}
                  <b style={{ color: '#f97316' }}>{(100 - shareA).toFixed(1)}%</b>
                </div>
              )}
              {resolvedA && resolvedB && (
                <div
                  style={{
                    marginTop: '4px',
                    fontSize: '10px',
                    fontFamily: 'monospace',
                    color: 'var(--rn-clr-content-tertiary)',
                  }}
                >
                  Δp = {Math.abs(resolvedB.percentile - resolvedA.percentile).toFixed(1)} pp
                </div>
              )}
            </>
          ) : (
            <div style={{ fontSize: '11px', color: 'var(--rn-clr-content-tertiary)' }}>—</div>
          )}
        </div>

        {renderSide('B', sideB, setSideB, resolvedB, sampleB, () => setRerollB((n) => n + 1), '#f97316')}
      </div>

      <div
        style={{
          marginTop: '8px',
          fontSize: '10.5px',
          color: 'var(--rn-clr-content-tertiary)',
          lineHeight: '1.5',
        }}
      >
        The lottery only fills the randomized share of the queue
        {activeRandomness != null && <> (currently {Math.round(activeRandomness * 100)}%)</>}; the
        remaining slots stay in strict priority order, where the more important item always wins.
        Percentiles here are ranks in the selected universe — inside a session the lottery ranks
        within the <i>due</i> population, so the ratio holds as long as the gap between the two
        items does.
      </div>
    </div>
  );
}

// --- Session-cache pool loading -------------------------------------------

async function loadPool(
  plugin: RNPlugin,
  kind: OddsItemKind,
  scope: OddsScope
): Promise<Pool> {
  let entries: PoolEntry[] = [];

  if (kind === 'incRem') {
    const slim =
      (await plugin.storage.getSession<{ remId: string; priority: number }[]>(
        allIncrementalRemSlimKey
      )) ??
      (await plugin.storage.getSession<{ remId: string; priority: number }[]>(
        allIncrementalRemKey
      )) ??
      [];
    entries = slim.map((r) => ({ remId: r.remId, priority: r.priority }));
  } else {
    const infos = (await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey)) ?? [];
    // Mirrors computeWeightedShieldBreakdown's pre-filter: rems with no cards
    // are not part of the card universe.
    entries = infos
      .filter((c) => c.cardCount === undefined || c.cardCount > 0)
      .map((c) => ({ remId: c.remId, priority: c.priority }));
  }

  let scopeExact = true;
  if (scope === 'doc') {
    const scopeIds = await plugin.storage.getSession<string[] | null>(priorityCalcScopeRemIdsKey);
    if (scopeIds && scopeIds.length > 0) {
      const set = new Set(scopeIds);
      entries = entries.filter((e) => set.has(e.remId));
    } else {
      // No cached queue scope (e.g. the popup was opened from the editor against
      // a focused rem). Sample from the KB pool rather than showing nothing, and
      // flag it so the sample carries a caveat.
      scopeExact = false;
    }
  }

  return buildPool(entries, scopeExact);
}
