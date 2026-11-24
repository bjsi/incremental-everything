import { QueueItemType, ReactRNPlugin, WidgetLocation } from '@remnote/plugin-sdk';
import { pageRangeWidgetId, parentSelectorWidgetId, parentPickWidgetId, historyMoveWidgetId, powerupCode, priorityGraphPowerupCode, incremNotesSidebarWidgetId, enableMasteryDrillId, pluginHubWidgetId, onboardingTipsWidgetId, cardVideoPowerupCode, mcScissorsWidgetId, mcAssertionsWidgetId, menuHubWidgetId, READ_ALOUD_POPUP, AUDIO_PLAYLIST_FLOAT, EXTRACT_EDITOR_FLOAT } from '../lib/consts';
import { getIESetting } from '../lib/settings';
import { screenFittedHeight } from '../lib/utils';
import { CLUSTER_EXTRA_DETAIL_WIDGET } from '../lib/cluster_extra_detail';

/* The regular-queue Mastery Drill bar sits at QueueBelowTopBar. Registering anything
   there drops RemNote's own h-2 spacer (it renders only when the location is empty), so
   the bar's wrapper keeps that 0.5rem. The slot is a flex child of the queue box without
   shrink-0: once a revealed answer overflows the box, flexbox would squeeze the wrapper
   and its overflow:hidden clip the bar.

   The queue's own badge and timer are one widget at QueueToolbar, in both variants
   (queue_toolbar_priority). When the Beautiful queue first shipped its chrome showed no
   QueueToolbar widgets, so a second widget carried them at QueueBelowTopBar; RemNote
   now mounts them in the chrome's actions on a computer, and that workaround is gone.
   On a phone the Beautiful chrome still mounts none. */
// The other half of the toolbar widget's see-through page (useTransparentFrame in
// widgets/queue_toolbar_priority.tsx): its iframe element's colour scheme is pinned to
// the page's, whatever the queue chrome around it inherits.
const TOOLBAR_FRAME_CSS = `
  iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue_toolbar_priority&"] {
    color-scheme: light !important;
  }
`;

const QUEUE_BELOW_TOP_BAR_CSS = `
  .rn-queue__widget-below-top-bar:has(> div > iframe[data-plugin-id="incremental-everything"][src*="widgetName=mastery_drill_queue_bar&"]) {
    min-height: 0.5rem;
    flex-shrink: 0;
  }
`;

/* Keeps the Editor Review Timer in view while the document scrolls.

   DocumentAboveToolbar widgets are ordinary flow content at the top of the
   pane's scroller, so they scroll away with the title:

     div#tile__document.rn-pane__body          <- the scroller (overflow-y-scroll)
       div.w-full.h-full.relative
         div.document-inner-container          <- overflow-hidden
           div.fade-in-first-load.relative     <- one per widget (overflow:hidden)
             div > iframe[data-plugin-id]
           div.rn-document-wrapper             <- the document itself

   position:sticky on the widget's wrapper is the whole fix, but a sticky box
   sticks to its nearest ancestor with a scrolling mechanism, and overflow:hidden
   makes .document-inner-container one (that never scrolls) — so it would stick
   to nothing. overflow:clip clips the same way without being a scroll container,
   which hands the sticky box to #tile__document. The wrapper is a direct child
   of .document-inner-container, which spans the whole document, so it stays
   pinned to the end. With no review running the widget renders nothing and the
   pinned box is 0px tall. */
const EDITOR_REVIEW_TIMER_STICKY_CSS = `
  .document-inner-container:has(> .fade-in-first-load > div > iframe[data-plugin-id="incremental-everything"][src*="widgetName=editor_review_timer&"]) {
    overflow: clip !important;
  }
  .document-inner-container > .fade-in-first-load:has(> div > iframe[data-plugin-id="incremental-everything"][src*="widgetName=editor_review_timer&"]) {
    position: sticky !important;
    top: 0;
    z-index: 100;
  }
`;

/* SidebarEnd widgets lose 64px per side to RemNote, not to anything we set.

   The sidebar mounts its plugin slot as
     <WidgetsAtLocation location={SidebarEnd} widgetClassName="px-8" />
   and the renderer behind it puts that class on BOTH boxes it builds:

     div.fade-in-first-load.relative.px-8   <- wrapper (overflow:hidden)
       div.px-8                             <- mount div (display:flex)
         iframe[data-plugin-id]

   `.px-8` is 2rem, so the iframe starts 4rem in from each edge — on a sidebar
   dragged down to ~200px there is more padding than widget. No other location
   does this (QueueToolbar/UnderRemEditor pass "" or a w-full class), and the
   dimensions we register cannot reach it: `width: '100%'` is 100% of the box
   that has already been inset.

   So take both paddings back and re-add the 0.5rem that the native chrome
   directly above and below this slot uses (the updater banner's `mx-2`, the
   status-badge stack's `px-2`), which lines our panels up with the sidebar's
   own rows. Scoped by data-plugin-id so we only move our own widgets. */
const SIDEBAR_END_PADDING_CSS = `
  .fade-in-first-load.px-8:has(> div > iframe[data-plugin-id="incremental-everything"]) {
    padding-left: 0.5rem;
    padding-right: 0.5rem;
  }
  .fade-in-first-load.px-8 > div.px-8:has(> iframe[data-plugin-id="incremental-everything"]) {
    padding-left: 0;
    padding-right: 0;
  }
`;

// The Rem text in the history sidebars (Flashcard/Rem/Incremental History) is a
// <RemViewer>, which RemNote draws in its own page over our iframe. A Shift+click there
// (open in a new pane) also extends the host's text selection over the whole sidebar,
// and clicks in the widget can't clear it. The rows are links, not text to copy, so
// make them unselectable. Only the RemViewer rows carry this class; the expanded
// RemHierarchyEditorTree stays selectable.
const HISTORY_ROW_NO_SELECT_CSS = `
  .ie-history-row-text,
  .ie-history-row-text * {
    user-select: none !important;
    -webkit-user-select: none !important;
  }
`;

// A floating widget's wrapper is z-50, but the reader's Notes (z 12), Explain (z 20)
// and every default popup (z 30) sit below it, in #controlled-popup-portal. While the
// Source float is open, lift that whole portal: popups keep their order among themselves.
// Tablets excluded: their popups are absolute, and this would clip them to the portal.
const SOURCE_FLOATING_POPUPS_CSS = `
  @media (pointer: fine) {
    body:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=pdf_source_floating"]) #controlled-popup-portal {
      position: relative;
      z-index: 60;
    }
  }
  /* The reference search ([[) in the reader's Notes is in #keyboard-aware-portal
     instead; see the Extract Editor rule below. */
  body:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=pdf_source_floating"]) #keyboard-aware-portal {
    z-index: 60 !important;
  }
`;

// The Extract Editor is a float too, holding a real editor: its slash menu and
// formatting bar are host popups, which would open under it for the same reason.
// Same lift, same exclusion.
//
// The reference search ([[ or [ on a selection) is not in that portal either: the rich
// text editor puts it in #keyboard-aware-portal (fixed, z 30). That portal is already
// position:fixed, so only its z-index changes, which clips nothing and is safe on
// tablets too. Its 0.3 s transition animates the change, so a probe must wait before
// reading it back. Verified live in 1.30.4.
//
// The bar that appears over selected text (bold, highlight, cloze…) is not in that
// portal: RemNote portals it straight into <body> as .rn-selected-text-menu, at z 30
// (40 over a popup), so it too opened under the float (z 50). It goes between the
// float and the lifted portal, where its own dropdowns open.
const EXTRACT_EDITOR_POPUPS_CSS = `
  @media (pointer: fine) {
    body:has(iframe[src*="widgetName=${EXTRACT_EDITOR_FLOAT}"]) #controlled-popup-portal {
      position: relative;
      z-index: 60;
    }
  }
  body:has(iframe[src*="widgetName=${EXTRACT_EDITOR_FLOAT}"]) #keyboard-aware-portal {
    z-index: 60 !important;
  }
  body:has(iframe[src*="widgetName=${EXTRACT_EDITOR_FLOAT}"]) .rn-selected-text-menu {
    z-index: 55 !important;
  }

  /* On a phone the DocumentViewer is RemNote's mobile document page, which opens with
     its own top bar (PageHeaderMobile: back arrow, breadcrumb, actions) and a spacer
     the height of the screen's safe area (--safe-area-inset-top). In a floating panel
     these covered the first lines of the Rem, and moved with the panel when dragged.
     Inside the panel the safe area is zero, and the bar is the plugin's own (Done). */
  div.absolute.z-50:has(iframe[src*="widgetName=${EXTRACT_EDITOR_FLOAT}"]) {
    --safe-area-inset-top: 0px !important;
  }
  div.absolute.z-50:has(iframe[src*="widgetName=${EXTRACT_EDITOR_FLOAT}"]) .rn-page-header-mobile,
  div.absolute.z-50:has(iframe[src*="widgetName=${EXTRACT_EDITOR_FLOAT}"]) [data-covers-top-area="true"],
  div.absolute.z-50:has(iframe[src*="widgetName=${EXTRACT_EDITOR_FLOAT}"]) div[aria-hidden="true"][class*="-mt-safe"] {
    display: none !important;
  }
`;

export async function registerWidgets(plugin: ReactRNPlugin) {
  const masteryDrillEnabled = await getIESetting(plugin, enableMasteryDrillId);

  // The "Incremental RemNote" hub: shortcuts to settings, docs, sorting criteria
  // and the Priority Review Document creator, plus one onboarding tip at a time.
  // Ungated on purpose — it is the entry point to everything else, so it has to
  // be visible before the user knows there is a settings popup to find.
  plugin.app.registerWidget(pluginHubWidgetId, WidgetLocation.SidebarEnd, {
    dimensions: {
      width: '100%',
      height: 'auto',
    },
  });

  // The whole tip pile, behind the hub's "All Tips" button. Sized for prose:
  // every tip's one-line body is shown in full, which the 130px sidebar cannot
  // do. Height is fixed so the list scrolls inside the popup rather than the
  // popup growing past the window on a knowledge base with every tip unseen.
  plugin.app.registerWidget(onboardingTipsWidgetId, WidgetLocation.Popup, {
    dimensions: {
      width: 620,
      height: 'auto',
    },
  });

  // IE Settings popup — the plugin's own settings UI (grouped and layered,
  // unlike RemNote's flat plugin-settings list).
  plugin.app.registerWidget('ie_settings', WidgetLocation.Popup, {
    dimensions: {
      width: 940,
      height: 720,
    },
  });

  // NEW: Light Priority Widget
  plugin.app.registerWidget('priority_light', WidgetLocation.Popup, {
    dimensions: {
      width: '350px', // Compact width
      height: 'auto',
    },
  });

  // Combined Priority + Interval Widget (for new incremental rem creation flows)
  plugin.app.registerWidget('priority_interval', WidgetLocation.Popup, {
    dimensions: {
      width: '370px',
      height: 'auto',
    },
  });

  plugin.app.registerWidget('priority', WidgetLocation.Popup, {
    dimensions: {
      width: '500px',
      height: 'auto',
    },
  });

  plugin.app.registerWidget('priority_editor', WidgetLocation.RightSideOfEditor, {
    dimensions: {
      height: 'auto',
      width: 'auto',
    },
  });

  plugin.app.registerWidget('batch_priority', WidgetLocation.Popup, {
    dimensions: {
      width: 1200,
      height: 1150,
    },
  });

  plugin.app.registerWidget('batch_card_priority', WidgetLocation.Popup, {
    dimensions: {
      width: 1000,
      height: 1100,
    },
  });

  plugin.app.registerWidget('card_enablement_audit', WidgetLocation.Popup, {
    dimensions: {
      width: 1100,
      height: 1100,
    },
  });

  plugin.app.registerWidget('reschedule', WidgetLocation.Popup, {
    dimensions: {
      // Same width as priority_interval: both carry the scheduler picker, whose
      // two segments and multiplier field need the room to stay on one line.
      width: '370px',
      height: 'auto',
    },
  });

  plugin.app.registerWidget(pageRangeWidgetId, WidgetLocation.Popup, {
    dimensions: {
      width: 700,
      height: 1100,
    },
  });

  plugin.app.registerWidget('debug', WidgetLocation.Popup, {
    dimensions: {
      width: 450,
      height: 800,
    },
  });

  // Find & Insert Reference — floating (not a popup) so it doesn't hide the
  // editor while you pick a rem to reference.
  plugin.app.registerWidget('reference_finder', WidgetLocation.FloatingWidget, {
    dimensions: {
      width: 680,
      height: 'auto',
    },
  });

  plugin.app.registerWidget('queue', WidgetLocation.Flashcard, {
    powerupFilter: powerupCode,
    dimensions: {
      width: '100%',
      height: 'auto',
    },
    queueItemTypeFilter: QueueItemType.Plugin,
  });

  plugin.app.registerWidget('answer_buttons', WidgetLocation.FlashcardAnswerButtons, {
    powerupFilter: powerupCode,
    dimensions: {
      width: '100%',
      height: 'auto',
    },
    queueItemTypeFilter: QueueItemType.Plugin,
  });

  plugin.app.registerWidget('sorting_criteria', WidgetLocation.Popup, {
    dimensions: {
      width: '100%',
      height: 'auto',
    },
  });

  plugin.app.registerWidget('priority_shield_graph', WidgetLocation.Popup, {
    dimensions: {
      width: 1075,
      height: screenFittedHeight(600),
    },
  });

  // The queue's toolbar: the No-Inc countdown and the priority badge, one iframe for
  // both queue variants (widgets/queue_toolbar_priority.tsx).
  plugin.app.registerWidget('queue_toolbar_priority', WidgetLocation.QueueToolbar, {
    dimensions: {
      width: 'auto',
      height: 'auto',
    },
  });

  await plugin.app.registerCSS('queue-below-top-bar', QUEUE_BELOW_TOP_BAR_CSS);
  await plugin.app.registerCSS('queue-toolbar-frame', TOOLBAR_FRAME_CSS);
  await plugin.app.registerCSS('sidebar-end-padding', SIDEBAR_END_PADDING_CSS);
  await plugin.app.registerCSS('history-row-no-select', HISTORY_ROW_NO_SELECT_CSS);
  await plugin.app.registerCSS('editor-review-timer-sticky', EDITOR_REVIEW_TIMER_STICKY_CSS);

  // The Priority Queue popup: status, refresh/drain/refill/practise for the
  // persistent review document, and the Cooling list. Replaces the snapshot
  // creator (review_document_creator).
  plugin.app.registerWidget('priority_queue_popup', WidgetLocation.Popup, {
    dimensions: {
      width: 640,
      height: 'auto',
    },
  });

  plugin.app.registerWidget('jump_to_rem_input', WidgetLocation.Popup, {
    dimensions: {
      width: 400,
      height: 'auto',
    },
  });

  // Confirmation + report for "Tag Rems With Images". A popup rather than a
  // native confirm(): the dialog offers a third choice (this scope / whole KB),
  // and the report has to stay on screen — a toast pair raced and the result
  // was replaced by the "scanning…" toast before it could be read.
  plugin.app.registerWidget('image_scan_popup', WidgetLocation.Popup, {
    dimensions: {
      width: 480,
      height: 'auto',
    },
  });

  // Scan → review → delete for the blank Rems an Anki import leaves under the
  // Extra Card Detail powerup. Taller than the image scan popup because the
  // review stage shows a skip tally and a sample of what will be removed —
  // deleting is irreversible, so the numbers come before the decision.
  plugin.app.registerWidget('empty_ecd_popup', WidgetLocation.Popup, {
    dimensions: {
      width: 520,
      height: 'auto',
    },
  });

  // Pin Source Quote on a PDF that also has a Text Reader version: pin in both
  // views or just one (lib/pdf_source_pins PIN_SOURCE_VIEWS_POPUP).
  plugin.app.registerWidget('pin_source_views_popup', WidgetLocation.Popup, {
    dimensions: {
      width: 440,
      height: 'auto',
    },
  });

  // Warning that another Incremental or Dismissed Rem has the same web page as a
  // source (lib/duplicate_source).
  plugin.app.registerWidget('duplicate_source_popup', WidgetLocation.Popup, {
    dimensions: {
      width: 460,
      height: 'auto',
    },
  });

  // Incremental and Dismissed Rems grouped by the website of their source.
  plugin.app.registerWidget('source_sites_popup', WidgetLocation.Popup, {
    dimensions: {
      width: 560,
      height: 'auto',
    },
  });

  // Generic message dialog for failures the user must read (lib/message_dialog.ts).
  plugin.app.registerWidget('message_popup', WidgetLocation.Popup, {
    dimensions: {
      width: 420,
      height: 'auto',
    },
  });

  // Fallback for lib/clipboard.ts when the index iframe cannot write the clipboard.
  plugin.app.registerWidget('copy_text_popup', WidgetLocation.Popup, {
    dimensions: {
      width: 420,
      height: 'auto',
    },
  });

  // Copy Rem ID's picker: the focused Rem, its sources, the PDF open in the pane.
  plugin.app.registerWidget('copy_rem_id_popup', WidgetLocation.Popup, {
    dimensions: {
      width: 480,
      height: 'auto',
    },
  });

  // Scan → review → delete for entries left behind in Priority Review Documents.
  // Tall and scrollable because the review stage is also the diagnostic: it lists
  // every document with what it still carries, and you tick which ones to clean.
  plugin.app.registerWidget('prd_cleanup_popup', WidgetLocation.Popup, {
    dimensions: {
      width: 620,
      height: 'auto',
    },
  });

  plugin.app.registerWidget('card_info_bar', WidgetLocation.FlashcardUnder, {
    powerupFilter: 'cardPriority',
    dimensions: {
      width: '100%',
      height: 'auto',
    },
  });

  // The video that explains a card (Link Local Video as Card Extra). The slot
  // is mounted only after Show Answer, where Extra Card Details show.
  plugin.app.registerWidget('card_video', WidgetLocation.FlashcardExtraDetail, {
    powerupFilter: cardVideoPowerupCode,
    dimensions: {
      width: '100%',
      height: 'auto',
    },
  });

  // Extra details of the Card Cluster member being tested: RemNote shows the loaded
  // member's instead (lib/cluster_extra_detail). No powerupFilter: RemNote filters
  // this slot on the loaded member, which says nothing about the tested one.
  plugin.app.registerWidget(CLUSTER_EXTRA_DETAIL_WIDGET, WidgetLocation.FlashcardExtraDetail, {
    dimensions: {
      width: '100%',
      height: 'auto',
    },
  });

  plugin.app.registerWidget('editor_review', WidgetLocation.Popup, {
    dimensions: { height: 'auto', width: '500px' },
  });

  plugin.app.registerWidget('editor_review_timer', WidgetLocation.DocumentAboveToolbar, {
    dimensions: { height: 'auto', width: '100%' },
  });

  // Import Local Videos: opened by its command after the helper's folder dialog.
  plugin.app.registerWidget('local_video_import', WidgetLocation.Popup, {
    dimensions: { width: 480, height: 'auto' },
  });

  // The timer's controls over RemNote's video page; opened by lib/video_review_bar.ts.
  plugin.app.registerWidget('video_review_bar', WidgetLocation.FloatingWidget, {
    dimensions: { height: 'auto', width: 'auto' },
  });

  // The Audio Playlist player (lib/audio_playlist.ts), opened and kept open by the index.
  // 'auto' both ways: it sizes itself, to a panel or to a bar, and to a phone's width.
  plugin.app.registerWidget(AUDIO_PLAYLIST_FLOAT, WidgetLocation.FloatingWidget, {
    dimensions: { height: 'auto', width: 'auto' },
  });

  // Notices of background work (lib/notice.ts), opened and closed by the index.
  plugin.app.registerWidget('notice_float', WidgetLocation.FloatingWidget, {
    dimensions: { height: 'auto', width: 'auto' },
  });

  // Shows that a window follows the queue, with its controls; opened by lib/follow_queue_sources.ts.
  plugin.app.registerWidget('follow_queue_bar', WidgetLocation.FloatingWidget, {
    dimensions: { height: 'auto', width: 'auto' },
  });

  // Register incremental rem counter widget below document title. It also
  // hosts a local video's player (components/LocalVideoEditorPlayer).
  plugin.app.registerWidget('inc_rem_counter', WidgetLocation.DocumentBelowTitle, {
    dimensions: { height: 'auto', width: '100%' },
  });

  // Register incremental rem list popup
  plugin.app.registerWidget('inc_rem_list', WidgetLocation.Popup, {
    dimensions: { height: 800, width: 1000 },
  });

  // Register incremental rem main view - comprehensive view with filters
  plugin.app.registerWidget('inc_rem_main_view', WidgetLocation.Popup, {
    dimensions: { height: 800, width: 1000 },
  });

  // Import Incremental Rems (with full rep history) from a JSON payload
  plugin.app.registerWidget('import_increm_history', WidgetLocation.Popup, {
    dimensions: { height: 'auto', width: 620 },
  });

  // Import the file written by scripts/export_scheduler_cards.py
  plugin.app.registerWidget('import_scheduler_cards', WidgetLocation.Popup, {
    dimensions: { height: 'auto', width: 520 },
  });

  // Register parent selector popup for creating rems under incremental rems.
  // The height follows the screen; keep it in sync with the container height in
  // widgets/parent_selector.tsx, whose tree list absorbs the difference.
  plugin.app.registerWidget(parentSelectorWidgetId, WidgetLocation.Popup, {
    dimensions: { height: screenFittedHeight(560), width: 400 },
  });

  // "Pick in editor" card (lib/parent_pick.ts): floats over the editor while a
  // new Rem waits for the user to confirm a parent there.
  plugin.app.registerWidget(parentPickWidgetId, WidgetLocation.FloatingWidget, {
    dimensions: { height: 'auto', width: 340 },
  });

  // "↪ Move to another Rem" card (lib/history_move_pick.ts): floats over the
  // editor while a Repetition History record waits for the Rem that gets its time.
  plugin.app.registerWidget(historyMoveWidgetId, WidgetLocation.FloatingWidget, {
    dimensions: { height: 'auto', width: 340 },
  });

  // Multiple-choice scissors (lib/mc_scissors.ts): one per option of a native
  // multiple-choice card, pinned beside it by CSS anchor positioning.
  plugin.app.registerWidget(mcScissorsWidgetId, WidgetLocation.FloatingWidget, {
    dimensions: { height: 28, width: 28 },
  });
  // Its True/False answer sheet: one column, pinned beside the question.
  plugin.app.registerWidget(mcAssertionsWidgetId, WidgetLocation.FloatingWidget, {
    // Its height comes from host CSS (the options' spacing), not from its content.
    dimensions: { height: 120, width: 58 },
  });

  plugin.app.registerWidget('priority_review_graph', WidgetLocation.UnderRemEditor, {
    powerupFilter: priorityGraphPowerupCode,
    dimensions: {
      width: '100%',
      height: 'auto',
    },
  });



  plugin.app.registerWidget('practiced_queues', WidgetLocation.RightSidebar, {
    dimensions: {
      width: '100%',
      height: 'auto',
    },
    widgetTabIcon: "https://cdn-icons-png.flaticon.com/512/6688/6688557.png",
    widgetTabTitle: "Practiced Queues",
  });

  plugin.app.registerWidget('incremental_history', WidgetLocation.RightSidebar, {
    dimensions: {
      width: '100%',
      height: 'auto',
    },
    widgetTabIcon: "https://cdn-icons-png.flaticon.com/512/3626/3626838.png",
    widgetTabTitle: "Incremental History",
  });

  plugin.app.registerWidget('flashcard_history', WidgetLocation.RightSidebar, {
    dimensions: {
      width: '100%',
      height: 'auto',
    },
    widgetTabIcon: "https://cdn-icons-png.flaticon.com/512/9145/9145670.png",
    widgetTabTitle: "Flashcard History",
  });

  plugin.app.registerWidget('rem_history', WidgetLocation.RightSidebar, {
    dimensions: {
      width: '100%',
      height: 'auto',
    },
    widgetTabIcon: "https://i.imgur.com/MLaBDJw.png",
    widgetTabTitle: "Visited Rem History",
  });

  // IncRem Notes Sidebar: shows the DocumentViewer for the IncRem being reviewed
  // Opened programmatically by the Reader 📝 button via openWidgetInRightSidebar.
  plugin.app.registerWidget(incremNotesSidebarWidgetId, WidgetLocation.RightSidebar, {
    dimensions: {
      width: '100%',
      height: 'auto',
    },
    widgetTabIcon: "https://cdn-icons-png.flaticon.com/512/1828/1828911.png",
    widgetTabTitle: "Document Notes",
  });

  // Repetition history popup for Answer Buttons
  plugin.app.registerWidget('repetition_history', WidgetLocation.Popup, {
    dimensions: {
      // 500px (was 440, was 380) so the header fits Show Aggregated + Cards
      // History + Add session + close, and the history grid keeps its column
      // widths beside the per-row edit/delete actions.
      width: '500px',
      height: 'auto',
    },
  });

  plugin.app.registerWidget('aggregated_repetition_history', WidgetLocation.Popup, {
    dimensions: {
      width: '550px',
      height: 'auto',
    },
  });

  // Study Dashboard popup. The height follows the screen rather than sitting at
  // the 950 it used to, which ran off a laptop display; the body scrolls, so a
  // shorter frame only means less of it at once. Keep in sync with the
  // container height in widgets/study_dashboard.tsx.
  plugin.app.registerWidget('study_dashboard', WidgetLocation.Popup, {
    dimensions: {
      width: '900px',
      height: screenFittedHeight(600),
    },
  });

  plugin.app.registerWidget('flashcard_repetition_history', WidgetLocation.Popup, {
    dimensions: {
      width: '1150px',
      height: 'auto',
    },
  });

  plugin.app.registerWidget('weighted_shield_popup', WidgetLocation.Popup, {
    dimensions: {
      width: '560px',
      height: 900,
    },
  });

  // Search & Browse (components/SearchBrowseView.tsx): a floating panel over the
  // AI helper's Search Engine. Floating, not a popup, so it can collapse to a small
  // bar while you work in the editor and come back with its search and scroll
  // intact. Width follows RemNote's window ('90vw'); the height (a number, by the
  // type) is fitted to the display, and the panel trims itself to the window.
  plugin.app.registerWidget('search_browse_floating', WidgetLocation.FloatingWidget, {
    dimensions: {
      width: '90vw',
      height: screenFittedHeight(640, 1300, 0.86),
    },
  });

  // Wide variant: same component, registered at ~2× width so the `wsh` command
  // can show Incremental Rems and Cards side-by-side when both groups are present.
  plugin.app.registerWidget('weighted_shield_popup_wide', WidgetLocation.Popup, {
    dimensions: {
      // Wide enough for the Card Priority × Memory Analytics table's 23 columns
      // without a horizontal scroller — the table is the reason this variant
      // exists, and a scroller hides the FSRS columns at the right edge.
      width: '1400px',
      height: 900,
    },
  });

  // Consolidated PDF highlight toolbar: bookmark, create extract, and toggle
  // incremental — one widget hosts all three icons, so RemNote only spins up a
  // single plugin iframe per toolbar render instead of three.
  plugin.app.registerWidget('highlight_toolbar', WidgetLocation.PDFHighlightToolbarLocation, {
    dimensions: {
      width: 'auto',
      height: 'auto',
    },
  });


  plugin.app.registerWidget('pdf_bookmark_popup', WidgetLocation.Popup, {
    dimensions: {
      width: '350px',
      height: 'auto',
    },
  });

  // Source-in-popup: renders a PDF/HTML source (PDFWebReader) in a centered
  // modal so a hovered pin reference can be opened without killing the queue.
  plugin.app.registerWidget('pdf_source_popup', WidgetLocation.Popup, {
    dimensions: {
      width: 1000,
      height: screenFittedHeight(600),
    },
  });

  // True/False: Judge by Emoji, asking first when the Rem has descendants or a card
  // was judged by a word.
  plugin.app.registerWidget('true_false_judge_confirm', WidgetLocation.Popup, {
    dimensions: {
      width: 620,
      height: 'auto',
    },
  });

  // Editor Review Timer lost to a crash or quit: resume / save / discard (lib/editor_review_recovery.ts).
  plugin.app.registerWidget('editor_review_recovery', WidgetLocation.Popup, {
    dimensions: {
      width: 560,
      height: 'auto',
    },
  });

  // Cycle Image Size: the confirmation, and the size it just set (lib/image_size_session.ts).
  plugin.app.registerWidget('image_size_confirm', WidgetLocation.Popup, {
    dimensions: {
      width: 540,
      height: 'auto',
    },
  });
  // Upscale image with ChatGPT: progress, side-by-side + fidelity check, replace (lib/upscale_image.ts).
  // Fixed, screen-fitted frame: 'auto' measures the popup before the side-by-side
  // image has loaded, so the result spilled out of the frame. The body scrolls.
  plugin.app.registerWidget('upscale_image_popup', WidgetLocation.Popup, {
    dimensions: {
      width: 960,
      height: screenFittedHeight(640, 1100),
    },
  });
  // Find Sources: review the passages found by meaning, pin the accepted ones (lib/find_sources).
  plugin.app.registerWidget('find_sources_popup', WidgetLocation.Popup, {
    dimensions: {
      width: 820,
      height: screenFittedHeight(560, 900),
    },
  });
  // Read aloud: editable script, the helper's estimate, Generate (lib/read_aloud.ts).
  plugin.app.registerWidget(READ_ALOUD_POPUP, WidgetLocation.Popup, {
    dimensions: {
      width: 820,
      height: screenFittedHeight(560, 900),
    },
  });
  plugin.app.registerWidget('image_size_feedback', WidgetLocation.FloatingWidget, {
    dimensions: { height: 'auto', width: 'auto' },
  });

  // Menu Hub: the Document and Queue menus' actions in a panel that stays open,
  // opened by their "Incremental RemNote…" items (lib/menu_hub_actions.ts).
  plugin.app.registerWidget(menuHubWidgetId, WidgetLocation.FloatingWidget, {
    dimensions: { height: 'auto', width: 300 },
  });

  // Floating (non-blocking) variant of the Source popup — opens to the side so
  // the queue/editor stays visible. Positioned + auto-closed by the
  // `open-source-in-floating` command and the QueueLoadCard listener.
  // NOTE: RemNote floating widgets are not user-resizable, so this fixed size is
  // the only size lever — keep it generous. Tune here if it overflows a screen.
  plugin.app.registerWidget('pdf_source_floating', WidgetLocation.FloatingWidget, {
    dimensions: {
      // EXPERIMENT: width accepts a string (per WidgetOptions type), so try a
      // viewport-relative width that adapts to screen size. If the float opens
      // as a ~48px sliver, RemNote parsed this numerically — revert to a fixed
      // number (e.g. 1100). Height MUST stay a number (PDFWebReader needs an
      // explicit height; the type forbids a string here anyway), so it is
      // fitted to the display once at registration instead.
      width: '40vw',
      height: screenFittedHeight(600),
    },
  });
  await plugin.app.registerCSS('source-floating-popups', SOURCE_FLOATING_POPUPS_CSS);

  // The Extract Editor (lib/extract_editor.ts): an editable document page over the
  // queue's read-only Extract Viewer. Sized by its content, which the opener sets.
  plugin.app.registerWidget(EXTRACT_EDITOR_FLOAT, WidgetLocation.FloatingWidget, {
    dimensions: { height: 'auto', width: 'auto' },
  });
  await plugin.app.registerCSS('extract-editor-popups', EXTRACT_EDITOR_POPUPS_CSS);

  // Outline Restructure preview popup (Before | After + per-rem preserve toggles).
  plugin.app.registerWidget('outline_restructure_preview', WidgetLocation.Popup, {
    dimensions: {
      width: 1100,
      height: 800,
    },
  });

  // Outline Restructure undo banner — appears in the sidebar after an apply,
  // stays until the user clicks Undo or dismisses it.
  plugin.app.registerWidget(
    'outline_restructure_undo',
    WidgetLocation.SidebarEnd,
    {
      dimensions: {
        width: '100%',
        height: 'auto',
      },
    }
  );

  // Heading Levels (Table of Contents / shift) preview popup — Before | After
  // with level badges and Top/Deepest level selectors.
  plugin.app.registerWidget('heading_assign_preview', WidgetLocation.Popup, {
    dimensions: {
      width: 1100,
      height: 800,
    },
  });

  // Heading Levels undo banner — appears in the sidebar after an apply, stays
  // until the user clicks Undo or dismisses it. Separate snapshot slot from the
  // outline restructure banner.
  plugin.app.registerWidget('heading_assign_undo', WidgetLocation.SidebarEnd, {
    dimensions: {
      width: '100%',
      height: 'auto',
    },
  });

  // Mastery Drill widgets are gated behind the 'enable-mastery-drill' setting.
  if (masteryDrillEnabled) {
    // Mastery Drill popup. The height follows the screen rather than sitting at
    // the 900 it used to: the card list inside is capped in `vh`, so it scales
    // with the frame and the drill gets the room a tall display can give it.
    plugin.app.registerWidget('mastery_drill', WidgetLocation.Popup, {
      dimensions: {
        width: 1100,
        height: screenFittedHeight(560),
      },
    });

    // Regular-queue drill (lib/mastery_drill_native): its bar in the queue, empty unless that
    // drill is on screen, and the card list it opens.
    plugin.app.registerWidget('mastery_drill_queue_bar', WidgetLocation.QueueBelowTopBar, {
      dimensions: {
        width: '100%',
        height: 'auto',
      },
    });
    plugin.app.registerWidget('mastery_drill_list', WidgetLocation.Popup, {
      dimensions: {
        width: 900,
        height: screenFittedHeight(560),
      },
    });
    // The bar's panels: clear confirmations and Clear Low Priority.
    plugin.app.registerWidget('mastery_drill_panel', WidgetLocation.Popup, {
      dimensions: {
        width: 900,
        height: screenFittedHeight(560),
      },
    });

    // Mastery Drill notification banner
    plugin.app.registerWidget('mastery_drill_notification', WidgetLocation.SidebarEnd, {
      dimensions: {
        width: '100%',
        height: 'auto',
      },
    });
  }
}
