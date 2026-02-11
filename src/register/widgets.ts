import { QueueItemType, ReactRNPlugin, WidgetLocation } from '@remnote/plugin-sdk';
import { pageRangeWidgetId, parentSelectorWidgetId, powerupCode, priorityGraphPowerupCode, priorityGraphDocPowerupCode } from '../lib/consts';

export function registerWidgets(plugin: ReactRNPlugin) {

  // NEW: Light Priority Widget
  plugin.app.registerWidget('priority_light', WidgetLocation.Popup, {
    dimensions: {
      width: '350px', // Compact width
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
      width: 1000,
      height: 950,
    },
  });

  plugin.app.registerWidget('batch_card_priority', WidgetLocation.Popup, {
    dimensions: {
      width: 600,
      height: 'auto',
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
      width: 600,
      height: 1100,
    },
  });

  plugin.app.registerWidget('debug', WidgetLocation.Popup, {
    dimensions: {
      width: '350px',
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
    queueItemTypeFilter: QueueItemType.Flashcard,
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
    dimensions: { height: '600px', width: '800px' },
  });

  // Register incremental rem main view - comprehensive view with filters
  plugin.app.registerWidget('inc_rem_main_view', WidgetLocation.Popup, {
    dimensions: { height: '800px', width: '1000px' },
  });

  // Register parent selector popup for creating rems under incremental rems
  plugin.app.registerWidget(parentSelectorWidgetId, WidgetLocation.Popup, {
    dimensions: { height: '850px', width: '400px' },
  });

  plugin.app.registerWidget('priority_review_graph', WidgetLocation.UnderRemEditor, {
    powerupFilter: priorityGraphPowerupCode,
    dimensions: {
      width: '100%',
      height: 'auto',
    },
  });

  plugin.app.registerWidget('priority_distribution_graph', WidgetLocation.UnderRemEditor, {
    powerupFilter: priorityGraphDocPowerupCode,
    dimensions: {
      width: '100%',
      height: 'auto',
    },
  });

  plugin.app.registerWidget('incremental_history', WidgetLocation.RightSidebar, {
    dimensions: {
      width: '100%',
      height: 'auto',
    },
    widgetTabIcon: "https://cdn-icons-png.flaticon.com/512/3626/3626838.png",
    widgetTabTitle: "Incremental History",
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
}
