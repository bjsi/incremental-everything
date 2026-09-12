import { QueueItemType, ReactRNPlugin, WidgetLocation } from '@remnote/plugin-sdk';
import { pageRangeWidgetId, parentSelectorWidgetId, powerupCode, priorityGraphPowerupCode, incremNotesSidebarWidgetId, enableMasteryDrillId, pluginHubWidgetId, onboardingTipsWidgetId } from '../lib/consts';
import { getIESetting } from '../lib/settings';

/* RemNote wraps each location widget as
     div.fade-in-first-load.rn-queue__widget-below-top-bar > div > iframe
   inside .rn-queue, which carries .queue-beautiful-box only in the Beautiful
   variant. Registering anything at QueueBelowTopBar also drops RemNote's own
   h-2 spacer there (it renders only when the location is empty), so the wrapper
   keeps that 0.5rem in both variants. The hidden iframe is also how the widget
   learns it is in Compact mode (useHostShown in queue_beautiful_bar.tsx).

   In Beautiful the wrapper leaves the flow and overlays the box's top-right
   corner: the box already opens with 40px of blank space (that 0.5rem spacer +
   the card content's pt-8) above the breadcrumbs, and the ~36px badge row fits
   inside it. In flow it stacked on top of that blank space instead. The spacer
   moves to the next sibling so the card sits exactly where RemNote puts it.
   The width cap keeps the transparent iframe from swallowing clicks across the
   whole strip when the card content scrolls under it. */
const QUEUE_BEAUTIFUL_BAR_CSS = `
  .rn-queue__widget-below-top-bar:has(> div > iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue_beautiful_bar&"]) {
    min-height: 0.5rem;
    flex-shrink: 0;
  }
  .rn-queue:not(.queue-beautiful-box) iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue_beautiful_bar&"] {
    display: none;
  }
  .queue-beautiful-box > .rn-queue__widget-below-top-bar:has(> div > iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue_beautiful_bar&"]) {
    position: absolute;
    top: 0;
    right: 0;
    width: min(360px, 60%);
    min-height: 0;
    z-index: 5;
  }
  .queue-beautiful-box > .rn-queue__widget-below-top-bar:has(> div > iframe[data-plugin-id="incremental-everything"][src*="widgetName=queue_beautiful_bar&"]) + * {
    margin-top: 0.5rem;
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
      width: '100%',
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
      height: 1050,
    },
  });

  plugin.app.registerWidget('no_inc_timer_indicator', WidgetLocation.QueueToolbar, {
    dimensions: {
      width: 'auto',
      height: 'auto',
    },
  });

  plugin.app.registerWidget('queue_toolbar_priority', WidgetLocation.QueueToolbar, {
    dimensions: {
      width: 'auto',
      height: 'auto',
    },
  });

  // Beautiful queue variant: it renders no QueueToolbar, so the two widgets
  // above never mount. This one carries both at QueueBelowTopBar (top of the
  // card box), which both variants render — the CSS below hides it in Compact.
  plugin.app.registerWidget('queue_beautiful_bar', WidgetLocation.QueueBelowTopBar, {
    dimensions: {
      width: '100%',
      height: 'auto',
    },
  });
  await plugin.app.registerCSS('queue-beautiful-bar', QUEUE_BEAUTIFUL_BAR_CSS);

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

  plugin.app.registerWidget('video_debug', WidgetLocation.Popup, {
    dimensions: {
      width: '500px',
      height: 'auto',
    },
  });

  plugin.app.registerWidget('editor_review', WidgetLocation.Popup, {
    dimensions: { height: 'auto', width: '500px' },
  });

  plugin.app.registerWidget('editor_review_timer', WidgetLocation.DocumentAboveToolbar, {
    dimensions: { height: 'auto', width: '100%' },
  });

  // Register incremental rem counter widget below document title
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

  // Register parent selector popup for creating rems under incremental rems
  plugin.app.registerWidget(parentSelectorWidgetId, WidgetLocation.Popup, {
    dimensions: { height: 850, width: 400 },
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

  plugin.app.registerWidget('study_dashboard', WidgetLocation.Popup, {
    dimensions: {
      width: '900px',
      height: 950,
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
      height: 800,
    },
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
      // number (e.g. 1100). Height MUST stay a fixed number (PDFWebReader needs
      // an explicit height; the type forbids a string here anyway).
      width: '40vw',
      height: 1000,
    },
  });

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
    // Mastery Drill popup
    plugin.app.registerWidget('mastery_drill', WidgetLocation.Popup, {
      dimensions: {
        width: 1100,
        height: 900,
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
