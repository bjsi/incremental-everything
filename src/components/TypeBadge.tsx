import React from 'react';
import { ActionItemType } from '../lib/incremental_rem/types';

const TYPE_BADGES: Record<ActionItemType, { emoji: string; label: string; bgColor: string; textColor: string; description: string }> = {
  'pdf': { emoji: '📄', label: 'PDF', bgColor: '#fef3c7', textColor: '#92400e', description: 'A PDF file added as incremental rem' },
  'pdf-highlight': { emoji: '🖍️', label: 'PDF Extract', bgColor: '#fce7f3', textColor: '#9d174d', description: 'Text or area highlighted in a PDF' },
  'pdf-note': { emoji: '📑', label: 'PDF Note', bgColor: '#e0e7ff', textColor: '#3730a3', description: 'A rem created inside a PDF (open PDF → Notes)' },
  'html': { emoji: '🌐', label: 'Web', bgColor: '#dbeafe', textColor: '#1e40af', description: 'A web page added as incremental rem' },
  'html-highlight': { emoji: '🔖', label: 'Web Extract', bgColor: '#d1fae5', textColor: '#065f46', description: 'Text highlighted from a web page' },
  'youtube': { emoji: '▶️', label: 'YouTube', bgColor: '#fee2e2', textColor: '#991b1b', description: 'A YouTube video added as incremental rem' },
  'youtube-highlight': { emoji: '✂️', label: 'Video Extract', bgColor: '#fecaca', textColor: '#7f1d1d', description: 'A segment extracted from a YouTube video' },
  'local-video': { emoji: '🎞️', label: 'Local Video', bgColor: '#ede9fe', textColor: '#5b21b6', description: 'A video file on this computer added as incremental rem' },
  'local-video-highlight': { emoji: '✂️', label: 'Local Video Extract', bgColor: '#ddd6fe', textColor: '#4c1d95', description: 'A segment extracted from a video file on this computer' },
  'video': { emoji: '🎬', label: 'Video', bgColor: '#fae8ff', textColor: '#86198f', description: 'A video file added as incremental rem' },
  'rem': { emoji: '📝', label: 'Rem', bgColor: '#f3f4f6', textColor: '#374151', description: 'A regular rem added as incremental rem' },
  'unknown': { emoji: '❓', label: 'Unknown', bgColor: '#f3f4f6', textColor: '#6b7280', description: 'Unknown type' },
};

export { TYPE_BADGES };

interface TypeBadgeProps {
  type?: ActionItemType;
  compact?: boolean;
  mini?: boolean;
}

export function TypeBadge({ type, compact = false, mini = false }: TypeBadgeProps) {
  if (!type) return null;
  const badge = TYPE_BADGES[type] || TYPE_BADGES['unknown'];

  if (mini) {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] shrink-0"
        style={{ backgroundColor: badge.bgColor, color: badge.textColor }}
        title={badge.description}
      >
        <span>{badge.emoji}</span>
        <span className="font-medium">{badge.label}</span>
      </span>
    );
  }

  if (compact) {
    return (
      <span
        className="inline-flex items-center justify-center gap-1 px-1.5 py-0.5 rounded text-xs shrink-0"
        style={{ backgroundColor: badge.bgColor, color: badge.textColor, width: '90px' }}
        title={badge.description}
      >
        <span>{badge.emoji}</span>
        <span className="font-medium truncate">{badge.label}</span>
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center justify-center gap-1.5 px-2 py-1 rounded text-sm shrink-0"
      style={{ backgroundColor: badge.bgColor, color: badge.textColor, width: '110px' }}
      title={badge.description}
    >
      <span>{badge.emoji}</span>
      <span className="font-medium truncate">{badge.label}</span>
    </span>
  );
}
