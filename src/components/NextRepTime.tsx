import { usePlugin } from '@remnote/plugin-sdk';
import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration';
import React from 'react';
import { getNextSpacingDateForRem } from '../lib/scheduler';
import { IncrementalRem } from '../lib/incremental_rem';
import { describeScheduler, ResolvedScheduler } from '../lib/scheduler_core';
dayjs.extend(duration);

export interface NextRepTimeProps {
  rem: IncrementalRem;
  /** Lead with a chip naming the scheduler that produced the interval. */
  showScheduler?: boolean;
  /**
   * The chip above the interval instead of beside it, in two small lines: for a
   * narrow button, where one line would cut the interval short.
   */
  stacked?: boolean;
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
  const [scheduler, setScheduler] = React.useState<ResolvedScheduler>();
  const plugin = usePlugin();

  React.useEffect(() => {
    const effect = async () => {
      const inLookbackMode = !!(await plugin.queue.inLookbackMode());
      const nt = await getNextSpacingDateForRem(plugin, props.rem.remId, inLookbackMode);
      if (nt) {
        setNextTime(nt.newNextRepDate);
        setScheduler(nt.scheduler);
      }
    };
    effect();
  }, [props.rem.remId]);

  const duration = dayjs.duration(dayjs(nextTime).diff(dayjs()));
  const longVersion = durationToHumanReadable(duration);
  const shortVersion = longVersion.replace(/mins/g, 'min').replace(/hours/g, 'hrs');
  const described = props.showScheduler && scheduler ? describeScheduler(scheduler) : null;
  if (props.stacked) {
    return (
      <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1, lineHeight: 1.05 }}>
        {described && (
          <span
            title={`Scheduler: ${described.name} (${described.source}). ${described.explanation} Change it in Reschedule.`}
            style={{
              padding: '0 4px',
              borderRadius: 6,
              fontSize: '0.85em',
              fontWeight: 600,
              backgroundColor: 'rgba(255, 255, 255, 0.22)',
              boxShadow: scheduler?.source === 'item' ? '0 0 0 1px rgba(255, 255, 255, 0.75)' : 'none',
            }}
          >
            {described.chip}
          </span>
        )}
        {/* The narrow button (a phone): months and years as m and y, the longest words here. */}
        <span style={{ whiteSpace: 'nowrap' }}>in {shortVersion.replace(/ months?$/, ' m').replace(/ years?$/, ' y')}</span>
      </span>
    );
  }
  return (
    <>
      {described && (
        <span
          title={`Scheduler: ${described.name} (${described.source}). ${described.explanation} Change it in Reschedule.`}
          style={{
            marginRight: 6,
            padding: '0 5px',
            borderRadius: 8,
            fontSize: '0.9em',
            fontWeight: 600,
            backgroundColor: 'rgba(255, 255, 255, 0.22)',
            // A scheduler chosen for this Rem is outlined, so an exception to the
            // settings is visible without reading the tooltip.
            boxShadow:
              scheduler?.source === 'item' ? '0 0 0 1px rgba(255, 255, 255, 0.75)' : 'none',
          }}
        >
          {described.chip}
        </span>
      )}
      in {shortVersion}
    </>
  );
}
