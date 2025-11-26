import React, { useState } from 'react';

export interface PageHistoryEntry {
  page: number;
  timestamp: number;
  sessionDuration?: number;
}

interface ReadingHistoryViewProps {
  history: PageHistoryEntry[];
  statistics?: { totalTimeSeconds: number; sessionsWithTime: number };
  formatDuration: (seconds: number) => string;
}

type HistoryViewMode = 'list' | 'calendar';

export function ReadingHistoryView({ history, statistics, formatDuration }: ReadingHistoryViewProps) {
  const [viewMode, setViewMode] = useState<HistoryViewMode>('list');

  const getCalendarData = () => {
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    const weeksToShow = 8;
    const daysToShow = weeksToShow * 7;

    const dayMap: Record<string, { sessions: number; totalTime: number; pages: number[] }> = {};

    history.forEach(entry => {
      const date = new Date(entry.timestamp);
      const dateKey = date.toISOString().split('T')[0];
      if (!dayMap[dateKey]) {
        dayMap[dateKey] = { sessions: 0, totalTime: 0, pages: [] };
      }
      dayMap[dateKey].sessions++;
      dayMap[dateKey].totalTime += entry.sessionDuration || 0;
      if (!dayMap[dateKey].pages.includes(entry.page)) {
        dayMap[dateKey].pages.push(entry.page);
      }
    });

    const maxTime = Math.max(...Object.values(dayMap).map(d => d.totalTime), 1);

    const calendar: { date: Date; dateKey: string; data: typeof dayMap[string] | null }[][] = [];

    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - daysToShow + 1);
    startDate.setDate(startDate.getDate() - startDate.getDay());

    let currentDate = new Date(startDate);

    for (let week = 0; week < weeksToShow + 1; week++) {
      const weekDays: typeof calendar[0] = [];
      for (let day = 0; day < 7; day++) {
        const dateKey = currentDate.toISOString().split('T')[0];
        weekDays.push({
          date: new Date(currentDate),
          dateKey,
          data: dayMap[dateKey] || null
        });
        currentDate.setDate(currentDate.getDate() + 1);
      }
      calendar.push(weekDays);
    }

    return { calendar, maxTime };
  };

  const getIntensityColor = (time: number, maxTime: number) => {
    if (time === 0) return 'var(--rn-clr-background-tertiary)';
    const intensity = Math.min(time / maxTime, 1);
    if (intensity < 0.25) return '#bbf7d0';
    if (intensity < 0.5) return '#86efac';
    if (intensity < 0.75) return '#4ade80';
    return '#22c55e';
  };

  const { calendar, maxTime } = getCalendarData();
  const dayLabels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium" style={{ color: 'var(--rn-clr-content-primary)' }}>📚 Reading History</span>
          <span className="text-xs px-1.5 py-0.5 rounded" style={{ backgroundColor: 'var(--rn-clr-background-tertiary)', color: 'var(--rn-clr-content-tertiary)' }}>
            {history.length} sessions
          </span>
        </div>
        <div className="flex items-center gap-2">
          {statistics && statistics.totalTimeSeconds > 0 && (
            <span className="text-xs font-medium" style={{ color: '#10b981' }}>
              Total: {formatDuration(statistics.totalTimeSeconds)}
            </span>
          )}
          <div className="flex text-xs rounded overflow-hidden" style={{ border: '1px solid var(--rn-clr-border-primary)' }}>
            <button
              onClick={() => setViewMode('list')}
              className="px-2 py-0.5 transition-colors"
              style={{
                backgroundColor: viewMode === 'list' ? 'var(--rn-clr-background-tertiary)' : 'transparent',
                color: viewMode === 'list' ? 'var(--rn-clr-content-primary)' : 'var(--rn-clr-content-tertiary)',
              }}
              title="List view"
            >
              ☰
            </button>
            <button
              onClick={() => setViewMode('calendar')}
              className="px-2 py-0.5 transition-colors"
              style={{
                backgroundColor: viewMode === 'calendar' ? 'var(--rn-clr-background-tertiary)' : 'transparent',
                color: viewMode === 'calendar' ? 'var(--rn-clr-content-primary)' : 'var(--rn-clr-content-tertiary)',
              }}
              title="Calendar view"
            >
              📅
            </button>
          </div>
        </div>
      </div>

      {viewMode === 'list' ? (
        <div className="grid grid-cols-2 gap-1.5 max-h-32 overflow-y-auto">
          {history.slice(-10).reverse().map((entry, idx) => {
            const date = new Date(entry.timestamp);
            const isToday = new Date().toDateString() === date.toDateString();
            const isYesterday = new Date(Date.now() - 86400000).toDateString() === date.toDateString();
            const dateStr = isToday ? 'Today' : isYesterday ? 'Yesterday' : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

            return (
              <div key={idx} className="p-2 rounded" style={{ backgroundColor: 'var(--rn-clr-background-primary)', border: '1px solid var(--rn-clr-border-primary)' }}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-semibold" style={{ color: 'var(--rn-clr-content-primary)' }}>
                    Page {entry.page}
                  </span>
                  {entry.sessionDuration && (
                    <span className="text-xs font-medium" style={{ color: '#10b981' }}>
                      {formatDuration(entry.sessionDuration)}
                    </span>
                  )}
                </div>
                <div className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
                  {dateStr} · {timeStr}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="p-2 rounded" style={{ backgroundColor: 'var(--rn-clr-background-primary)', border: '1px solid var(--rn-clr-border-primary)' }}>
          <div className="flex gap-0.5">
            <div className="flex flex-col gap-0.5 mr-1">
              {dayLabels.map((label, i) => (
                <div key={i} className="w-3 h-3 flex items-center justify-center text-xs" style={{ color: 'var(--rn-clr-content-tertiary)', fontSize: '8px' }}>
                  {i % 2 === 1 ? label : ''}
                </div>
              ))}
            </div>
            {calendar.map((week, weekIdx) => (
              <div key={weekIdx} className="flex flex-col gap-0.5">
                {week.map((day, dayIdx) => {
                  const isToday = new Date().toDateString() === day.date.toDateString();
                  const isFuture = day.date > new Date();

                  return (
                    <div
                      key={dayIdx}
                      className="w-3 h-3 rounded-sm cursor-default transition-transform hover:scale-125"
                      style={{
                        backgroundColor: isFuture ? 'transparent' : getIntensityColor(day.data?.totalTime || 0, maxTime),
                        border: isToday ? '1px solid #3b82f6' : 'none',
                        opacity: isFuture ? 0.3 : 1,
                      }}
                      title={isFuture ? '' : `${day.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}${day.data ? `\n${day.data.sessions} session(s)\n${formatDuration(day.data.totalTime)}\nPages: ${day.data.pages.join(', ')}` : '\nNo reading'}`}
                    />
                  );
                })}
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between mt-2 pt-2" style={{ borderTop: '1px solid var(--rn-clr-border-primary)' }}>
            <span className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>Less</span>
            <div className="flex gap-0.5">
              <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: 'var(--rn-clr-background-tertiary)' }} />
              <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: '#bbf7d0' }} />
              <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: '#86efac' }} />
              <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: '#4ade80' }} />
              <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: '#22c55e' }} />
            </div>
            <span className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>More</span>
          </div>
        </div>
      )}
    </div>
  );
}
