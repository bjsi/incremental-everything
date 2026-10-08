import { RNPlugin } from '@remnote/plugin-sdk';
import { cardInfoBarDockCssId, cardInfoBarHeightKey } from './consts';

/* Docks card_info_bar above the answer buttons in the Beautiful queue.

   The widget is registered at FlashcardUnder, which renders at the end of the card
   content and so moves with it. No SDK location sits at the bottom of the box:
   FlashcardAnswerButtons replaces RemNote's own buttons on every matching card. So
   the widget stays where it is, and host CSS moves it.

   How the Beautiful bottom works (findings/QUEUE_AND_PRACTICE.md):
   - The buttons live in .beautiful-queue-bottom-controls-overlay (absolute, z 10000)
     inside the swipe HOC root (.spacedRepetition). A ResizeObserver reads the
     overlay's height into --beautiful-queue-bottom-controls-height on that root.
   - The AI insights panel ("Explanation") is in-flow, pushed down by a spacer that
     RemNote computes from that height. So growing the controls moves it up.

   The rules below:
   1. pad the top of .spaced-repetition__bottom by the bar's height + a gap. Padding
      on the CHILD grows the overlay's content box, so the observer fires.
   2. contain: layout on the HOC root makes it the containing block for fixed
      descendants, so the bar can be fixed relative to the box and escape the scroll
      surface.
   3. fix the widget's wrapper (not the iframe: the wrapper carries an inline
      transform, which would trap a fixed iframe) over that padding, above the mask
      (z 9998) and the overlay (z 10000).
   4. when RemNote makes the card content sticky (a stacking context), lift it so the
      bar inside can still paint above the mask.

   Every rule is gated on our iframe being inside the Beautiful scroll surface. If a
   RemNote update renames something, the bar falls back to its old place under the
   card. The height comes from the widget itself (cardInfoBarHeightKey), because CSS
   cannot read an element's height. */

const IFRAME = 'iframe[data-plugin-id="incremental-everything"][src*="widgetName=card_info_bar&"]';
// The innermost widget wrapper that holds our iframe.
const WRAPPER = `.fade-in-first-load:has(${IFRAME}):not(:has(.fade-in-first-load ${IFRAME}))`;
const ROOT = `.spacedRepetition:has(> .queue-beautiful-scroll-surface ${IFRAME})`;

// Before the widget reports its height. One row of the bar.
const DEFAULT_BAR_HEIGHT = 38;
// Space between the bar and the answer buttons.
const GAP_ABOVE_BUTTONS = 12;
// The "↵ Enter" tab RemNote draws above a suggested answer button.
const SUGGESTED_TAB_HEIGHT = 25;
// Matches the controls' px-8 on desktop, so the bar lines up with the buttons.
const SIDE_INSET = 32;

export function buildCardInfoBarDockCss(barHeight: number): string {
  // A bar that renders nothing (no priority, IncRem queue) reserves no space.
  const band = barHeight > 0 ? barHeight + GAP_ABOVE_BUTTONS : 0;
  return `
  /* Spacing from the card above, when the bar sits in-flow (Compact queue, or
     any queue where the dock rules below don't apply). */
  ${WRAPPER} {
    padding-top: 30px;
    padding-bottom: 10px;
  }

  ${ROOT} {
    contain: layout;
  }
  ${ROOT} > .beautiful-queue-bottom-controls-overlay .spaced-repetition__bottom {
    padding-top: ${band}px !important;
  }
  /* A graded type-in answer pre-selects a button and hangs an "↵ Enter" tab over
     it (absolute, 25px, top: -25px). On desktop that button, and only that one,
     loses its top border and corners, which is the hook to make room for the tab. */
  ${ROOT} > .beautiful-queue-bottom-controls-overlay .spaced-repetition__bottom:has(.rn-queue__answer-btn.border-t-transparent.rounded-t-none) {
    padding-top: ${band > 0 ? band + SUGGESTED_TAB_HEIGHT : 0}px !important;
  }
  ${ROOT} .beautiful-queue-card-content--sticky:has(${IFRAME}) {
    z-index: 10001;
  }
  ${ROOT} ${WRAPPER} {
    position: fixed !important;
    left: ${SIDE_INSET}px;
    right: ${SIDE_INSET}px;
    bottom: calc(var(--beautiful-queue-bottom-controls-height, 0px) - ${barHeight}px);
    z-index: 10001;
    padding: 0;
  }
`;
}

export async function registerCardInfoBarDockCss(plugin: RNPlugin, barHeight?: number) {
  const height = typeof barHeight === 'number' ? barHeight : DEFAULT_BAR_HEIGHT;
  await plugin.app.registerCSS(cardInfoBarDockCssId, buildCardInfoBarDockCss(height));
}

let lastReportedHeight: number | undefined;

/** Called from the widget whenever its rendered height changes (0 = renders nothing). */
export async function reportCardInfoBarHeight(plugin: RNPlugin, height: number) {
  const rounded = Math.ceil(height);
  if (rounded === lastReportedHeight) return;
  lastReportedHeight = rounded;
  await plugin.storage.setSession(cardInfoBarHeightKey, rounded);
}
