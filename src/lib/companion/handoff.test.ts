/**
 * One sitting, one review: the queue and the Chrome Companion. Run with `npm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { companionSessionInTurn, queueSecondsBefore, refinedReviewSeconds } from './handoff';
import { IncrementalRep } from '../incremental_rem/types';

const MIN = 60000;
const T0 = 1_800_000_000_000;

describe('the queue and the Companion', () => {
  const session: IncrementalRep = {
    date: T0 + 20 * MIN,
    scheduled: T0,
    reviewTimeSeconds: 10 * 60,
    eventType: 'externalRep',
    context: { webUrl: 'https://a.org/x' },
  };

  it('finds a Companion session recorded during the queue turn, and only that', () => {
    assert.equal(companionSessionInTurn([session], T0), session);
    assert.equal(companionSessionInTurn([session], T0 + 30 * MIN), undefined);
    assert.equal(companionSessionInTurn([{ ...session, context: undefined }], T0), undefined);
    assert.equal(companionSessionInTurn([session], null), undefined);
  });

  it('adds the minutes in RemNote before the hand-off, or before the reading began', () => {
    assert.equal(queueSecondsBefore(session, T0, T0 + 3 * MIN), 3 * 60);
    // Reading began at T0 + 10 min: the 10 minutes before it were in the queue.
    assert.equal(queueSecondsBefore(session, T0), 10 * 60);
    assert.equal(queueSecondsBefore(session, T0 + 15 * MIN), 0);
  });

  it("swaps a queue review's wall clock after the hand-off for the Companion's reading", () => {
    // Shown at T0, handed off at T0 + 2 min, Next at T0 + 30 min.
    const review: IncrementalRep = { date: T0 + 30 * MIN, scheduled: T0, reviewTimeSeconds: 30 * 60 };
    assert.equal(refinedReviewSeconds(review, T0 + 2 * MIN, 10 * 60), 12 * 60);
  });
});
