import React from 'react';
import { ButtonVariant, getButtonStyles } from './styles';

interface ButtonProps {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: ButtonVariant;
  style?: React.CSSProperties;
  disabled?: boolean;
  className?: string;
  title?: string;
}

export function Button({ children, onClick, variant = 'secondary', style, disabled, className, title }: ButtonProps) {
  const styles = getButtonStyles();
  const variantStyles = variant === 'primary' ? styles.primary : variant === 'danger' ? styles.danger : styles.secondary;
  const filled = variant === 'primary' || !!style?.backgroundColor;

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        ...styles.base,
        ...variantStyles,
        ...style,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
      aria-label={title ? title.split(/[:(]/)[0].trim() : undefined}
      onMouseEnter={(e) => {
        if (disabled) return;
        // A filled button (the primary, or one the caller coloured, like the yellow
        // Scroll to Highlight) keeps its colour and brightens; the rest get a tint.
        if (filled) e.currentTarget.style.filter = styles.hoverFilter;
        else e.currentTarget.style.backgroundColor = styles.hoverBackground;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.filter = 'none';
        if (!filled) e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-secondary)';
      }}
      className={className}
    >
      {children}
    </button>
  );
}

