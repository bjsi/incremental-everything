// widgets/mc_assertions.tsx
//
// The True/False answer sheet of a multiple-choice question that numbers its
// statements (I., II., III.): one column with a box per statement. A click
// cycles the box empty → T (green) → F (red) → empty, so the user can judge
// each sentence on screen before matching the verdicts to an option.
//
// Opened by lib/mc_scissors.ts, which writes the numerals first and pins the
// column beside the question with CSS anchor positioning. Nothing is saved: the
// marks are session state and are cleared when the card changes.

import { renderWidget, usePlugin, useTrackerPlugin } from '@remnote/plugin-sdk';
import React, { useEffect } from 'react';
import '../rn_theme_vars.css';
import {
  mcAssertionLabelsKey,
  mcAssertionMarksKey,
  mcSheetBottomEdge as SHEET_BOTTOM_EDGE,
  mcSheetTopEdge as SHEET_TOP_EDGE,
} from '../lib/consts';

type Mark = '' | 'T' | 'F';
const NEXT: Record<Mark, Mark> = { '': 'T', T: 'F', F: '' };
const FILL: Record<Exclude<Mark, ''>, string> = { T: '#16a34a', F: '#dc2626' };
const SPOKEN: Record<Mark, string> = { '': 'not judged', T: 'true', F: 'false' };
// The first box's centre sits this share of the column below its top, the last
// one's this share above its bottom; the others are spread evenly between them.
// Both values live in consts.ts, shared with lib/mc_scissors.ts, which sizes the column.

/** A row's centre as a share of the column's height. */
const rowCentre = (i: number, count: number) =>
  count < 2 ? 0.5 : SHEET_TOP_EDGE + (i * (1 - SHEET_TOP_EDGE - SHEET_BOTTOM_EDGE)) / (count - 1);

function McAssertions() {
  const plugin = usePlugin();

  useEffect(() => {
    // The iframe is sized to the column; the default 8px body margin would push it out.
    document.body.style.margin = '0';
    document.body.style.background = 'transparent';
  }, []);

  const labels = useTrackerPlugin((rp) => rp.storage.getSession<string[]>(mcAssertionLabelsKey), []) ?? [];
  const marks = useTrackerPlugin((rp) => rp.storage.getSession<Mark[]>(mcAssertionMarksKey), []) ?? [];

  const cycle = async (index: number) => {
    const current = (await plugin.storage.getSession<Mark[]>(mcAssertionMarksKey)) ?? [];
    const next = labels.map((_, i) => current[i] ?? '');
    next[index] = NEXT[next[index]];
    await plugin.storage.setSession(mcAssertionMarksKey, next);
  };

  return (
    // The host CSS makes the frame as tall as the question (see sheetCss in
    // lib/mc_scissors.ts); each row is placed by its share of that height.
    <div style={{ position: 'relative', height: '100vh', overflow: 'hidden' }}>
      {labels.map((label, i) => {
        const mark = marks[i] ?? '';
        return (
          <div
            key={label}
            style={{
              position: 'absolute',
              right: 0,
              top: `${rowCentre(i, labels.length) * 100}%`,
              transform: 'translateY(-50%)',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--rn-clr-content-tertiary, #9ca3af)',
                minWidth: 24,
                textAlign: 'right',
                userSelect: 'none',
              }}
            >
              {label}
            </span>
            <button
              onClick={() => cycle(i)}
              aria-label={`Statement ${label}: ${SPOKEN[mark]}. Click to change.`}
              style={{
                width: 26,
                height: 26,
                padding: 0,
                borderRadius: 5,
                border: mark ? 'none' : '1.5px solid var(--rn-clr-content-tertiary, #9ca3af)',
                background: mark ? FILL[mark] : 'transparent',
                color: '#fff',
                fontSize: 14,
                fontWeight: 700,
                lineHeight: '26px',
                cursor: 'pointer',
                boxSizing: 'border-box',
              }}
            >
              {mark}
            </button>
          </div>
        );
      })}
    </div>
  );
}

renderWidget(McAssertions);
