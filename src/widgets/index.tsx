import { declareIndexPlugin, ReactRNPlugin } from '@remnote/plugin-sdk';
import '../style.css';
import '../App.css';
import { allCardPriorityInfoKey } from '../lib/consts';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { handleMobileDetectionOnStartup, shouldUseLightMode } from '../lib/mobileUtils';
import { loadCardPriorityCache } from '../lib/card_priority/cache';
import { registerEventListeners } from '../register/events';
import { registerPluginPowerups } from '../register/powerups';
import { registerPluginSettings } from '../register/settings';
import { registerWidgets } from '../register/widgets';
import { registerMenus } from '../register/menus';
import { registerCommands } from '../register/commands';
import { registerCallbacks, resetSessionItemCounter } from '../register/callbacks';
import {
  registerCoreQueueDisplayPowerups,
  registerHideInQueueLegacyPowerups,
} from '../register/queue_display_powerups';
import {
  registerCoreQueueDisplayCommands,
  registerHideInQueueLegacyCommands,
} from '../register/queue_display_commands';
import { enableHideInQueueIntegrationId, enableFlashcardPrioritisationId, pdfHighlightBordersReloadKey, priorityBandColorsReloadKey } from '../lib/consts';
import { registerIncrementalRemTracker } from '../register/tracker';
import { cleanupOrphanedReviewGraphs } from '../lib/priority_review_document/cleanup';
import { compactAuthoritativeAggregatesIfNeeded } from '../lib/authoritative_aggregates';
import { registerJumpToRemHelper } from '../register/window';
import { registerPluginHidingCSS, registerPdfHighlightCSS, registerClozeExtractCSS, registerTagBadgeCSS, registerIgnoreTagCSS, registerHighlightBandBadgeCSS, registerTableBandBadgeCSS } from '../lib/ui_helpers';
import { getIESetting } from '../lib/settings';
import { migrateIESettingsIfNeeded, isIESettingsSeedNeeded } from '../lib/settings_migration';

async function onActivate(plugin: ReactRNPlugin) {
  //Debug
  console.log('🚀 INCREMENTAL EVERYTHING onActivate CALLED');
  console.log('Plugin type:', typeof plugin);
  console.log('Plugin methods:', Object.keys(plugin));
  console.log('Plugin.app methods:', Object.keys(plugin.app));
  console.log('Plugin.storage methods:', Object.keys(plugin.storage));

  (window as any).__plugin = plugin;
  registerJumpToRemHelper(plugin);


  await registerPluginPowerups(plugin);
  // Core queue display powerups (Remove Parent / Remove Grandparent) are
  // always registered — the Cloze and Extract creators apply Remove Parent to
  // newly-created rems. These powerup codes don't exist in the standalone
  // Hide in Queue plugin, so they cannot collide with it.
  await registerCoreQueueDisplayPowerups(plugin);
  // Popup-tier settings are registered with RemNote only while this KB still
  // needs seeding — the migration reads them through getSetting, which throws
  // for an unregistered id. Once seeded they vanish from RemNote's panel and
  // the IE Settings popup owns them.
  const seedNeeded = await isIESettingsSeedNeeded(plugin);
  await registerPluginSettings(plugin, { includePopupTier: seedNeeded });

  // Seed the plugin-owned settings store from the registrations that were just
  // installed. Must run after registerPluginSettings and before any widget can
  // read a setting, so it is awaited rather than fired and forgotten — it is a
  // few dozen reads of already-loaded values. No-ops once completed.
  await migrateIESettingsIfNeeded(plugin);

  // Hide-in-Queue legacy powerups (Hide in Queue, Remove from Queue, etc.) and
  // their commands are gated by a setting. They share powerup codes with the
  // standalone Hide in Queue plugin — registering both at once causes RemNote
  // to throw "Duplicated powerup" and aborts plugin loading. The user must
  // uninstall the standalone plugin first, then enable this setting.
  const enableHideInQueueIntegration =
    await getIESetting(plugin, enableHideInQueueIntegrationId);
  if (enableHideInQueueIntegration) {
    await registerHideInQueueLegacyPowerups(plugin);
  }

  registerEventListeners(plugin, resetSessionItemCounter);

  registerIncrementalRemTracker(plugin);

  // Fire-and-forget: clear synced graph-data entries whose Priority Review
  // Document graph Rem was deleted. Errors are logged inside the helper and
  // must not block activation.
  void cleanupOrphanedReviewGraphs(plugin);

  // Fire-and-forget: shrink the authoritative-aggregates key into its compact
  // form if it is still the legacy array. Needs no card/rem enumeration, so it
  // works while those APIs are unavailable — and until it runs, that key sits
  // over RemNote's 900KB per-key ceiling and every write to it is rejected.
  void compactAuthoritativeAggregatesIfNeeded(plugin);

  registerCallbacks(plugin);
  await registerWidgets(plugin);

  // Register CSS rules
  // PDF highlight CSS is (re)registered reactively: the "peek" toggle (command +
  // highlight-toolbar button) can't call registerCSS from its iframe, so it bumps
  // pdfHighlightBordersReloadKey (session) instead. This track subscribes to that
  // key and re-registers here in the index widget. It also runs once on activation
  // (key undefined) to do the initial registration. registerPdfHighlightCSS reads
  // the persisted local flag itself to decide whether to draw the marker borders.
  plugin.track(async (rp) => {
    await rp.storage.getSession(pdfHighlightBordersReloadKey); // reactive trigger
    // Also re-runs when the band→percentile colour mapping changes: the PDF
    // marker tint is emitted inside this stylesheet.
    await rp.storage.getSession(priorityBandColorsReloadKey);
    await registerPdfHighlightCSS(plugin);
  });

  // Band badge colours come from the RELATIVE position of each band in the
  // priority distribution, which is only known once the caches are warm — well
  // after activation. This re-registers both badge stylesheets whenever that
  // mapping should be recomputed (cache load below, or a badge refresh).
  plugin.track(async (rp) => {
    await rp.storage.getSession(priorityBandColorsReloadKey); // reactive trigger
    await registerTableBandBadgeCSS(plugin);
    await registerHighlightBandBadgeCSS(plugin);
  });

  await registerPluginHidingCSS(plugin);
  await registerClozeExtractCSS(plugin);
  await registerTagBadgeCSS(plugin);
  await registerIgnoreTagCSS(plugin);

  await registerCommands(plugin);

  // Remove Parent / Remove Grandparent commands are always available — they
  // wrap powerups that are always registered and don't conflict with anything.
  await registerCoreQueueDisplayCommands(plugin);

  // Hide-in-Queue legacy commands gated on the same setting as the legacy
  // powerups above (must be in lockstep — registering commands without their
  // backing powerups would surface no-op commands to the user).
  if (enableHideInQueueIntegration) {
    await registerHideInQueueLegacyCommands(plugin);
  }

  await registerMenus(plugin);

  // Mobile and Web Browser Light Mode Features
  await handleMobileDetectionOnStartup(plugin);

  // The card-priority cache, and the KB-wide pretagging pass inside it, are the
  // heaviest thing the plugin does: phase 2 applies the CardPriority powerup to
  // every untagged rem that owns a flashcard. Both the opt-in and light mode must
  // allow it — the opt-in because nothing consumes the cache when prioritisation
  // is off, light mode because the build itself is what light mode exists to avoid.
  const useLightMode = await shouldUseLightMode(plugin);
  const mayBuildCardPriorityCache =
    !useLightMode && (await getIESetting(plugin, enableFlashcardPrioritisationId));

  if (mayBuildCardPriorityCache) {
    // Run the full, expensive cache build, then recompute the band colours: the
    // percentile mapping is meaningless until this cache exists.
    loadCardPriorityCache(plugin).then(
      () => plugin.storage.setSession(priorityBandColorsReloadKey, Date.now()),
      (err) => console.error('CACHE: card priority cache build failed', err)
    );

  } else {
    // Empty cache. Readers treat "absent" as "no card priorities known", which is
    // the correct answer in both cases; the cascade falls back to per-rem
    // rem.getCards() rather than assuming nothing has cards.
    console.log(
      `CACHE: Skipping card priority cache build (${useLightMode ? 'light mode' : 'flashcard prioritisation off'}).`
    );
    await plugin.storage.setSession(allCardPriorityInfoKey, []);
  }
}

async function onDeactivate(_: ReactRNPlugin) { }

declareIndexPlugin(onActivate, onDeactivate);
