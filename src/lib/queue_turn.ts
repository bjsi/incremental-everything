// A counter of queue turns, bumped synchronously by the queue events, so a
// command can tell whether the queue moved on between the keypress and the
// moment it learned which card was on screen.
//
// Why it is needed: a command learns the card through bridge calls
// (getCurrentCard, getSelection, …), and those wait behind whatever else the
// plugin is doing. A card priority cache flush takes 2-3 s and keeps this
// iframe busy, so keypresses reach the command in bursts (several with the same
// Date.now()). A press made before rating could then resolve "the card on
// screen" after the queue had already shown the next one, and change that card.
//
// Host messages reach this iframe in the order they were sent, so the turn read
// on the first synchronous line of a command action is the turn of the
// keypress. Must be registered in the same iframe as the commands (index).
//
// Known gap: Card Cluster siblings advance without a queue event, so moving
// between siblings does not bump the turn.

import { AppEvents, RNPlugin } from '@remnote/plugin-sdk';

let turn = 0;
// Bumped on every editor selection change: a previewer selection can outrank
// the card, so a resolution made before it is no longer valid for later presses.
let selectionEpoch = 0;

/** The current queue turn. */
export function currentQueueTurn(): number {
  return turn;
}

export type QueuePress = { turn: number; epoch: number };

/** Where the queue and the selection stood at the keypress. Call it on the
 *  first synchronous line of the command action, before any await. */
export function captureQueuePress(): QueuePress {
  return { turn, epoch: selectionEpoch };
}

export function registerQueueTurnTracking(plugin: RNPlugin) {
  const bump = () => {
    turn++;
  };
  // QueueLoadCard fires on every card change, with or without a cardId (IncRem
  // turns have none). QueueCompleteCard comes first, on the rating itself.
  plugin.event.addListener(AppEvents.QueueLoadCard, undefined, bump);
  plugin.event.addListener(AppEvents.QueueCompleteCard, undefined, bump);
  plugin.event.addListener(AppEvents.QueueExit, undefined, bump);
  plugin.event.addListener(AppEvents.QueueEnter, undefined, bump);
  plugin.event.addListener(AppEvents.EditorSelectionChanged, undefined, () => {
    selectionEpoch++;
  });
}

export type TurnResolution<T> = { status: 'ok'; value: T | undefined } | { status: 'moved' };

/**
 * One target resolution per queue turn, shared by every press of that turn.
 *
 * The first press of a turn starts the resolution; later presses of the same
 * turn await the same promise rather than asking the bridge again, so they all
 * land on the card that was on screen when they were pressed, even when they
 * run after the queue has moved. A selection change starts a new resolution.
 *
 * A resolution is accepted only if the queue did not move while it ran;
 * otherwise it reports `moved`, and the caller must not guess.
 */
export function createTurnTargetResolver<T>(
  resolve: (plugin: RNPlugin) => Promise<T | undefined>
) {
  let memo: { turn: number; epoch: number; promise: Promise<TurnResolution<T>> } | undefined;

  return (plugin: RNPlugin, press: QueuePress): Promise<TurnResolution<T>> => {
    if (memo && memo.turn === press.turn && memo.epoch === press.epoch) {
      return memo.promise;
    }
    // Too late to look: whatever is on screen now is not what was pressed on.
    // (A selection change alone is the user's own doing, so it may be read live.)
    if (turn !== press.turn) {
      return Promise.resolve({ status: 'moved' });
    }
    const promise = resolve(plugin).then(
      (value): TurnResolution<T> =>
        turn === press.turn ? { status: 'ok', value } : { status: 'moved' }
    );
    memo = { turn: press.turn, epoch: selectionEpoch, promise };
    return promise;
  };
}
