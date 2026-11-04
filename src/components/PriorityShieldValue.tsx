import React from 'react';
import { percentileToHslColor } from '../lib/utils';
import type { UnifiedShieldEntry } from '../lib/unified_shield';

/** Hover text for one Priority Shield value: both sides and the universe. */
export function priorityShieldTitle(entry: UnifiedShieldEntry, scope: string): string {
  const incRems = entry.universeSize - entry.cardCount;
  const side = (v: number | null) => (v === null ? 'nothing missed' : `P${v}`);
  return [
    `Priority Shield (${scope}): IncRems and cards ranked together by priority`,
    `IncRem side: ${side(entry.incRemAbsolute)}`,
    `Card side: ${side(entry.cardAbsolute)}`,
    `Universe: ${entry.universeSize.toLocaleString()} (${incRems.toLocaleString()} IncRems + ${entry.cardCount.toLocaleString()} cards; dismissed Rems excluded)`,
  ].join('\n');
}

/** `KB: 9 (10.2%)` for the queue bars; nothing when there is no missed element. */
export function PriorityShieldValue({
  label,
  entry,
  style,
}: {
  label: string;
  entry: UnifiedShieldEntry | null | undefined;
  style?: React.CSSProperties;
}) {
  if (!entry || entry.absolute === null) return null;
  return (
    <span style={style} title={priorityShieldTitle(entry, label)}>
      {label}: <strong style={{ color: percentileToHslColor(entry.percentile ?? entry.absolute) }}>{entry.absolute}</strong>
      {entry.percentile !== null && ` (${entry.percentile.toFixed(1)}%)`}
    </span>
  );
}
