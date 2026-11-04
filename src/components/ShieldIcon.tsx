import React from 'react';

/**
 * The two shield marks, drawn on a 16-unit grid so they stay sharp at 12–16px.
 *
 * - priority: the Priority Shield (IncRems + cards) — a shield with a ring
 *   around it, protection over the whole knowledge base.
 * - card: the Card Shield (flashcards only) — a stack of two flashcards inside
 *   the shield.
 *
 * Single-colour (currentColor), so a caller can tint or animate them like text.
 */
export type ShieldIconKind = 'priority' | 'card';

export const SHIELD_ICON_COLOR: Record<ShieldIconKind, string> = {
  priority: '#3b8fb5',
  card: '#c8902f',
};

const SHIELD = 'M8 1.25 L13.75 3.4 V7.6 C13.75 11.1 11.3 13.6 8 14.75 C4.7 13.6 2.25 11.1 2.25 7.6 V3.4 Z';
const SHIELD_SMALL = 'M8 2.2 L12.1 3.75 V7.4 C12.1 10.25 10.35 12.35 8 13.35 C5.65 12.35 3.9 10.25 3.9 7.4 V3.75 Z';

// React 17 has no useId: one id per mounted icon keeps masks from colliding.
let nextId = 0;

export function ShieldIcon({
  kind,
  size = 15,
  color,
  style,
  title,
}: {
  kind: ShieldIconKind;
  size?: number;
  color?: string;
  style?: React.CSSProperties;
  title?: string;
}) {
  const id = React.useMemo(() => `ie-shield-${nextId++}`, []);
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      strokeLinejoin="round"
      strokeLinecap="round"
      role="img"
      aria-label={title ?? (kind === 'priority' ? 'Priority Shield' : 'Card Shield')}
      style={{ display: 'inline-block', flex: 'none', overflow: 'visible', color: color ?? SHIELD_ICON_COLOR[kind], ...style }}
    >
      {title && <title>{title}</title>}
      {kind === 'priority' ? (
        <>
          <defs>
            <mask id={id} maskUnits="userSpaceOnUse" x="-2" y="-2" width="20" height="20">
              <rect x="-2" y="-2" width="20" height="20" fill="#fff" />
              <path d={SHIELD_SMALL} fill="#000" stroke="#000" strokeWidth={2.6} />
            </mask>
          </defs>
          <ellipse cx="8" cy="8.2" rx="7.3" ry="2.45" transform="rotate(-18 8 8.2)" stroke="currentColor" strokeWidth={1.1} mask={`url(#${id})`} />
          <path d={SHIELD_SMALL} fill="currentColor" fillOpacity={0.2} stroke="currentColor" strokeWidth={1.35} />
          <path d="M1.06 10.46 A7.3 2.45 -18 0 0 14.94 5.94" stroke="currentColor" strokeWidth={1.1} />
        </>
      ) : (
        <>
          {/* The front card hides what lies behind it: the shield's tint and the back card. */}
          <defs>
            <mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">
              <rect width="16" height="16" fill="#fff" />
              <rect x="4.7" y="5.9" width="5.4" height="4.2" rx="0.7" fill="#000" stroke="#000" strokeWidth={1.1} />
            </mask>
          </defs>
          <path d={SHIELD} fill="currentColor" fillOpacity={0.16} mask={`url(#${id})`} />
          <path d={SHIELD} stroke="currentColor" strokeWidth={1.35} />
          <rect x="5.9" y="4.1" width="5.4" height="4.2" rx="0.7" stroke="currentColor" strokeWidth={1} mask={`url(#${id})`} />
          <rect x="4.7" y="5.9" width="5.4" height="4.2" rx="0.7" stroke="currentColor" strokeWidth={1.1} />
        </>
      )}
    </svg>
  );
}
