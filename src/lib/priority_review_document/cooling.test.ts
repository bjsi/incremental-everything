/**
 * Fixture tests for the pure cooling engine. Run with `npm test`.
 * Uses node's built-in runner so no test framework is added to the bundle.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cardIntervalDays,
  cardLastSeenAt,
  cardsFromCacheInfo,
  cardTypeTag,
  isBackwardCard,
  pickConceptAncestor,
  isRecentlyCreatedUnseen,
  COOLING_RELATION_LABELS,
  coolingWindowDays,
  DAY_MS,
  DEFAULT_COOLING_PARAMS,
  EMPTY_COOLING_OVERRIDES,
  evaluateCooling,
  excludeCooling,
  isCardDue,
  pruneCoolingOverrides,
  CoolingCandidate,
  SpoilerSeenEvent,
} from './cooling';

const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);
const daysAgo = (d: number) => NOW - d * DAY_MS;

const seen = (over: Partial<SpoilerSeenEvent> = {}): SpoilerSeenEvent => ({
  relation: 'same-rem',
  sourceRemId: 'sib',
  cardId: 'sib-card',
  seenAt: daysAgo(1),
  stillDue: false,
  ...over,
});

const candidate = (over: Partial<CoolingCandidate> = {}): CoolingCandidate => ({
  remId: 'r1',
  dueCards: [{ cardId: 'c1', intervalDays: 100 }],
  seen: [seen()],
  ...over,
});

describe('coolingWindowDays', () => {
  it('follows the documented table with the default parameters', () => {
    assert.equal(coolingWindowDays(10), 1);
    assert.equal(coolingWindowDays(60), 3);
    assert.equal(coolingWindowDays(200), 10);
    assert.equal(coolingWindowDays(365), 15);
    assert.equal(coolingWindowDays(3000), 15);
  });
  it('never drops below the minimum, even for a new card', () => {
    assert.equal(coolingWindowDays(0), 1);
    assert.equal(coolingWindowDays(-5), 1);
  });
  it('honours custom parameters and keeps max >= min', () => {
    assert.equal(coolingWindowDays(100, { intervalFraction: 0.1, minDays: 2, maxDays: 30 }), 10);
    assert.equal(coolingWindowDays(100, { intervalFraction: 0.1, minDays: 20, maxDays: 5 }), 20);
  });
});

describe('card facts', () => {
  it('reads the last VIEWED repetition, ignoring reset and manual entries', () => {
    const card = {
      _id: 'c',
      repetitionHistory: [
        { date: daysAgo(10), score: 1 },
        { date: daysAgo(2), score: 3 }, // RESET
        { date: daysAgo(1), score: 4 }, // MANUAL_DATE
      ],
    };
    assert.equal(cardLastSeenAt(card), daysAgo(10));
  });
  it('counts TOO_EARLY as a viewing', () => {
    assert.equal(cardLastSeenAt({ _id: 'c', repetitionHistory: [{ date: daysAgo(3), score: 0.01 }] }), daysAgo(3));
  });
  it('falls back to lastRepetitionTime and then to null', () => {
    assert.equal(cardLastSeenAt({ _id: 'c', lastRepetitionTime: daysAgo(4) }), daysAgo(4));
    assert.equal(cardLastSeenAt({ _id: 'c' }), null);
  });
  it('derives the interval from next due minus last seen, 0 when unknown', () => {
    const card = { _id: 'c', nextRepetitionTime: daysAgo(-20), repetitionHistory: [{ date: daysAgo(80), score: 1 }] };
    assert.equal(Math.round(cardIntervalDays(card)), 100);
    assert.equal(cardIntervalDays({ _id: 'c', nextRepetitionTime: NOW }), 0);
    assert.equal(cardIntervalDays({ _id: 'c', nextRepetitionTime: daysAgo(5), repetitionHistory: [{ date: daysAgo(1), score: 1 }] }), 0);
  });
  it('treats an unscheduled card as never due', () => {
    assert.equal(isCardDue({ _id: 'c' }, NOW), false);
    assert.equal(isCardDue({ _id: 'c', nextRepetitionTime: null }, NOW), false);
    assert.equal(isCardDue({ _id: 'c', nextRepetitionTime: NOW }, NOW), true);
    assert.equal(isCardDue({ _id: 'c', nextRepetitionTime: NOW + 1 }, NOW), false);
  });
});

describe('evaluateCooling', () => {
  it('cools a rem whose sibling was graded inside the window', () => {
    const v = evaluateCooling(candidate(), NOW);
    assert.ok(v);
    assert.equal(v.windowDays, 5);
    assert.equal(v.until, daysAgo(1) + 5 * DAY_MS);
    assert.equal(v.reasons.length, 1);
    assert.equal(v.reasons[0].relation, 'same-rem');
  });
  it('returns null without due cards', () => {
    assert.equal(evaluateCooling(candidate({ dueCards: [] }), NOW), null);
  });
  it('ignores a sibling that is itself still due', () => {
    assert.equal(evaluateCooling(candidate({ seen: [seen({ stillDue: true })] }), NOW), null);
  });
  it('ignores an event whose window has run out', () => {
    assert.equal(evaluateCooling(candidate({ seen: [seen({ seenAt: daysAgo(6) })] }), NOW), null);
    assert.ok(evaluateCooling(candidate({ seen: [seen({ seenAt: daysAgo(4.9) })] }), NOW));
  });
  it('uses the LONGEST due interval to size the window', () => {
    const v = evaluateCooling(
      candidate({
        dueCards: [
          { cardId: 'a', intervalDays: 10 },
          { cardId: 'b', intervalDays: 400 },
        ],
        seen: [seen({ seenAt: daysAgo(12) })],
      }),
      NOW
    );
    assert.ok(v);
    assert.equal(v.windowDays, 15);
    assert.equal(v.intervalDays, 400);
  });
  it('a new card is buried for the minimum window', () => {
    const v = evaluateCooling(candidate({ dueCards: [{ cardId: 'n', intervalDays: 0 }], seen: [seen({ seenAt: NOW - 3600_000 })] }), NOW);
    assert.ok(v);
    assert.equal(v.windowDays, 1);
  });
  it('cools until the latest reason and lists reasons latest-first', () => {
    const v = evaluateCooling(
      candidate({
        seen: [
          seen({ seenAt: daysAgo(3), relation: 'descendant', sourceRemId: 'd' }),
          seen({ seenAt: daysAgo(1), relation: 'cloze-sibling', sourceRemId: 's' }),
        ],
      }),
      NOW
    );
    assert.ok(v);
    assert.equal(v.until, daysAgo(1) + 5 * DAY_MS);
    assert.deepEqual(v.reasons.map((r) => r.relation), ['cloze-sibling', 'descendant']);
  });
  it('clamps a future seenAt to now', () => {
    const v = evaluateCooling(candidate({ seen: [seen({ seenAt: NOW + DAY_MS })] }), NOW);
    assert.ok(v);
    assert.equal(v.until, NOW + 5 * DAY_MS);
  });

  describe('overrides', () => {
    it('release suppresses events up to the release, not after', () => {
      const overrides = { ...EMPTY_COOLING_OVERRIDES, released: { r1: daysAgo(0.5) } };
      assert.equal(evaluateCooling(candidate(), NOW, DEFAULT_COOLING_PARAMS, overrides), null);
      const later = candidate({ seen: [seen({ seenAt: daysAgo(0.25) })] });
      assert.ok(evaluateCooling(later, NOW, DEFAULT_COOLING_PARAMS, overrides));
    });
    it('never wins over everything', () => {
      const overrides = { ...EMPTY_COOLING_OVERRIDES, never: ['r1'] };
      assert.equal(evaluateCooling(candidate(), NOW, DEFAULT_COOLING_PARAMS, overrides), null);
    });
    it('an extension lengthens cooling and can hold it alone', () => {
      const ext = NOW + 20 * DAY_MS;
      const overrides = { ...EMPTY_COOLING_OVERRIDES, extended: { r1: ext } };
      const v = evaluateCooling(candidate(), NOW, DEFAULT_COOLING_PARAMS, overrides);
      assert.ok(v);
      assert.equal(v.until, ext);
      assert.equal(v.extendedUntil, ext);
      const alone = evaluateCooling(candidate({ seen: [] }), NOW, DEFAULT_COOLING_PARAMS, overrides);
      assert.ok(alone);
      assert.equal(alone.reasons.length, 0);
      assert.equal(alone.until, ext);
    });
    it('an extension shorter than the reasons does not shorten them', () => {
      const overrides = { ...EMPTY_COOLING_OVERRIDES, extended: { r1: NOW + DAY_MS } };
      const v = evaluateCooling(candidate(), NOW, DEFAULT_COOLING_PARAMS, overrides);
      assert.ok(v);
      assert.equal(v.until, daysAgo(1) + 5 * DAY_MS);
      assert.equal(v.extendedUntil, undefined);
    });
    it('an expired extension is ignored', () => {
      const overrides = { ...EMPTY_COOLING_OVERRIDES, extended: { r1: daysAgo(1) } };
      assert.equal(evaluateCooling(candidate({ seen: [] }), NOW, DEFAULT_COOLING_PARAMS, overrides), null);
    });
  });
});

describe('pruneCoolingOverrides', () => {
  it('drops dead releases and past extensions, keeps never', () => {
    const pruned = pruneCoolingOverrides(
      {
        released: { old: daysAgo(16), fresh: daysAgo(2) },
        extended: { past: daysAgo(1), future: NOW + DAY_MS },
        never: ['a', 'a', 'b'],
      },
      NOW
    );
    assert.deepEqual(Object.keys(pruned.released), ['fresh']);
    assert.deepEqual(Object.keys(pruned.extended), ['future']);
    assert.deepEqual(pruned.never, ['a', 'b']);
  });
  it('tolerates a half-missing record', () => {
    const pruned = pruneCoolingOverrides({ released: {}, extended: {}, never: undefined as any }, NOW);
    assert.deepEqual(pruned.never, []);
  });
});

describe('excludeCooling', () => {
  it('filters by remId and is a no-op for an empty set', () => {
    const items = [{ remId: 'a', priority: 1 }, { remId: 'b', priority: 2 }];
    assert.equal(excludeCooling(items, new Set()), items);
    assert.deepEqual(excludeCooling(items, new Set(['a'])), [{ remId: 'b', priority: 2 }]);
  });
});

describe('cardsFromCacheInfo', () => {
  it('rebuilds due and last-seen facts per card, in order', () => {
    const cards = cardsFromCacheInfo({
      remId: 'r',
      cardsNextRep: [NOW - DAY_MS, NOW + 40 * DAY_MS, null],
      cardsLastSeen: [daysAgo(10), daysAgo(1), null],
    });
    assert.equal(cards.length, 3);
    assert.equal(isCardDue(cards[0], NOW), true);
    assert.equal(isCardDue(cards[2], NOW), false);
    assert.equal(cardLastSeenAt(cards[1]), daysAgo(1));
    assert.equal(cardLastSeenAt(cards[2]), null);
    assert.equal(Math.round(cardIntervalDays(cards[1])), 41);
    assert.equal(cards[1]._id, 'r#1');
  });
  it('fails open for an entry built before cardsLastSeen existed', () => {
    const cards = cardsFromCacheInfo({ remId: 'r', cardsNextRep: [NOW - DAY_MS] });
    assert.equal(cardLastSeenAt(cards[0]), null);
  });
  it('drives a same-rem cooling verdict from cache facts alone', () => {
    const cards = cardsFromCacheInfo({
      remId: 'r',
      cardsNextRep: [NOW - DAY_MS, NOW + 99 * DAY_MS],
      cardsLastSeen: [daysAgo(101), daysAgo(1)],
    });
    const due = cards.filter((c) => isCardDue(c, NOW));
    const v = evaluateCooling(
      {
        remId: 'r',
        dueCards: due.map((c) => ({ cardId: c._id, intervalDays: cardIntervalDays(c) })),
        seen: cards
          .filter((c) => !isCardDue(c, NOW))
          .map((c) => ({ relation: 'same-rem' as const, sourceRemId: 'r', cardId: c._id, seenAt: cardLastSeenAt(c)!, stillDue: false })),
      },
      NOW
    );
    assert.ok(v);
    assert.equal(v.reasons[0].cardId, 'r#1');
  });
});

describe('concept-reviewed relation', () => {
  it('tags card directions the way the cache stores them', () => {
    assert.equal(cardTypeTag('forward'), 'forward');
    assert.equal(cardTypeTag('backward'), 'backward');
    assert.equal(cardTypeTag({ clozeId: 'x' }), 'cloze');
    assert.equal(cardTypeTag('cloze'), 'cloze');
    assert.equal(cardTypeTag(undefined), null);
  });
  it('reads backward cards from raw cards and from cache entries alike', () => {
    assert.equal(isBackwardCard({ _id: 'c', type: 'backward' }), true);
    assert.equal(isBackwardCard({ _id: 'c', type: { clozeId: 'z' } }), false);
    const fromCache = cardsFromCacheInfo({
      remId: 'd',
      cardsNextRep: [NOW - DAY_MS, NOW + DAY_MS],
      cardsLastSeen: [daysAgo(700), daysAgo(3)],
      cardsType: ['backward', 'forward'],
    });
    assert.equal(isBackwardCard(fromCache[0]), true);
    assert.equal(isBackwardCard(fromCache[1]), false);
  });
  it('finds the concept past nested descriptors', () => {
    // pode ser transmitido...? -> transmitidos por quem (descriptor) -> Recibos de socorro (concept)
    assert.equal(pickConceptAncestor([{ _id: 'transmitidos', type: 2 }, { _id: 'recibos', type: 1 }]), 'recibos');
    assert.equal(pickConceptAncestor([{ _id: 'flutuacoes', type: 1 }]), 'flutuacoes');
    assert.equal(pickConceptAncestor([{ _id: 'plain-parent', type: 0 }]), 'plain-parent');
    assert.equal(pickConceptAncestor([{ _id: 'a', type: 2 }, { _id: 'b', type: 2 }]), null);
    assert.equal(pickConceptAncestor([]), null);
  });
  it('cools a mature backward card for the full window after its concept was reviewed', () => {
    const v = evaluateCooling(
      {
        remId: 'translation',
        // Backward card: last interval 2 years, so 5% caps at the 15-day maximum.
        dueCards: [{ cardId: 'translation#1', intervalDays: 723 }],
        seen: [
          { relation: 'concept-reviewed', sourceRemId: 'flutuacoes', cardId: 'flutuacoes#0', seenAt: daysAgo(2), stillDue: false },
          { relation: 'concept-reviewed', sourceRemId: 'flutuacoes', cardId: 'flutuacoes#1', seenAt: daysAgo(0.5), stillDue: false },
        ],
      },
      NOW
    );
    assert.ok(v);
    assert.equal(v.windowDays, 15);
    assert.equal(v.reasons[0].relation, 'concept-reviewed');
    assert.equal(COOLING_RELATION_LABELS['concept-reviewed'], 'its concept was reviewed');
  });
});

describe('just-created cooling', () => {
  it('recognises a never-shown card created within the window, and only that', () => {
    const fresh = { _id: 'c', createdAt: NOW - 3600_000, nextRepetitionTime: NOW - 3600_000 + 3000 };
    assert.equal(isRecentlyCreatedUnseen(fresh, NOW, 1), true);
    assert.equal(isRecentlyCreatedUnseen(fresh, NOW, 0), false, '0 days switches it off');
    assert.equal(isRecentlyCreatedUnseen({ ...fresh, createdAt: daysAgo(2) }, NOW, 1), false, 'older than the window');
    // A direction switched back on keeps its old record and history.
    const reEnabled = { _id: 'c', createdAt: NOW - 3600_000, repetitionHistory: [{ date: daysAgo(20), score: 1 }] };
    assert.equal(isRecentlyCreatedUnseen(reEnabled, NOW, 1), false, 'already shown once');
    assert.equal(isRecentlyCreatedUnseen({ _id: 'c' }, NOW, 1), false, 'no creation time');
  });
  it('reads the creation time from cache entries', () => {
    const cards = cardsFromCacheInfo({
      remId: 'r',
      cardsNextRep: [NOW - 1000],
      cardsLastSeen: [null],
      cardsCreatedAt: [NOW - 5000],
    });
    assert.equal(isRecentlyCreatedUnseen(cards[0], NOW, 1), true);
  });
  it('holds for the fixed new-card window, not the interval formula', () => {
    const createdAt = NOW - 6 * 3600_000;
    const v = evaluateCooling(
      {
        remId: 'r',
        dueCards: [{ cardId: 'r#0', intervalDays: 0 }],
        seen: [{ relation: 'just-created', sourceRemId: 'r', cardId: 'r#0', seenAt: createdAt, stillDue: false, windowDays: 3 }],
      },
      NOW
    );
    assert.ok(v);
    assert.equal(v.until, createdAt + 3 * DAY_MS);
    assert.equal(v.windowDays, 3);
    assert.equal(v.reasons[0].relation, 'just-created');
  });
  it('a 0-day new-card window never cools', () => {
    const v = evaluateCooling(
      {
        remId: 'r',
        dueCards: [{ cardId: 'r#0', intervalDays: 0 }],
        seen: [{ relation: 'just-created', sourceRemId: 'r', cardId: 'r#0', seenAt: NOW - 1000, stillDue: false, windowDays: 0 }],
      },
      NOW
    );
    assert.equal(v, null);
  });
});
