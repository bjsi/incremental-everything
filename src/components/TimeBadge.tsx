import React from 'react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

interface TimeBadgeProps {
  nextRepDate: number;
  compact?: boolean;
}

export function TimeBadge({ nextRepDate, compact = false }: TimeBadgeProps) {
  const isDue = nextRepDate <= Date.now();
  const relativeTimeStr = dayjs(nextRepDate).fromNow(true);

  if (compact) {
    return (
      <span
        className="text-xs shrink-0 text-right"
        style={{ color: isDue ? '#ea580c' : 'var(--rn-clr-content-tertiary)', width: '75px' }}
        title={dayjs(nextRepDate).format('DD MMM YYYY')}
      >
        {isDue ? `${relativeTimeStr} ago` : `in ${relativeTimeStr}`}
      </span>
    );
  }

  return (
    <span
      className="text-sm shrink-0 text-right"
      style={{ color: isDue ? '#ea580c' : 'var(--rn-clr-content-tertiary)', width: '90px' }}
      title={dayjs(nextRepDate).format('DD MMM YYYY')}
    >
      {isDue ? `${relativeTimeStr} ago` : `in ${relativeTimeStr}`}
    </span>
  );
}
