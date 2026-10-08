import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { DocsHelpButton } from './DocsHelpButton';
import {
  MAX_FACTOR,
  MIN_FACTOR,
  normalizeFactor,
  ResolvedScheduler,
  SchedulerKind,
} from '../lib/scheduler_core';

export interface SchedulerPickerValue {
  kind: SchedulerKind;
  /** Kept as typed text so a half-entered "1." is not rewritten under the cursor. */
  factor: string;
}

interface SchedulerPickerProps {
  value: SchedulerPickerValue;
  onChange: (value: SchedulerPickerValue) => void;
  /** What the settings give this rem — shown so a deviation from them is visible. */
  inherited: ResolvedScheduler;
  /** One line under the control: what the choice means for the coming intervals. */
  hint?: string;
  /** Receives the keys the picker does not use itself (Tab, Enter…). */
  onKeyDown?: (e: React.KeyboardEvent) => void;
}

export interface SchedulerPickerRef {
  focus: () => void;
}

const KIND_LABELS: Record<SchedulerKind, string> = {
  multiplier: '× Multiplier',
  curve: 'Saturating Curve',
};

const SOURCE_LABELS: Record<ResolvedScheduler['source'], string> = {
  item: 'this Rem',
  type: 'the setting for this type',
  default: 'the Default Scheduler',
};

/**
 * Scheduler switch for a single Incremental Rem, shared by the Reschedule and
 * Priority & Interval popups. Keyboard-driven from its container: ←/→ switch
 * scheduler, ↑/↓ step the multiplier, a digit starts typing one.
 */
export const SchedulerPicker = forwardRef<SchedulerPickerRef, SchedulerPickerProps>(
  function SchedulerPicker({ value, onChange, inherited, hint, onKeyDown }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const factorInputRef = useRef<HTMLInputElement>(null);
    const [focused, setFocused] = useState(false);

    useImperativeHandle(ref, () => ({
      focus: () => containerRef.current?.focus(),
    }));

    const setKind = (kind: SchedulerKind) => onChange({ ...value, kind });

    const stepFactor = (delta: number) => {
      const current = normalizeFactor(value.factor) ?? inherited.factor;
      const next = normalizeFactor(Math.round((current + delta) * 10) / 10) ?? current;
      onChange({ ...value, factor: String(next) });
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
      const inFactorInput = e.target === factorInputRef.current;

      if (!inFactorInput) {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          setKind(value.kind === 'multiplier' ? 'curve' : 'multiplier');
          return;
        }
        if (value.kind === 'multiplier') {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            stepFactor(e.key === 'ArrowUp' ? 0.1 : -0.1);
            return;
          }
          if (/^[0-9.,]$/.test(e.key)) {
            // Start typing a multiplier: the keystroke lands in the input.
            factorInputRef.current?.focus();
            factorInputRef.current?.select();
            return;
          }
        }
      } else if (e.key.startsWith('Arrow')) {
        // Caret movement and the native number stepper.
        return;
      }

      onKeyDown?.(e);
    };

    const differsFromSettings =
      value.kind !== inherited.kind ||
      (value.kind === 'multiplier' &&
        (normalizeFactor(value.factor) ?? inherited.factor) !== inherited.factor);

    const inheritedText =
      inherited.kind === 'multiplier'
        ? `${KIND_LABELS.multiplier} ${inherited.factor}`
        : KIND_LABELS.curve;

    return (
      <div className="flex flex-col gap-1" data-section="scheduler">
        <div className="flex justify-between text-xs font-semibold mb-1">
          <span className="flex items-center gap-1">
            <span>⚙️</span> Scheduler
            <span className="text-[10px] font-normal opacity-70 italic">(←/→ to switch)</span>
          </span>
          <DocsHelpButton path="IncRem-Scheduler/#per-rem-scheduler" label="Scheduler" />
        </div>
        <div
          ref={containerRef}
          tabIndex={0}
          role="radiogroup"
          aria-label="Scheduler"
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
          }}
          className="flex items-center gap-2 rounded p-1"
          style={{
            outline: 'none',
            boxShadow: focused ? '0 0 0 3px rgba(59, 130, 246, 0.5)' : 'none',
          }}
        >
          <div
            className="flex rounded overflow-hidden"
            style={{
              border: '1px solid var(--rn-clr-border-primary, rgba(128,128,128,0.35))',
              // The labels are the fixed part of the row: the multiplier field
              // gives way before either of them is clipped.
              flexShrink: 0,
            }}
          >
            {(['multiplier', 'curve'] as SchedulerKind[]).map((kind) => {
              const selected = value.kind === kind;
              return (
                <button
                  key={kind}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  tabIndex={-1}
                  onClick={() => {
                    setKind(kind);
                    containerRef.current?.focus();
                  }}
                  className="px-2 py-1 text-xs font-semibold"
                  style={{
                    border: 'none',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    backgroundColor: selected ? '#3B82F6' : 'transparent',
                    color: selected ? 'white' : 'var(--rn-clr-content-primary)',
                    opacity: selected ? 1 : 0.7,
                  }}
                >
                  {KIND_LABELS[kind]}
                </button>
              );
            })}
          </div>
          {value.kind === 'multiplier' && (
            <input
              ref={factorInputRef}
              type="number"
              min={MIN_FACTOR}
              max={MAX_FACTOR}
              step={0.1}
              tabIndex={-1}
              value={value.factor}
              title="Multiplier for this Rem: next interval = current interval × this value"
              onChange={(e) => onChange({ ...value, factor: e.target.value })}
              onBlur={() => {
                const normalized = normalizeFactor(value.factor) ?? inherited.factor;
                if (String(normalized) !== value.factor) {
                  onChange({ ...value, factor: String(normalized) });
                }
              }}
              className="text-sm font-bold tabular-nums px-1 py-1 rounded border outline-none"
              style={{
                width: '46px',
                minWidth: 0,
                flexShrink: 1,
                textAlign: 'center',
                backgroundColor: 'var(--rn-clr-background-secondary)',
                color: 'var(--rn-clr-content-primary)',
                borderColor: 'var(--rn-clr-border-primary, rgba(128,128,128,0.35))',
              }}
            />
          )}
        </div>
        {hint && <span className="text-xs opacity-60 italic">{hint}</span>}
        <span className="text-[10px] opacity-50 italic">
          {differsFromSettings
            ? `Set for this Rem — the settings give ${inheritedText}`
            : `Same as ${SOURCE_LABELS[inherited.source]}`}
        </span>
      </div>
    );
  }
);

/** The scheduler a picker value stands for; an unusable multiplier falls back to the inherited one. */
export function pickerValueToChoice(value: SchedulerPickerValue, inherited: ResolvedScheduler) {
  return {
    kind: value.kind,
    factor: normalizeFactor(value.factor) ?? inherited.factor,
  };
}

/** The line shown under the picker for an interval of `days` on the chosen scheduler. */
export function schedulerHint(
  value: SchedulerPickerValue,
  inherited: ResolvedScheduler,
  days: number,
  preview: (interval: number, factor: number) => number[]
): string {
  if (value.kind === 'curve') {
    return 'This interval is a one-off: the next ones depend only on the number of reviews.';
  }
  if (isNaN(days)) return '';
  const factor = normalizeFactor(value.factor) ?? inherited.factor;
  if (factor === 1) return `Stays at ${Math.max(1, days)} days after each review.`;
  return `After that: ${preview(days, factor).join(' → ')} days.`;
}
