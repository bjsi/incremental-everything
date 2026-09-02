import React from 'react';

/**
 * A solid bookmark ribbon, drawn inline.
 *
 * The 🔖 emoji is unusable as a status marker: macOS renders it from the colour
 * emoji font, so `color` is ignored and it comes out the same pale tag shape as
 * the PDF chip's own 🔖 — two different bookmarks that look identical at 10px.
 * An inline SVG takes `currentColor`, so a read point can be tinted (green,
 * like the other "saved position" markers) and read as its own thing.
 */
export function ReadPointIcon({
  size = 11,
  color = 'currentColor',
  style,
}: {
  size?: number;
  color?: string;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={color}
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', flexShrink: 0, ...style }}
    >
      <path d="M6 2h12a1 1 0 0 1 1 1v19l-7-5-7 5V3a1 1 0 0 1 1-1z" />
    </svg>
  );
}
