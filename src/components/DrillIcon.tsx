import React from 'react';

/**
 * The Mastery Drill's icon: a bullseye wrapped in a return arrow — aim at the cards
 * you missed, and come back round until they hit. Lucide-style 24px grid and 2px
 * stroke, in `currentColor`, so it sits at the weight of RemNote's own icons and
 * follows the theme. `accent` colours the centre dot; it defaults to the stroke
 * colour for monochrome places such as the hub's icon row.
 */
export function DrillIcon({
  size = 16,
  accent = 'currentColor',
  strokeWidth = 2,
}: {
  size?: number;
  accent?: string;
  /** In the 24-unit grid; the hub passes its own to match its row's rendered weight. */
  strokeWidth?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0, display: 'block' }}
    >
      <path d="M20.5 12a8.5 8.5 0 1 1-2.5-6" />
      <path d="M20.5 3.5V7h-3.5" />
      <circle cx="12" cy="12" r="4.2" />
      <circle cx="12" cy="12" r="1.4" fill={accent} stroke={accent} />
    </svg>
  );
}
