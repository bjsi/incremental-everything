import React from 'react';
import { HeadingLevel } from '../lib/outline_restructure';

// Shared heading-level palette + badge, used by both the Outline Restructure
// preview and the Heading Levels (ToC) preview so the H1–H6 colors stay in
// sync across widgets. `null` renders the paragraph marker (¶).
export const HEADING_COLORS: Record<number, string> = {
  1: '#1e3a8a', // blue-900
  2: '#1d4ed8', // blue-700
  3: '#0369a1', // sky-700
  4: '#0d9488', // teal-600
  5: '#65a30d', // lime-600
  6: '#a16207', // yellow-700
};

export function HeadingBadge({ level }: { level: HeadingLevel | null }) {
  if (level === null) {
    return (
      <span
        style={{
          display: 'inline-block',
          minWidth: 22,
          textAlign: 'center',
          color: 'var(--rn-clr-content-tertiary)',
          fontSize: 10,
          fontFamily: 'monospace',
        }}
      >
        ¶
      </span>
    );
  }
  return (
    <span
      style={{
        display: 'inline-block',
        minWidth: 22,
        textAlign: 'center',
        background: HEADING_COLORS[level],
        color: 'white',
        fontSize: 10,
        fontWeight: 700,
        padding: '1px 4px',
        borderRadius: 3,
        fontFamily: 'monospace',
      }}
    >
      H{level}
    </span>
  );
}
