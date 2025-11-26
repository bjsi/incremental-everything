import React from 'react';

interface StatBadgeProps {
  value: number | string;
  label: string;
  highlight?: number | string;
  highlightLabel?: string;
  compact?: boolean;
}

export function StatBadge({ value, label, highlight, highlightLabel, compact = false }: StatBadgeProps) {
  const fontSize = compact ? '10px' : '11px';
  const numberFontSize = compact ? '11px' : '12px';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        whiteSpace: 'nowrap',
        fontSize,
        color: 'var(--rn-clr-content-tertiary)',
      }}
    >
      <span
        style={{
          fontWeight: 600,
          color: 'var(--rn-clr-content-primary)',
          fontSize: numberFontSize,
        }}
      >
        {value}
      </span>
      <span>{label}</span>
      {highlight !== undefined && Number(highlight) > 0 && (
        <span style={{ color: 'var(--rn-clr-blue, #3b82f6)' }}>
          ({highlight}{highlightLabel ? ` ${highlightLabel}` : ''})
        </span>
      )}
    </div>
  );
}
