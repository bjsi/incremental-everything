import { RNPlugin } from '@remnote/plugin-sdk';
import { queueBeautifulBarFitCssId, queueBeautifulBarWidthKey } from './consts';

/* Sizes the Beautiful queue's top-right strip (queue_beautiful_bar) to what it shows.

   QUEUE_VARIANT_CSS (register/widgets.ts) lays the strip over the card box's blank
   top-right corner. Its iframe takes clicks across its whole width, empty or not,
   and covers whatever else sits at QueueBelowTopBar — the regular-queue Mastery
   Drill's bar. A fixed width had to fit the widest content: the No-Inc timer or the
   "IncRems disabled" state next to the badge (~300px), where usually there is only
   the badge. So the widget reports its content width (CSS cannot read it) and this
   sizes the strip to it, still capped at 60% of the box. The drill bar keeps its
   buttons out of the same width. registerCSS is index-only, so index.tsx re-runs
   this on each report. */

const SLOT = '.queue-beautiful-box > .rn-queue__widget-below-top-bar';
const iframe = (widget: string) => `iframe[data-plugin-id="incremental-everything"][src*="widgetName=${widget}&"]`;

// Before the widget reports: the width the strip always had.
const DEFAULT_WIDTH = 360;
// Between the drill bar's last button and the strip.
const GAP = 8;

export function buildQueueBeautifulBarFitCss(width: number): string {
  const strip = `min(${width}px, 60%)`;
  return `
  ${SLOT}:has(> div > ${iframe('queue_beautiful_bar')}) {
    width: ${strip} !important;
  }
  ${SLOT}:has(> div > ${iframe('mastery_drill_queue_bar')}) {
    padding-right: calc(${strip} + ${GAP}px);
  }
`;
}

export async function registerQueueBeautifulBarFitCss(plugin: RNPlugin, width?: number) {
  const w = typeof width === 'number' && width > 0 ? width : DEFAULT_WIDTH;
  await plugin.app.registerCSS(queueBeautifulBarFitCssId, buildQueueBeautifulBarFitCss(w));
}

let lastReportedWidth: number | undefined;

/** Called from the widget whenever its content width changes. */
export async function reportQueueBeautifulBarWidth(plugin: RNPlugin, width: number) {
  const rounded = Math.ceil(width);
  if (rounded === lastReportedWidth) return;
  lastReportedWidth = rounded;
  await plugin.storage.setSession(queueBeautifulBarWidthKey, rounded);
}
