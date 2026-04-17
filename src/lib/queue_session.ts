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
}

export function hasActiveSession(): boolean {
  return currentSession !== null;
}

export function registerQueueSessionTracking(plugin: ReactRNPlugin) {
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
        scopeName = 'Ad-hoc Session';
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

      // Lazy session init (mobile fix: QueueEnter sometimes doesn't fire on iOS)
      if (!currentSession) {
        try {
          const kbData = await plugin.kb.getCurrentKnowledgeBaseData();
          currentSession = {
            id: Math.random().toString(36).substring(7),
            startTime: now,
            kbId: kbData._id,
            scopeName: 'Restored Mobile Session',
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
        // Shift current → previous card stats
        if (currentSession) {
          currentSession.prevCardFirstRep = currentSession.currentCardFirstRep;
          currentSession.prevCardTotalTime = currentSession.currentCardTotalTime;
          currentSession.prevCardRepCount = currentSession.currentCardRepCount;
          currentSession.prevCardId = currentSession.currentCardId;
          currentSession.currentCardId = data.cardId;

          const card = await plugin.card.findOne(data.cardId);
          if (card?.repetitionHistory && card.repetitionHistory.length > 0) {
            const dates = card.repetitionHistory.map((h) => h.date);
            currentSession.currentCardFirstRep = Math.min(...dates);

            const lastRepTime =
              card.lastRepetitionTime || (dates.length > 0 ? Math.max(...dates) : undefined);
            currentSession.currentCardInterval =
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
            currentSession.currentCardTotalTime = totalCardTime;
            currentSession.currentCardRepCount = totalCardReps;
          } else {
            currentSession.currentCardFirstRep = undefined;
            currentSession.currentCardTotalTime = 0;
            currentSession.currentCardRepCount = 0;
            currentSession.currentCardInterval = undefined;
          }

          await syncLiveSession(plugin);
        }

        cardStartTimes.set(data.cardId, now);
      }
    } catch (error) {
      console.error('ERROR in QueueSession QueueLoadCard listener:', error);
    }
  });

  plugin.event.addListener(AppEvents.QueueCompleteCard, undefined, async (message: any) => {
    try {
      const { cardId, score } = message as { cardId: string; score: QueueInteractionScore };

      if (currentSession && cardId) {
        const startTime = cardStartTimes.get(cardId);
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
            if (currentSession.currentCardId === cardId) {
              currentSession.currentCardTotalTime =
                (currentSession.currentCardTotalTime || 0) + timeSpent;
              currentSession.currentCardRepCount =
                (currentSession.currentCardRepCount || 0) + 1;
            }
            if (currentSession.prevCardId === cardId) {
              currentSession.prevCardTotalTime =
                (currentSession.prevCardTotalTime || 0) + timeSpent;
              currentSession.prevCardRepCount =
                (currentSession.prevCardRepCount || 0) + 1;
            }
          }

          cardStartTimes.delete(cardId);
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
          currentSession.currentCardId === cardId ||
          currentSession.prevCardId === cardId
        ) {
          const card = await plugin.card.findOne(cardId);
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
