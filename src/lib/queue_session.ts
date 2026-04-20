import {
  AppEvents,
  QueueInteractionScore,
  QueueItemType,
  ReactRNPlugin,
} from '@remnote/plugin-sdk';
import { safeRemTextToString } from './pdfUtils';
import type { PracticedQueueSession } from '../widgets/practiced_queues';

const PRACTICED_QUEUES_HISTORY_KEY = 'practicedQueuesHistory';
const ACTIVE_SESSION_KEY = 'activeQueueSession';
const FLASHCARD_RESPONSE_TIME_LIMIT_SETTING = 'flashcard_response_time_limit';
const DEFAULT_RESPONSE_TIME_LIMIT_SEC = 180;

let currentSession: PracticedQueueSession | null = null;
const cardStartTimes = new Map<string, number>();
let currentIncRemStart: number | null = null;

async function syncLiveSession(plugin: ReactRNPlugin) {
  await plugin.storage.setSession(ACTIVE_SESSION_KEY, currentSession);
}

export async function saveCurrentSession(plugin: ReactRNPlugin, _reason: string) {
  if (!currentSession) return;

  currentSession.endTime = Date.now();

  if (currentIncRemStart) {
    currentSession.incRemsTime += Date.now() - currentIncRemStart;
  }
  currentSession.totalTime = currentSession.flashcardsTime + currentSession.incRemsTime;

  if (currentSession.flashcardsCount > 0 || currentSession.incRemsCount > 0) {
    const history =
      ((await plugin.storage.getSynced(PRACTICED_QUEUES_HISTORY_KEY)) as PracticedQueueSession[]) || [];
    await plugin.storage.setSynced(PRACTICED_QUEUES_HISTORY_KEY, [currentSession, ...history]);
  }

  currentSession = null;
  cardStartTimes.clear();
  currentIncRemStart = null;
  await plugin.storage.setSession(ACTIVE_SESSION_KEY, null);
  await plugin.storage.setSession('finalDrillHeartbeat', 0);
}

export function hasActiveSession(): boolean {
  return currentSession !== null;
}

/**
 * Populate the `currentCard*` lifetime stats on the given session from a card's
 * repetitionHistory. Used by both QueueLoadCard and the cluster-sibling poll.
 */
async function loadCardStats(
  plugin: ReactRNPlugin,
  session: PracticedQueueSession,
  cardId: string
) {
  const card = await plugin.card.findOne(cardId);
  if (card?.repetitionHistory && card.repetitionHistory.length > 0) {
    const dates = card.repetitionHistory.map((h) => h.date);
    session.currentCardFirstRep = Math.min(...dates);

    const lastRepTime =
      card.lastRepetitionTime || (dates.length > 0 ? Math.max(...dates) : undefined);
    session.currentCardInterval =
      card.nextRepetitionTime && lastRepTime
        ? card.nextRepetitionTime - lastRepTime
        : undefined;

    let totalCardTime = 0;
    let totalCardReps = 0;
    for (const rep of card.repetitionHistory) {
      if (rep.score !== QueueInteractionScore.TOO_EARLY) {
        totalCardReps++;
        if (rep.responseTime) totalCardTime += rep.responseTime;
      }
    }
    session.currentCardTotalTime = totalCardTime;
    session.currentCardRepCount = totalCardReps;
  } else {
    session.currentCardFirstRep = undefined;
    session.currentCardTotalTime = 0;
    session.currentCardRepCount = 0;
    session.currentCardInterval = undefined;
  }
}

export function registerQueueSessionTracking(plugin: ReactRNPlugin) {
  // Heartbeat monitor: auto-save Mastery Drill session if the popup is closed without QueueExit
  setInterval(async () => {
    if (currentSession && currentSession.scopeName === 'Mastery Drill') {
      if (Date.now() - currentSession.startTime < 5000) return; // grace period
      const lastHeartbeat = await plugin.storage.getSession<number>('finalDrillHeartbeat');
      if (lastHeartbeat) {
        if (Date.now() - lastHeartbeat > 5000) {
          await saveCurrentSession(plugin, 'Heartbeat Stale');
        }
      }
    }
  }, 2500);

  // Cluster sibling-transition poll: inside a cluster, QueueLoadCard does NOT fire per
  // sibling — only card_priority_display.tsx sees each sibling via getWidgetContext().
  // The widget broadcasts `clusterVisibleCardId`; we poll for changes and advance the
  // per-card panel state (currentCardId/prevCardId + lifetime stats) so the UI tracks
  // the sibling actually on screen rather than being stuck on the cluster anchor.
  setInterval(async () => {
    if (!currentSession) return;
    try {
      const vis = await plugin.storage.getSession<string>('clusterVisibleCardId');
      if (!vis || vis === currentSession.currentCardId) return;

      currentSession.prevCardFirstRep = currentSession.currentCardFirstRep;
      currentSession.prevCardTotalTime = currentSession.currentCardTotalTime;
      currentSession.prevCardRepCount = currentSession.currentCardRepCount;
      currentSession.prevCardId = currentSession.currentCardId;
      currentSession.currentCardId = vis;

      await loadCardStats(plugin, currentSession, vis);
      await syncLiveSession(plugin);
    } catch (error) {
      console.error('ERROR in cluster sibling-transition poll:', error);
    }
  }, 500);

  plugin.event.addListener(AppEvents.QueueEnter, undefined, async (data: any) => {
    try {
      if (currentSession) {
        await saveCurrentSession(plugin, 'QueueEnter Overwrite');
      }

      const kbData = await plugin.kb.getCurrentKnowledgeBaseData();

      let scopeName = 'Ad-hoc Queue';
      const queueId: string | undefined = data?.subQueueId;
      const isValidId = queueId && typeof queueId === 'string' && !queueId.startsWith('0.');

      if (isValidId) {
        const rem = await plugin.rem.findOne(queueId);
        if (rem) {
          const text = rem.text ? await safeRemTextToString(plugin, rem.text) : '';
          scopeName = text && text !== 'Untitled' ? text : 'Untitled';
        }
      } else {
        // Generated queueId could be "Practice All", "Mastery Drill", or "Embedded Queue"
        const isFinalDrillActive = await plugin.storage.getSession<boolean>('finalDrillActive');
        const lastHeartbeat = await plugin.storage.getSession<number>('finalDrillHeartbeat');
        const isFresh = lastHeartbeat && Date.now() - lastHeartbeat < 4000;
        scopeName = isFinalDrillActive || isFresh ? 'Mastery Drill' : 'Ad-hoc Session';
      }

      currentSession = {
        id: Math.random().toString(36).substring(7),
        startTime: Date.now(),
        kbId: kbData._id,
        queueId: isValidId ? queueId : undefined,
        scopeName,
        totalTime: 0,
        flashcardsCount: 0,
        flashcardsTime: 0,
        incRemsCount: 0,
        incRemsTime: 0,
        againCount: 0,
        currentCardFirstRep: undefined,
      };

      await syncLiveSession(plugin);
      cardStartTimes.clear();
      currentIncRemStart = null;
    } catch (error) {
      console.error('ERROR in QueueSession QueueEnter listener:', error);
    }
  });

  plugin.event.addListener(AppEvents.QueueExit, undefined, async () => {
    if (currentSession) {
      await saveCurrentSession(plugin, 'QueueExit Event');
    }
  });

  plugin.event.addListener('force_save_session', undefined, async () => {
    if (currentSession) {
      await saveCurrentSession(plugin, 'force_save_session Event');
    }
  });

  plugin.event.addListener(AppEvents.QueueLoadCard, undefined, async (data: any) => {
    try {
      const now = Date.now();
      const type = await plugin.queue.getCurrentQueueScreenType();

      // Staleness defense: clear cluster signals at the start of each new card load so a
      // value left over from the previous card can't leak in if the widget fails to mount.
      // Inside a cluster, QueueLoadCard does not fire per sibling, so the widget's writes
      // for subsequent siblings are preserved (only overwritten, not cleared, between them).
      await plugin.storage.setSession('clusterVisibleCardId', undefined);
      await plugin.storage.setSession('clusterVisibleCardLoadTime', undefined);

      // Lazy session init (mobile fix: QueueEnter sometimes doesn't fire on iOS)
      if (!currentSession) {
        try {
          const kbData = await plugin.kb.getCurrentKnowledgeBaseData();
          const isFinalDrillActive = await plugin.storage.getSession<boolean>('finalDrillActive');
          currentSession = {
            id: Math.random().toString(36).substring(7),
            startTime: now,
            kbId: kbData._id,
            scopeName: isFinalDrillActive ? 'Mastery Drill' : 'Restored Mobile Session',
            totalTime: 0,
            flashcardsCount: 0,
            flashcardsTime: 0,
            incRemsCount: 0,
            incRemsTime: 0,
            againCount: 0,
            currentCardFirstRep: undefined,
          };
          await syncLiveSession(plugin);
          cardStartTimes.clear();
          currentIncRemStart = null;
        } catch (err) {
          console.error('ERROR: Failed to lazily initialize practice session', err);
        }
      }

      const isLikelyIncRem =
        type === QueueItemType.Plugin || ((type === undefined || type === null) && !data?.cardId);

      if (isLikelyIncRem) {
        if (currentIncRemStart && currentSession) {
          const duration = now - currentIncRemStart;
          currentSession.incRemsTime += duration;
          currentSession.totalTime += duration;
        }

        if (currentSession) {
          currentSession.incRemsCount++;
        }

        currentIncRemStart = now;

        if (currentSession) {
          await syncLiveSession(plugin);
        }

        // Capture scope from first IncRem text if scope is generic
        if (
          currentSession &&
          (currentSession.scopeName === 'Untitled' ||
            currentSession.scopeName === 'Ad-hoc Queue' ||
            currentSession.scopeName === 'Ad-hoc Session' ||
            !currentSession.scopeName) &&
          data?.remId
        ) {
          const rem = await plugin.rem.findOne(data.remId);
          if (rem?.text) {
            const text = await safeRemTextToString(plugin, rem.text);
            if (text && text !== 'Untitled') currentSession.scopeName = text;
          }
        }
      } else {
        // Switched to a flashcard — close any open IncRem timing
        if (currentIncRemStart && currentSession) {
          const duration = now - currentIncRemStart;
          currentSession.incRemsTime += duration;
          currentSession.totalTime += duration;
        }
        currentIncRemStart = null;
      }

      if (data?.cardId) {
        // Track current and previous card for Mastery Drill edit features
        const lastCurrentId = await plugin.storage.getSession<string>('finalDrillCurrentCardId');
        if (lastCurrentId && lastCurrentId !== data.cardId) {
          await plugin.storage.setSession('finalDrillPreviousCardId', lastCurrentId);
        }
        await plugin.storage.setSession('finalDrillCurrentCardId', data.cardId);

        // Shift current → previous card stats
        if (currentSession) {
          currentSession.prevCardFirstRep = currentSession.currentCardFirstRep;
          currentSession.prevCardTotalTime = currentSession.currentCardTotalTime;
          currentSession.prevCardRepCount = currentSession.currentCardRepCount;
          currentSession.prevCardId = currentSession.currentCardId;
          currentSession.currentCardId = data.cardId;

          await loadCardStats(plugin, currentSession, data.cardId);

          await syncLiveSession(plugin);
        }

        cardStartTimes.set(data.cardId, now);

        // Verify Mastery Drill scope: if we labeled this session as Mastery Drill but the
        // card isn't in the drill list, it's an embedded/ad-hoc queue collision.
        if (currentSession && currentSession.scopeName === 'Mastery Drill') {
          type FinalDrillItem = string | { cardId: string; kbId?: string };
          const finalDrillItems =
            ((await plugin.storage.getSynced('finalDrillIds')) as FinalDrillItem[]) || [];
          const isOurCard =
            finalDrillItems.length > 0 &&
            finalDrillItems.some((item) =>
              (typeof item === 'string' ? item : item.cardId) === data.cardId
            );
          if (!isOurCard) {
            currentSession.scopeName = 'Ad-hoc Session';
          }
        }
      }
    } catch (error) {
      console.error('ERROR in QueueSession QueueLoadCard listener:', error);
    }
  });

  plugin.event.addListener(AppEvents.QueueCompleteCard, undefined, async (message: any) => {
    try {
      const { cardId, score } = message as { cardId: string; score: QueueInteractionScore };

      // Cluster-aware: RemNote keeps the FlashcardUnder widget mounted across cluster
      // siblings and only getWidgetContext().cardId advances; QueueLoadCard + the event's
      // cardId both stick to the anchor. card_priority_display.tsx broadcasts the actually
      // visible sibling id + load time so we can still record count and time per sibling.
      const clusterCardId = cardId
        ? await plugin.storage.getSession<string>('clusterVisibleCardId')
        : undefined;
      const clusterLoadTime = cardId
        ? (await plugin.storage.getSession<number>('clusterVisibleCardLoadTime')) || undefined
        : undefined;
      const effectiveCardId = clusterCardId || cardId;

      if (currentSession && cardId) {
        // Prefer the QueueLoadCard-recorded start time (more accurate for anchor / first card);
        // fall back to the widget-recorded sibling load time for subsequent siblings.
        const startTime = cardStartTimes.get(effectiveCardId) ?? clusterLoadTime;
        if (startTime) {
          const rawTimeSpent = Date.now() - startTime;
          const timeLimitSec =
            (await plugin.settings.getSetting<number>(FLASHCARD_RESPONSE_TIME_LIMIT_SETTING)) ||
            DEFAULT_RESPONSE_TIME_LIMIT_SEC;
          const timeSpent = Math.min(rawTimeSpent, timeLimitSec * 1000);

          currentSession.totalTime += timeSpent;
          currentSession.flashcardsTime += timeSpent;
          currentSession.flashcardsCount++;
          if (score === QueueInteractionScore.AGAIN) {
            currentSession.againCount = (currentSession.againCount || 0) + 1;
          }

          if (score !== QueueInteractionScore.TOO_EARLY) {
            if (currentSession.currentCardId === effectiveCardId) {
              currentSession.currentCardTotalTime =
                (currentSession.currentCardTotalTime || 0) + timeSpent;
              currentSession.currentCardRepCount =
                (currentSession.currentCardRepCount || 0) + 1;
            }
            if (currentSession.prevCardId === effectiveCardId) {
              currentSession.prevCardTotalTime =
                (currentSession.prevCardTotalTime || 0) + timeSpent;
              currentSession.prevCardRepCount =
                (currentSession.prevCardRepCount || 0) + 1;
            }
          }

          cardStartTimes.delete(effectiveCardId);
        }
      } else if (currentIncRemStart && currentSession) {
        // No cardId means IncRem completion (or generic) — close timing
        const duration = Date.now() - currentIncRemStart;
        currentSession.incRemsTime += duration;
        currentSession.totalTime += duration;
        currentIncRemStart = null;
      }

      // Update prev-card interval/coverage now that scheduler has updated
      if (currentSession && cardId && score !== QueueInteractionScore.TOO_EARLY) {
        if (
          currentSession.currentCardId === effectiveCardId ||
          currentSession.prevCardId === effectiveCardId
        ) {
          const card = await plugin.card.findOne(effectiveCardId);
          if (card) {
            const dates = card.repetitionHistory?.map((h) => h.date) || [];
            const lastRepTime =
              card.lastRepetitionTime || (dates.length > 0 ? Math.max(...dates) : undefined);
            if (card.nextRepetitionTime && lastRepTime) {
              currentSession.prevCardInterval = card.nextRepetitionTime - lastRepTime;
              currentSession.prevCardNextRepTime = card.nextRepetitionTime;
            }
          }
        }
      }

      if (currentSession) {
        await syncLiveSession(plugin);
      }
    } catch (error) {
      console.error('ERROR in QueueSession QueueCompleteCard listener:', error);
    }
  });
}
