import { ReactRNPlugin } from '@remnote/plugin-sdk';

/* Powerup codes — applied to a Rem via rem.addPowerup(<code>).
   RemNote slugifies the camelCase code to kebab-case in the rendered
   data attribute (e.g. `hideInQueue` → `data-queue-rem-container-tags~="hide-in-queue"`). */

/* CORE — always registered. The Cloze and Extract creators apply Remove Parent
   to newly-created rems, so the powerup must always exist. Remove Grandparent
   is bundled with it for symmetry. Neither exists in the standalone Hide in
   Queue plugin, so they cannot collide with it. */
export const REMOVE_PARENT_POWERUP_CODE = 'removeParent';
export const REMOVE_GRANDPARENT_POWERUP_CODE = 'removeGrandparent';

/* LEGACY — registered only when the user enables the Hide-in-Queue integration
   setting. Codes match the standalone Hide in Queue plugin exactly, so users
   must uninstall that plugin before enabling our integration to avoid a
   "Duplicated powerup" error from RemNote. */
export const HIDE_IN_QUEUE_POWERUP_CODE = 'hideInQueue';
export const REMOVE_FROM_QUEUE_POWERUP_CODE = 'removeFromQueue';
export const NO_HIERARCHY_POWERUP_CODE = 'noHierarchy';
export const HIDE_PARENT_POWERUP_CODE = 'hideParent';
export const HIDE_GRANDPARENT_POWERUP_CODE = 'hideGrandparent';

/* CORE CSS — covers Remove Parent, Remove Grandparent, and Remove from Queue.

   Why Remove from Queue is here (not in LEGACY_CSS):
   - The createExtract flow falls back on Remove Parent only when Remove from
     Queue is unavailable. When it IS available, it tags the PARENT, and we
     need that to render whether or not our integration is on (the standalone
     Hide in Queue plugin also registers an equivalent rule, so duplication
     when both exist is harmless).
   - Existing extracts created before the powerup migration carry a legacy
     tag-rem named "remove-from-queue" on their parent. Keeping the CSS
     always-on preserves the rendering for that legacy data even for users
     who have neither our integration enabled nor the standalone plugin.

   Both selector forms (`~="remove-parent"` and `~="removeparent"`) are
   included defensively to cover any RemNote-side slugification differences
   between powerup-applied tags and legacy tag-rem-applied tags. */
const CORE_CSS = `
/* ===== Remove from Queue ===== */
.rn-queue__content [data-queue-rem-container-tags~="remove-from-queue"]:not(.rn-question-rem) > .rn-queue-rem,
.rn-queue__content [data-queue-rem-container-tags~="removefromqueue"]:not(.rn-question-rem) > .rn-queue-rem {
  display: none;
}

.rn-queue__content [data-queue-rem-container-tags~="remove-from-queue"]:not(.rn-question-rem),
.rn-queue__content [data-queue-rem-container-tags~="removefromqueue"]:not(.rn-question-rem),
.rn-breadcrumb-item[data-rem-tags~="remove-from-queue"],
.rn-breadcrumb-item[data-rem-tags~="removefromqueue"] {
  margin-left: 0px !important;
}

/* ===== Remove Parent =====
   Like hide-parent but: (a) applies on BOTH front and back (no --answer-hidden gate)
   and (b) hides .rn-queue-rem outright instead of leaving a "Hidden in queue" stub. */
.rn-queue__content .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="remove-parent"]) > .RichTextViewer,
.rn-queue__content .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="removeparent"]) > .RichTextViewer,
.rn-queue__content .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="remove-parent"]) > .rn-flashcard-delimiter,
.rn-queue__content .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="removeparent"]) > .rn-flashcard-delimiter,
.rn-queue__content .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="remove-parent"]) > .rn-queue-rem,
.rn-queue__content .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="removeparent"]) > .rn-queue-rem,
.rn-queue__content .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="remove-parent"]) > .rem-bullet__document,
.rn-queue__content .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="removeparent"]) > .rem-bullet__document {
  display: none !important;
}

.rn-queue__content .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="remove-parent"]),
.rn-queue__content .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="removeparent"]) {
  margin-left: 0px !important;
}

/* ===== Remove Grandparent =====
   Same as Remove Parent but matches one level up via :has(> .indented-rem > …). */
.rn-queue__content .indented-rem:has(> .indented-rem > .rn-question-rem[data-queue-rem-container-tags~="remove-grandparent"]) > .RichTextViewer,
.rn-queue__content .indented-rem:has(> .indented-rem > .rn-question-rem[data-queue-rem-container-tags~="removegrandparent"]) > .RichTextViewer,
.rn-queue__content .indented-rem:has(> .indented-rem > .rn-question-rem[data-queue-rem-container-tags~="remove-grandparent"]) > .rn-flashcard-delimiter,
.rn-queue__content .indented-rem:has(> .indented-rem > .rn-question-rem[data-queue-rem-container-tags~="removegrandparent"]) > .rn-flashcard-delimiter,
.rn-queue__content .indented-rem:has(> .indented-rem > .rn-question-rem[data-queue-rem-container-tags~="remove-grandparent"]) > .rn-queue-rem,
.rn-queue__content .indented-rem:has(> .indented-rem > .rn-question-rem[data-queue-rem-container-tags~="removegrandparent"]) > .rn-queue-rem,
.rn-queue__content .indented-rem:has(> .indented-rem > .rn-question-rem[data-queue-rem-container-tags~="remove-grandparent"]) > .rem-bullet__document,
.rn-queue__content .indented-rem:has(> .indented-rem > .rn-question-rem[data-queue-rem-container-tags~="removegrandparent"]) > .rem-bullet__document {
  display: none !important;
}

.rn-queue__content .indented-rem:has(> .indented-rem > .rn-question-rem[data-queue-rem-container-tags~="remove-grandparent"]),
.rn-queue__content .indented-rem:has(> .indented-rem > .rn-question-rem[data-queue-rem-container-tags~="removegrandparent"]) {
  margin-left: 0px !important;
}
`;

/* LEGACY CSS — Hide in Queue, No Hierarchy, Hide Parent, Hide Grandparent.
   Remove from Queue's CSS lives in CORE_CSS (always-on) — see comment there. */
const LEGACY_CSS = `
/* ===== Hide in Queue ===== */
.rn-queue__content--answer-hidden [data-queue-rem-container-tags~="hide-in-queue"]:not(.rn-question-rem) > .RichTextViewer,
.rn-queue__content--answer-hidden [data-queue-rem-container-tags~="hideinqueue"]:not(.rn-question-rem) > .RichTextViewer,
.rn-queue__content--answer-hidden [data-queue-rem-container-tags~="hide-in-queue"]:not(.rn-question-rem) > .rn-flashcard-delimiter,
.rn-queue__content--answer-hidden [data-queue-rem-container-tags~="hideinqueue"]:not(.rn-question-rem) > .rn-flashcard-delimiter,
.rn-queue__content--answer-hidden [data-queue-rem-container-tags~="hide-in-queue"]:not(.rn-question-rem) > .rn-queue-rem > .RichTextViewer,
.rn-queue__content--answer-hidden [data-queue-rem-container-tags~="hideinqueue"]:not(.rn-question-rem) > .rn-queue-rem > .RichTextViewer,
.rn-queue__content--answer-hidden [data-queue-rem-container-tags~="hide-in-queue"]:not(.rn-question-rem) > .rem-bullet__document,
.rn-queue__content--answer-hidden [data-queue-rem-container-tags~="hideinqueue"]:not(.rn-question-rem) > .rem-bullet__document {
  display: none;
}

.rn-queue__content--answer-hidden [data-queue-rem-container-tags~="hide-in-queue"]:not(.rn-question-rem) > .rn-queue-rem > .rn-bullet-container,
.rn-queue__content--answer-hidden [data-queue-rem-container-tags~="hideinqueue"]:not(.rn-question-rem) > .rn-queue-rem > .rn-bullet-container,
.rn-queue__content--answer-hidden [data-queue-rem-container-tags~="hide-in-queue"]:not(.rn-question-rem) > .rn-queue-rem > .rem-bullet__document,
.rn-queue__content--answer-hidden [data-queue-rem-container-tags~="hideinqueue"]:not(.rn-question-rem) > .rn-queue-rem > .rem-bullet__document {
  position: relative;
}

.rn-queue__content--answer-hidden [data-queue-rem-container-tags~="hide-in-queue"]:not(.rn-question-rem) > .rn-queue-rem > .rn-bullet-container:after,
.rn-queue__content--answer-hidden [data-queue-rem-container-tags~="hideinqueue"]:not(.rn-question-rem) > .rn-queue-rem > .rn-bullet-container:after,
.rn-queue__content--answer-hidden [data-queue-rem-container-tags~="hide-in-queue"]:not(.rn-question-rem) > .rn-queue-rem > .rem-bullet__document:after,
.rn-queue__content--answer-hidden [data-queue-rem-container-tags~="hideinqueue"]:not(.rn-question-rem) > .rn-queue-rem > .rem-bullet__document:after {
  content: "Hidden in queue";
  opacity: .3;
  white-space: nowrap;
  position: absolute;
  left: 25px;
  top: 0;
}

/* ===== No Hierarchy ===== */
.rn-queue__content:has(.rn-question-rem[data-queue-rem-container-tags~="no-hierarchy"]) .indented-rem:not(.rn-question-rem),
.rn-queue__content:has(.rn-question-rem[data-queue-rem-container-tags~="nohierarchy"]) .indented-rem:not(.rn-question-rem) {
  margin-left: 0px !important;
}

.rn-queue__content:has(.rn-question-rem[data-queue-rem-container-tags~="no-hierarchy"]) .indented-rem:not(.rn-question-rem) > .rn-queue-rem,
.rn-queue__content:has(.rn-question-rem[data-queue-rem-container-tags~="nohierarchy"]) .indented-rem:not(.rn-question-rem) > .rn-queue-rem,
.rn-queue__content:has(.rn-question-rem[data-queue-rem-container-tags~="no-hierarchy"]) .indented-rem:not(.rn-question-rem) > .rn-flashcard-delimiter,
.rn-queue__content:has(.rn-question-rem[data-queue-rem-container-tags~="nohierarchy"]) .indented-rem:not(.rn-question-rem) > .rn-flashcard-delimiter,
.rn-queue__content:has(.rn-question-rem[data-queue-rem-container-tags~="no-hierarchy"]) .indented-rem:not(.rn-question-rem) > .RichTextViewer,
.rn-queue__content:has(.rn-question-rem[data-queue-rem-container-tags~="nohierarchy"]) .indented-rem:not(.rn-question-rem) > .RichTextViewer {
  display: none;
}

/* ===== Hide Parent ===== */
.rn-queue__content--answer-hidden .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="hide-parent"]) > .RichTextViewer,
.rn-queue__content--answer-hidden .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="hideparent"]) > .RichTextViewer,
.rn-queue__content--answer-hidden .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="hide-parent"]) > .rn-flashcard-delimiter,
.rn-queue__content--answer-hidden .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="hideparent"]) > .rn-flashcard-delimiter,
.rn-queue__content--answer-hidden .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="hide-parent"]) > .rn-queue-rem > .RichTextViewer,
.rn-queue__content--answer-hidden .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="hideparent"]) > .rn-queue-rem > .RichTextViewer,
.rn-queue__content--answer-hidden .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="hide-parent"]) > .rem-bullet__document,
.rn-queue__content--answer-hidden .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="hideparent"]) > .rem-bullet__document {
  display: none !important;
}

.rn-queue__content--answer-hidden .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="hide-parent"]) > .rn-queue-rem > .rn-bullet-container,
.rn-queue__content--answer-hidden .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="hideparent"]) > .rn-queue-rem > .rn-bullet-container,
.rn-queue__content--answer-hidden .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="hide-parent"]) > .rn-queue-rem > .rem-bullet__document,
.rn-queue__content--answer-hidden .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="hideparent"]) > .rn-queue-rem > .rem-bullet__document {
  position: relative;
}

.rn-queue__content--answer-hidden .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="hide-parent"]) > .rn-queue-rem > .rn-bullet-container:after,
.rn-queue__content--answer-hidden .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="hideparent"]) > .rn-queue-rem > .rn-bullet-container:after,
.rn-queue__content--answer-hidden .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="hide-parent"]) > .rn-queue-rem > .rem-bullet__document:after,
.rn-queue__content--answer-hidden .indented-rem:has(> .rn-question-rem[data-queue-rem-container-tags~="hideparent"]) > .rn-queue-rem > .rem-bullet__document:after {
  content: "Hidden in queue";
  opacity: .3;
  white-space: nowrap;
  position: absolute;
  left: 25px;
  top: 0;
}

/* ===== Hide Grandparent ===== */
.rn-queue__content--answer-hidden .indented-rem:has(> .indented-rem > .rn-question-rem[data-queue-rem-container-tags~="hide-grandparent"]) > .RichTextViewer,
.rn-queue__content--answer-hidden .indented-rem:has(> .indented-rem > .rn-question-rem[data-queue-rem-container-tags~="hidegrandparent"]) > .RichTextViewer,
.rn-queue__content--answer-hidden .indented-rem:has(> .indented-rem > .rn-question-rem[data-queue-rem-container-tags~="hide-grandparent"]) > .rn-flashcard-delimiter,
.rn-queue__content--answer-hidden .indented-rem:has(> .indented-rem > .rn-question-rem[data-queue-rem-container-tags~="hidegrandparent"]) > .rn-flashcard-delimiter,
.rn-queue__content--answer-hidden .indented-rem:has(> .indented-rem > .rn-question-rem[data-queue-rem-container-tags~="hide-grandparent"]) > .rn-queue-rem > .RichTextViewer,
.rn-queue__content--answer-hidden .indented-rem:has(> .indented-rem > .rn-question-rem[data-queue-rem-container-tags~="hidegrandparent"]) > .rn-queue-rem > .RichTextViewer,
.rn-queue__content--answer-hidden .indented-rem:has(> .indented-rem > .rn-question-rem[data-queue-rem-container-tags~="hide-grandparent"]) > .rem-bullet__document,
.rn-queue__content--answer-hidden .indented-rem:has(> .indented-rem > .rn-question-rem[data-queue-rem-container-tags~="hidegrandparent"]) > .rem-bullet__document {
  display: none !important;
}

.rn-queue__content--answer-hidden .indented-rem:has(> .indented-rem > .rn-question-rem[data-queue-rem-container-tags~="hide-grandparent"]) > .rn-queue-rem > .rn-bullet-container,
.rn-queue__content--answer-hidden .indented-rem:has(> .indented-rem > .rn-question-rem[data-queue-rem-container-tags~="hidegrandparent"]) > .rn-queue-rem > .rn-bullet-container,
.rn-queue__content--answer-hidden .indented-rem:has(> .indented-rem > .rn-question-rem[data-queue-rem-container-tags~="hide-grandparent"]) > .rn-queue-rem > .rem-bullet__document,
.rn-queue__content--answer-hidden .indented-rem:has(> .indented-rem > .rn-question-rem[data-queue-rem-container-tags~="hidegrandparent"]) > .rn-queue-rem > .rem-bullet__document {
  position: relative;
}

.rn-queue__content--answer-hidden .indented-rem:has(> .indented-rem > .rn-question-rem[data-queue-rem-container-tags~="hide-grandparent"]) > .rn-queue-rem > .rn-bullet-container:after,
.rn-queue__content--answer-hidden .indented-rem:has(> .indented-rem > .rn-question-rem[data-queue-rem-container-tags~="hidegrandparent"]) > .rn-queue-rem > .rn-bullet-container:after,
.rn-queue__content--answer-hidden .indented-rem:has(> .indented-rem > .rn-question-rem[data-queue-rem-container-tags~="hide-grandparent"]) > .rn-queue-rem > .rem-bullet__document:after,
.rn-queue__content--answer-hidden .indented-rem:has(> .indented-rem > .rn-question-rem[data-queue-rem-container-tags~="hidegrandparent"]) > .rn-queue-rem > .rem-bullet__document:after {
  content: "Hidden in queue";
  opacity: .3;
  white-space: nowrap;
  position: absolute;
  left: 25px;
  top: 0;
}
`;

/* Always-on: Remove Parent + Remove Grandparent powerups + their CSS.
   Required by createClozeDeletion / createExtract regardless of the
   Hide-in-Queue integration setting. */
export async function registerCoreQueueDisplayPowerups(plugin: ReactRNPlugin) {
  await plugin.app.registerPowerup({
    name: 'Remove Parent',
    code: REMOVE_PARENT_POWERUP_CODE,
    description:
      'Completely removes the immediate parent of the tagged Rem from the queue (front and back, no placeholder). ' +
      'Useful for clozes whose parent has other descendants with their own flashcards.',
    options: { slots: [] },
  });

  await plugin.app.registerPowerup({
    name: 'Remove Grandparent',
    code: REMOVE_GRANDPARENT_POWERUP_CODE,
    description:
      'Completely removes the grandparent of the tagged Rem from the queue (front and back, no placeholder).',
    options: { slots: [] },
  });

  await plugin.app.registerCSS('queue-display-core-css', CORE_CSS);
}

/* Gated: ports the standalone Hide in Queue plugin's powerups + CSS into
   Incremental Everything. Only call when the user's integration setting is on
   AND they have uninstalled the standalone plugin (otherwise RemNote throws
   "Duplicated powerup" and the entire plugin fails to load). */
export async function registerHideInQueueLegacyPowerups(plugin: ReactRNPlugin) {
  await plugin.app.registerPowerup({
    name: 'Hide in Queue',
    code: HIDE_IN_QUEUE_POWERUP_CODE,
    description: 'Hides the tagged Rem in the queue view (only "Hidden in Queue" placeholder is shown).',
    options: { slots: [] },
  });

  await plugin.app.registerPowerup({
    name: 'Remove from Queue',
    code: REMOVE_FROM_QUEUE_POWERUP_CODE,
    description: 'Completely removes the tagged Rem from the queue view (no placeholder).',
    options: { slots: [] },
  });

  await plugin.app.registerPowerup({
    name: 'No Hierarchy',
    code: NO_HIERARCHY_POWERUP_CODE,
    description: 'Removes the ancestor hierarchy of the tagged Rem in the queue view.',
    options: { slots: [] },
  });

  await plugin.app.registerPowerup({
    name: 'Hide Parent',
    code: HIDE_PARENT_POWERUP_CODE,
    description: 'Hides the immediate parent of the tagged Rem in the queue view (front side only).',
    options: { slots: [] },
  });

  await plugin.app.registerPowerup({
    name: 'Hide Grandparent',
    code: HIDE_GRANDPARENT_POWERUP_CODE,
    description: 'Hides the grandparent of the tagged Rem in the queue view (front side only).',
    options: { slots: [] },
  });

  await plugin.app.registerCSS('queue-display-legacy-css', LEGACY_CSS);
}
