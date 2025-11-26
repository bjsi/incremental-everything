import React from 'react';

export interface BreadcrumbItem {
  id: string;
  text: string;
}

interface BreadcrumbProps {
  items: BreadcrumbItem[];
  isLoading?: boolean;
  loadingText?: string;
  onClick?: (id: string) => void;
}

export function Breadcrumb({ items, isLoading = false, loadingText = 'Loading...', onClick }: BreadcrumbProps) {
  if (isLoading) {
    return (
      <span
        className="text-xs"
        style={{ color: 'var(--rn-clr-content-tertiary)' }}
      >
        {loadingText}
      </span>
    );
  }

  if (items.length === 0) {
    return null;
  }

  return (
    <div
      style={{
        fontSize: '11px',
        color: 'var(--rn-clr-content-tertiary)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {items.map((item, index) => (
        <span
          key={item.id}
          onClick={onClick ? () => onClick(item.id) : undefined}
          style={{ cursor: onClick ? 'pointer' : 'default' }}
        >
          {item.text}
          {index < items.length - 1 && ' › '}
        </span>
      ))}
    </div>
  );
}
