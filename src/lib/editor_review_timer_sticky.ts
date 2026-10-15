import { RNPlugin } from '@remnote/plugin-sdk';
import { editorReviewTimerHeadersCssId, editorReviewTimerHeightsKey } from './consts';

/* Keeps RemNote's sticky headers clear of the pinned Editor Review Timer.

   The timer is pinned to the top of the pane's scroller (EDITOR_REVIEW_TIMER_STICKY_CSS
   in register/widgets.ts). RemNote's sticky headers land on the same spot: they
   are not in the document flow but in a fixed layer the editor positions over the
   top of the scroller,

     div.fixed.h-full.pointer-events-none.z-[6000]   <- inline translateY(top of the scroller)
       div.relative.w-full.h-full
         div.rn-sticky-header.absolute.z-[6000]      <- inline top: 0, the header stack

   so at z 6000 they paint over the timer. A top margin on .rn-sticky-header moves
   the stack down by the timer's height (it is absolutely positioned, so the margin
   adds to its inline top). CSS cannot read that height from another subtree, so
   each timer instance reports its own (findings/EDITOR_DOM_AND_CSS.md).

   The widget's context carries a documentId but no pane id, so the rule cannot be
   written per pane. The heights are kept per document and the tallest one wins:
   in a split view with panes of different widths the narrower timer wraps to more
   rows, and a gap under the shorter one is better than a header over the taller. */

const IFRAME = 'iframe[data-plugin-id="incremental-everything"][src*="widgetName=editor_review_timer&"]';

type TimerHeights = Record<string, number>;

export function buildEditorReviewTimerHeadersCss(heights: TimerHeights | undefined): string {
  const tallest = Math.max(0, ...Object.values(heights || {}));
  // No review running: the timer renders nothing and the headers stay where they are.
  if (tallest <= 0) return '';
  return `
  .rn-pane__body:has(${IFRAME}) .rn-sticky-header {
    margin-top: ${tallest}px;
  }
`;
}

export async function registerEditorReviewTimerHeadersCss(plugin: RNPlugin, heights?: TimerHeights) {
  await plugin.app.registerCSS(editorReviewTimerHeadersCssId, buildEditorReviewTimerHeadersCss(heights));
}

const lastReported = new Map<string, number>();

/** Called from the widget whenever the height of its rendered bar changes. */
export async function reportEditorReviewTimerHeight(plugin: RNPlugin, documentId: string, height: number) {
  const rounded = Math.ceil(height);
  if (rounded <= 0 || lastReported.get(documentId) === rounded) return;
  lastReported.set(documentId, rounded);
  const heights = (await plugin.storage.getSession<TimerHeights>(editorReviewTimerHeightsKey)) || {};
  await plugin.storage.setSession(editorReviewTimerHeightsKey, { ...heights, [documentId]: rounded });
}

/**
 * Called by every timer instance when the review ends. The timer is global, so
 * all of them stop at once and the whole map goes: clearing only one's own entry
 * would leave behind those of panes closed mid-review, whose iframes never got
 * to report anything again.
 */
export async function clearEditorReviewTimerHeights(plugin: RNPlugin) {
  lastReported.clear();
  const heights = await plugin.storage.getSession<TimerHeights>(editorReviewTimerHeightsKey);
  if (heights && Object.keys(heights).length > 0) {
    await plugin.storage.setSession(editorReviewTimerHeightsKey, {});
  }
}
