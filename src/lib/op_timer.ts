/**
 * Times the steps of one command for a single console line, so that a slow command can be
 * diagnosed from a user's log. `track` times a call running alongside others, measured from when
 * it started; `lap` times the stretch since the previous lap.
 */
export interface OpTimer {
  /** When the command started, to match its line against other timed work. */
  readonly startedAt: number;
  lap(label: string): void;
  track<T>(label: string, work: Promise<T>): Promise<T>;
  report(): string;
}

export function createOpTimer(): OpTimer {
  const startedAt = Date.now();
  let lastLapAt = startedAt;
  const parts: string[] = [];
  return {
    startedAt,
    lap(label) {
      const now = Date.now();
      parts.push(`${label} ${now - lastLapAt}`);
      lastLapAt = now;
    },
    track(label, work) {
      const trackedFrom = Date.now();
      const note = () => parts.push(`${label} ${Date.now() - trackedFrom}`);
      work.then(note, note);
      return work;
    },
    report() {
      return `${Date.now() - startedAt} ms (${parts.join(', ')})`;
    },
  };
}
