/**
 * Makes overlapping runs of a command take turns, in the order they were started. Take the turn
 * synchronously when the command fires, wait for `ready`, and call `release` when the next run may
 * go. Releasing twice is harmless, so a run can release early and again in a `finally`.
 */
export interface Turn {
  ready: Promise<void>;
  release: () => void;
}

export function createTurnQueue(): () => Turn {
  let tail: Promise<void> = Promise.resolve();
  return () => {
    const ready = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => (release = resolve));
    return { ready, release };
  };
}
