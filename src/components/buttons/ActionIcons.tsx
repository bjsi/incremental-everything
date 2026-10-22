import React from 'react';

/**
 * Small stroke icons for the queue's answer buttons. They take `currentColor`,
 * so each one follows its button's text colour (red on Dismiss, secondary grey
 * elsewhere) in both themes. Paths adapted from Lucide (ISC licence).
 */
function StrokeIcon({ size = 14, children }: { size?: number; children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', flexShrink: 0 }}
    >
      {children}
    </svg>
  );
}

export const RescheduleIcon = ({ size }: { size?: number }) => (
  <StrokeIcon size={size}>
    <path d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5" />
    <path d="M16 2v4" />
    <path d="M8 2v4" />
    <path d="M3 10h5" />
    <circle cx="17.5" cy="17.5" r="4.5" />
    <path d="M17.5 15.5v2l1.5 1" />
  </StrokeIcon>
);

export const DismissIcon = ({ size }: { size?: number }) => (
  <StrokeIcon size={size}>
    <circle cx="12" cy="12" r="10" />
    <path d="m15 9-6 6" />
    <path d="m9 9 6 6" />
  </StrokeIcon>
);

export const PriorityIcon = ({ size }: { size?: number }) => (
  <StrokeIcon size={size}>
    <path d="m21 16-4 4-4-4" />
    <path d="M17 20V4" />
    <path d="m3 8 4-4 4 4" />
    <path d="M7 4v16" />
  </StrokeIcon>
);

export const ReviewInEditorIcon = ({ size }: { size?: number }) => (
  <StrokeIcon size={size}>
    <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
  </StrokeIcon>
);

export const NewTabIcon = ({ size }: { size?: number }) => (
  <StrokeIcon size={size}>
    <path d="M15 3h6v6" />
    <path d="M10 14 21 3" />
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  </StrokeIcon>
);

/** Crosshair: "go to where it is", not "make one". */
export const LocateIcon = ({ size }: { size?: number }) => (
  <StrokeIcon size={size}>
    <line x1="2" x2="5" y1="12" y2="12" />
    <line x1="19" x2="22" y1="12" y2="12" />
    <line x1="12" x2="12" y1="2" y2="5" />
    <line x1="12" x2="12" y1="19" y2="22" />
    <circle cx="12" cy="12" r="7" />
    <circle cx="12" cy="12" r="3" />
  </StrokeIcon>
);

export const BookmarkIcon = ({ size }: { size?: number }) => (
  <StrokeIcon size={size}>
    <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" />
  </StrokeIcon>
);
