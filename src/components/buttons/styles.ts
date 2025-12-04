export type ButtonVariant = 'primary' | 'secondary' | 'danger';

export const getButtonStyles = () => ({
  base: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    padding: '10px 16px',
    borderRadius: '10px',
    border: '1px solid var(--rn-clr-border-primary)',
    fontSize: '13px',
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    gap: '3px',
    minWidth: '95px',
    height: '50px',
    backgroundColor: 'var(--rn-clr-background-secondary)',
    color: 'var(--rn-clr-content-primary)',
    boxShadow: '0 2px 4px rgba(0, 0, 0, 0.08)',
  },
  primary: {
    backgroundColor: 'var(--rn-clr-button-primary-bg, #3b82f6)',
    color: 'var(--rn-clr-button-primary-text, #ffffff)',
    border: '1px solid var(--rn-clr-button-primary-bg, #3b82f6)',
    minWidth: '115px',
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
    fontSize: '12px',
    fontWeight: 600,
    lineHeight: '1.2',
  },
  sublabel: {
    fontSize: '10px',
    opacity: 0.85,
    fontWeight: 400,
  },
  hoverShadow: '0 6px 12px rgba(0, 0, 0, 0.12)',
  defaultShadow: '0 2px 4px rgba(0, 0, 0, 0.08)',
});

