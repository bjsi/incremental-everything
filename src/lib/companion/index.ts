// The plugin's half of the Chrome companion extension (companion/ in this repo).
// The extension hosts RemNote in its side panel, and a content script of its own
// runs inside this plugin's index frame. The two talk by window.postMessage within
// this frame, so no other plugin can take part, and this listener is all that runs
// where the extension is not installed, including the desktop app.

import { AppEvents, PluginRem, ReactRNPlugin, RichTextInterface } from '@remnote/plugin-sdk';
import { dismissedPowerupCode, powerupCode } from '../consts';
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

// ---- Telling a page that one of its extracts is gone ----

/** The extracts of each page a tab has shown here, with the Rem each sits under. */
const watchedPages = new Map<string, Map<string, string | undefined>>();
/** Every extract and parent above, for a quick test of each change event. */
let watchedIds = new Set<string>();

function setWatchedPage(url: string, extracts: Map<string, string | undefined>) {
  watchedPages.set(url, extracts);
  watchedIds = new Set([...watchedPages.values()].flatMap((page) => [...page].flat().filter((id): id is string => !!id)));
}

function watchExtract(url: string, remId: string, parentId: string | undefined) {
  setWatchedPage(url, new Map([...(watchedPages.get(url) ?? []), [remId, parentId]]));
}

async function isAliveExtract(plugin: ReactRNPlugin, remId: string) {
  const rem = await plugin.rem.findOne(remId);
  return !!rem && ((await rem.hasPowerup(powerupCode)) || (await rem.hasPowerup(dismissedPowerupCode)));
}

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
    const { docId, url, text, richText, chain, opId, withPriority, priority } = data;
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
    await initIncrementalRem(plugin, rem, {
      explicitParentId: section._id,
      priority: typeof priority === 'number' ? priority : undefined,
      skipInitialCascade: !!withPriority || typeof priority === 'number',
    });
    const elapsedMs = Date.now() - started;

    state.extracts.push({ remId: rem._id, anchor, opId });
    await writePage(plugin, url, state);
    watchExtract(url, rem._id, section._id);

    const saved = await plugin.rem.findOne(rem._id);
    if (!saved) throw new Error('The new Rem cannot be read back.');
    const siblings = await section.getChildrenRem();
    const incRem = await getIncrementalRemFromRem(plugin, saved);

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
      priorityPopup: !!withPriority,
      elapsedMs,
    };
  },

  async pageState(plugin, { url }) {
    const state = await readPage(plugin, url);
    const alive: PageState['extracts'] = [];
    const watched = new Map<string, string | undefined>();
    for (const extract of state.extracts) {
      const rem = await plugin.rem.findOne(extract.remId);
      if (rem && ((await rem.hasPowerup(powerupCode)) || (await rem.hasPowerup(dismissedPowerupCode)))) {
        alive.push(extract);
        watched.set(rem._id, rem.parent ?? undefined);
      }
    }
    setWatchedPage(url, watched);
    if (alive.length !== state.extracts.length) await writePage(plugin, url, { ...state, extracts: alive });
    return { kbId: await currentKbId(plugin), extracts: alive, readPoint: state.readPoint };
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
  // highlights if one of them died. A Set lookup per event: this one fires a lot.
  const changed = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const flush = async () => {
    const ids = [...changed];
    changed.clear();
    for (const [url, extracts] of watchedPages) {
      const suspects = [...extracts].filter(([remId, parentId]) => ids.includes(remId) || (parentId && ids.includes(parentId)));
      for (const [remId] of suspects) {
        if (await isAliveExtract(plugin, remId)) continue;
        setWatchedPage(url, new Map([...extracts].filter(([id]) => id !== remId)));
        toExtension({ kind: 'pageChanged', url });
        break;
      }
    }
  };
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
