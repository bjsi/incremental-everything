import { declareIndexPlugin, ReactRNPlugin } from '@remnote/plugin-sdk';
import { registerStartupShieldCoolingScan } from '../lib/priority_review_document/shield_cooling_scan';
import '../style.css';
import '../App.css';
import { allCardPriorityInfoKey } from '../lib/consts';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { handleMobileDetectionOnStartup, shouldUseLightMode } from '../lib/mobileUtils';
import { loadCardPriorityCache } from '../lib/card_priority/cache';
import { writeCardPriorityCache } from '../lib/card_priority/persistence';
import { checkFlashcardPrioritisationOptOut } from '../lib/card_priority/opt_out';
import { checkCardPriorityHiddenSlotMigration } from '../lib/card_priority/hidden_slot_migration';
import { isVisiblePrioritySlotRetired } from '../lib/card_priority/slot_access';
import { registerEventListeners } from '../register/events';
import { refreshTagSubtreeCSS } from '../lib/tag_subtree_css';
import { registerPluginPowerups } from '../register/powerups';
import { registerPluginSettings } from '../register/settings';
import { registerWidgets } from '../register/widgets';
import { registerMenus } from '../register/menus';
import { registerCommands } from '../register/commands';
import { registerCallbacks, resetSessionItemCounter } from '../register/callbacks';
import { registerPrefetchTrackers } from '../lib/queue_prefetch';
import {
  registerCoreQueueDisplayPowerups,
  registerHideInQueueLegacyPowerups,
} from '../register/queue_display_powerups';
import {
  registerCoreQueueDisplayCommands,
  registerHideInQueueLegacyCommands,
} from '../register/queue_display_commands';
import { autoRefreshPriorityQueueId, enableHideInQueueIntegrationId, enableFlashcardPrioritisationId, pdfHighlightBordersReloadKey, priorityBandColorsReloadKey } from '../lib/consts';
import { refreshAllPriorityQueuesAtStartup } from '../lib/priority_review_document/queue_doc';
import { bandVerboseLogsEnabled } from '../lib/priority_bands';
import { registerIncrementalRemTracker } from '../register/tracker';
import { cleanupOrphanedReviewGraphs } from '../lib/priority_review_document/cleanup';
import { migrateAuthoritativeAggregatesToShards } from '../lib/authoritative_aggregates';
import { registerJumpToRemHelper } from '../register/window';
import { registerPluginHidingCSS, registerPdfHighlightCSS, registerClozeExtractCSS, registerTagBadgeCSS, registerIgnoreTagCSS, registerHighlightBandBadgeCSS, registerTableBandBadgeCSS, registerHasImageCSS, registerPinReferenceCSS } from '../lib/ui_helpers';
import { getIESetting } from '../lib/settings';
import { StartupTaskBoard, waitForSessionFlag } from '../lib/startup_status';
import { migrateIESettingsIfNeeded, settingIdsNeedingRegistration } from '../lib/settings_migration';

async function onActivate(plugin: ReactRNPlugin) {
  //Debug
  console.log('🚀 INCREMENTAL EVERYTHING onActivate CALLED');
  console.log('Plugin type:', typeof plugin);
  console.log('Plugin methods:', Object.keys(plugin));
  console.log('Plugin.app methods:', Object.keys(plugin.app));
  console.log('Plugin.storage methods:', Object.keys(plugin.storage));

  (window as any).__plugin = plugin;
  registerJumpToRemHelper(plugin);

  // Records the background startup work as it settles, for the hub's ▶ pulse.
  const startup = new StartupTaskBoard(plugin);


  // Read BEFORE the powerups are registered: on a knowledge base whose card
  // priorities have been verified out of the deprecated visible `priority` slot,
  // that slot is not registered at all — which is the only thing that removes the
  // leftover "Priority — Empty" row, since the row comes from the slot definition
  // and survives its values being deleted. Same shape as the settings
  // registration, which is likewise handed only what this KB still needs.
  // Defaults to registering if the record cannot be read.
  await registerPluginPowerups(plugin, {
    retireVisiblePrioritySlot: await isVisiblePrioritySlotRetired(plugin),
  });
  // Core queue display powerups (Remove Parent / Remove Grandparent) are
  // always registered — the Cloze and Extract creators apply Remove Parent to
  // newly-created rems. These powerup codes don't exist in the standalone
  // Hide in Queue plugin, so they cannot collide with it.
  await registerCoreQueueDisplayPowerups(plugin);
  // Settings appear in RemNote's own panel only while this KB still has to read
  // them across — the migration reads through getSetting, which throws for an
  // unregistered id. For an up-to-date KB this list is empty, so the plugin's
  // section of that panel is empty too and the IE Settings popup owns every
  // setting.
  await registerPluginSettings(plugin, {
    ids: await settingIdsNeedingRegistration(plugin),
  });

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
  // A full load was measured at 29s; the deadline only has to catch a load that died.
  const incRemSettled = startup.track(
    'incRemCache',
    waitForSessionFlag(plugin, 'inc_rem_cache_fully_loaded', { timeoutMs: 15 * 60 * 1000 })
  );

  // Fire-and-forget: clear synced graph-data entries whose Priority Review
  // Document graph Rem was deleted. Errors are logged inside the helper and
  // must not block activation.
  void cleanupOrphanedReviewGraphs(plugin);

  // Fire-and-forget: split the authoritative-aggregates key into one shard per
  // knowledge base, compacting the legacy array shape on the way through. Needs
  // no card/rem enumeration, so it works while those APIs are unavailable. Costs
  // one read per session once the legacy key is drained.
  void migrateAuthoritativeAggregatesToShards(plugin);

  registerCallbacks(plugin);
  // Keeps the GetNextCard prefetch's no-IncRem-timer gate live. Must run in the
  // index widget: plugin.track subscriptions belong to the realm that owns the
  // callback, and this is the same realm registerCallbacks runs in.
  registerPrefetchTrackers(plugin);
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
    const reloadStamp = await rp.storage.getSession(priorityBandColorsReloadKey); // reactive trigger
    // Through `plugin`, not `rp`: cache warmth is recorded here, not subscribed
    // to — each cache load bumps the reload key itself once it is warm.
    const cachesWarm =
      startup.get('cardCache') !== 'running' &&
      !!(await plugin.storage.getSession<boolean>('inc_rem_cache_fully_loaded'));
    // Instrumentation (verbose-gated): `undefined` here means this is the
    // ACTIVATION-time run, i.e. the colours are being baked before either
    // priority cache is warm. Any later run carries the stamp of whatever
    // bumped the key.
    if (await bandVerboseLogsEnabled(plugin)) {
      console.log(
        `[PriorityBands] re-registering band stylesheets — trigger=${
          reloadStamp === undefined ? 'ACTIVATION (caches likely cold)' : `reload key ${reloadStamp}`
        }`
      );
    }
    await registerTableBandBadgeCSS(plugin);
    await registerHighlightBandBadgeCSS(plugin);
    if (cachesWarm) startup.settle('priorityBands', 'done');
  });

  await registerPluginHidingCSS(plugin);
  await registerClozeExtractCSS(plugin);
  await registerTagBadgeCSS(plugin);
  await registerIgnoreTagCSS(plugin);
  // Descendants of #cloze-extract / #ignore Rems; kept current by the listeners
  // in lib/tag_subtree_css. Not awaited: it walks the open panes.
  void refreshTagSubtreeCSS(plugin);
  await registerHasImageCSS(plugin);
  await registerPinReferenceCSS(plugin);

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

  let cardCacheSettled: Promise<void>;
  let pretaggingSettled: Promise<void>;
  let coolingScanSettled: Promise<void>;
  if (mayBuildCardPriorityCache) {
    // Run the full, expensive cache build, then recompute the band colours: the
    // percentile mapping is meaningless until this cache exists.
    const cardCacheLoad = loadCardPriorityCache(plugin);
    // Tracked BEFORE the bump below is chained, so the task is already settled
    // when the band tracker re-runs and asks whether the caches are warm.
    cardCacheSettled = startup.track('cardCache', cardCacheLoad);
    cardCacheLoad.then(
      () => plugin.storage.setSession(priorityBandColorsReloadKey, Date.now()),
      (err) => console.error('CACHE: card priority cache build failed', err)
    );
    // Pre-tagging is the build's phase 2, which runs on after the build resolves.
    pretaggingSettled = startup.track('pretagging', cardCacheLoad.then((load) => load.deferred));
    // Once the cache has finished loading, judge cooling for the shield, so the
    // first queue of this RemNote run already excludes cooling Rems.
    coolingScanSettled = startup.track('coolingScan', registerStartupShieldCoolingScan(plugin));

  } else {
    cardCacheSettled = pretaggingSettled = coolingScanSettled = Promise.resolve();
    startup.settle('cardCache', 'skipped');
    startup.settle('pretagging', 'skipped');
    startup.settle('coolingScan', 'skipped');
    // Empty cache. Readers treat "absent" as "no card priorities known", which is
    // the correct answer in both cases; the cascade falls back to per-rem
    // rem.getCards() rather than assuming nothing has cards.
    console.log(
      `CACHE: Skipping card priority cache build (${useLightMode ? 'light mode' : 'flashcard prioritisation off'}).`
    );
    // Session only, deliberately. An empty cache here means "not built in this
    // context" (light mode, or the opt-in off), not "there are no priorities" —
    // persisting it would wipe a good copy on every mobile session and make the
    // next full-mode launch pay a cold build for it.
    await writeCardPriorityCache(plugin, []);
  }

  // The queue-exit auto-refresh, also run once at startup for every Priority
  // Queue document. After the caches: in Full Mode a refresh takes its card facts
  // from the card cache, and would otherwise pay for a card.getAll(). After the
  // cooling scan too: both publish cooling, and the scan — which alone records the
  // Rems held back by a cooling ancestor for the shield — skips itself once any
  // cooling has been published. Not in Light Mode, for the same reason as at exit.
  if (useLightMode || !(await getIESetting(plugin, autoRefreshPriorityQueueId))) {
    startup.settle('priorityQueueRefresh', 'skipped');
  } else {
    startup.track(
      'priorityQueueRefresh',
      Promise.all([cardCacheSettled, pretaggingSettled, coolingScanSettled, incRemSettled]).then(() =>
        refreshAllPriorityQueuesAtStartup(plugin)
      )
    );
  }

  // Turning the flashcard-prioritisation opt-in OFF leaves every tag it wrote in
  // place. Deferred and deliberately not awaited: it ends in a modal and a KB-wide
  // scan, neither of which belongs on the activation path. It is a no-op unless
  // the setting actually changed since the last launch of this KB.
  setTimeout(() => {
    checkFlashcardPrioritisationOptOut(plugin).catch((err) =>
      console.warn('Flashcard prioritisation opt-out check failed', err)
    );
  }, 8000);

  // Offers to move card priorities out of the VISIBLE Priority slot, whose
  // property child makes RemNote render "Priority — 31" in place of a table
  // cell's own content. Offered on every launch while the condition holds — it is
  // a live rendering bug in the user's tables, not a preference — with a "never
  // ask again" on the decline path. Deferred well past the opt-out prompt so two
  // modals can never land together, and a no-op in light mode.
  const hiddenSlotCheck = new Promise<void>((resolve) => setTimeout(resolve, 20000)).then(() =>
    checkCardPriorityHiddenSlotMigration(plugin)
  );
  hiddenSlotCheck.catch((err) => console.warn('Card priority hidden-slot migration check failed', err));
  startup.track('hiddenSlotCheck', hiddenSlotCheck);

  // The band stylesheets are normally re-registered warm by the caches' own
  // bumps. Two paths never get there: an IncRem cache with no IncRems (which
  // bumps nothing) finishing after the card cache, and a registration that
  // threw. Bump once more for those; if even that run does not settle it, say so.
  void Promise.all([cardCacheSettled, incRemSettled]).then(async () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    await sleep(5000);
    if (startup.get('priorityBands') !== 'running') return;
    await plugin.storage.setSession(priorityBandColorsReloadKey, Date.now());
    await sleep(15000);
    startup.settle('priorityBands', 'failed');
  });
}

async function onDeactivate(_: ReactRNPlugin) { }

declareIndexPlugin(onActivate, onDeactivate);
