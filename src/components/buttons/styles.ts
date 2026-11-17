export type ButtonVariant = 'primary' | 'secondary' | 'danger';

/**
 * The queue's answer buttons (widgets/answer_buttons.tsx): flat, bordered, one
 * height. Depth comes from the hover tint, not from shadows or lifts, so a row of
 * them reads as one control strip beside RemNote's own flat buttons.
 */
export const getButtonStyles = () => ({
  base: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    boxSizing: 'border-box' as const,
    padding: '6px 14px',
    borderRadius: '9px',
    border: '1px solid var(--rn-clr-border-primary)',
    fontSize: '13px',
    fontWeight: 500,
    fontFamily: 'inherit',
    cursor: 'pointer',
    transition: 'background-color 0.15s ease, border-color 0.15s ease, filter 0.15s ease',
    gap: '3px',
    minWidth: '88px',
    height: '44px',
    backgroundColor: 'var(--rn-clr-background-secondary)',
    color: 'var(--rn-clr-content-primary)',
    WebkitTapHighlightColor: 'transparent',
  },
  primary: {
    backgroundColor: 'var(--rn-clr-button-primary-bg, #3b82f6)',
    color: 'var(--rn-clr-button-primary-text, #ffffff)',
    border: '1px solid var(--rn-clr-button-primary-bg, #3b82f6)',
    minWidth: '112px',
  },
  secondary: {
    backgroundColor: 'var(--rn-clr-background-secondary)',
    color: 'var(--rn-clr-content-secondary)',
    border: '1px solid var(--rn-clr-border-primary)',
  },
  danger: {
    backgroundColor: 'var(--rn-clr-background-secondary)',
    color: 'var(--rn-clr-red, #dc2626)',
    border: '1px solid var(--rn-clr-red, #dc2626)',
  },
  label: {
    fontSize: '13px',
    fontWeight: 600,
    lineHeight: '1.15',
  },
  sublabel: {
    fontSize: '10.5px',
    opacity: 0.88,
    fontWeight: 400,
    lineHeight: '1.15',
  },
  /** Hover: a tint for the bordered buttons, a slight brightening for the filled one. */
  hoverBackground: 'var(--rn-clr-background-tertiary)',
  hoverFilter: 'brightness(1.08)',
});
