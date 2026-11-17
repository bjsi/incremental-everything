import React from 'react';
import { getButtonStyles, ButtonVariant } from './styles';

interface DraggableButtonProps {
  children: React.ReactNode;
  variant?: ButtonVariant;
  dragThreshold?: number;
  overlayUpText?: string;
  overlayDownText?: string;
  onClick: () => Promise<void> | void;
  onDragUp?: () => Promise<void> | void;
  onDragDown?: () => Promise<void> | void;
  style?: React.CSSProperties;
  /** For the element around the button: how it sits in the caller's row (flex, width). */
  wrapperStyle?: React.CSSProperties;
  /** Leave out the ↕ drag hint (the drag still works): for a button short of room. */
  hideGrip?: boolean;
  title?: string;
}

/**
 * Generic press+drag button:
 *   - drag up   -> onDragUp (if provided)
 *   - drag down -> onDragDown (if provided)
 *   - click/short press -> onClick
 */
export function DraggableButton({
  children,
  variant = 'secondary',
  dragThreshold = 12,
  overlayUpText = 'Drag up',
  overlayDownText = 'Drag down',
  onClick,
  onDragUp,
  onDragDown,
  style,
  wrapperStyle,
  hideGrip = false,
  title,
}: DraggableButtonProps) {
  const [dragMode, setDragMode] = React.useState<'up' | 'down' | null>(null);
  const dragStartY = React.useRef<number | null>(null);
  const isPointerDown = React.useRef(false);
  const skipNextClick = React.useRef(false);
  const isMounted = React.useRef(true);
  const [showNudge, setShowNudge] = React.useState(true);
  // Fallback to clear drag mode if pointer state is lost
  React.useEffect(() => {
    if (dragMode && !isPointerDown.current) {
      setDragMode(null);
    }
  }, [dragMode]);

  React.useEffect(() => {
    return () => {
      isMounted.current = false;
    };
  }, []);

  const resetDragState = () => {
    if (!isMounted.current) return;
    isPointerDown.current = false;
    dragStartY.current = null;
    setDragMode(null);
  };

  const handlePointerDown: React.PointerEventHandler<HTMLButtonElement> = (e) => {
    if (!isMounted.current) return;
    isPointerDown.current = true;
    skipNextClick.current = false;
    dragStartY.current = e.clientY;
    setDragMode(null);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove: React.PointerEventHandler<HTMLButtonElement> = (e) => {
    if (!isPointerDown.current || dragStartY.current === null) return;
    if (!isMounted.current) return;
    const dy = e.clientY - dragStartY.current;
    if (dy <= -dragThreshold && onDragUp) {
      setDragMode('up');
    } else if (dy >= dragThreshold && onDragDown) {
      setDragMode('down');
    } else {
      setDragMode(null);
    }
  };

  const handlePointerUp: React.PointerEventHandler<HTMLButtonElement> = async (e) => {
    if (!isPointerDown.current) return;
    const selection = dragMode;
    resetDragState();
    if (selection === 'up' && onDragUp) {
      e.preventDefault();
      skipNextClick.current = true;
      await onDragUp();
    } else if (selection === 'down' && onDragDown) {
      e.preventDefault();
      skipNextClick.current = true;
      await onDragDown();
    } else {
      skipNextClick.current = true;
      await onClick();
    }
  };

  const handlePointerLeave: React.PointerEventHandler<HTMLButtonElement> = () => {
    skipNextClick.current = false;
    resetDragState();
  };

  const handlePointerCancel: React.PointerEventHandler<HTMLButtonElement> = () => {
    skipNextClick.current = false;
    resetDragState();
  };

  const styles = getButtonStyles();
  const variantStyles =
    variant === 'primary'
      ? styles.primary
      : variant === 'danger'
        ? styles.danger
        : styles.secondary;

  // Visual feedback + inline text change while dragging
  const dragFeedbackStyle: React.CSSProperties =
    dragMode === 'up'
      ? {
        transform: 'translateY(-3px)',
        borderColor: 'var(--rn-clr-blue, #3b82f6)',
        backgroundColor: 'var(--rn-clr-blue-light, #e0ecff)',
        color: 'var(--rn-clr-blue-dark, #1e3a8a)',
      }
      : dragMode === 'down'
        ? {
          transform: 'translateY(3px)',
          borderColor: 'var(--rn-clr-green, #10b981)',
          backgroundColor: 'var(--rn-clr-green-light, #dcfce7)',
          color: 'var(--rn-clr-green-dark, #064e3b)',
        }
        : {};

  const activeContent =
    dragMode === 'up'
      ? overlayUpText
      : dragMode === 'down'
        ? overlayDownText
        : null;

  return (
    <div style={{ position: 'relative', display: 'inline-flex', overflow: 'visible', zIndex: 1, ...wrapperStyle }} title={title}>
      <button
        onClick={async () => {
          if (skipNextClick.current) {
            skipNextClick.current = false;
            return;
          }
          await onClick();
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onPointerCancel={handlePointerCancel}
        style={{
          ...styles.base,
          ...variantStyles,
          ...dragFeedbackStyle,
          userSelect: 'none',
          touchAction: 'none',
          transition: 'transform 0.12s ease, background-color 0.15s ease, filter 0.15s ease',
          ...style,
        }}
        onMouseEnter={(e) => {
          if (!dragMode) e.currentTarget.style.filter = styles.hoverFilter;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.filter = 'none';
        }}
      >
        {dragMode ? (
          <span style={{ fontWeight: 700, fontSize: '12px' }}>{activeContent}</span>
        ) : (
          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, minWidth: 0, maxWidth: '100%', overflow: 'hidden' }}>
            {children}
            {!hideGrip && (<span
              aria-hidden
              style={{
                fontSize: '11px',
                flex: 'none',
                opacity: 0.6,
                animation: 'bobDragHint 900ms ease-in-out infinite',
              }}
            >
              ↕
            </span>)}
          </span>
        )}
      </button>

      <style>
        {`
        @keyframes bobDragHint {
          0% { transform: translateY(0); }
          25% { transform: translateY(-2px); }
          50% { transform: translateY(2px); }
          75% { transform: translateY(-1px); }
          100% { transform: translateY(0); }
        }
        `}
      </style>

    </div>
  );
}
