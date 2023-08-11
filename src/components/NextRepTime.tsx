import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration';
import React from 'react';
import { IncrementalRem } from '../lib/types';
dayjs.extend(duration);

export interface NextRepTimeProps {
  rem: IncrementalRem;
}

export function durationToHumanReadable(duration: any) {
  return Math.round(duration.asMinutes()) == 0
    ? 'later today'
    : Math.round(duration.asMinutes()) < 60
    ? numberWithLabel(Math.round(duration.asMinutes()), 'min')
    : duration.asHours() < 50
    ? numberWithLabel(Math.round(duration.asHours()), 'hour')
    : duration.asDays() < 30
    ? numberWithLabel(Math.round(duration.asDays()), 'day')
    : duration.asMonths() < 12
    ? numberWithLabel(Math.round(duration.asMonths() * 10) / 10, 'month')
    : numberWithLabel(Math.round(duration.asYears() * 10) / 10, 'year');
}

function numberWithLabel(number: number, label: string) {
  return `${number} ${label}${number == 1 ? '' : 's'}`;
}

export function NextRepTime({ rem }: NextRepTimeProps): React.ReactElement {
  const duration = dayjs.duration(dayjs(rem.nextRepDate).diff(dayjs()));
  const longVersion = durationToHumanReadable(duration);
  const shortVersion = longVersion.replace(/mins/g, 'min').replace(/hours/g, 'h');
  return <>{longVersion}</>;
}
