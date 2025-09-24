import {
  AppEvents,
  declareIndexPlugin,
  PluginCommandMenuLocation,
  PropertyLocation,
  PropertyType,
  QueueItemType,
  ReactRNPlugin,
  Rem,
  RemId,
  RNPlugin,
  SelectionType,
  SpecialPluginCallback,
  StorageEvents,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import '../style.css';
import '../App.css';
import {
  allIncrementalRemKey,
  initialIntervalId,
  multiplierId,
  nextRepDateSlotCode,
  powerupCode,
  prioritySlotCode,
  repHistorySlotCode,
  collapseQueueTopBar,
  scrollToHighlightId,
  collapseTopBarId,
  queueCounterId,
  hideIncEverythingId,
  nextRepCommandId,
  shouldHideIncEverythingKey,
  collapseTopBarKey,
  queueLayoutFixId,
  incrementalQueueActiveKey,
  activeHighlightIdKey,
  currentScopeRemIdsKey,
  defaultPriorityId,
  seenRemInSessionKey,
  displayPriorityShieldId,
  priorityShieldHistoryKey,
  priorityShieldHistoryMenuItemId,
  documentPriorityShieldHistoryKey,
  currentSubQueueIdKey,
  remnoteEnvironmentId,
  pageRangeWidgetId,
} from '../lib/consts';
import * as _ from 'remeda';
import { getSortingRandomness, getCardsPerRem } from '../lib/sorting';
import { IncrementalRem } from '../lib/types';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { getIncrementalRemInfo, handleHextRepetitionClick } from '../lib/incremental_rem';
import { calculateRelativePriority } from '../lib/priority';
import { getDailyDocReferenceForDate } from '../lib/date';
import { getCurrentIncrementalRem, setCurrentIncrementalRem } from '../lib/currentRem';
import { getInitialPriority } from '../lib/priority_inheritance';
import { findPDFinRem } from '../lib/pdfUtils';
dayjs.extend(relativeTime);

async function onActivate(plugin: ReactRNPlugin) {
  let sessionItemCounter = 0;

  const QUEUE_LAYOUT_FIX_CSS = `
    .rn-queue {
      height: 100% !important;
    }
    .rn-queue__content,
    .rn-queue__content .rn-flashcard,
    .rn-queue__content .rn-flashcard__content,
    .rn-queue__content > .box-border,
    .rn-queue__content > .box-border > .fade-in-first-load {
      flex-grow: 1 !important;
    }
    /* Hide unwanted UI elements during incremental rem review */
    .rn-flashcard-insights,
    div.fade-in-first-load:has(div[data-cy="bottom-of-card-suggestions"]),
    div:has(> iframe[data-plugin-id="flashcard-repetition-history"]) {
      display: none !important;

    }
  `;

  const COLLAPSE_TOP_BAR_CSS = `
    .spacedRepetitionContent { height: 100%; box-sizing: border-box; }
    .queue__title { max-height: 0; overflow: hidden; transition: max-height 0.3s ease; }
    .queue__title:hover { max-height: 999px; }
  `.trim();


  await plugin.app.registerPowerup('Incremental', powerupCode, 'Incremental Everything Powerup', {
    slots: [
      {
        code: prioritySlotCode,
        name: 'Priority',
        propertyType: PropertyType.NUMBER,
        propertyLocation: PropertyLocation.BELOW,
      },
      {
        code: nextRepDateSlotCode,
        name: 'Next Rep Date',
        propertyType: PropertyType.DATE,
        propertyLocation: PropertyLocation.BELOW,
      },
      {
        code: repHistorySlotCode,
        name: 'History',
        hidden: true,
      },
    ],
  });

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
  
  // Register the new setting as a number input, as sliders are not supported.
  plugin.settings.registerNumberSetting({
    id: defaultPriorityId,
    title: 'Default Priority',
    description: 'Sets the default priority for new incremental rem (0-100, Lower = more important). Default: 10',
    defaultValue: 10,
    // Use validators to enforce the range and type.
    validators: [
      {
        type: "int" as const // Ensures the input is a whole number
      },
      {
        type: "gte" as const, // "Greater than or equal to"
        arg: 0,
      },
      {
        type: "lte" as const, // "Less than or equal to"
        arg: 100,
      },
    ]
  });

  plugin.settings.registerBooleanSetting({
    id: displayPriorityShieldId,
    title: 'Display Priority Shield in Queue',
    description: 'If enabled, shows a real-time status of your highest-priority due items in the queue top bar.',
    defaultValue: true,
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
        value: 'beta'
      },
      { 
        key: 'www', 
        label: 'Regular (www.remnote.com)',
        value: 'www'
      }
    ]
  });

  // Note: doesn't handle rem just tagged with incremental rem powerup because they don't have powerup slots yet
  // so added special handling in initIncrementalRem
  plugin.track(async (rp) => {
    const powerup = await rp.powerup.getPowerupByCode(powerupCode);
    const taggedRem = (await powerup?.taggedRem()) || [];
    const updatedAllRem = (
      await Promise.all(taggedRem.map((rem) => getIncrementalRemInfo(plugin, rem)))
    ).filter(Boolean) as IncrementalRem[];
    await plugin.storage.setSession(allIncrementalRemKey, updatedAllRem);
  });

  // TODO: some handling to include extracts created in current queue in the queue?
  // or unnecessary due to init interval? could append to this list

  plugin.event.addListener(AppEvents.QueueExit, undefined, async ({ subQueueId }) => {
    console.log('QueueExit triggered, subQueueId:', subQueueId);
    
    // IMPORTANT: Get the scope BEFORE clearing it
    const docScopeRemIds = await plugin.storage.getSession<RemId[] | null>(currentScopeRemIdsKey);
    console.log('Document scope RemIds at exit:', docScopeRemIds);
    
    const allRems = (await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || [];

    if (allRems.length > 0) {
      const today = dayjs().format('YYYY-MM-DD');
      
      // Save KB-level priority shield
      const unreviewedDueRems = allRems.filter(
        (rem) => Date.now() >= rem.nextRepDate
      );

      let kbFinalStatus = {
        absolute: null as number | null,
        percentile: 100,
      };

      if (unreviewedDueRems.length > 0) {
        const topMissedInKb = _.minBy(unreviewedDueRems, (rem) => rem.priority);
        if (topMissedInKb) {
          kbFinalStatus.absolute = topMissedInKb.priority;
          kbFinalStatus.percentile = calculateRelativePriority(allRems, topMissedInKb.remId);
        }
      }
      
      // Save KB history
      const kbHistory = (await plugin.storage.getSynced(priorityShieldHistoryKey)) || {};
      kbHistory[today] = kbFinalStatus;
      await plugin.storage.setSynced(priorityShieldHistoryKey, kbHistory);
      console.log('Saved KB history:', kbFinalStatus);
      
      // Save Document-level priority shield if we have scope data
      // Note: We check docScopeRemIds (which we got BEFORE clearing) instead of subQueueId
      if (docScopeRemIds && docScopeRemIds.length > 0) {
        console.log('Processing document-level shield with', docScopeRemIds.length, 'scoped rems');
        
        const scopedRems = allRems.filter((rem) => docScopeRemIds.includes(rem.remId));
        console.log('Found', scopedRems.length, 'incremental rems in document scope');
        
        const unreviewedDueInScope = scopedRems.filter(
          (rem) => Date.now() >= rem.nextRepDate
        );
        console.log('Found', unreviewedDueInScope.length, 'due rems in document scope');
        
        let docFinalStatus = {
          absolute: null as number | null,
          percentile: 100,
        };
        
        if (unreviewedDueInScope.length > 0) {
          const topMissedInDoc = _.minBy(unreviewedDueInScope, (rem) => rem.priority);
          if (topMissedInDoc) {
            docFinalStatus.absolute = topMissedInDoc.priority;
            docFinalStatus.percentile = calculateRelativePriority(scopedRems, topMissedInDoc.remId);
          }
        }
        
        // Get the stored subQueueId since the parameter might not always be passed
        const storedSubQueueId = subQueueId || await plugin.storage.getSession<string>(currentSubQueueIdKey);
        
        if (storedSubQueueId) {
          // Save document history with subQueueId as key
          const docHistory = (await plugin.storage.getSynced(documentPriorityShieldHistoryKey)) || {};
          if (!docHistory[storedSubQueueId]) {
            docHistory[storedSubQueueId] = {};
          }
          docHistory[storedSubQueueId][today] = docFinalStatus;
          await plugin.storage.setSynced(documentPriorityShieldHistoryKey, docHistory);
          console.log('Saved document history for', storedSubQueueId, ':', docFinalStatus);
        } else {
          console.log('Warning: No subQueueId available for saving document history');
        }
      } else {
        console.log('No document scope RemIds found or empty - skipping document history save');
      }
    }

    // Reset session-specific state AFTER we've used the data
    await plugin.storage.setSession(seenRemInSessionKey, []);
    sessionItemCounter = 0;
    await plugin.storage.setSession(currentScopeRemIdsKey, null);
    await plugin.storage.setSession(currentSubQueueIdKey, null);
    console.log('Session state reset complete');
  });

  plugin.event.addListener(AppEvents.QueueEnter, undefined, async ({ subQueueId }) => {
    await plugin.storage.setSession(seenRemInSessionKey, []);
    sessionItemCounter = 0;
    await plugin.storage.setSession(currentScopeRemIdsKey, null);
    // Store the current subQueueId
    await plugin.storage.setSession(currentSubQueueIdKey, subQueueId || null);
    console.log('QueueEnter - storing subQueueId:', subQueueId);
  });

  const nextRepDateSlotRem = await plugin.powerup.getPowerupSlotByCode(
    powerupCode,
    nextRepDateSlotCode
  );

  plugin.app.registerCommand({
    id: nextRepCommandId,
    name: 'Next Repetition',
    action: async () => {
      const rem = await getCurrentIncrementalRem(plugin);
      const url = await plugin.window.getURL();
      debugger;
      if (!rem || !url.includes('/flashcards')) {
        return;
      }
      const incRem = await getIncrementalRemInfo(plugin, rem);
      await handleHextRepetitionClick(plugin, incRem);
    },
  });

  const unregisterQueueCSS = async (plugin: RNPlugin) => {
    await plugin.app.registerCSS(collapseTopBarId, '');
  };

  plugin.app.registerCallback<SpecialPluginCallback.GetNextCard>(
    SpecialPluginCallback.GetNextCard,
    async (queueInfo) => {
      console.log('queueInfo', queueInfo);
      const allIncrementalRem: IncrementalRem[] =
        (await plugin.storage.getSession(allIncrementalRemKey)) || [];

      // --- REFACTORED LOGIC START ---
      // Read the scope directly from session storage, making it the single source of truth.
      let docScopeRemIds = await plugin.storage.getSession<RemId[] | null>(currentScopeRemIdsKey);

      // If we are in a document queue but the scope hasn't been calculated yet for this session (it's null)...
      if (queueInfo.subQueueId && docScopeRemIds === null) {
        const subQueueRem = await plugin.rem.findOne(queueInfo.subQueueId);
        // Special handling for studying a daily doc.
        const referencedRemIds = _.compact(
          ((await subQueueRem?.remsReferencingThis()) || []).map((rem) => {
            if (nextRepDateSlotRem && (rem.text?.[0] as any)?._id === nextRepDateSlotRem._id) {
              return rem.parent;
            } else {
              return rem._id;
            }
          })
        );
        
        // Calculate the new scope.
        const newScope = ((await subQueueRem?.allRemInFolderQueue()) || [])
          .map((x) => x._id)
          .concat(((await subQueueRem?.getSources()) || []).map((x) => x._id))
          .concat(referencedRemIds)
          .concat(queueInfo.subQueueId);
        
        // Update our variable for this run AND save to storage for other parts of the plugin.
        docScopeRemIds = newScope;
        await plugin.storage.setSession(currentScopeRemIdsKey, docScopeRemIds);
      }
      // --- REFACTORED LOGIC END ---

      const cardsPerRem = await getCardsPerRem(plugin);
      const intervalBetweenIncRem = 
        typeof cardsPerRem === 'number' ? cardsPerRem + 1 : cardsPerRem;
      
      const sorted = _.sortBy(allIncrementalRem, (incRem) => {
        if (queueInfo.mode === 'in-order' && docScopeRemIds) {
          // Use the fetched scope for in-order sorting.
          return docScopeRemIds.indexOf(incRem.remId);
        } else {
          return incRem.priority;
        }
      });
      
      // Use the fetched scope for filtering.
      const seenRemIds = (await plugin.storage.getSession<RemId[]>(seenRemInSessionKey)) || [];
      const filtered = sorted.filter((x) => {
        const isDue = Date.now() >= x.nextRepDate;
        const hasBeenSeen = seenRemIds.includes(x.remId);
        const isInScope = !queueInfo.subQueueId || docScopeRemIds?.includes(x.remId);
        
        if (!isInScope) {
          return false;
        }

        switch (queueInfo.mode) {
          case 'practice-all':
          case 'in-order':
            return !hasBeenSeen;
          default: // SRS mode
            return isDue && !hasBeenSeen;
        }
      });


      plugin.app.registerCSS(
        queueCounterId,
        `
        .rn-queue__card-counter {
          visibility: hidden;
        }

        .light .rn-queue__card-counter:after {
          content: '${queueInfo.numCardsRemaining} + ${filtered.length}';
          visibility: visible;
          background-color: #f0f0f0;
          display: inline-block;
          padding: 0.5rem 1rem;
          font-size: 0.875rem;
          border-radius: 0.25rem;
        }

        .dark .rn-queue__card-counter:after {
          content: '${queueInfo.numCardsRemaining} + ${filtered.length}';
          visibility: visible;
          background-color: #34343c;
          font-color: #d4d4d0;
          display: inline-block;
          padding: 0.5rem 1rem;
          font-size: 0.875rem;
          border-radius: 0.25rem;
        }`.trim()
              );

      if (
        (typeof intervalBetweenIncRem === 'number' &&
          (sessionItemCounter + 1) % intervalBetweenIncRem === 0) || // <-- This line is corrected
        queueInfo.numCardsRemaining === 0 ||
        intervalBetweenIncRem === 'no-cards'
      ) {
        // do n random swaps
        const sortingRandomness = await getSortingRandomness(plugin);
        const num_random_swaps = sortingRandomness * allIncrementalRem.length;
        for (let i = 0; i < num_random_swaps; i++) {
          const idx1 = Math.floor(Math.random() * filtered.length);
          const idx2 = Math.floor(Math.random() * filtered.length);
          const temp = filtered[idx1];
          filtered[idx1] = filtered[idx2];
          filtered[idx2] = temp;
        }

        if (filtered.length === 0) {
          await plugin.app.registerCSS(queueLayoutFixId, '');
          return null;
        } else {
          // make sure we don't show a rem that has been deleted
          let first = filtered[0];
          while (!(await getIncrementalRemInfo(plugin, await plugin.rem.findOne(first.remId)))) {
            filtered.shift();
            if (filtered.length === 0) {
              return null;
            } else {
              first = filtered[0];
            }
          }
          await plugin.app.registerCSS(queueLayoutFixId, QUEUE_LAYOUT_FIX_CSS);
          await plugin.storage.setSession(seenRemInSessionKey, [...seenRemIds, first.remId]);
          console.log('nextRep', first, 'due', dayjs(first.nextRepDate).fromNow());
          sessionItemCounter++;
          return {
            remId: first.remId,
            pluginId: 'incremental-everything',
          };
        }
      } else {
        sessionItemCounter++;
        await plugin.app.registerCSS(queueLayoutFixId, '');
        return null;
      }
    }
  );

  async function initIncrementalRem(rem: Rem) {
    // First, check if the Rem has already been initialized.
    const isAlreadyIncremental = await rem.hasPowerup(powerupCode);

    // Only set the default values if it's a new incremental Rem.
    if (!isAlreadyIncremental) {
      const initialInterval = (await plugin.settings.getSetting<number>(initialIntervalId)) || 0;
      
      // Get the default priority from settings
      const defaultPrioritySetting = (await plugin.settings.getSetting<number>(defaultPriorityId)) || 10;
      const defaultPriority = Math.min(100, Math.max(0, defaultPrioritySetting));
      
      // Try to inherit priority from closest incremental ancestor
      const initialPriority = await getInitialPriority(plugin, rem, defaultPriority);

      await rem.addPowerup(powerupCode);

      const nextRepDate = new Date(Date.now() + (initialInterval * 24 * 60 * 60 * 1000));
      const dateRef = await getDailyDocReferenceForDate(plugin, nextRepDate);
      if (!dateRef) {
        return;
      }

      await rem.setPowerupProperty(powerupCode, nextRepDateSlotCode, dateRef);
      await rem.setPowerupProperty(powerupCode, prioritySlotCode, [initialPriority.toString()]);

      // Initialize the history property to prevent validation errors.
      await rem.setPowerupProperty(powerupCode, repHistorySlotCode, [JSON.stringify([])]);


      const newIncRem = await getIncrementalRemInfo(plugin, rem);
      if (!newIncRem) {
        return;
      }

      const allIncrementalRem: IncrementalRem[] =
        (await plugin.storage.getSession(allIncrementalRemKey)) || [];
      const updatedAllRem = allIncrementalRem
        .filter((x) => x.remId !== newIncRem.remId)
        .concat(newIncRem);
      await plugin.storage.setSession(allIncrementalRemKey, updatedAllRem);
    }
  } 

  plugin.app.registerWidget('priority', WidgetLocation.Popup, {
    dimensions: {
      width: '100%',
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
      height: 850,
    },
  });

  const createExtract = async () => {
    const selection = await plugin.editor.getSelection();
    if (!selection) {
      return;
    }
    // TODO: extract within extract support
    if (selection.type === SelectionType.Text) {
      const focused = await plugin.focus.getFocusedRem();
      if (!focused) {
        return;
      }
      await initIncrementalRem(focused);
      return focused;
    } else if (selection.type === SelectionType.Rem) {
      const rems = (await plugin.rem.findMany(selection.remIds)) || [];
      await Promise.all(rems.map(initIncrementalRem));
    } else {
      const highlight = await plugin.reader.addHighlight();
      if (!highlight) {
        return;
      }
      await initIncrementalRem(highlight);
      return highlight;
    }
  };

  await plugin.app.registerCommand({
    id: 'extract-with-priority',
    name: 'Extract with Priority',
    keyboardShortcut: 'opt+shift+x',
    action: async () => {
      const rem = await createExtract();
      if (!rem) {
        return;
      }
      await plugin.widget.openPopup('priority', {
        remId: rem._id,
      });
    },
  });

  plugin.app.registerCommand({
    id: 'set-priority',
    name: 'Set Priority',
    keyboardShortcut: 'opt+p',
    action: async () => {
      const rem = await plugin.focus.getFocusedRem();
      if (!rem) {
        return;
      }
      if (!(await rem.hasPowerup(powerupCode))) {
        await initIncrementalRem(rem);
      }
      await plugin.widget.openPopup('priority', {
        remId: rem._id,
      });
    },
  });

  plugin.app.registerCommand({
    id: 'set-page-range',
    name: 'Set PDF page range',
    action: async () => {
      const rem = await plugin.focus.getFocusedRem();
      if (!rem) {
        return;
      }

      // 1. Find the associated PDF Rem within the focused Rem or its descendants
      const pdfRem = await findPDFinRem(plugin, rem);

      // 2. If no PDF is found, inform the user and stop.
      if (!pdfRem) {
        await plugin.app.toast('No PDF found in the focused Rem or its children.');
        return;
      }

      // 3. Ensure the focused Rem is an incremental Rem, initializing it if necessary.
      if (!(await rem.hasPowerup(powerupCode))) {
        await initIncrementalRem(rem);
      }

      // 4. Prepare the context for the popup widget, similar to how the Reader does it.
      //    This context tells the popup which incremental Rem and which PDF to work with.
      const context = {
        incrementalRemId: rem._id,
        pdfRemId: pdfRem._id,
        totalPages: undefined, // Not available in the editor context
        currentPage: undefined, // Not available in the editor context
      };

      // 5. Store the context in session storage so the popup can access it.
      await plugin.storage.setSession('pageRangeContext', context);

      // 6. Open the popup widget.
      await plugin.widget.openPopup(pageRangeWidgetId, {
        remId: rem._id, // Pass remId for consistency, though the widget relies on session context.
      });
    },
  });

  plugin.app.registerCommand({
    id: 'incremental-everything',
    keyboardShortcut: 'opt+x',
    name: 'Incremental Everything',
    action: async () => {
      createExtract();
    },
  });

  plugin.app.registerCommand({
    id: 'untag-incremental-everything',
    name: 'Untag Incremental Everything',
    action: async () => {
      const selection = await plugin.editor.getSelection();
      if (!selection) {
        return;
      }
      if (selection.type === SelectionType.Text) {
        const focused = await plugin.focus.getFocusedRem();
        if (!focused) {
          return;
        }
        await focused.removePowerup(powerupCode);
      } else if (selection.type === SelectionType.Rem) {
        const rems = (await plugin.rem.findMany(selection.remIds)) || [];
        await Promise.all(rems.map((r) => r.removePowerup(powerupCode)));
      }
    },
  });


  plugin.app.registerWidget('debug', WidgetLocation.Popup, {
    dimensions: {
      width: '350px',
      height: 'auto',
    },
  });

  plugin.app.registerCommand({
    id: 'debug-incremental-everything',
    name: 'Debug Incremental Everything',
    action: async () => {
      const rem = await plugin.focus.getFocusedRem();
      if (!rem) {
        return;
      }
      if (!(await rem.hasPowerup(powerupCode))) {
        return;
      }
      await plugin.widget.openPopup('debug', {
        remId: rem._id,
      });
    },
  });

  plugin.event.addListener(AppEvents.URLChange, undefined, async () => {
    const url = await plugin.window.getURL();
    if (!url.includes('/flashcards')) {
      plugin.app.unregisterMenuItem(scrollToHighlightId);
      plugin.app.registerCSS(collapseTopBarId, '');
      plugin.app.registerCSS(queueCounterId, '');
      plugin.app.registerCSS(hideIncEverythingId, '');
      setCurrentIncrementalRem(plugin, undefined);
    } else {
    }
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

  plugin.app.registerMenuItem({
    id: 'sorting_criteria_menuitem',
    location: PluginCommandMenuLocation.QueueMenu,
    name: 'Sorting Criteria',
    action: async () => {
      await plugin.widget.openPopup('sorting_criteria');
    },
  });

  plugin.app.registerWidget('priority_shield_graph', WidgetLocation.Popup, {
    dimensions: {
      width: 1000,
      height: 1050,
    },
  });


  plugin.app.registerMenuItem({
    id: priorityShieldHistoryMenuItemId,
    name: 'Priority Shield History',
    location: PluginCommandMenuLocation.QueueMenu,
    action: async () => {
      // Get the stored subQueueId from session
      const subQueueId = await plugin.storage.getSession<string | null>(currentSubQueueIdKey);
      console.log('Opening Priority Shield Graph with subQueueId:', subQueueId);
      
      await plugin.widget.openPopup('priority_shield_graph', {
        subQueueId: subQueueId
      });
    },
  });

  plugin.app.registerMenuItem({
    id: 'tag_rem_menuitem',
    location: PluginCommandMenuLocation.DocumentMenu,
    name: 'Toggle tag as Incremental Rem',
    action: async (args: { remId: string }) => {
      const rem = await plugin.rem.findOne(args.remId);
      if (!rem) {
        return;
      }
      const isIncremental = await rem.hasPowerup(powerupCode);
      if (isIncremental) {
        await rem.removePowerup(powerupCode);
      } else {
        await initIncrementalRem(rem);
      }
      const msg = isIncremental ? 'Untagged as Incremental Rem' : 'Tagged as Incremental Rem';
      await plugin.app.toast(msg);
    },
  });


  plugin.app.registerMenuItem({
    id: 'tag_highlight',
    location: PluginCommandMenuLocation.PDFHighlightPopupLocation,
    name: 'Toggle Incremental Rem',
    action: async (args: { remId: string }) => {
      const rem = await plugin.rem.findOne(args.remId);
      if (!rem) {
        return;
      }

      const isIncremental = await rem.hasPowerup(powerupCode);

      if (isIncremental) {
        // If it's already incremental, just remove the powerup.
        await rem.removePowerup(powerupCode);
        await plugin.app.toast('Untagged as Incremental Rem');
      } else {
        // If it's not incremental, initialize it and open the priority popup.
        await initIncrementalRem(rem);
        await plugin.widget.openPopup('priority', {
          remId: rem._id,
        });
      }
    },
    iconUrl: 'https://cdn-icons-png.flaticon.com/512/2232/2232688.png',
  });

  
}

async function onDeactivate(_: ReactRNPlugin) {}

declareIndexPlugin(onActivate, onDeactivate);
