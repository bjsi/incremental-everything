import { BuiltInPowerupCodes, PluginRem } from '@remnote/plugin-sdk';

/**
 * Multi-line cards and their answer lines.
 *
 * A multi-line card (`>>>`) shows its Rem as the question and, on the back, the
 * children marked as CARD ITEMS — its answer lines. RemNote marks each of those
 * children with the MultiLineCard powerup (`w`): `getIsCardItem()` in the app is
 * `hasPowerup(MultiLineCard)`, and nothing on the parent says it is multi-line
 * (checked in remnote.db, Sep 2026: the parent carries no `w`; only its answer
 * lines do). Other children of a multi-line card — an image, a note tagged as
 * Extra Card Detail — are not part of its answer.
 *
 * When answer lines have cards of their own, the cooling order is inverted: the
 * answer lines go first, and the multi-line card waits for them and then cools
 * from their review (cooling.ts, `answer-line` / `answer-line-due`). Every
 * top-down rule — the ancestor swap, the shield's cooling-ancestor hold — skips
 * the parent of an answer line for the same reason.
 */
export async function isAnswerLine(rem: PluginRem): Promise<boolean> {
  try {
    return await rem.hasPowerup(BuiltInPowerupCodes.MultiLineCard);
  } catch {
    return false;
  }
}
