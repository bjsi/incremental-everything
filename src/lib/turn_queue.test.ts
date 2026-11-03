import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnQueue } from './turn_queue';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('runs take turns in the order they started', async () => {
  const takeTurn = createTurnQueue();
  const log: string[] = [];
  const first = takeTurn();
  const second = takeTurn();
  const third = takeTurn();
  second.ready.then(() => log.push('second'));
  third.ready.then(() => log.push('third'));
  await first.ready;
  await tick();
  assert.deepEqual(log, []);
  first.release();
  await tick();
  assert.deepEqual(log, ['second']);
  second.release();
  await tick();
  assert.deepEqual(log, ['second', 'third']);
});

test('releasing twice does not let a later run jump its turn', async () => {
  const takeTurn = createTurnQueue();
  const log: string[] = [];
  const first = takeTurn();
  const second = takeTurn();
  const third = takeTurn();
  third.ready.then(() => log.push('third'));
  first.release();
  first.release();
  await tick();
  assert.deepEqual(log, []);
  second.release();
  await tick();
  assert.deepEqual(log, ['third']);
});
