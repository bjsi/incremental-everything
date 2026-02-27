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
      onMouseEnter={(e) => {
        if (!disabled) {
          e.currentTarget.style.transform = 'translateY(-2px)';
          e.currentTarget.style.boxShadow = styles.hoverShadow;
          e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-tertiary)';
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'translateY(0)';
        e.currentTarget.style.boxShadow = styles.defaultShadow;
        if (variant === 'primary') {
          e.currentTarget.style.backgroundColor = 'var(--rn-clr-button-primary-bg, #3b82f6)';
        } else {
          e.currentTarget.style.backgroundColor = 'var(--rn-clr-background-secondary)';
        }
      }}
      className={className}
    >
      {children}
    </button>
  );
}

