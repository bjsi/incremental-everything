/**
 * Tests for the Priority Shield History chart rows. Run with `npm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCardRows, buildIncRemRows, buildPriorityRows, GraphHistory } from './shield_graph_data';

const inc: GraphHistory = {
  '2026-10-01': { absolute: 12, percentile: 3, universeSize: 6000, dismissedCount: 300 },
  '2026-10-02': { absolute: 9, percentile: 2, universeSize: 6010, dismissedCount: 310 },
  '2026-10-03': { absolute: null, percentile: null, universeSize: 6020 }, // flawed
  '2026-11-04': {
    absolute: 9,
    percentile: 1,
    universeSize: 6500,
    dismissedCount: 400,
    unified: {
      absolute: 8,
      percentile: 6.6,
      universeSize: 74800,
      cardCount: 68300,
      incRemAbsolute: 9,
      cardAbsolute: 8,
      weightedShield: 38.9,
    },
  },
};
const card: GraphHistory = {
  '2026-10-01': { absolute: 7, percentile: 5, universeSize: 67000 },
  '2026-10-03': { absolute: 4, percentile: 1, universeSize: 67100 },
  '2026-11-04': { absolute: 8, percentile: 6, universeSize: 68300 },
};

describe('buildPriorityRows', () => {
  const rows = buildPriorityRows(inc, card);

  it('rebuilds days with both sides recorded, and only those', () => {
    // 10-02 has no card entry; 10-03 has a flawed IncRem entry.
    assert.deepEqual(rows.map((r) => r.originalDate), ['2026-10-01', '2026-11-04']);
    const r = rows[0];
    assert.equal(r.rebuilt, true);
    assert.equal(r.absolute, null);
    assert.equal(r.absoluteRebuilt, 7);
    assert.equal(r.relative, null);
    assert.equal(r.weightedShield, null);
    assert.equal(r.cardUniverse, 67000);
    assert.equal(r.incRemUniverse, 6000);
    assert.equal(r.unifiedUniverse, 73000);
    assert.equal(r.dismissedCount, 300);
  });

  it('reads recorded days from entry.unified, bridged to the rebuilt line', () => {
    const r = rows[1];
    assert.equal(r.rebuilt, false);
    assert.equal(r.absolute, 8);
    assert.equal(r.absoluteRebuilt, 8);
    assert.equal(r.relative, 6.6);
    assert.equal(r.weightedShield, 38.9);
    assert.equal(r.cardUniverse, 68300);
    assert.equal(r.incRemUniverse, 6500);
    assert.equal(r.unifiedUniverse, 74800);
  });

  it('leaves recorded days away from rebuilt ones unbridged', () => {
    const only = buildPriorityRows({ '2026-11-04': inc['2026-11-04'] }, {});
    assert.equal(only.length, 1);
    assert.equal(only[0].absoluteRebuilt, null);
  });
});

describe('buildCardRows / buildIncRemRows', () => {
  it('keep their own fields, sorted, flawed days out', () => {
    assert.deepEqual(buildCardRows(card).map((r) => r.absolute), [7, 4, 8]);
    const incRows = buildIncRemRows(inc);
    assert.deepEqual(incRows.map((r) => r.absolute), [12, 9, 9]);
    assert.equal(incRows[0].totalUniverse, 6300);
    assert.equal(Math.round(incRows[2].processingPercentage * 10) / 10, 5.8);
  });
});
