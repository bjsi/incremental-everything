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
}: DraggableButtonProps) {
  const [dragMode, setDragMode] = React.useState<'up' | 'down' | null>(null);
  const dragStartY = React.useRef<number | null>(null);
  const isPointerDown = React.useRef(false);
  const skipNextClick = React.useRef(false);
  const isMounted = React.useRef(true);

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
    if (!isPointerDown.current) {
      skipNextClick.current = false;
      resetDragState();
    }
  };

  const styles = getButtonStyles();
  const variantStyles =
    variant === 'primary'
      ? styles.primary
      : variant === 'danger'
      ? styles.danger
      : styles.secondary;

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
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
        style={{
          ...styles.base,
          ...variantStyles,
          userSelect: 'none',
          ...style,
        }}
      >
        {children}
      </button>

      {dragMode && (
        <div
          style={{
            position: 'absolute',
            top: '52px',
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '6px 10px',
            borderRadius: '10px',
            backgroundColor: 'var(--rn-clr-background-secondary)',
            border: '1px solid var(--rn-clr-border-primary)',
            boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
            zIndex: 15,
            fontSize: '12px',
            fontWeight: 600,
            color: 'var(--rn-clr-content-primary)',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          {dragMode === 'up' ? overlayUpText : overlayDownText}
        </div>
      )}
    </div>
  );
}
