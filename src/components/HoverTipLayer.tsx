import React from 'react';

const SHOW_DELAY_MS = 350;
const MAX_WIDTH = 380;
const GAP = 8;
const EDGE = 8;

interface Tip {
  text: string;
  anchor: DOMRect;
  mouseX: number;
}

// Only one layer may be live per iframe: two would each draw the same tip.
// The first mounted one is live; when it unmounts, the next one takes over.
const layers: Array<(live: boolean) => void> = [];
const announce = () => layers.forEach((set, i) => set(i === 0));

// Rough size of the tip box, to decide whether it fits in the iframe at all.
// Matches the box style below: 11px text, 1.4 line height, 6/9px padding.
const LINE_PX = 15.4;
const BOX_PAD_Y = 14;
const BOX_PAD_X = 20;
const CHAR_PX = 6;

function estimateTipHeight(text: string, viewportWidth: number): number {
  const inner = Math.max(40, Math.min(MAX_WIDTH, viewportWidth - 2 * EDGE) - BOX_PAD_X);
  const perLine = Math.max(1, Math.floor(inner / CHAR_PX));
  const lines = text
    .split('\n')
    .reduce((n, para) => n + Math.max(1, Math.ceil(para.length / perLine)), 0);
  return lines * LINE_PX + BOX_PAD_Y;
}

/** True when a tip under or above `anchor` fits inside this iframe. */
function tipFits(text: string, anchor: DOMRect): boolean {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const h = estimateTipHeight(text, vw);
  return anchor.bottom + GAP + h <= vh - EDGE || anchor.top - GAP - h >= EDGE;
}

/**
 * Draws hover tooltips in the page for every element carrying a `title`
 * (or `data-tip`) attribute, replacing the OS tooltip.
 *
 * Native `title` tooltips are unreliable inside plugin iframes in RemNote's
 * desktop app (the web app in Chrome is fine): the help cursor appears but
 * the tooltip often never does, or shows once and not again until the mouse
 * leaves the element. Nothing in the page can make the native one appear, so
 * this layer takes over. On first hover it moves the element's `title` into
 * `data-tip`, so the native tooltip can no longer race it and show a second
 * copy.
 *
 * A tip can't leave the iframe, so in a strip too thin to hold it (queue
 * bars, editor badges) the `title` is left alone for the OS to draw.
 *
 * Every widget gets one through `withHoverTips` at its `renderWidget` call;
 * extra mounts are harmless (only one is live). Multi-line text ("\n") is kept.
 */
export function HoverTipLayer() {
  const [live, setLive] = React.useState(false);

  React.useLayoutEffect(() => {
    layers.push(setLive);
    announce();
    return () => {
      const i = layers.indexOf(setLive);
      if (i >= 0) layers.splice(i, 1);
      announce();
    };
  }, []);

  return live ? <LiveHoverTips /> : null;
}

/** Wraps a widget's root so every `title` in it gets a drawn tooltip. */
export function withHoverTips(Widget: React.ComponentType) {
  function WithHoverTips() {
    return (
      <>
        <Widget />
        <HoverTipLayer />
      </>
    );
  }
  WithHoverTips.displayName = `WithHoverTips(${Widget.displayName || Widget.name || 'Widget'})`;
  return WithHoverTips;
}

function LiveHoverTips() {
  const [tip, setTip] = React.useState<Tip | null>(null);
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null);
  const boxRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    let timer: number | undefined;
    let current: Element | null = null;
    let mouseX = 0;

    const hide = () => {
      window.clearTimeout(timer);
      timer = undefined;
      setTip(null);
    };
    const reset = () => {
      hide();
      current = null;
    };

    const onOver = (e: MouseEvent) => {
      mouseX = e.clientX;
      const target = e.target as Element | null;
      const el = target?.closest?.('[title], [data-tip]') ?? null;
      if (el === current) return;
      hide();
      current = el;
      if (!el) return;
      const native = el.getAttribute('title');
      if (native != null) {
        // Too thin an iframe for a drawn tip: leave it to the OS tooltip.
        if (native && !tipFits(native, el.getBoundingClientRect())) return;
        el.removeAttribute('title');
        if (native) el.setAttribute('data-tip', native);
      }
      const text = el.getAttribute('data-tip');
      if (!text) return;
      timer = window.setTimeout(() => {
        if (current !== el || !el.isConnected) return;
        const anchor = el.getBoundingClientRect();
        if (!tipFits(text, anchor)) {
          // Moved here earlier when it fitted; hand it back to the OS.
          el.removeAttribute('data-tip');
          el.setAttribute('title', text);
          return;
        }
        setTip({ text, anchor, mouseX });
      }, SHOW_DELAY_MS);
    };
    const onMove = (e: MouseEvent) => {
      mouseX = e.clientX;
    };
    const onOut = (e: MouseEvent) => {
      if (!e.relatedTarget) reset();
    };

    document.addEventListener('mouseover', onOver);
    document.addEventListener('mousemove', onMove, { passive: true });
    document.addEventListener('mouseout', onOut);
    document.addEventListener('mousedown', hide, true);
    document.addEventListener('keydown', hide, true);
    document.addEventListener('wheel', hide, { capture: true, passive: true });
    window.addEventListener('scroll', hide, true);
    window.addEventListener('blur', reset);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseout', onOut);
      document.removeEventListener('mousedown', hide, true);
      document.removeEventListener('keydown', hide, true);
      document.removeEventListener('wheel', hide, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', reset);
    };
  }, []);

  // Place under the hovered element, horizontally at the pointer (a group
  // header can span half the table), flipped above when there is no room.
  React.useLayoutEffect(() => {
    const box = boxRef.current;
    if (!tip || !box) {
      setPos(null);
      return;
    }
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const left = Math.max(EDGE, Math.min(vw - w - EDGE, tip.mouseX - w / 2));
    let top = tip.anchor.bottom + GAP;
    if (top + h > vh - EDGE && tip.anchor.top - GAP - h >= EDGE) top = tip.anchor.top - GAP - h;
    setPos({ left, top: Math.max(EDGE, Math.min(top, vh - h - EDGE)) });
  }, [tip]);

  if (!tip) return null;
  return (
    <div
      ref={boxRef}
      role="tooltip"
      style={{
        position: 'fixed',
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        visibility: pos ? 'visible' : 'hidden',
        maxWidth: MAX_WIDTH,
        zIndex: 2147483647,
        pointerEvents: 'none',
        padding: '6px 9px',
        borderRadius: 6,
        border: '1px solid var(--rn-clr-border-opaque, rgba(128,128,128,0.35))',
        background: 'var(--rn-clr-background-primary, #fff)',
        color: 'var(--rn-clr-content-primary, #111)',
        boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
        fontSize: 11,
        fontWeight: 400,
        lineHeight: 1.4,
        letterSpacing: 'normal',
        textTransform: 'none',
        textAlign: 'left',
        whiteSpace: 'pre-line',
        overflowWrap: 'break-word',
      }}
    >
      {tip.text}
    </div>
  );
}
