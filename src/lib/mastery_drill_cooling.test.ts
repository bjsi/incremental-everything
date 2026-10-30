/**
 * Fixture tests for the Mastery Drill cooling rule. Run with `npm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DrillCooling, drillCoolingMs, drillReadyAt, formatDrillWait, returnsAtOnce, summarizeDrill, toCooling } from './mastery_drill_cooling';

const MIN = 60_000;
const DAY = 86_400_000;
// The defaults: 180 min floor, 5% of the interval, 7-day cap.
const defaults: DrillCooling = { minDelayMs: 180 * MIN, hardShare: 0.05, hardMaxMs: 7 * DAY };

describe('drill cooling', () => {
  it('gives Again ratings and legacy entries the Minimum Delay', () => {
    assert.equal(drillCoolingMs({ cardId: 'a', addedAt: 1 }, defaults), 180 * MIN);
    assert.equal(drillCoolingMs('legacy', defaults), 180 * MIN);
    assert.equal(drillReadyAt('legacy', defaults), 0);
  });

  it('cools a Hard card for a share of its interval, between the floor and the cap', () => {
    assert.equal(drillCoolingMs({ cardId: 'h', addedAt: 1, intervalMs: 60 * DAY }, defaults), 3 * DAY);
    assert.equal(drillCoolingMs({ cardId: 'h', addedAt: 1, intervalMs: 365 * DAY }, defaults), 7 * DAY);
    assert.equal(drillCoolingMs({ cardId: 'h', addedAt: 1, intervalMs: 2 * DAY }, defaults), 180 * MIN);
  });

  it('lets the floor win over a cap set below it', () => {
    const c = { ...defaults, hardMaxMs: 0 };
    assert.equal(drillCoolingMs({ cardId: 'h', addedAt: 1, intervalMs: 365 * DAY }, c), 180 * MIN);
  });

  it('counts the wait from when the card entered the drill', () => {
    assert.equal(drillReadyAt({ cardId: 'h', addedAt: 1000, intervalMs: 60 * DAY }, defaults), 1000 + 3 * DAY);
  });

  it('returns a rated card at once only when its rating has no wait at all', () => {
    const noFloor = { ...defaults, minDelayMs: 0 };
    assert.equal(returnsAtOnce(false, noFloor), true);
    assert.equal(returnsAtOnce(true, noFloor), false);
    assert.equal(returnsAtOnce(true, { ...noFloor, hardShare: 0 }), true);
    assert.equal(returnsAtOnce(false, defaults), false);
  });

  it('reads the settings, treating junk as 0 and capping the share at 100%', () => {
    assert.deepEqual(toCooling(180, 5, 7), defaults);
    assert.deepEqual(toCooling(undefined, 250, -3), { minDelayMs: 0, hardShare: 1, hardMaxMs: 0 });
  });

  it('formats waits in minutes, hours or days', () => {
    assert.equal(formatDrillWait(40 * MIN), '40 min');
    assert.equal(formatDrillWait(5 * 60 * MIN), '5 h');
    assert.equal(formatDrillWait(3 * DAY), '3 days');
    assert.equal(formatDrillWait(DAY * 1.6), '2 days');
  });

  it('summarizes one knowledge base: ready, cooling, first release and old entries', () => {
    const now = 100 * DAY;
    const items = [
      'legacy',
      { cardId: 'again-fresh', kbId: 'kb', addedAt: now - 60 * MIN },
      { cardId: 'again-old', kbId: 'kb', addedAt: now - 10 * DAY },
      { cardId: 'hard-cooling', kbId: 'kb', addedAt: now - 5 * DAY, intervalMs: 365 * DAY },
      { cardId: 'other-kb', kbId: 'other', addedAt: now - 10 * DAY },
    ];
    const s = summarizeDrill(items, (i) => typeof i === 'string' || i.kbId === 'kb', defaults, 7, now);
    assert.equal(s.kbItems.length, 4);
    assert.deepEqual(s.readyIds, ['legacy', 'again-old']);
    assert.equal(s.coolingCount, 2);
    assert.equal(s.firstReadyAt, now - 60 * MIN + 180 * MIN);
    // again-old became ready 10 days minus 3 h ago; hard-cooling is not old however long it waited.
    assert.equal(s.oldCount, 1);
  });
});
