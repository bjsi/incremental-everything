// The plugin's half of the Chrome companion extension (companion/ in this repo).
// The extension hosts RemNote in its side panel, and a content script of its own
// runs inside this plugin's index frame. The two talk by window.postMessage within
// this frame, so no other plugin can take part, and this listener is all that runs
// where the extension is not installed, including the desktop app.

import { PluginRem, ReactRNPlugin, RichTextInterface } from '@remnote/plugin-sdk';
import { dismissedPowerupCode, powerupCode } from '../consts';
import { canonicalUrlKey } from '../duplicate_source/url_key';
import { markRemsAsFreshlyCreated } from '../incRemHelpers';
import { getIncrementalRemFromRem, initIncrementalRem } from '../incremental_rem';
import { getPlatform, shouldUseLightMode } from '../mobileUtils';
import {
  Anchor,
  companionShardKey,
  emptyPageState,
  indexInReadingOrder,
  isInReadingOrder,
  MAX_SHARD_CHARACTERS,
  PageState,
  shardOfPage,
} from './rules';

const FONT_BY_DEPTH = ['H1', 'H2', 'H3'] as const;
const TEST_PLUGIN_ID = 'incremental-everything-plus';

/** A section, with the positions of the headings from the top down to it. */
type SectionChain = Array<{ text: string; position: number }>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const pageKeyOf = (url: string) => canonicalUrlKey(url) ?? url;

async function readPage(plugin: ReactRNPlugin, url: string): Promise<PageState> {
  const key = pageKeyOf(url);
  const shard = await plugin.storage.getSynced<Record<string, PageState>>(companionShardKey(shardOfPage(key)));
  return { ...emptyPageState(), ...shard?.[key] };
}

async function writePage(plugin: ReactRNPlugin, url: string, state: PageState) {
  const key = pageKeyOf(url);
  const shardKey = companionShardKey(shardOfPage(key));
  const shard = (await plugin.storage.getSynced<Record<string, PageState>>(shardKey)) ?? {};
  const next = { ...shard, [key]: state };
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

const OPS: Record<string, (plugin: ReactRNPlugin, data: any) => Promise<unknown>> = {
  async addExtract(plugin, data) {
    const { docId, url, text, markdown, chain, opId, withPriority, priority } = data;
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
    let richText: RichTextInterface = [text];
    try {
      const parsed = await plugin.richText.parseFromMarkdown(markdown);
      if (parsed?.length) richText = parsed;
    } catch (err) {
      console.warn('[Companion] Markdown not parsed, keeping plain text', err);
    }
    await rem.setText(richText);
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
    for (const extract of state.extracts) {
      const rem = await plugin.rem.findOne(extract.remId);
      if (rem && ((await rem.hasPowerup(powerupCode)) || (await rem.hasPowerup(dismissedPowerupCode)))) {
        alive.push(extract);
      }
    }
    if (alive.length !== state.extracts.length) await writePage(plugin, url, { ...state, extracts: alive });
    return { extracts: alive, readPoint: state.readPoint };
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

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.data?.ieCompanion !== 'toPlugin') return;
    const { kind, id, op, data } = event.data;
    if (kind === 'hello') {
      const knowledgeBase = await plugin.kb.getCurrentKnowledgeBaseData().catch(() => undefined);
      toExtension({
        kind: 'here',
        info: {
          knowledgeBase: knowledgeBase?.name,
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
