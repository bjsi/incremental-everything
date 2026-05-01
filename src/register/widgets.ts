import { QueueItemType, ReactRNPlugin, WidgetLocation } from '@remnote/plugin-sdk';
import { pageRangeWidgetId, parentSelectorWidgetId, powerupCode, priorityGraphPowerupCode, incremNotesSidebarWidgetId } from '../lib/consts';

export async function registerWidgets(plugin: ReactRNPlugin) {
  const skipMasteryDrill = Boolean(
    await plugin.settings.getSetting('skip_mastery_drill')
  );

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
      width: 400,
      height: 800,
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

  plugin.app.registerWidget('review_document_creator', WidgetLocation.Popup, {
    dimensions: {
      width: 500,
      height: 'auto',
    },
  });

  plugin.app.registerWidget('jump_to_rem_input', WidgetLocation.Popup, {
    dimensions: {
      width: 400,
      height: 'auto',
    },
  });

  plugin.app.registerWidget('card_priority_display', WidgetLocation.FlashcardUnder, {
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
      width: '380px',
      height: 'auto',
    },
  });

  plugin.app.registerWidget('aggregated_repetition_history', WidgetLocation.Popup, {
    dimensions: {
      width: '450px',
      height: 'auto',
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
      height: 700,
    },
  });

  // PDF Bookmark Flow
  plugin.app.registerWidget('pdf_bookmark_toolbar', WidgetLocation.PDFHighlightToolbarLocation, {
    dimensions: {
      width: 'auto',
      height: 'auto',
    },
  });

  // Create Incremental Rem Toolbar Button
  plugin.app.registerWidget('create_inc_rem_toolbar', WidgetLocation.PDFHighlightToolbarLocation, {
    dimensions: {
      width: 'auto',
      height: 'auto',
    },
  });

  // Toggle Incremental Rem Toolbar Button
  plugin.app.registerWidget('toggle_incremental_toolbar', WidgetLocation.PDFHighlightToolbarLocation, {
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

  // Mastery Drill widgets are gated behind the 'skip_mastery_drill' setting.
  if (!skipMasteryDrill) {
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
