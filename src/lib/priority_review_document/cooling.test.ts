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
  coolingReasonText,
  dueAnswerLineIds,
  startOfLocalDay,
  coolingWindowDays,
  DAY_MS,
  DEFAULT_COOLING_PARAMS,
  EMPTY_COOLING_OVERRIDES,
  evaluateCooling,
  excludeCooling,
  isCardDue,
  isImageOcclusionText,
  pruneCoolingOverrides,
  CoolingCandidate,
  SpoilerSeenEvent,
  RATED_CARD_MIN_GAP_MS,
  withSessionRatings,
  withoutOwnSightings,
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

describe('withSessionRatings', () => {
  const unseen = { _id: 'c1', nextRepetitionTime: daysAgo(3), repetitionHistory: [] };
  it('adds a rating the read does not have yet, not due for an hour', () => {
    const at = NOW - 1000;
    const [card] = withSessionRatings([unseen], new Map([['c1', at]]));
    assert.equal(cardLastSeenAt(card), at);
    assert.equal(card.nextRepetitionTime, at + RATED_CARD_MIN_GAP_MS);
    assert.equal(isCardDue(card, NOW), false);
  });
  it('keeps a card whose history already holds the rating', () => {
    const stored = { ...unseen, repetitionHistory: [{ date: NOW - 1200, score: 1 }], nextRepetitionTime: NOW + 40 * DAY_MS };
    const [card] = withSessionRatings([stored], new Map([['c1', NOW - 1000]]));
    assert.equal(card, stored);
  });
  it('leaves cards the session did not rate alone', () => {
    const cards = withSessionRatings([unseen], new Map([['other', NOW]]));
    assert.equal(cards[0], unseen);
  });
  it('adds a rating whose card has no fact of its own (card-cache facts have no real ids)', () => {
    const cacheFact = { _id: 'r#0', nextRepetitionTime: daysAgo(3) };
    const cards = withSessionRatings([cacheFact], new Map([['realCardId', NOW - 500]]));
    assert.equal(cards.length, 2);
    assert.equal(cards[0], cacheFact);
    assert.equal(cardLastSeenAt(cards[1]), NOW - 500);
    assert.equal(isCardDue(cards[1], NOW), false);
  });
  it('a sibling rated moments ago cools the Rem at once', () => {
    const [sibling] = withSessionRatings([{ ...unseen, _id: 'sib' }], new Map([['sib', NOW - 500]]));
    const v = evaluateCooling(
      {
        remId: 'r',
        dueCards: [{ cardId: 'c2', intervalDays: 0 }],
        seen: [{ relation: 'same-rem', sourceRemId: 'r', cardId: 'sib', seenAt: cardLastSeenAt(sibling)!, stillDue: isCardDue(sibling, NOW) }],
      },
      NOW
    );
    assert.ok(v);
  });
});

describe('withoutOwnSightings', () => {
  // The Sep 2026 case: a one-card Rem whose card the queue left behind unrated. Cache facts
  // carry positional ids, so the session sighting lands beside the card's own due fact.
  const cacheFact = { _id: 'r#0', nextRepetitionTime: daysAgo(10), lastRepetitionTime: daysAgo(28) };
  const facts = withSessionRatings([cacheFact], new Map([['realA', NOW - 120_000]]));
  const candidate = (cards: typeof facts): CoolingCandidate => ({
    remId: 'r',
    dueCards: cards.filter((c) => isCardDue(c, NOW)).map((c) => ({ cardId: c._id, intervalDays: cardIntervalDays(c) })),
    seen: cards
      .filter((c) => !isCardDue(c, NOW) && cardLastSeenAt(c) !== null)
      .map((c) => ({ relation: 'same-rem' as const, sourceRemId: 'r', cardId: c._id, seenAt: cardLastSeenAt(c)!, stillDue: false })),
  });

  it('the Rem-wide verdict names the card itself as "another card"', () => {
    const v = evaluateCooling(candidate(facts), NOW);
    assert.ok(v);
    assert.equal(v!.reasons[0].cardId, 'realA');
  });
  it('the card itself is not held by its own sighting', () => {
    assert.equal(evaluateCooling(withoutOwnSightings(candidate(facts), 'realA'), NOW), null);
  });
  it('a sibling seen in the session still holds it', () => {
    const both = withSessionRatings([cacheFact], new Map([['realA', NOW - 120_000], ['realB', NOW - 60_000]]));
    const v = evaluateCooling(withoutOwnSightings(candidate(both), 'realA'), NOW);
    assert.ok(v);
    assert.deepEqual(v!.reasons.map((r) => r.cardId), ['realB']);
  });
  it('keeps a user extension', () => {
    const overrides = { ...EMPTY_COOLING_OVERRIDES, extended: { r: NOW + DAY_MS } };
    const v = evaluateCooling(withoutOwnSightings(candidate(facts), 'realA'), NOW, DEFAULT_COOLING_PARAMS, overrides);
    assert.equal(v?.until, NOW + DAY_MS);
  });
  it('leaves other relations naming the card alone, and returns the same object when nothing drops', () => {
    const c: CoolingCandidate = {
      remId: 'r',
      dueCards: [{ cardId: 'a', intervalDays: 0 }],
      seen: [{ relation: 'just-created', sourceRemId: 'r', cardId: 'a', seenAt: NOW - 1000, stillDue: false, windowDays: 1 }],
    };
    assert.equal(withoutOwnSightings(c, 'a'), c);
  });
});

describe('multi-line cards: answer lines first', () => {
  // "which short lines?" (interval 38 d → 2-day window) with two answer lines, "forward" and "aft".
  const hold = (over: Partial<SpoilerSeenEvent> = {}): SpoilerSeenEvent => ({
    relation: 'answer-line-due',
    sourceRemId: 'forward',
    cardId: 'forward-card',
    seenAt: daysAgo(30), // came due a month ago
    stillDue: true,
    whileDue: true,
    ...over,
  });
  const multiLine = (seen: SpoilerSeenEvent[]): CoolingCandidate => ({
    remId: 'which',
    dueCards: [{ cardId: 'which-card', intervalDays: 38 }],
    seen,
  });

  it('holds the multi-line card while an answer line is due, a full window from now', () => {
    const v = evaluateCooling(multiLine([hold()]), NOW);
    assert.ok(v);
    assert.equal(v!.reasons[0].relation, 'answer-line-due');
    assert.equal(v!.until, NOW + coolingWindowDays(38) * DAY_MS);
  });
  it('lets the hold go once the answer line is no longer due, and cools from its review instead', () => {
    const reviewed = hold({ stillDue: false });
    assert.equal(evaluateCooling(multiLine([reviewed]), NOW), null);
    const v = evaluateCooling(
      multiLine([reviewed, seen({ relation: 'answer-line', sourceRemId: 'forward', seenAt: NOW - 3_600_000 })]),
      NOW
    );
    assert.ok(v);
    assert.equal(v!.reasons[0].relation, 'answer-line');
    assert.equal(v!.until, NOW - 3_600_000 + coolingWindowDays(38) * DAY_MS);
  });
  it('an answer line still due is no sighting: its own review, not its due card, cools the parent', () => {
    const dueLine = seen({ relation: 'answer-line', sourceRemId: 'forward', seenAt: daysAgo(1), stillDue: true });
    assert.equal(evaluateCooling(multiLine([dueLine]), NOW), null);
  });
  it('a release lets the hold go until the answer line comes due again', () => {
    const released = { ...EMPTY_COOLING_OVERRIDES, released: { which: daysAgo(1) } };
    assert.equal(evaluateCooling(multiLine([hold()]), NOW, DEFAULT_COOLING_PARAMS, released), null);
    const dueAgain = hold({ seenAt: NOW - 60_000 });
    assert.ok(evaluateCooling(multiLine([dueAgain]), NOW, DEFAULT_COOLING_PARAMS, released));
  });
  it('"never cool" covers the hold too', () => {
    const never = { ...EMPTY_COOLING_OVERRIDES, never: ['which'] };
    assert.equal(evaluateCooling(multiLine([hold()]), NOW, DEFAULT_COOLING_PARAMS, never), null);
  });
  it('lists the answer lines it waits for, once each', () => {
    const v = evaluateCooling(
      multiLine([hold(), hold({ cardId: 'forward-card-2' }), hold({ sourceRemId: 'aft', cardId: 'aft-card' })]),
      NOW
    );
    assert.deepEqual(dueAnswerLineIds(v!).sort(), ['aft', 'forward']);
  });
  it('describes the hold without an "ago"', () => {
    assert.equal(coolingReasonText('answer-line-due', '3 days ago'), COOLING_RELATION_LABELS['answer-line-due']);
    assert.equal(coolingReasonText('answer-line', '3 days ago'), `${COOLING_RELATION_LABELS['answer-line']} 3 days ago`);
  });
});

describe('the shield judges cooling over the whole local day', () => {
  // The Sep 29 case: a card created at 20:55 the day before, never shown, cools for one day.
  const created = startOfLocalDay(NOW) - 3 * 3_600_000 - 5 * 60_000; // 20:55 yesterday
  const newCard: CoolingCandidate = {
    remId: 'new',
    dueCards: [{ cardId: 'n', intervalDays: 0 }],
    seen: [{ relation: 'just-created', sourceRemId: 'new', cardId: 'n', seenAt: created, stillDue: false, windowDays: 1 }],
  };
  const afterWindow = created + DAY_MS + 60 * 60_000; // 21:55 today

  it('the queue lets the card go once its window has closed', () => {
    assert.equal(evaluateCooling(newCard, afterWindow), null);
  });
  it('the shield keeps it out for the rest of the day', () => {
    const v = evaluateCooling(newCard, afterWindow, DEFAULT_COOLING_PARAMS, EMPTY_COOLING_OVERRIDES, startOfLocalDay(afterWindow));
    assert.ok(v);
    assert.equal(v!.until, created + DAY_MS);
  });
  it('and counts it again from the next day', () => {
    const tomorrow = startOfLocalDay(afterWindow) + DAY_MS + 3_600_000;
    assert.equal(evaluateCooling(newCard, tomorrow, DEFAULT_COOLING_PARAMS, EMPTY_COOLING_OVERRIDES, startOfLocalDay(tomorrow)), null);
  });
  it('a window that closed before the day began does not count', () => {
    const old: CoolingCandidate = { ...newCard, seen: [{ ...newCard.seen[0], seenAt: created - 2 * DAY_MS }] };
    assert.equal(evaluateCooling(old, afterWindow, DEFAULT_COOLING_PARAMS, EMPTY_COOLING_OVERRIDES, startOfLocalDay(afterWindow)), null);
  });
  it('a horizon in the future is clamped to now', () => {
    assert.equal(evaluateCooling(newCard, afterWindow, DEFAULT_COOLING_PARAMS, EMPTY_COOLING_OVERRIDES, afterWindow + DAY_MS), null);
  });
});

describe('multi-line cards: the other way round', () => {
  it('an answer line cools after its multi-line card was reviewed', () => {
    const line: CoolingCandidate = {
      remId: 'forward',
      dueCards: [{ cardId: 'f', intervalDays: 60 }],
      seen: [seen({ relation: 'multi-line-card', sourceRemId: 'which', cardId: 'which-card', seenAt: NOW - 3_600_000 })],
    };
    const v = evaluateCooling(line, NOW);
    assert.ok(v);
    assert.equal(v!.reasons[0].relation, 'multi-line-card');
    assert.equal(coolingReasonText('multi-line-card', '1 h ago'), 'its multi-line card was reviewed 1 h ago');
  });
});

describe('image occlusion Rems are exempt', () => {
  const occlusion = {
    i: 'i',
    url: '%LOCAL_FILE%x.png',
    blocks: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.1, rotation: 0, cId: '1', label: [], frontLabel: [] }],
    practiceInOrder: false,
  };

  it('detects an image with occlusion boxes, in the front or the back', () => {
    assert.equal(isImageOcclusionText(['Planos do Casco\n\n', occlusion]), true);
    assert.equal(isImageOcclusionText(['front'], [occlusion]), true);
  });

  it('ignores plain images, empty box lists and text', () => {
    assert.equal(isImageOcclusionText(['caption', { i: 'i', url: 'x.png' }]), false);
    assert.equal(isImageOcclusionText([{ ...occlusion, blocks: [] }]), false);
    assert.equal(isImageOcclusionText(['text', { i: 'q', _id: 'x' }], undefined), false);
  });
});
