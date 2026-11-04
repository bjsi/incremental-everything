/**
 * "Use comparison weights" — the switch Memory Analytics and FSRS Calibration
 * share, so the FSRS Comparison Weights setting can be judged on the same tables
 * as the configured ones, one click apart.
 *
 * Deliberately not remembered across openings: a view that silently reopened on
 * the comparison set would present a candidate's figures as the scheduler's.
 * Each run says which set produced it (`ComparisonWeightsNote`).
 */
import { RNPlugin } from '@remnote/plugin-sdk';
import React from 'react';
import { fsrsComparisonWeightsId, fsrsWeightsId } from '../lib/consts';
import { parseWeightsString } from '../lib/fsrs';
import { getIESetting, useIESetting } from '../lib/settings';

/** Same magenta as the forgetting-curve overlay, so the comparison reads as one thing. */
export const COMPARISON_WEIGHTS_COLOR = '#d946ef';

/**
 * The weights a run should replay with. Falls back to the configured set when
 * the comparison is asked for but the setting is blank or invalid, and says so.
 */
export async function loadFsrsWeights(
  plugin: RNPlugin,
  useComparison: boolean,
): Promise<{ weights: number[] | null; usedComparison: boolean }> {
  if (useComparison) {
    const comparison = parseWeightsString(await getIESetting(plugin, fsrsComparisonWeightsId));
    if (comparison) return { weights: comparison, usedComparison: true };
  }
  return { weights: parseWeightsString(await getIESetting(plugin, fsrsWeightsId)), usedComparison: false };
}

export function ComparisonWeightsToggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  const raw = useIESetting(fsrsComparisonWeightsId);
  const available = parseWeightsString(raw) !== null;
  // Still shown while ticked, so it can be unticked after the setting is cleared.
  if (!available && !checked) return null;
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '5px',
        cursor: disabled ? 'wait' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        color: 'var(--rn-clr-content-secondary)',
      }}
      title={
        'Replay every card with the FSRS Comparison Weights from the plugin settings instead of ' +
        'the FSRS Global Weights, to see how a candidate set would score before adopting it. ' +
        'Nothing is changed; untick to go back.'
      }
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ cursor: disabled ? 'wait' : 'pointer', accentColor: COMPARISON_WEIGHTS_COLOR }}
      />
      Use comparison weights
    </label>
  );
}

/** The status-bar mark for a run made with the comparison weights. */
export function ComparisonWeightsNote({ used }: { used: boolean }) {
  if (!used) return null;
  return (
    <span style={{ color: COMPARISON_WEIGHTS_COLOR, marginLeft: '6px', fontWeight: 600 }}>
      · with comparison weights
    </span>
  );
}
