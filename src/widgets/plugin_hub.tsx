import { renderWidget, usePlugin, useTrackerPlugin } from '@remnote/plugin-sdk';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import '../style.css';
import '../App.css';
import { IE_DOCS_BASE_URL } from '../lib/settings';
import { safeRemTextToString } from '../lib/pdfUtils';
// Static on purpose: a dynamic import here produced a split chunk that the
// plugin sandbox cannot fetch (ChunkLoadError on the dayjs vendor chunk).
import {
  findPriorityQueueDoc,
  isQueueOpen,
  practicePriorityQueue,
  refreshPriorityQueue,
} from '../lib/priority_review_document/queue_doc';
import {
  onboardingTipsWidgetId,
  pluginHubCollapsedKey,
  pluginHubHiddenKey,
  startupTasksStatusKey,
} from '../lib/consts';
import { getMasteryDrillStatus, masteryDrillIsReady } from '../lib/mastery_drill_status';
import {
  StartupTasksStatus,
  describeStartupTasks,
  startupTasksSucceeded,
} from '../lib/startup_status';
import {
  OnboardingTip,
  acknowledgeTip,
  ONBOARDING_TIPS,
  backfillLocalMirror,
  getAcknowledgedTipIds,
  getDrawnTipIdThisSession,
  getLastShownMap,
  pauseTipsAfterAnswer,
  pickTip,
  recordTipShown,
  setDrawnTipIdThisSession,
  tipAnsweredThisSession,
  tipsAreSnoozed,
} from '../lib/onboarding_tips';
import { openMasteryDrill as launchMasteryDrill } from '../lib/mastery_drill_launch';

/**
 * The "Incremental RemNote" sidebar hub.
 *
 * The plugin's surface is spread across a slash-command list, a settings popup,
 * two document menus and a dozen shortcuts, none of which announce themselves.
 * This panel is the one fixed place that does: five things a new user needs
 * within reach, and one tip per session from the onboarding pile.
 *
 * It sits in `SidebarEnd` next to the Mastery Drill notification, and is not
 * gated behind a setting — it is the entry point, so it has to be there before
 * the user knows there are settings to find.
 *
 * Everything here is sized for a *narrow* column. RemNote already pads the
 * sidebar slot, the sidebar itself can be dragged down to roughly 130px of
 * usable width, and this panel competes with the user's actual documents for
 * it. Hence the short labels, the 11px type, and tip bodies held to one line of
 * prose: anything longer wraps to five lines and the panel starts to look like
 * it is squatting.
 */

/**
 * `window.open` is blocked in some embedded contexts, so fall back to a
 * synthesised anchor click. Same helper shape as the IE Settings popup.
 */
const openDocs = (path: string) => {
  const url = `${IE_DOCS_BASE_URL}${path}`;
  const opened = window.open(url, '_blank');
  if (!opened || opened.closed) {
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    setTimeout(() => document.body.removeChild(link), 100);
  }
};

/**
 * The ▶ cell's "the plugin is ready" breathing, shared by both layouts — the
 * collapsed row runs the same animation on its own ▶, so it lives at module
 * scope rather than inside the expanded panel's JSX.
 */
const HUB_KEYFRAMES = `
  @keyframes hubPlayPulse {
    0%, 100% { transform: scale(1); filter: drop-shadow(0 0 0px rgba(255, 255, 255, 0)); }
    50% { transform: scale(1.15); filter: drop-shadow(0 0 3px rgba(255, 255, 255, 0.9)); }
  }
  @keyframes hubPlayCellGlow {
    0%, 100% { box-shadow: inset 0 0 0px rgba(191, 219, 254, 0); filter: brightness(1); }
    50% { box-shadow: inset 0 0 6px rgba(191, 219, 254, 0.9); filter: brightness(1.15); }
  }
`;

const containerStyle: React.CSSProperties = {
  backgroundColor: 'var(--rn-clr-background-elevation-10)',
  border: '1px solid var(--rn-clr-border-subtle)',
  color: 'var(--rn-clr-content-primary)',
  boxShadow: 'var(--rn-box-shadow-1)',
};

const iconButtonStyle: React.CSSProperties = {
  width: 18,
  height: 18,
  borderRadius: 5,
  border: '1px solid var(--rn-clr-border-primary, #cbd5e1)',
  background: 'transparent',
  color: 'var(--rn-clr-content-secondary, #64748b)',
  fontSize: 11,
  lineHeight: '16px',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flex: '0 0 auto',
  padding: 0,
};

const actionButtonStyle: React.CSSProperties = {
  padding: '2px 5px',
  borderRadius: 5,
  border: '1px solid var(--rn-clr-border-primary, #cbd5e1)',
  background: 'transparent',
  color: 'var(--rn-clr-content-secondary, #64748b)',
  fontSize: 11,
  lineHeight: '16px',
  fontWeight: 500,
  cursor: 'pointer',
  textAlign: 'center',
  whiteSpace: 'nowrap',
};

/**
 * The Priority Review trio is one segmented control rather than three buttons:
 * the sidebar can be dragged to ~130px of usable width, and three separate
 * bordered buttons would spend ~10px of that on borders and gaps that say
 * nothing. Collapsing them into a single outline also says the right thing —
 * create, browse and clean are three doors onto the same feature.
 */
const segmentedGroupStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'stretch',
  flex: '1 1 auto',
  minWidth: 0,
  height: 22,
  borderRadius: 5,
  border: '1px solid var(--rn-clr-border-primary, #cbd5e1)',
  overflow: 'hidden',
};

/** A cell inside the group: no outline of its own, just a divider on its left. */
const segmentStyle: React.CSSProperties = {
  background: 'transparent',
  color: 'var(--rn-clr-content-secondary, #64748b)',
  fontSize: 11,
  lineHeight: '16px',
  fontWeight: 500,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  border: 'none',
};

/** The icon cells are fixed; only the label cell gives ground as the panel narrows. */
const segmentIconStyle: React.CSSProperties = {
  ...segmentStyle,
  width: 22,
  flex: '0 0 auto',
  fontSize: 12,
  borderLeft: '1px solid var(--rn-clr-border-primary, #cbd5e1)',
};

/**
 * The panel's title, as two words that are dropped whole rather than cut.
 *
 * A plain `truncate` on "Incremental RemNote" produces "Incremental Re…" in a
 * narrow sidebar, which reads as a different plugin's name. Losing the second
 * word entirely is the honest fallback: "Incremental" is still this plugin.
 *
 * CSS cannot express "hide the last word if it does not fit" — `overflow` cuts
 * mid-glyph and `text-overflow` only adds the ellipsis — so the width is
 * measured and the text chosen.
 *
 * Both halves of that measurement have a trap in them:
 *
 * - **The box must not be sized by its own text**, or the question answers
 *   itself: a box holding "Incremental" is only as wide as "Incremental", so
 *   the full name would never look like it fits again and the second word could
 *   never come back. It therefore *fills* the row (`flex: 1 1 auto` here and on
 *   the wrapper), which makes its width the space available and nothing else.
 * - **The comparison must be sub-pixel.** `clientWidth` and `scrollWidth` are
 *   rounded to integers, and `text-overflow` fires on an overflow of any size:
 *   a box 0.02px narrower than its text reports 70 against 70 and still paints
 *   "Incremen…", dropping three characters to make room for the ellipsis. The
 *   natural width comes from an out-of-flow probe and both sides are read as
 *   fractions, with a quarter-pixel of margin so a hairline fit renders the
 *   short form rather than an ellipsised long one.
 */
function PanelTitle() {
  const boxRef = useRef<HTMLSpanElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const [showFull, setShowFull] = useState(true);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const probe = probeRef.current;
    if (!box || !probe) return;

    const measure = () =>
      setShowFull(
        probe.getBoundingClientRect().width <= box.getBoundingClientRect().width - 0.25
      );
    measure();

    // The box for the space available, the probe for the text's natural width —
    // which changes when a web font finishes loading, and would otherwise leave
    // the first measurement standing on the fallback font's metrics.
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(probe);
    return () => observer.disconnect();
  }, []);

  return (
    <span
      ref={boxRef}
      className="truncate"
      style={{ flex: '1 1 auto', minWidth: 0, position: 'relative', fontSize: 12.5, fontWeight: 600 }}
      title="Incremental RemNote"
    >
      {showFull ? 'Incremental RemNote' : 'Incremental'}
      <span
        ref={probeRef}
        aria-hidden
        // `width: max-content` matters: an absolutely positioned box with `auto`
        // width shrinks to fit its containing block, which is the very box being
        // measured — it would report the space available, not the text's width.
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: 'max-content',
          visibility: 'hidden',
          pointerEvents: 'none',
          whiteSpace: 'pre',
        }}
      >
        Incremental RemNote
      </span>
    </span>
  );
}

/**
 * The ▶ tooltip, shared by both layouts.
 *
 * A modifier that changes what a button does has to be discoverable from the
 * button, and naming the scope is the discoverable part: "the current scope"
 * means nothing until you know it currently resolves to "Anatomy" — the scope
 * follows the focused Rem, so it moves under the user between clicks.
 */
function learnLabel(scopeName: string | null | undefined): string {
  const scoped = scopeName
    ? `Shift/Cmd-click: the Priority Queue for “${scopeName}” instead`
    : 'Shift/Cmd-click: the Priority Queue for the focused document instead';
  return (
    'Learn (Cmd/Ctrl+L) — practise the Priority Queue for the whole knowledge base; ' +
    'builds it first if there is none yet\n' +
    scoped
  );
}

/**
 * The collapsed row's icons, as inline stroke SVGs in `currentColor`.
 *
 * Emoji were the first pass and they were the wrong material here. ⚙ and 👁
 * render as full-colour emoji on macOS and as flat glyphs on Windows, so the
 * row looked like a different control set per platform, and none of them sit at
 * the same optical weight as RemNote's own Tutorials/Settings icons directly
 * below — which is the company this row keeps. Stroked paths in `currentColor`
 * inherit the cell's colour, so they follow the theme into dark mode for free,
 * cost no asset fetch (the drill's old remote PNG cost one per render), and
 * come out at a single consistent weight.
 *
 * Feather/Lucide geometry (MIT), 24px grid, so they line up with the native
 * icons rather than merely sitting near them.
 */
interface IconProps {
  /** Rendered box, in px. 18 in the collapsed row, 13–14 in the expanded panel. */
  size?: number;
}

/**
 * SVG attributes for one icon at a given size, with the stroke expressed as the
 * weight it should END UP at on screen rather than as a number on the 24px
 * grid.
 *
 * The same icon appears at 18px in the collapsed row and at 13px in the
 * expanded panel's header. A fixed `strokeWidth` would render the small copy
 * at 0.72 of the large one's weight, so the two would not read as the same icon
 * — the expanded set would look faded next to a row the user had just been
 * looking at. Scaling the grid value by `24 / size` holds the painted line at
 * `strokePx` whatever the box is.
 */
function iconAttrs(size: number, strokePx = 1.3): React.SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: (strokePx * 24) / size,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  };
}

/**
 * The plugin's own mark, drawn as line art: a desk globe on a stand.
 *
 * A bare wireframe sphere (Feather's globe, which this replaces) is the icon
 * every app uses for "language" or "web", and it shares nothing with
 * `public/logo.png` but the ball. What makes that logo recognisable at a glance
 * is the *silhouette* around it — the meridian ring standing off to the right,
 * the pedestal and the foot — so the row identifies itself as this plugin's
 * rather than as a generic globe button.
 *
 * Two measurements do the work at 18px:
 *
 * - **The ring stands 3 units clear of the sphere** (r6 against r9). A wider
 *   sphere looks better on its own, but the two strokes are ~0.6px each once
 *   scaled down, so a narrower gap closes up and the pair renders as one thick
 *   smudged circle.
 * - **The stroke is 1.5, not the row's 1.75.** Six paths in the space the other
 *   icons spend on three; at the shared weight they thicken into a blob.
 */
const GlobeIcon = ({ size = 18 }: IconProps) => (
  <svg {...iconAttrs(size, 1.125)} aria-hidden>
    {/* sphere, with a meridian and the equator so it reads as a globe */}
    <circle cx="10.5" cy="10.5" r="6" />
    <ellipse cx="10.5" cy="10.5" rx="2.5" ry="6" />
    <line x1="4.5" y1="10.5" x2="16.5" y2="10.5" />
    {/* the mounting ring, open to the left exactly as the logo's is */}
    <path d="M10.5 1.5a9 9 0 0 1 0 18" />
    {/* pedestal and foot */}
    <path d="M10.5 19.5v2.2" />
    <path d="M7 21.7h7" />
  </svg>
);

const TargetIcon = ({ size = 18 }: IconProps) => (
  <svg {...iconAttrs(size)} aria-hidden>
    <circle cx="12" cy="12" r="10" />
    <circle cx="12" cy="12" r="6" />
    <circle cx="12" cy="12" r="2" />
  </svg>
);

const KeyboardIcon = ({ size = 18 }: IconProps) => (
  <svg {...iconAttrs(size)} aria-hidden>
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10" />
  </svg>
);

const GearIcon = ({ size = 18 }: IconProps) => (
  <svg {...iconAttrs(size)} aria-hidden>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

const EyeIcon = ({ size = 18 }: IconProps) => (
  <svg {...iconAttrs(size)} aria-hidden>
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

/**
 * Filled rather than stroked, and the one cell that is not grey.
 *
 * The expanded panel makes ▶ its single filled cell because it is the daily
 * driver, and dropping that distinction on collapse would hand the row six
 * equal-looking buttons with no answer to "which one do I press?". Colour is a
 * lighter way to say it than the expanded panel's filled blue box — it keeps
 * the flat, unboxed look the rest of the row has while still being the thing
 * your eye lands on.
 */
const PlayIcon = ({ size = 18 }: IconProps) => (
  <svg {...iconAttrs(size, 0.94)} fill="currentColor" aria-hidden>
    <polygon points="6 3 20 12 6 21 6 3" />
  </svg>
);

/**
 * Scoped styling for the collapsed row.
 *
 * The hover background is a rule rather than the `hover:opacity-60` the
 * expanded panel's small bordered buttons use: at 28px with no border, fading
 * an icon reads as it being disabled, while a filled rounded square reads as a
 * target — and matches how the native sidebar rows right below respond.
 *
 * The ▶ animation is compact-only and deliberately NOT the expanded panel's
 * `hubPlayCellGlow`: that one glows the segmented control's filled box from the
 * inside, which needs a box. Here the pulse lives in the arrow itself — scale
 * plus a blue drop-shadow, so the glow comes off the glyph's own silhouette.
 * (The expanded keyframes' white shadow would be invisible on this one; it is
 * tuned for a white arrow on blue.)
 */
const COMPACT_ROW_CSS = `
  .ie-hub-cell {
    background: transparent;
  }
  .ie-hub-cell:hover {
    background: var(--rn-clr-background--hovered, rgba(100, 116, 139, 0.14));
  }
  @keyframes ieHubArrowPulse {
    0%, 100% { transform: scale(1); filter: drop-shadow(0 0 0 rgba(59, 130, 246, 0)); }
    50% { transform: scale(1.18); filter: drop-shadow(0 0 3.5px rgba(59, 130, 246, 0.85)); }
  }
`;

/**
 * One cell of the collapsed row.
 *
 * Deliberately *not* {@link IconButton}: that one is bordered, because in the
 * expanded panel it sits against a card background and needs an edge to read as
 * a control. The collapsed row has no card — the icons sit straight on the
 * sidebar, next to RemNote's own Tutorials/Settings rows — so a border on each
 * would draw six boxes where the native chrome above and below draws none.
 *
 * The cells FLEX (`1 1 0`) rather than sitting at a fixed width: spread evenly
 * across whatever the sidebar currently is, they read as one row of the
 * sidebar's own chrome instead of a huddle of buttons pushed against its left
 * edge. The cap stops six icons from drifting apart into unrelated dots on a
 * wide sidebar; the floor is what makes the row wrap instead of crushing them.
 */
const compactCellStyle: React.CSSProperties = {
  height: 28,
  flex: '1 1 0',
  minWidth: 28,
  maxWidth: 44,
  padding: 0,
  borderRadius: 6,
  border: '1px solid transparent',
  // NOTE: no `background` here, and it must stay that way. An inline style beats
  // any stylesheet rule that is not `!important`, so setting the resting
  // background here silently killed `.ie-hub-cell:hover` — the rule matched and
  // lost on every hover, and the row had no hover feedback at all. Both states
  // live in COMPACT_ROW_CSS instead.
  color: 'var(--rn-clr-content-secondary, #64748b)',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'background 120ms ease',
};

function CompactCell(props: {
  label: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <button
      onClick={props.onClick}
      title={props.label}
      aria-label={props.label}
      className="ie-hub-cell"
      style={{ ...compactCellStyle, ...props.style }}
    >
      {props.children}
    </button>
  );
}

/**
 * Wraps an icon so a badge or a dot can hang off its corner.
 *
 * The marker anchors to the *icon*, not to the cell: the cells flex, so a
 * cell-anchored badge would drift further from the glyph the wider the sidebar
 * got and end up floating in the gap between two icons.
 */
function IconWithMarker(props: { children: React.ReactNode; marker: React.ReactNode }) {
  return (
    <span style={{ position: 'relative', display: 'inline-flex', lineHeight: 0 }}>
      {props.children}
      {props.marker}
    </span>
  );
}

/**
 * The hub, collapsed to a single row of icons.
 *
 * This is a *collapse*, not a second panel with its own feature set: everything
 * the expanded panel offers is one click away behind the globe, which is why
 * the row can get away with six cells and no labels. Sorting, the scope line
 * and the tip card have no icon here on purpose — inventing one for each would
 * put eight to ten cells in a column that can be dragged to about 130px, and
 * the row would wrap into the stack of rows this mode exists to avoid.
 *
 * What does *not* get to disappear silently is an unanswered tip: the panel is
 * the plugin's only teaching surface, so a collapsed hub with a tip waiting
 * marks the globe with a dot. Collapsing pauses the tips; it does not cancel
 * them.
 *
 * It wraps (`flex-wrap`) rather than overflowing: six cells need roughly 190px
 * at their floor and the sidebar goes narrower than that, so at the extreme it
 * becomes two short rows — still a fraction of the expanded panel.
 */
function CompactRow(props: {
  hasWaitingTip: boolean;
  drillCount: number | null;
  startupFinished: boolean;
  scopeName: string | null | undefined;
  onExpand: () => void;
  onDrill: () => void;
  onShortcuts: () => void;
  onSettings: () => void;
  onQueueRem: () => void;
  onLearn: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-0.5 px-1 py-1.5 mb-1">
      <style>{COMPACT_ROW_CSS}</style>

      <CompactCell
        label={
          props.hasWaitingTip
            ? 'Incremental RemNote — expand the panel (a tip is waiting)'
            : 'Incremental RemNote — expand the panel'
        }
        onClick={props.onExpand}
      >
        <IconWithMarker
          marker={
            props.hasWaitingTip ? (
              <span
                aria-hidden
                style={{
                  position: 'absolute',
                  top: -1,
                  right: -1,
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  background: '#3b82f6',
                  boxShadow: '0 0 0 2px var(--rn-clr-background-primary, #fff)',
                }}
              />
            ) : null
          }
        >
          <GlobeIcon />
        </IconWithMarker>
      </CompactCell>

      {/* The count is the whole point of the drill notification — an unlabelled
          target says "there is a drill" where the card said "49 cards waiting".
          A corner badge rather than a number beside the glyph: the cells are
          evenly spread, so a second element inside one would make that cell
          visibly wider than its neighbours and break the rhythm of the row. */}
      {props.drillCount !== null && (
        <CompactCell
          label={`Mastery Drill — ${props.drillCount} cards ready`}
          onClick={props.onDrill}
        >
          <IconWithMarker
            marker={
              <span
                style={{
                  position: 'absolute',
                  top: -4,
                  right: -7,
                  // Sized down from 14/9px after seeing it on screen: a
                  // two-digit count at that size spanned most of an 18px icon
                  // and the target read as a crescent. A badge is allowed to
                  // clip its icon's corner; it is not allowed to become the
                  // icon.
                  minWidth: 12,
                  height: 12,
                  padding: '0 2.5px',
                  borderRadius: 6,
                  background: '#ef4444',
                  color: '#fff',
                  fontSize: 8,
                  fontWeight: 700,
                  lineHeight: '12px',
                  textAlign: 'center',
                  boxShadow: '0 0 0 1.5px var(--rn-clr-background-primary, #fff)',
                }}
              >
                {props.drillCount > 99 ? '99+' : props.drillCount}
              </span>
            }
          >
            <TargetIcon />
          </IconWithMarker>
        </CompactCell>
      )}

      <CompactCell label="Keyboard shortcuts" onClick={props.onShortcuts}>
        <KeyboardIcon />
      </CompactCell>
      <CompactCell label="Open the plugin's settings" onClick={props.onSettings}>
        <GearIcon />
      </CompactCell>
      <CompactCell
        label="Open the “Priority Review Queue” Rem — every Priority Review Document you have made"
        onClick={props.onQueueRem}
      >
        <EyeIcon />
      </CompactCell>
      {/* The collapsed row has no "Priority Queue" cell and no Scope line, so
          the scoped queue would be unreachable here — hence the modifier, and
          hence the scope being named in the tooltip: it is the only place the
          row can say what Shift-click is about to act on. */}
      <CompactCell
        label={learnLabel(props.scopeName)}
        onClick={props.onLearn}
        style={{ color: '#3b82f6' }}
      >
        <span
          style={{
            display: 'inline-flex',
            animation: props.startupFinished ? 'ieHubArrowPulse 2s ease-in-out infinite' : 'none',
          }}
        >
          <PlayIcon />
        </span>
      </CompactCell>
    </div>
  );
}

function IconButton(props: {
  label: string;
  /** A text glyph, or one of the SVG icons above sized for this 18px button. */
  glyph: React.ReactNode;
  onClick: () => void;
  style?: React.CSSProperties;
}) {
  return (
    <button
      onClick={props.onClick}
      title={props.label}
      aria-label={props.label}
      className="hover:opacity-75"
      style={{ ...iconButtonStyle, ...props.style }}
    >
      {props.glyph}
    </button>
  );
}

/**
 * One tip, with its three answers. `onGotIt` retires it permanently and
 * `onClose` returns it to the pile; either way the tip area is done for this
 * session. `Learn More` is only rendered when the tip names a docs section.
 *
 * `All Tips` is the way out of the one-per-session pacing — it opens the whole
 * pile, answered ones first. The button row WRAPS rather than shrinking: three
 * labels need ~185px and the sidebar can be dragged to about 130px, so without
 * wrapping the third button would either overflow the panel or squeeze the
 * other two down to an ellipsis.
 */
function TipCard(props: {
  tip: OnboardingTip;
  onGotIt: () => void;
  onClose: () => void;
  onShowAll: () => void;
}) {
  const { tip } = props;
  return (
    <div
      style={{
        border: '1px solid var(--rn-clr-border-subtle)',
        borderRadius: 6,
        padding: 6,
        background: 'var(--rn-clr-background-primary, transparent)',
      }}
      className="flex flex-col gap-1"
    >
      <div className="flex items-start justify-between gap-1">
        <span style={{ fontSize: 12, fontWeight: 600, lineHeight: '15px' }}>💡 {tip.title}</span>
        <button
          onClick={props.onClose}
          title="Not now — this tip can come back later"
          aria-label="Dismiss this tip for now"
          className="hover:opacity-75"
          style={{ color: 'var(--rn-clr-content-tertiary)', flex: '0 0 auto', lineHeight: '15px' }}
        >
          ✕
        </button>
      </div>

      <div
        style={{ fontSize: 11, lineHeight: '14px', color: 'var(--rn-clr-content-secondary)' }}
      >
        {tip.body}
      </div>

      <div className="flex gap-1 mt-0.5" style={{ flexWrap: 'wrap' }}>
        <button
          onClick={props.onGotIt}
          // The background must be inline: an inline `background` in the shared
          // style would otherwise beat any Tailwind colour class here.
          style={{
            ...actionButtonStyle,
            flex: '1 1 0',
            border: '1px solid transparent',
            background: '#3b82f6',
            color: '#fff',
          }}
          className="hover:opacity-90"
        >
          I Got It
        </button>
        {tip.docsPath && (
          <button
            onClick={() => openDocs(tip.docsPath!)}
            style={{ ...actionButtonStyle, flex: '1 1 0' }}
            className="hover:opacity-75"
          >
            Learn More
          </button>
        )}
        <button
          onClick={props.onShowAll}
          style={{ ...actionButtonStyle, flex: '1 1 0' }}
          className="hover:opacity-75"
          title="See every tip — the ones you have acknowledged, with the date, and the ones still to come"
        >
          All Tips
        </button>
      </div>
    </div>
  );
}

export function PluginHub() {
  const plugin = usePlugin();

  /**
   * Collapsed to the icon row. **Local** storage, not session and not a
   * setting: how much room the panel may take is a question about this screen's
   * sidebar width, so it should survive a restart but not follow the user to
   * another device. There is no setting for it because the globe already is
   * one — a checkbox saying the same thing could only drift out of step with
   * whatever the user last clicked.
   */
  const collapsed = useTrackerPlugin(
    async (rp) => (await rp.storage.getLocal<boolean>(pluginHubCollapsedKey)) ?? false,
    []
  );

  const [tip, setTip] = useState<OnboardingTip | null>(null);
  /** null until the first load resolves, so the panel does not flash a tip in. */
  const [tipsReady, setTipsReady] = useState(false);

  // Drawn on mount rather than on a tracker: a tip that reshuffled every time
  // synced storage changed would move under the user's cursor.
  //
  // "Once per session" is enforced by the session flag, NOT by this effect
  // running once — RemNote remounts the SidebarEnd slot as the app is used, and
  // this effect runs again each time. Without the flag every remount re-drew,
  // which looks like variety while the pile is large and, once a category is
  // nearly exhausted, like the same handful of tips coming back after they were
  // answered.
  useEffect(() => {
    // The layout is not known yet on the first pass, and whether a tip may be
    // stamped depends on it.
    if (collapsed === undefined) return;
    let cancelled = false;
    (async () => {
      // Fire and forget: protecting the already-answered tips against a synced
      // wipe should never hold up painting the panel.
      backfillLocalMirror(plugin).catch(() => {
        /* best effort — the synced record is still authoritative */
      });

      if ((await tipAnsweredThisSession(plugin)) || (await tipsAreSnoozed(plugin))) {
        if (!cancelled) setTipsReady(true);
        return;
      }

      const acknowledged = await getAcknowledgedTipIds(plugin);
      if (cancelled) return;

      // A remount re-shows the tip this session already drew, rather than
      // rolling again: the session is entitled to one tip, and swapping it out
      // from under the user mid-session is the same complaint as repeating one.
      // It is re-checked against `acknowledged` because the All Tips popup can
      // retire it while the panel is up.
      const drawnId = await getDrawnTipIdThisSession(plugin);
      if (cancelled) return;
      const drawn = drawnId
        ? ONBOARDING_TIPS.find((t) => t.id === drawnId && !acknowledged.includes(t.id))
        : undefined;
      if (drawn) {
        setTip(drawn);
        setTipsReady(true);
        return;
      }

      const next = pickTip(acknowledged, await getLastShownMap(plugin));
      if (cancelled) return;
      setTip(next);
      setTipsReady(true);
      if (next && !collapsed) {
        // Stamped only on a fresh draw, so a remount cannot push a tip to the
        // back of the rotation the user never answered — and only once the tip
        // is actually on screen, which a collapsed hub's is not.
        await setDrawnTipIdThisSession(plugin, next.id);
        await recordTipShown(plugin, next.id);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `collapsed` is a dependency, not just a read: a collapsed hub draws a tip
    // so the globe can carry its dot, but does NOT stamp it as shown. Stamping
    // it would let the rotation advance past tips nobody was in a position to
    // read — days of collapsed sessions would pace the pile away silently. The
    // stamps are therefore owed on the transition to expanded, which is what
    // re-running this effect there pays.
  }, [plugin, collapsed]);

  /**
   * Whether the user has closed the whole panel. Session storage, not local:
   * ✕ means "not now, I need the room", so the panel is back on the next start
   * — the same contract as the Mastery Drill notification, which resets its own
   * dismissal on mount. The "Show Plugin Panel" command brings it back sooner.
   */
  const hidden = useTrackerPlugin(
    async (rp) => (await rp.storage.getSession<boolean>(pluginHubHiddenKey)) ?? false,
    []
  );

  /**
   * The drill's readiness, but only while collapsed — expanded, the Mastery
   * Drill notification is mounted below and answers this for itself, and two
   * widgets paying for the same synced read plus two KB lookups on every change
   * is a cost the sidebar does not need. Deliberately reads the flag inside the
   * tracker so it re-runs when the row appears.
   */
  const drillCount = useTrackerPlugin(async (rp) => {
    const isCollapsed = (await rp.storage.getLocal<boolean>(pluginHubCollapsedKey)) ?? false;
    if (!isCollapsed) return null;
    const status = await getMasteryDrillStatus(rp);
    return masteryDrillIsReady(status) ? status.readyCount : null;
  }, []);

  /**
   * The ▶ button only starts pulsing once the startup work has finished — the
   * caches, pre-tagging, the cooling scan, the hidden-slot check, the band
   * stylesheets and the Priority Queue refresh — so "is the plugin ready?" is answered here, not in the console.
   * It stays still if any of them failed; the tooltip says which.
   */
  const startupStatus = useTrackerPlugin(
    async (rp) => await rp.storage.getSession<StartupTasksStatus>(startupTasksStatusKey),
    []
  );
  const startupFinished = startupTasksSucceeded(startupStatus);

  // Retire the tip and stop there — one tip per session. Handing back the next
  // one on acknowledgement turns the panel into a quiz the user did not ask for,
  // and the pile is meant to be drained over weeks, not in one sitting.
  const handleGotIt = useCallback(async () => {
    const current = tip;
    if (!current) return;
    await acknowledgeTip(plugin, current.id);
    await pauseTipsAfterAnswer(plugin);
    setTip(null);
  }, [plugin, tip]);

  const handleCloseTip = useCallback(async () => {
    await pauseTipsAfterAnswer(plugin);
    setTip(null);
  }, [plugin]);

  /**
   * The tip card is gone once the tip is answered and while the panel is
   * snoozed, so "All Tips" would be unreachable for the rest of the session
   * exactly when the user has just been reminded that tips exist. It therefore
   * also has a standing link below, and both go through here.
   */
  const openAllTips = useCallback(
    () => plugin.widget.openPopup(onboardingTipsWidgetId),
    [plugin]
  );

  /**
   * The globe both ways. Reading the stored value here rather than closing over
   * the tracked one keeps the click honest if another pane's copy of the panel
   * toggled it a moment ago — the sidebar slot is remounted often enough that
   * two live copies are ordinary.
   */
  const toggleCollapsed = useCallback(async () => {
    const current = (await plugin.storage.getLocal<boolean>(pluginHubCollapsedKey)) ?? false;
    await plugin.storage.setLocal(pluginHubCollapsedKey, !current);
  }, [plugin]);

  const openMasteryDrill = useCallback(
    () => launchMasteryDrill(plugin),
    [plugin]
  );

  const handleHidePanel = useCallback(async () => {
    await plugin.storage.setSession(pluginHubHiddenKey, true);
    await plugin.app.toast('Plugin panel hidden for this session. "Show Plugin Panel" brings it back.');
  }, [plugin]);

  /**
   * The scope for a Priority Review Document, resolved the same way the "Create
   * Priority Review Document" document-menu item resolves it — so the button is
   * that menu item, with the scope filled in for you.
   *
   * The focused Rem comes first; a click in the sidebar leaves the editor's
   * focus intact, so this is usually the Rem the user was last on. Failing that,
   * the document the focused pane has open, then the first open pane. A missing
   * scope is not an error: the creator still offers the whole knowledge base.
   */
  const resolveScope = useCallback(async (): Promise<{ scopeRemId: string | null; scopeName: string }> => {
    let scopeRemId: string | undefined;

    const focused = await plugin.focus.getFocusedRem();
    if (focused) {
      scopeRemId = focused._id;
    } else {
      const paneId = await plugin.window.getFocusedPaneId();
      scopeRemId = await plugin.window.getOpenPaneRemId(paneId);
      if (!scopeRemId) {
        const openIds = await plugin.window.getOpenPaneRemIds();
        scopeRemId = openIds?.[0];
      }
    }

    const scopeRem = scopeRemId ? await plugin.rem.findOne(scopeRemId) : undefined;
    const scopeName = scopeRem ? await safeRemTextToString(plugin, scopeRem.text) : 'Full KB';
    return { scopeRemId: scopeRem?._id ?? null, scopeName };
  }, [plugin]);

  const openReviewDocumentCreator = useCallback(async () => {
    await plugin.storage.setSession('reviewDocContext', await resolveScope());
    await plugin.widget.openPopup('priority_queue_popup');
  }, [plugin, resolveScope]);

  /**
   * ▶ — straight into the queue on the full-KB Priority Queue, building the
   * document first when there is none yet. Always the knowledge base, whatever
   * is open: the daily driver, and the same thing the `prqgo` command does.
   * Document-scoped queues are practised from the popup.
   */
  const practiceKbQueue = useCallback(async () => {
    try {
      if (await isQueueOpen(plugin)) {
        await plugin.app.toast('A queue is already open.');
        return;
      }
      let doc = (await findPriorityQueueDoc(plugin, null))?.doc ?? null;
      if (!doc) {
        await plugin.app.toast('Building the Priority Queue for the whole knowledge base…');
        const result = await refreshPriorityQueue(plugin, { scopeRemId: null });
        doc = result.doc;
        if (!doc) {
          await plugin.app.toast('Could not build the Priority Queue — see the console.');
          return;
        }
      }
      await practicePriorityQueue(plugin, doc);
    } catch (e) {
      console.error('[Hub] Practice Priority Queue failed:', e);
      await plugin.app.toast('Could not open the Priority Queue — see the console.');
    }
  }, [plugin]);

  /**
   * Shift/Cmd-click on ▶ — the same thing, for the scope the panel is currently
   * pointing at rather than the whole knowledge base.
   *
   * The difference from {@link practiceKbQueue} is what happens when there is
   * no document yet. The full-KB queue *builds* one on the spot, because "the
   * whole knowledge base" needs no decisions from the user. A scope does: which
   * Rem, how big a burst, what the shield currently holds. So a missing scoped
   * queue opens the Priority Queue popup with the scope already filled in —
   * which is the same door the expanded panel's "Priority Queue" button opens,
   * and the reason the collapsed row can do without a cell for it.
   */
  const practiceScopedQueue = useCallback(async () => {
    try {
      if (await isQueueOpen(plugin)) {
        await plugin.app.toast('A queue is already open.');
        return;
      }
      const scope = await resolveScope();
      const existing = await findPriorityQueueDoc(plugin, scope.scopeRemId);
      if (!existing?.doc) {
        await plugin.storage.setSession('reviewDocContext', scope);
        await plugin.widget.openPopup('priority_queue_popup');
        return;
      }
      await practicePriorityQueue(plugin, existing.doc);
    } catch (e) {
      console.error('[Hub] Practice scoped Priority Queue failed:', e);
      await plugin.app.toast('Could not open the Priority Queue — see the console.');
    }
  }, [plugin, resolveScope]);

  /**
   * `mod` the way the plugin's own shortcuts read it — Cmd on macOS, Ctrl
   * elsewhere — plus Shift, which is the gesture people try first and which
   * costs nothing to honour. Alt is left alone: RemNote and the OS both claim
   * Alt-click in places.
   */
  const handleLearnClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) =>
      e.shiftKey || e.metaKey || e.ctrlKey ? practiceScopedQueue() : practiceKbQueue(),
    [practiceScopedQueue, practiceKbQueue]
  );

  /**
   * Opens the "Priority Review Queue" tag Rem — the one place every Priority
   * Review Document shows up, since the creator tags each document with it. Its
   * references list is the browsable index of past documents, and the queue can
   * be entered from any of them.
   *
   * The tag is created lazily by the first document, so its absence is not an
   * error state: it means there is nothing to browse yet, and the toast points
   * at the button that fixes that.
   */
  const openPriorityReviewQueue = useCallback(async () => {
    // Literal rather than the PRD_TAG_NAME export: that module pulls dayjs and
    // the IncRem cache in behind it, and this panel is mounted for the whole
    // session.
    const tagRem = await plugin.rem.findByName(['Priority Review Queue'], null);
    if (!tagRem) {
      await plugin.app.toast(
        'No Priority Queue yet — build one with the button to the left.'
      );
      return;
    }
    await plugin.window.openRem(tagRem);
  }, [plugin]);

  /**
   * What the Priority Review button will scope to, shown under it so the user is
   * not guessing which document they are about to collect. Tracked rather than
   * read once — the open document changes while the panel stays mounted.
   */
  const scopeName = useTrackerPlugin(async (rp) => {
    const focused = await rp.focus.getFocusedRem();
    let remId: string | undefined = focused?._id;
    if (!remId) {
      const paneId = await rp.window.getFocusedPaneId();
      remId = await rp.window.getOpenPaneRemId(paneId);
    }
    if (!remId) {
      const openIds = await rp.window.getOpenPaneRemIds();
      remId = openIds?.[0];
    }
    if (!remId) return null;
    const rem = await rp.rem.findOne(remId);
    if (!rem) return null;
    const name = await safeRemTextToString(rp, rem.text);
    return name.length > 28 ? name.slice(0, 28) + '…' : name;
  }, []);

  if (hidden) return null;

  // Held back until the stored state is known. `?? false` and render would be
  // the cheaper read, but it paints the full panel first and snaps it shut a
  // frame later on every remount of the sidebar slot — which is exactly the
  // layout thrash a collapsed hub is asking to be rid of.
  if (collapsed === undefined) return null;

  if (collapsed) {
    return (
      <CompactRow
        hasWaitingTip={tipsReady && !!tip}
        drillCount={drillCount ?? null}
        startupFinished={startupFinished}
        onExpand={toggleCollapsed}
        onDrill={openMasteryDrill}
        onShortcuts={() => openDocs('Keyboard-Shortcuts/')}
        onSettings={() => plugin.widget.openPopup('ie_settings')}
        onQueueRem={openPriorityReviewQueue}
        onLearn={handleLearnClick}
        scopeName={scopeName}
      />
    );
  }

  return (
    <div style={containerStyle} className="flex flex-col gap-1.5 p-2 rounded-lg mb-2">
      <style>{HUB_KEYFRAMES}</style>
      <div className="flex items-center justify-between gap-1">
        {/* Fills the row so the title's width is the space left by the icons,
            not the width of whichever text it currently holds. */}
        <div className="flex items-center gap-1 min-w-0" style={{ flex: '1 1 auto' }}>
          {/* The same globe that expands the row collapses the panel, so the
              control the user learns in one state is the control in the other.
              It is the only affordance for collapsing — no setting, no second
              button in the icon strip on the right. */}
          <button
            onClick={toggleCollapsed}
            title="Collapse to the icon row"
            aria-label="Collapse the panel to its icon row"
            className="hover:opacity-60"
            style={{
              flex: '0 0 auto',
              display: 'flex',
              alignItems: 'center',
              background: 'transparent',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
            }}
          >
            <img src={`${plugin.rootURL}globe-icon.png`} alt="" style={{ width: 16, height: 16 }} />
          </button>
          <PanelTitle />
        </div>
        <div className="flex items-center gap-0.5">
          {/* The same icons the collapsed row uses, at 13px for this 18px
              button — collapsing and expanding should not feel like moving
              between two different plugins. ? and ✕ stay as text: they are
              typographic symbols that render identically everywhere, which is
              exactly what ⌨ ⚙ 👁 were not. */}
          <IconButton
            label="Keyboard shortcuts"
            glyph={<KeyboardIcon size={13} />}
            onClick={() => openDocs('Keyboard-Shortcuts/')}
          />
          <IconButton
            label="Open the plugin's settings"
            glyph={<GearIcon size={13} />}
            onClick={() => plugin.widget.openPopup('ie_settings')}
          />
          <IconButton
            label="Open the documentation"
            glyph="?"
            onClick={() => openDocs('')}
          />
          <IconButton
            label="Hide this panel (bring it back with the “Show Plugin Panel” command)"
            glyph="✕"
            onClick={handleHidePanel}
          />
        </div>
      </div>

      <div className="flex gap-1">
        <button
          onClick={() => plugin.widget.openPopup('sorting_criteria')}
          // Sized to its own word, not to half the row: "Sorting" is a fixed
          // label that never needs more, while the Priority Review group has a
          // longer label plus two icon cells to fit. It still shrinks (0 1) if
          // the sidebar is dragged narrower than the two of them together.
          style={{
            ...actionButtonStyle,
            flex: '0 1 auto',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
          className="hover:opacity-75"
          title="Sorting Criteria — the mix of flashcards, incremental items and randomness in your queue"
        >
          Sorting
        </button>

        {/*
          Create / browse / Practice, in the order you meet them. The label cell is
          the only one that flexes, and it truncates rather than overflowing its
          box the way a `nowrap` button does at sidebar widths.
        */}
        <div style={segmentedGroupStyle}>
          <button
            onClick={openReviewDocumentCreator}
            style={{
              ...segmentStyle,
              flex: '1 1 0',
              minWidth: 0,
              padding: '0 5px',
              // `display: block` is what makes the ellipsis work, and it costs
              // the flex centring — so the line box is the group's 20px inner
              // height instead.
              lineHeight: '20px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              display: 'block',
              textAlign: 'center',
            }}
            className="hover:opacity-75"
            title={
              scopeName
                ? `Priority Queue — refresh, practise and inspect the queue for "${scopeName}" or the whole knowledge base`
                : 'Priority Queue — refresh, practise and inspect your persistent priority review document'
            }
          >
            Priority Queue
          </button>
          <button
            onClick={openPriorityReviewQueue}
            style={segmentIconStyle}
            className="hover:opacity-75"
            title="Open the “Priority Review Queue” Rem — every Priority Review Document you have made, ready to study from"
            aria-label="Open the Priority Review Queue Rem"
          >
            <EyeIcon size={14} />
          </button>
          {/*
            The daily driver, so it is the one filled cell in the panel. Once
            startup has finished it breathes the same way the Card Shield does
            when a card is inside it — until then it stays still.
            The glow is inset: the group clips its children (`overflow: hidden`),
            so an outer box-shadow would be cut off at the rounded border.
          */}
          <button
            onClick={handleLearnClick}
            style={{
              ...segmentIconStyle,
              width: 24,
              borderLeft: '1px solid #2563eb',
              background: '#3b82f6',
              color: '#fff',
              animation: startupFinished ? 'hubPlayCellGlow 2s ease-in-out infinite' : 'none',
            }}
            className="hover:opacity-90"
            title={learnLabel(scopeName) + '\n\n' + describeStartupTasks(startupStatus)}
            aria-label="Learn — practise the Priority Queue"
          >
            <span
              style={{
                display: 'inline-block',
                animation: startupFinished ? 'hubPlayPulse 2s ease-in-out infinite' : 'none',
              }}
            >
              ▶
            </span>
          </button>
        </div>
      </div>

      {scopeName && (
        <div
          className="truncate"
          style={{ fontSize: 10.5, color: 'var(--rn-clr-content-tertiary)' }}
        >
          Scope: {scopeName}
        </div>
      )}

      {tipsReady && tip && (
        <TipCard
          tip={tip}
          onGotIt={handleGotIt}
          onClose={handleCloseTip}
          onShowAll={openAllTips}
        />
      )}

      {/* Standing entry to the pile for every state the tip card is absent in:
          answered, snoozed, or drained. Text rather than a header icon — the
          header is already four icons wide at a sidebar width where the panel
          title has to drop a word to fit. */}
      {tipsReady && !tip && (
        <button
          onClick={openAllTips}
          className="hover:opacity-75 text-left"
          style={{
            fontSize: 11,
            lineHeight: '14px',
            color: 'var(--rn-clr-content-tertiary)',
            background: 'transparent',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
          }}
          title="See every tip — the ones you have acknowledged, with the date, and the ones still to come"
        >
          💡 All tips
        </button>
      )}
    </div>
  );
}

renderWidget(PluginHub);
