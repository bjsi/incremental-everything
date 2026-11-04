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

/**
 * Draws hover tooltips in the page for every element carrying a `title`
 * (or `data-tip`) attribute, replacing the OS tooltip.
 *
 * Native `title` tooltips are unreliable inside RemNote's plugin iframes on
 * desktop: the help cursor appears but the tooltip often never does, or shows
 * once and not again until the mouse leaves the element. Nothing in the page
 * can make the native one appear, so this layer takes over. On first hover it
 * moves the element's `title` into `data-tip`, so the native tooltip can no
 * longer race it and show a second copy.
 *
 * Mount once per widget, at its root. Multi-line text ("\n") is kept.
 */
export function HoverTipLayer() {
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
        el.removeAttribute('title');
        if (native) el.setAttribute('data-tip', native);
      }
      const text = el.getAttribute('data-tip');
      if (!text) return;
      timer = window.setTimeout(() => {
        if (current !== el || !el.isConnected) return;
        setTip({ text, anchor: el.getBoundingClientRect(), mouseX });
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
