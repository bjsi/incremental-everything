/**
 * Recognition First decisions. Run with `npm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hasBeenReviewed, recognitionPassed, shouldHoldForward } from './recognition_first_rules';

const DAY = 86_400_000;
const rep = (score: number, date = 1_000) => ({ score, date });
const forward = (...reps: Array<{ score: number; date: number }>) => ({ type: 'forward', repetitionHistory: reps });
const backward = (...reps: Array<{ score: number; date: number }>) => ({ type: 'backward', repetitionHistory: reps });

describe('hasBeenReviewed', () => {
  it('a skip and bookkeeping scores are no review', () => {
    assert.equal(hasBeenReviewed(forward()), false);
    assert.equal(hasBeenReviewed(forward(rep(0.01), rep(3), rep(4), rep(5))), false);
  });
  it('any real rating is one, a failed one included', () => {
    assert.equal(hasBeenReviewed(forward(rep(0))), true);
    assert.equal(hasBeenReviewed(forward(rep(1))), true);
  });
});

describe('recognitionPassed', () => {
  it('needs Good or Easy', () => {
    assert.equal(recognitionPassed(backward(), 0), false);
    assert.equal(recognitionPassed(backward(rep(0), rep(0.5)), 0), false);
    assert.equal(recognitionPassed(backward(rep(1)), 0), true);
    assert.equal(recognitionPassed(backward(rep(1.5)), 0), true);
  });
  it('with a minimum, the last interval must reach it', () => {
    const at = (days: number) => ({ ...backward(rep(1, 1_000)), nextRepetitionTime: 1_000 + days * DAY });
    assert.equal(recognitionPassed(at(2), 7), false);
    assert.equal(recognitionPassed(at(7), 7), true);
  });
  it('a long interval without a pass does not count', () => {
    const card = { ...backward(rep(0.5, 1_000)), nextRepetitionTime: 1_000 + 30 * DAY };
    assert.equal(recognitionPassed(card, 7), false);
  });
});

describe('shouldHoldForward', () => {
  it('holds a brand-new pair', () => {
    assert.equal(shouldHoldForward([forward(), backward()], 0), true);
  });
  it('keeps holding after a failed recognition', () => {
    assert.equal(shouldHoldForward([forward(), backward(rep(0))], 0), true);
  });
  it('leaves the card alone once recognition has passed', () => {
    assert.equal(shouldHoldForward([forward(), backward(rep(1))], 0), false);
  });
  it('never holds a forward card that has been reviewed', () => {
    assert.equal(shouldHoldForward([forward(rep(1)), backward()], 0), false);
    assert.equal(shouldHoldForward([forward(rep(0)), backward()], 0), false);
  });
  it('needs both directions; clozes do not count', () => {
    assert.equal(shouldHoldForward([forward()], 0), false);
    assert.equal(shouldHoldForward([backward()], 0), false);
    assert.equal(shouldHoldForward([{ type: { clozeId: 'x' } }], 0), false);
  });
});
