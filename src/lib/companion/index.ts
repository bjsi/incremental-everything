// The plugin's half of the Chrome companion extension (companion/ in this repo).
// The extension hosts RemNote in its side panel, and a content script of its own
// runs inside this plugin's index frame. The two talk by window.postMessage within
// this frame, so no other plugin can take part, and this listener is all that runs
// where the extension is not installed, including the desktop app.

import { AppEvents, PluginRem, ReactRNPlugin, RichTextInterface } from '@remnote/plugin-sdk';
import { dismissedPowerupCode, editorReviewTimerRemIdKey, powerupCode } from '../consts';
import { addExternalSessionRep } from '../history_edit';
import { repCountsForStats } from '../incremental_rem/types';
import { getNextSpacingDateForRem } from '../scheduler';
import { canonicalUrlKey } from '../duplicate_source/url_key';
import { markRemsAsFreshlyCreated } from '../incRemHelpers';
import { getIncrementalRemFromRem, initIncrementalRem } from '../incremental_rem';
import { getPlatform, shouldUseLightMode } from '../mobileUtils';
import {
  Anchor,
  claimLegacyPage,
  companionEntryKey,
  companionShardKey,
  emptyPageState,
  indexInReadingOrder,
  isInReadingOrder,
  MAX_SHARD_CHARACTERS,
  PageState,
  remIdsOfPage,
  shardOfPage,
  sanitizeExtractRichText,
} from './rules';

const FONT_BY_DEPTH = ['H1', 'H2', 'H3'] as const;
const TEST_PLUGIN_ID = 'incremental-everything-plus';

/** A section, with the positions of the headings from the top down to it. */
type SectionChain = Array<{ text: string; position: number }>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const pageKeyOf = (url: string) => canonicalUrlKey(url) ?? url;

// ---- Telling the extension what changed in RemNote ----

type DocumentStatus = Awaited<ReturnType<typeof documentStatus>>;
/** The document the panel's header shows, and what it last said of it. */
let watchedDoc: DocumentStatus | undefined;
type WatchedExtract = { parentId?: string; kind?: 'highlight'; incremental: boolean };
/** The extracts of each page a tab has shown here, with the Rem each sits under. */
const watchedPages = new Map<string, Map<string, WatchedExtract>>();
/** Every extract and parent above, and the panel's document, for a quick test of each change event. */
let watchedIds = new Set<string>();

function rebuildWatchedIds() {
  const ids = new Set<string>(watchedDoc ? [watchedDoc.docId] : []);
  for (const page of watchedPages.values()) {
    for (const [remId, { parentId }] of page) {
      ids.add(remId);
      if (parentId) ids.add(parentId);
    }
  }
  watchedIds = ids;
}

function setWatchedPage(url: string, extracts: Map<string, WatchedExtract>) {
  watchedPages.set(url, extracts);
  rebuildWatchedIds();
}

function watchExtract(url: string, remId: string, extract: WatchedExtract) {
  setWatchedPage(url, new Map([...(watchedPages.get(url) ?? []), [remId, extract]]));
}

function watchDocument(status: NonNullable<typeof watchedDoc>) {
  watchedDoc = status;
  rebuildWatchedIds();
}

/** A highlight lives while its Rem does. An extract also needs to stay Incremental or Dismissed. */
async function isAliveExtract(plugin: ReactRNPlugin, remId: string, kind?: 'highlight') {
  const rem = await plugin.rem.findOne(remId);
  if (!rem) return { alive: false, incremental: false };
  const incremental = await rem.hasPowerup(powerupCode);
  const alive = kind === 'highlight' || incremental || (await rem.hasPowerup(dismissedPowerupCode));
  return { alive, incremental, rem };
}

/**
 * The page's document, as the panel's header shows it: whether it is Incremental,
 * the reading time its history holds, and the reviews since `since`, which the
 * Companion's clock takes out of its own unrecorded time.
 */
async function documentStatus(plugin: ReactRNPlugin, doc: PluginRem, since?: number) {
  const incremental = await doc.hasPowerup(powerupCode);
  const incRem = incremental ? await getIncrementalRemFromRem(plugin, doc) : undefined;
  const reviews = (incRem?.history ?? []).filter((rep) => repCountsForStats(rep.eventType));
  const totalSeconds = reviews.reduce((sum, rep) => sum + (rep.reviewTimeSeconds ?? 0), 0);
  const timerRemId = await plugin.storage.getSession<string>(editorReviewTimerRemIdKey);
  return {
    docId: doc._id,
    incremental,
    /** Was Incremental, and was dismissed: Make Incremental brings it back. */
    dismissed: !incremental && (await doc.hasPowerup(dismissedPowerupCode)),
    priority: incRem?.priority,
    totalSeconds,
    lastReviewAt: reviews.length ? Math.max(...reviews.map((rep) => rep.date)) : undefined,
    reviewsSince:
      since === undefined
        ? []
        : reviews
            .filter((rep) => rep.date >= since)
            .map((rep) => ({ date: rep.date, reviewTimeSeconds: rep.reviewTimeSeconds ?? 0, eventType: rep.eventType })),
    editorTimerRunning: !!timerRemId && timerRemId === doc._id,
  };
}

const sameStatus = (a: DocumentStatus, b: DocumentStatus) =>
  a.incremental === b.incremental &&
  a.dismissed === b.dismissed &&
  a.priority === b.priority &&
  a.totalSeconds === b.totalSeconds &&
  a.lastReviewAt === b.lastReviewAt &&
  a.editorTimerRunning === b.editorTimerRunning;

async function currentKbId(plugin: ReactRNPlugin): Promise<string> {
  const knowledgeBase = await plugin.kb.getCurrentKnowledgeBaseData();
  if (!knowledgeBase?._id) throw new Error('RemNote did not say which knowledge base this is.');
  return knowledgeBase._id;
}

async function readPage(plugin: ReactRNPlugin, url: string): Promise<PageState> {
  const pageKey = pageKeyOf(url);
  const entryKey = companionEntryKey(await currentKbId(plugin), pageKey);
  const shardKey = companionShardKey(shardOfPage(pageKey));
  const shard = (await plugin.storage.getSynced<Record<string, PageState>>(shardKey)) ?? {};
  const state = { ...emptyPageState(), ...shard[entryKey] };
  const legacy = shard[pageKey];
  if (!legacy) return state;

  const owned = new Set<string>();
  for (const remId of remIdsOfPage(legacy)) {
    if (await plugin.rem.findOne(remId)) owned.add(remId);
  }
  const { claimed, rest } = claimLegacyPage(legacy, owned, state);
  if (!claimed) return state;
  const { [pageKey]: _moved, ...others } = shard;
  await plugin.storage.setSynced(shardKey, { ...others, [entryKey]: claimed, ...(rest ? { [pageKey]: rest } : {}) });
  return claimed;
}

async function writePage(plugin: ReactRNPlugin, url: string, state: PageState) {
  const pageKey = pageKeyOf(url);
  const shardKey = companionShardKey(shardOfPage(pageKey));
  const shard = (await plugin.storage.getSynced<Record<string, PageState>>(shardKey)) ?? {};
  const next = { ...shard, [companionEntryKey(await currentKbId(plugin), pageKey)]: state };
  if (JSON.stringify(next).length > MAX_SHARD_CHARACTERS) {
    throw new Error('The extension has run out of room to remember highlights in this group of pages.');
  }
  await plugin.storage.setSynced(shardKey, next);
}

async function findDocument(plugin: ReactRNPlugin, docId: string) {
  // It may have been created a moment ago in this same client.
  for (let attempt = 0; attempt < 10; attempt++) {
    const doc = await plugin.rem.findOne(docId);
    if (doc) return doc;
    await sleep(300);
  }
  throw new Error(`The page's document ${docId} was not found.`);
}

/** The unlisted test plugin must stay away from real notes. */
async function guardTestPlugin(plugin: ReactRNPlugin) {
  if (new URLSearchParams(location.search).get('pluginId') !== TEST_PLUGIN_ID) return;
  if (await plugin.kb.isPrimaryKnowledgeBase()) {
    throw new Error('The test plugin refuses to write in your primary knowledge base.');
  }
}

async function positionFor(parent: PluginRem, position: number, state: PageState) {
  const children = await parent.getChildrenRem();
  return indexInReadingOrder(children.map((child) => child._id), position, state.order);
}

/** Finds or creates the Rems of a section, from the top of the chain down. */
async function ensureSection(plugin: ReactRNPlugin, doc: PluginRem, chain: SectionChain, state: PageState) {
  let parent = doc;
  let created = 0;
  const path: string[] = [];
  for (let depth = 0; depth < chain.length; depth++) {
    const { text, position } = chain[depth];
    path.push(text);
    const key = path.join('\u0001');
    const known = state.sections[key] ? await plugin.rem.findOne(state.sections[key]) : undefined;
    if (known) {
      parent = known;
      continue;
    }
    const rem = await plugin.rem.createRem();
    if (!rem) throw new Error('Could not create a section Rem.');
    await rem.setText([text]);
    const font = FONT_BY_DEPTH[depth];
    if (font) await rem.setFontSize(font);
    await rem.setParent(parent, await positionFor(parent, position, state));
    state.sections[key] = rem._id;
    state.order[rem._id] = position;
    parent = rem;
    created++;
  }
  return { section: parent, created };
}

export const OPS: Record<string, (plugin: ReactRNPlugin, data: any) => Promise<unknown>> = {
  async addExtract(plugin, data) {
    const { docId, url, text, richText, chain, opId, priority } = data;
    // Add Highlight: the same Rem in the same place, left out of the queue.
    const highlightOnly = data.highlight === true;
    const withPriority = !highlightOnly && !!data.withPriority;
    const anchor: Anchor = data.anchor;
    const started = Date.now();
    await guardTestPlugin(plugin);
    const state = await readPage(plugin, url);

    // A retry after a lost answer must not add the extract twice.
    const already = opId && state.extracts.find((extract) => extract.opId === opId);
    if (already) return { remId: already.remId, repeated: true };

    const doc = await findDocument(plugin, docId);
    const { section, created } = await ensureSection(plugin, doc, chain ?? [], state);

    const rem = await plugin.rem.createRem();
    if (!rem) throw new Error('Could not create a Rem.');
    const content = sanitizeExtractRichText(richText) as RichTextInterface;
    await rem.setText(content.length ? content : [text]);
    await rem.setParent(section, await positionFor(section, anchor.position, state));
    state.order[rem._id] = anchor.position;
    // No cascade when the priority is settled here or by the popup: a new extract
    // has no descendants to pass it to, and the popup fires its own.
    if (!highlightOnly) {
      await initIncrementalRem(plugin, rem, {
        explicitParentId: section._id,
        priority: typeof priority === 'number' ? priority : undefined,
        skipInitialCascade: withPriority || typeof priority === 'number',
      });
    }
    const elapsedMs = Date.now() - started;

    state.extracts.push({ remId: rem._id, anchor, opId, ...(highlightOnly ? { kind: 'highlight' as const } : {}) });
    await writePage(plugin, url, state);
    watchExtract(url, rem._id, { parentId: section._id, kind: highlightOnly ? 'highlight' : undefined, incremental: !highlightOnly });

    const saved = await plugin.rem.findOne(rem._id);
    if (!saved) throw new Error('The new Rem cannot be read back.');
    const siblings = await section.getChildrenRem();
    const incRem = highlightOnly ? undefined : await getIncrementalRemFromRem(plugin, saved);

    if (withPriority) {
      await plugin.storage.setSession('priorityPopupTargetRemId', undefined);
      await markRemsAsFreshlyCreated(plugin, [saved._id]);
      await plugin.widget.openPopup('priority_interval', { remId: saved._id });
    }

    return {
      remId: saved._id,
      inSection: saved.parent === section._id,
      section: chain?.map((c: { text: string }) => c.text).join(' > ') || '(top of the document)',
      sectionsCreated: created,
      inReadingOrder: isInReadingOrder(siblings.map((child) => child._id), state.order),
      isIncremental: await saved.hasPowerup(powerupCode),
      priority: incRem?.priority,
      priorityPopup: withPriority,
      highlight: highlightOnly,
      elapsedMs,
    };
  },

  async pageState(plugin, { url }) {
    const state = await readPage(plugin, url);
    const alive: PageState['extracts'] = [];
    // A highlight made Incremental since turns blue on the page.
    const shown: Array<PageState['extracts'][number] & { incremental: boolean }> = [];
    const watched = new Map<string, WatchedExtract>();
    for (const extract of state.extracts) {
      const { alive: isAlive, incremental, rem } = await isAliveExtract(plugin, extract.remId, extract.kind);
      if (!isAlive || !rem) continue;
      alive.push(extract);
      shown.push({ ...extract, incremental });
      watched.set(rem._id, { parentId: rem.parent ?? undefined, kind: extract.kind, incremental });
    }
    setWatchedPage(url, watched);
    if (alive.length !== state.extracts.length) await writePage(plugin, url, { ...state, extracts: alive });
    return { kbId: await currentKbId(plugin), extracts: shown, readPoint: state.readPoint };
  },

  async documentStatus(plugin, { docId, since }) {
    const status = await documentStatus(plugin, await findDocument(plugin, docId), since);
    watchDocument(status);
    return status;
  },

  /**
   * The Companion's reading clock, recorded as a review dated when the reading
   * stopped. The scheduler's interval runs from that moment, so a session
   * recorded the next morning still lands on the evening it was read.
   */
  async recordPageReview(plugin, { docId, reviewTimeSeconds, endedAt, url }) {
    await guardTestPlugin(plugin);
    const doc = await findDocument(plugin, docId);
    if (!(await doc.hasPowerup(powerupCode))) throw new Error("The page's document is not an Incremental Rem.");
    const seconds = Math.round(Number(reviewTimeSeconds));
    const ended = Math.min(Number(endedAt), Date.now());
    if (!(seconds > 0) || !Number.isFinite(ended)) throw new Error('There is no reading time to record.');
    const spacing = await getNextSpacingDateForRem(plugin, docId, false);
    if (!spacing) throw new Error('The scheduler could not compute the next repetition.');
    const nextRepDate = ended + Math.max(0, spacing.newNextRepDate - Date.now());
    const result = await addExternalSessionRep(plugin, docId, {
      date: ended,
      reviewTimeSeconds: seconds,
      nextRepDate,
      ...(typeof url === 'string' && /^https?:/.test(url) ? { context: { webUrl: url } } : {}),
    });
    if (!result.ok) throw new Error(result.error || 'Could not record the session.');
    const status = await documentStatus(plugin, doc);
    watchDocument(status);
    return { ...status, rescheduled: result.rescheduled, nextRepDate: result.rescheduled ? nextRepDate : undefined };
  },

  /** Shift+Enter on the clock: the Execute Repetition popup, with the time filled in. */
  async openReviewPopup(plugin, { docId, minutes }) {
    await guardTestPlugin(plugin);
    await findDocument(plugin, docId);
    await plugin.widget.openPopup('editor_review', { remId: docId, reviewMinutes: Math.max(0, Math.round(minutes)) });
    return { opened: true };
  },

  async makeDocumentIncremental(plugin, { docId, priority }) {
    await guardTestPlugin(plugin);
    const doc = await findDocument(plugin, docId);
    if (priority !== undefined && !(Number.isInteger(priority) && priority >= 0 && priority <= 100)) {
      throw new Error('The priority must be a whole number from 0 to 100.');
    }
    await initIncrementalRem(plugin, doc, { priority });
    const status = await documentStatus(plugin, doc);
    watchDocument(status);
    return status;
  },

  async setReadPoint(plugin, { url, anchor, percent }) {
    await guardTestPlugin(plugin);
    const state = await readPage(plugin, url);
    state.readPoint = { anchor, percent, at: Date.now() };
    await writePage(plugin, url, state);
    return { saved: true };
  },

  async importHeadings(plugin, { docId, url, headings }) {
    const started = Date.now();
    await guardTestPlugin(plugin);
    const doc = await findDocument(plugin, docId);
    const state = await readPage(plugin, url);
    let created = 0;
    for (const chain of headings as SectionChain[]) {
      created += (await ensureSection(plugin, doc, chain, state)).created;
    }
    await writePage(plugin, url, state);
    return { sections: headings.length, created, elapsedMs: Date.now() - started };
  },
};

export function startCompanionListener(plugin: ReactRNPlugin) {
  const toExtension = (message: Record<string, unknown>) =>
    window.postMessage({ ieCompanion: 'toExtension', ...message }, '*');
  // One at a time: operations read and rewrite the same stored pages.
  let queue: Promise<unknown> = Promise.resolve();

  // A deleted Rem reports itself, and its parent reports a child gone. Either one
  // gets that page's affected extracts checked, and the page reloads its
  // highlights if one died or changed colour. The panel's document is checked the
  // same way, for its header. A Set lookup per event: this one fires a lot.
  const changed = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const flush = async () => {
    const ids = [...changed];
    changed.clear();
    for (const [url, extracts] of watchedPages) {
      const suspects = [...extracts].filter(
        ([remId, { parentId }]) => ids.includes(remId) || (!!parentId && ids.includes(parentId))
      );
      for (const [remId, watched] of suspects) {
        const { alive, incremental } = await isAliveExtract(plugin, remId, watched.kind);
        if (alive && incremental === watched.incremental) continue;
        // pageState, which the page now asks for, sets this page's list anew.
        setWatchedPage(url, new Map([...extracts].filter(([id]) => id !== remId)));
        toExtension({ kind: 'pageChanged', url });
        break;
      }
    }
    if (watchedDoc && ids.includes(watchedDoc.docId)) await checkDocument();
  };
  const checkDocument = async () => {
    const shown = watchedDoc;
    if (!shown) return;
    const doc = await plugin.rem.findOne(shown.docId);
    const status = doc ? await documentStatus(plugin, doc) : undefined;
    if (status && !sameStatus(status, shown)) {
      watchDocument(status);
      toExtension({ kind: 'documentChanged', status });
    }
  };
  // The Editor Review Timer starting or ending on the document changes no Rem.
  plugin.event.addListener(AppEvents.StorageSessionChange, editorReviewTimerRemIdKey, () => void checkDocument());
  plugin.event.addListener(AppEvents.GlobalRemChanged, undefined, (data) => {
    const remId = data?.remId;
    if (!remId || !watchedIds.has(remId)) return;
    changed.add(remId);
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => void flush(), 400);
  });

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.data?.ieCompanion !== 'toPlugin') return;
    const { kind, id, op, data } = event.data;
    if (kind === 'hello') {
      const knowledgeBase = await plugin.kb.getCurrentKnowledgeBaseData().catch(() => undefined);
      toExtension({
        kind: 'here',
        info: {
          knowledgeBase: knowledgeBase?.name,
          knowledgeBaseId: knowledgeBase?._id,
          isPrimaryKnowledgeBase: await plugin.kb.isPrimaryKnowledgeBase(),
          platform: await getPlatform(plugin),
          lightMode: await shouldUseLightMode(plugin),
        },
      });
    } else if (kind === 'op' && OPS[op]) {
      queue = queue.then(async () => {
        try {
          toExtension({ kind: 'opDone', id, ok: true, result: await OPS[op](plugin, data) });
        } catch (err) {
          toExtension({ kind: 'opDone', id, ok: false, error: String((err as Error)?.message ?? err) });
        }
      });
    }
  });
}
