// Run from the repo root: node --test companion/clock.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const C = require('./clock.js');

describe('reading clock', () => {
  it('joins time that touches, and starts a segment after a gap', () => {
    let segments = C.addTime([], 0, 1000);
    segments = C.addTime(segments, 1000, 2000);
    segments = C.addTime(segments, 60000, 61000);
    assert.deepEqual(segments, [[0, 2000], [60000, 61000]]);
    assert.equal(C.totalMs(segments), 3000);
  });

  it('keeps all the time when the list grows too long', () => {
    let segments = [];
    for (let i = 0; i < 500; i++) segments = C.addTime(segments, i * 10000, i * 10000 + 1000);
    assert.ok(segments.length <= 400);
    assert.equal(C.totalMs(segments), 500 * 1000);
  });

  it('takes out what was cleared, and the span of each review recorded elsewhere', () => {
    const segments = [[0, 10], [20, 30], [40, 50]];
    assert.deepEqual(C.uncovered(segments, { clearedUntil: 25 }), [[25, 30], [40, 50]]);
    assert.deepEqual(C.uncovered(segments, { windows: [[5, 22], [45, 100]] }), [[0, 5], [22, 30], [40, 45]]);
    assert.deepEqual(C.uncovered(segments, null), segments);
  });

  it('turns reviews into the spans they covered, and adds each span once', () => {
    const windows = C.windowsOf([
      { date: 100000, reviewTimeSeconds: 60 },
      { date: 200000, reviewTimeSeconds: 0 },
    ]);
    assert.deepEqual(windows, [[40000, 100000]]);
    const cover = C.withWindows(null, windows);
    assert.deepEqual(cover.windows, [[40000, 100000]]);
    assert.equal(C.withWindows(cover, windows), null);
    // A refined review's span overlaps the one it had before: the union is kept.
    assert.deepEqual(C.withWindows(cover, [[70000, 120000]]).windows, [[40000, 120000]]);
    assert.equal(C.withWindows(cover, [[50000, 90000]]), null);
  });

  it('formats the clock and the total', () => {
    assert.equal(C.format(754000), '12:34');
    assert.equal(C.format(3920000), '1:05:20');
    assert.equal(C.formatShort(45000), '45 s');
    assert.equal(C.formatShort(12 * 60000), '12 min');
    assert.equal(C.formatShort(125 * 60000), '2 h 05 min');
  });

  it('counts a page by its address without the fragment', () => {
    assert.equal(C.targetKey('kb', 'https://a.org/x#part'), C.targetKey('kb', 'https://a.org/x'));
  });
});

describe('reading clock and the queue', () => {
  it('spans a handed-off queue review from the hand-off on', () => {
    assert.deepEqual(C.windowsOf([{ date: 100000, reviewTimeSeconds: 10, companionHandoffAt: 20000 }]), [[20000, 100000]]);
    assert.deepEqual(C.windowsOf([{ date: 100000, reviewTimeSeconds: 0, companionHandoffAt: 20000 }]), [[20000, 100000]]);
  });

  it('cuts segments to a span', () => {
    assert.deepEqual(C.within([[0, 10], [20, 30]], 5, 25), [[5, 10], [20, 25]]);
  });
});
