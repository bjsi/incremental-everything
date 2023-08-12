import { usePlugin } from '@remnote/plugin-sdk';
import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration';
import React from 'react';
import { getNextSpacingDateForRem } from '../lib/scheduler';
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

export function NextRepTime(props: NextRepTimeProps): React.ReactElement {
  const [nextTime, setNextTime] = React.useState<number>();
  const plugin = usePlugin();
  React.useEffect(() => {
    const effect = async () => {
      const inLookbackMode = !!(await plugin.queue.inLookbackMode());
      const nt = await getNextSpacingDateForRem(plugin, props.rem.remId, inLookbackMode);
      if (nt) {
        setNextTime(nt.newNextRepDate);
      }
    };
    effect();
  }, [props.rem.remId]);
  const duration = dayjs.duration(dayjs(nextTime).diff(dayjs()));
  const longVersion = durationToHumanReadable(duration);
  const shortVersion = longVersion.replace(/mins/g, 'min').replace(/hours/g, 'hrs');
  return <>in {shortVersion}</>;
}
