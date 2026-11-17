/**
 * The mark of a pronunciation audio Rem ("Add pronunciation"): the Pronunciation
 * powerup's pill shows a speaking-head icon instead of its name, and the Rem's bullet
 * becomes that icon. The bullet carries it too because RemNote shows separate pills
 * only while a Rem has a single tag; with the Extra Card Detail powerup as well, the
 * bar may collapse into a "2 tags" chip (findings/EDITOR_DOM_AND_CSS.md).
 *
 * The pill: RemNote draws a plugin powerup in the row's Tag Bar as a tag pill whose
 * label is the ⚡ `.rem-powerup-icon` plus the name, WITHOUT the `data-test="Applied
 * Powerup Pill <name>"` that the built-in ones (Extra Card Detail) get, outside the
 * Tag Bar (saved DOM, 2026-11-13). So it is matched as the Tag Bar pill holding a
 * powerup icon, in a row whose `data-rem-tags` has `pronunciation`, and only its
 * label (⚡ + name) is swapped for the icon; the ✕ stays. The `data-test` rule stays
 * as a fallback. The bullet: the same slug. Same technique as the sierra-remnote
 * anchor marks.
 *
 * In the queue, the card's "Extra details" list shows the audio Rem with a bullet of
 * its own, reached through lib/extra_details_css.
 */
import { extraDetailsItem } from './extra_details_css';

export const PRONUNCIATION_POWERUP_NAME = 'Pronunciation';
export const PRONUNCIATION_POWERUP_CODE = 'pronunciation';
export const PRONUNCIATION_CSS_ID = 'pronunciation-mark';
/**
 * The 🔊 caption's text colour (RemColor.Brown), which RemNote renders as the class
 * `text-color--brown` and which does not change how an emoji looks. With a single
 * Extra Card Detail Rem, the queue draws the item bare: no bullet, no nested editor,
 * no tags (saved DOM, 2026-11-13), so the coloured caption followed by an audio is
 * how CSS recognises a pronunciation there.
 */
export const PRONUNCIATION_CAPTION_COLOR = 8;
const CAPTION_CLASS = 'text-color--brown';

const SLUG = 'pronunciation';

// Material Icons "record_voice_over" (Apache License 2.0): a head speaking.
const speakingHead = (fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g fill="${fill}">` +
  `<circle cx="9" cy="9" r="4"/>` +
  `<path d="M9 15c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>` +
  `<path d="M16.76 5.36l-1.68 1.69c.84 1.18.84 2.71 0 3.89l1.68 1.69c2.02-2.02 2.02-5.07 0-7.27z"/>` +
  `<path d="M20.07 2l-1.63 1.63c2.77 3.02 2.77 7.56 0 10.74L20.07 16c3.9-3.89 3.91-9.95 0-14z"/>` +
  `</g></svg>`;

const url = (svg: string) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
const LIGHT = url(speakingHead('#0f766e'));
const DARK = url(speakingHead('#5eead4'));

const ROW = `.rn-editor__rem__body[data-rem-tags~="${SLUG}"]`;
/** The pill (a flex box: label, then the ✕). */
const PILLS = [
  `${ROW} .hierarchy-editor__tag-bar__tag:has(.rem-powerup-icon)`,
  `.hierarchy-editor__tag-bar__tag[data-test^="Applied Powerup Pill ${PRONUNCIATION_POWERUP_NAME}"]`,
];
const pills = (prefix = '', suffix = '') => PILLS.map((p) => `${prefix}${p}${suffix}`).join(',\n');
const EDITOR_BULLET = `.rn-editor__rem__body[data-rem-tags~="${SLUG}"] .rem-bullet__container .rem-bullet`;
const EXTRA_DETAILS_BULLET = `${extraDetailsItem(SLUG)} > .rem-bullet__container .rem-bullet`;
/**
 * A lone Extra details item: no bullet of its own, so the mark is drawn in the gutter
 * where the bullet would be. Recognised by its caption (the first rich-text item, in the
 * caption colour) followed by an audio. RemNote puts formatting classes on the item's
 * inner span (empty `class=""` without formatting; renderer read 2026-11-13); the outer
 * span is covered too. No `:has()` inside another `:has()`: CSS forbids it, and the
 * browser would drop the whole rule.
 */
const LONE = `.extra-card-detail__item:not(:has(> .rem-bullet__container))`;
const CAPTION = `.RichTextViewer > [data-linear-editor-item-type="m"]:first-child`;
const LONE_EXTRA_DETAILS = [
  `${LONE}:has(${CAPTION} > .${CAPTION_CLASS}):has(${CAPTION} + [data-linear-editor-item-type="a"])`,
  `${LONE}:has(${CAPTION}.${CAPTION_CLASS} + [data-linear-editor-item-type="a"])`,
];
const lone = (prefix = '', suffix = '') =>
  LONE_EXTRA_DETAILS.map((l) => `${prefix}${l}${suffix}`).join(',\n');
/** Both bullets, each with `prefix` and `suffix` added. */
const bullets = (prefix = '', suffix = '') =>
  [EDITOR_BULLET, EXTRA_DETAILS_BULLET].map((b) => `${prefix}${b}${suffix}`).join(',\n');

export const PRONUNCIATION_CSS = `
/* Pronunciation pill: the icon instead of ⚡ and the name. The icon is drawn on the
   pill itself, a flex box, as a fixed-size first item: on the label it vanished,
   because the label (Tailwind truncate + min-w-0) clips and may shrink to nothing.
   The label is hidden; the ✕ stays. */
${pills('', ' > :not(.rn-tag__close):not([data-test$="Close Button"]):not([data-test^="Remove Applied Powerup"])')} {
  display: none;
}
${pills('', ':before')} {
  content: "";
  flex: 0 0 14px;
  align-self: center;
  width: 14px;
  height: 14px;
  margin: 0 2px 0 3px;
  background: center / contain no-repeat ${LIGHT};
}
${pills('.dark ', ':before')} {
  background-image: ${DARK};
}

/* The bullet becomes the icon (drawn over it, so RemNote's hover ring stays behind),
   in the editor and in the queue's Extra details. */
${bullets('', ' .rem-bullet__core')} {
  fill: transparent;
}
${bullets('', ':after')} {
  content: "";
  position: absolute;
  left: 50%;
  top: 50%;
  width: 15px;
  height: 15px;
  transform: translate(-50%, -50%);
  pointer-events: none;
  background: center / contain no-repeat ${LIGHT};
}
${bullets('.dark ', ':after')} {
  background-image: ${DARK};
}

/* A lone Extra details item (the card has one Extra Card Detail): no bullet is drawn,
   so the mark goes in the gutter where the bullet would be. */
${lone('', ':before')} {
  content: "";
  position: absolute;
  left: -22px;
  top: 6px;
  width: 15px;
  height: 15px;
  pointer-events: none;
  background: center / contain no-repeat ${LIGHT};
}
.dark ${lone('', ':before')} {
  background-image: ${DARK};
}
`;
