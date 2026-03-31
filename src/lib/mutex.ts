let queueLock: Promise<void> = Promise.resolve();

export function withQueueMutex<T>(fn: () => Promise<T>): Promise<T> {
    const result = queueLock.then(fn);
    // Catch errors so the chain doesn't break forever
    queueLock = result.then(() => { }).catch(() => { });
    return result;
}