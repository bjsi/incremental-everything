import { ReactRNPlugin } from '@remnote/plugin-sdk';
import {
  initialIntervalId,
  multiplierId,
  collapseQueueTopBar,
  defaultPriorityId,
  displayPriorityShieldId,
  alwaysUseLightModeOnMobileId,
  alwaysUseLightModeOnWebId,
  remnoteEnvironmentId,
  pdfHighlightColorId,
} from '../lib/consts';

const hideCardPriorityTagId = 'hide-card-priority-tag';
const HIDE_CARD_PRIORITY_CSS = `
  [data-rem-tags~="cardpriority"] .hierarchy-editor__tag-bar__tag {
  display: none; }
`;

const showLeftBorderForIncRemsId = 'show-left-border-for-increms';
const SHOW_LEFT_BORDER_CSS = `
  .rem[data-rem-tags~="incremental"] {
    border-left: 3px solid green;
    padding-left: 5px;
  }
`;

/**
 * Registers every plugin setting (numbers, dropdowns, toggles) and applies startup defaults (e.g. hiding CardPriority tags).
 * Settings covered:
 * - `initialIntervalId`, `multiplierId`, `collapseQueueTopBar`
 * - `hideCardPriorityTag`, `defaultPriorityId`, `defaultCardPriority`
 * - `performanceMode`, `alwaysUseLightModeOnMobileId`, `alwaysUseLightModeOnWebId`
 * - `displayPriorityShieldId`, `priorityEditorDisplayMode`
 * - `remnoteEnvironmentId`, `pdfHighlightColorId`
 *
 * @param plugin RemNote plugin entry point used to register settings/CSS and read persisted values.
 */
export async function registerPluginSettings(plugin: ReactRNPlugin) {
  plugin.settings.registerNumberSetting({
    id: initialIntervalId,
    title: 'Initial Interval',
    description: 'Sets the number of days until the first repetition.',
    defaultValue: 1,
  });

  plugin.settings.registerNumberSetting({
    id: multiplierId,
    title: 'Multiplier',
    description:
      'Sets the multiplier to calculate the next interval. Multiplier * previous interval = next interval.',
    defaultValue: 1.5,
  });

  plugin.settings.registerBooleanSetting({
    id: collapseQueueTopBar,
    title: 'Collapse Queue Top Bar',
    description:
      'Create extra space by collapsing the top bar in the queue. You can hover over the collapsed bar to open it.',
    defaultValue: true,
  });

  plugin.settings.registerBooleanSetting({
    id: 'hideCardPriorityTag',
    title: 'Hide CardPriority Tag in Editor',
    description:
      'If enabled, this will hide the "CardPriority" powerup tag in the editor to reduce clutter. You can still set priority with (Alt+P). After changing this setting, reload RemNote.',
    defaultValue: true,
  });

  const shouldHide = await plugin.settings.getSetting('hideCardPriorityTag');
  if (shouldHide) {
    await plugin.app.registerCSS(hideCardPriorityTagId, HIDE_CARD_PRIORITY_CSS);
  }

  plugin.settings.registerBooleanSetting({
    id: 'showLeftBorderForIncRems',
    title: 'Show a greeb left Border for IncRems in Editor',
    description:
      'If enabled, this will show a green left border for IncRems in Editor, to make it easier to identify your "extracts".',
    defaultValue: true,
  });

  const shouldShowLeftBorderForIncRems = await plugin.settings.getSetting('showLeftBorderForIncRems');
  if (shouldShowLeftBorderForIncRems) {
    await plugin.app.registerCSS(showLeftBorderForIncRemsId, SHOW_LEFT_BORDER_CSS);
  }

  plugin.settings.registerNumberSetting({
    id: defaultPriorityId,
    title: 'Default Priority',
    description: 'Sets the default priority for new incremental rem (0-100, Lower = more important). Default: 10',
    defaultValue: 10,
    validators: [
      {
        type: 'int' as const,
      },
      {
        type: 'gte' as const,
        arg: 0,
      },
      {
        type: 'lte' as const,
        arg: 100,
      },
    ],
  });

  plugin.settings.registerNumberSetting({
    id: 'defaultCardPriority',
    title: 'Default Card Priority',
    description: 'Default priority for flashcards without inherited priority (0-100, Lower = more important).  Default: 50',
    defaultValue: 50,
    validators: [
      { type: 'int' as const },
      { type: 'gte' as const, arg: 0 },
      { type: 'lte' as const, arg: 100 },
    ],
  });

  plugin.settings.registerDropdownSetting({
    id: 'performanceMode',
    title: 'Performance Mode',
    description:
      'Choose performance level. "Light" is recommended for web/mobile. "Full" can bring significant computational overhead (best used in the Desktop App); it will also automatically start a pretagging process of all flashcards, that can make RemNote slow untill everything is tagged/synced/wired/cached!',
    defaultValue: 'light',
    options: [
      {
        key: 'full',
        label: 'Full (All Features, High Resource Use)',
        value: 'full',
      },
      {
        key: 'light',
        label: 'Light (Faster, No Relative Priority/Shield)',
        value: 'light',
      },
    ],
  });

  plugin.settings.registerBooleanSetting({
    id: alwaysUseLightModeOnMobileId,
    title: 'Always use Light Mode on Mobile',
    description:
      'Automatically switch to Light performance mode when using RemNote on iOS or Android. This prevents crashes and improves performance on mobile devices. Recommended: enabled.',
    defaultValue: true,
  });

  plugin.settings.registerBooleanSetting({
    id: alwaysUseLightModeOnWebId,
    title: 'Always use Light Mode on Web Browser',
    description:
      'Automatically switch to Light performance mode when using RemNote on the web browser. Full Mode can be slow or unstable on web browsers. Recommended: enabled.',
    defaultValue: true,
  });

  plugin.settings.registerBooleanSetting({
    id: displayPriorityShieldId,
    title: 'Display Priority Shield in Queue',
    description:
      'If enabled, shows a real-time status of your highest-priority due items in the queue (below the Answer Buttons for IncRems, and in the card priority widget under the flashcard in case of regular cards).',
    defaultValue: true,
  });

  plugin.settings.registerDropdownSetting({
    id: 'priorityEditorDisplayMode',
    title: 'Priority Editor in Editor',
    description: 'Controls when to show the priority widget in the right-hand margin of the editor.',
    defaultValue: 'all',
    options: [
      {
        key: 'all',
        label: 'Show for IncRem and Cards',
        value: 'all',
      },
      {
        key: 'incRemOnly',
        label: 'Show only for IncRem',
        value: 'incRemOnly',
      },
      {
        key: 'disable',
        label: 'Disable',
        value: 'disable',
      },
    ],
  });

  plugin.settings.registerDropdownSetting({
    id: remnoteEnvironmentId,
    title: 'RemNote Environment',
    description: 'Choose which RemNote environment to open documents in (beta.remnote.com or www.remnote.com)',
    defaultValue: 'www',
    options: [
      {
        key: 'beta',
        label: 'Beta (beta.remnote.com)',
        value: 'beta',
      },
      {
        key: 'www',
        label: 'Regular (www.remnote.com)',
        value: 'www',
      },
    ],
  });

  plugin.settings.registerDropdownSetting({
    id: pdfHighlightColorId,
    title: 'Incremental PDF Highlight Color',
    description:
      'Choose the highlight color for PDF highlights tagged as Incremental Rem. When toggling OFF (removing Incremental tag), the highlight will be reset to Yellow.',
    defaultValue: 'Blue',
    options: [
      { key: 'Red', label: 'Red', value: 'Red' },
      { key: 'Orange', label: 'Orange', value: 'Orange' },
      { key: 'Green', label: 'Green', value: 'Green' },
      { key: 'Blue', label: 'Blue', value: 'Blue' },
      { key: 'Purple', label: 'Purple', value: 'Purple' },
    ],
  });
}
