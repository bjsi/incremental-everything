/**
 * CSS selector for a tagged Rem shown in the queue's "Extra details" list (Extra Card
 * Detail Rems under the card). The item carries no tags of its own, but the editor
 * nested in it (for the Rem's children) holds a container whose
 * `data-rem-container-tags` name the Rem's tags and powerups, so `:has()` reaches the
 * item through it (saved DOM of the Beautiful queue, 2026-11-13):
 *
 *   .extra-card-detail__item
 *     > .rem-bullet__container > .rem-bullet (> .perfect-circle__inner > svg .rem-bullet__core)
 *     > #hierarchy-editor > #hierarchy-editor-inner
 *         > .container-node[data-rem-container-tags="pronunciation extra-card-detail"]
 *
 * The child combinators keep it to the item's own Rem, not a tagged child of it.
 * Append ` > .rem-bullet__container` (and ` .rem-bullet` …) as the editor rules do
 * after their row selector.
 */
export const extraDetailsItem = (slug: string, ...more: string[]) =>
  `.extra-card-detail__item:has(> #hierarchy-editor > #hierarchy-editor-inner > ` +
  [slug, ...more].map((s) => `[data-rem-container-tags~="${s}"]`).join('') +
  `)`;
