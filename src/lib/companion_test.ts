// TEST BRANCH ONLY: the plugin's half of spikes/companion-extension. Lets a Chrome
// extension hosting RemNote in its side panel add extracts from a page, restore
// their highlights, keep a read point and import the page's headings. Refuses to
// write in a primary knowledge base.
//
// Per-page state in one synced key each is good enough for a test. A release must
// not do this: synced storage caps a plugin at 1000 keys.

import { PluginRem, ReactRNPlugin, RichTextInterface } from '@remnote/plugin-sdk';
import { dismissedPowerupCode, powerupCode } from './consts';
import { canonicalUrlKey } from './duplicate_source/url_key';
import { getIncrementalRemFromRem, initIncrementalRem } from './incremental_rem';
import { getPlatform, shouldUseLightMode } from './mobileUtils';

const PLUGIN_ID = 'incremental-everything-plus';
const HELLO_EVERY_MS = 2000;
const MAX_HELLOS = 90;
const FONT_BY_DEPTH = ['H1', 'H2', 'H3'] as const;

interface Anchor {
  exact: string;
  prefix: string;
  suffix: string;
  position: number;
}

interface PageState {
  extracts: Array<{ remId: string; anchor: Anchor }>;
  readPoint?: { anchor: Anchor; percent: number; at: number };
  /** Section path joined with \u0001 → its Rem. */
  sections: Record<string, string>;
  /** Rem → where it sits in the page's text, which keeps children in reading order. */
  order: Record<string, number>;
}

/** A section with the positions of the headings from the top down to it. */
type SectionChain = Array<{ text: string; position: number }>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const stateKey = (url: string) => `companion_test_page_${hash(canonicalUrlKey(url) ?? url)}`;

async function readState(plugin: ReactRNPlugin, url: string): Promise<PageState> {
  const saved = await plugin.storage.getSynced<PageState>(stateKey(url));
  return { extracts: [], sections: {}, order: {}, ...saved };
}

async function findDocument(plugin: ReactRNPlugin, docId: string) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const doc = await plugin.rem.findOne(docId);
    if (doc) return doc;
    await sleep(300);
  }
  throw new Error(`The page's document ${docId} was not found.`);
}

async function refuseInPrimaryKb(plugin: ReactRNPlugin) {
  if (await plugin.kb.isPrimaryKnowledgeBase()) {
    throw new Error('Refused: this is your primary knowledge base. Switch to the throwaway KB.');
  }
}

/** Where a child belongs among its siblings, by its position in the page's text. */
export async function indexInReadingOrder(parent: PluginRem, position: number, state: PageState) {
  const children = await parent.getChildrenRem();
  const at = children.findIndex((child) => (state.order[child._id] ?? -1) > position);
  return at === -1 ? children.length : at;
}

/** Finds or creates the Rems of a section, from the top of the chain down. */
export async function ensureSection(plugin: ReactRNPlugin, doc: PluginRem, chain: SectionChain, state: PageState) {
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
    await rem.setParent(parent, await indexInReadingOrder(parent, position, state));
    state.sections[key] = rem._id;
    state.order[rem._id] = position;
    parent = rem;
    created++;
  }
  return { section: parent, created };
}

function describeRichText(text: RichTextInterface | undefined) {
  const kinds = { bold: 0, italic: 0, links: 0, images: 0, plain: 0 };
  for (const item of (text ?? []) as any[]) {
    if (typeof item === 'string') kinds.plain++;
    else if (item.i === 'i') kinds.images++;
    else if (item.i === 'm') {
      if (item.b) kinds.bold++;
      if (item.l) kinds.italic++;
      if (item.iUrl || item.url || item.qId) kinds.links++;
    }
  }
  return kinds;
}

const OPS: Record<string, (plugin: ReactRNPlugin, data: any) => Promise<unknown>> = {
  async addExtract(plugin, { docId, url, text, markdown, anchor, chain }) {
    const started = Date.now();
    await refuseInPrimaryKb(plugin);
    const doc = await findDocument(plugin, docId);
    const state = await readState(plugin, url);
    const { section, created } = await ensureSection(plugin, doc, chain ?? [], state);

    const rem = await plugin.rem.createRem();
    if (!rem) throw new Error('Could not create a Rem.');
    let richText: RichTextInterface = [text];
    let markdownError: string | undefined;
    try {
      const parsed = await plugin.richText.parseFromMarkdown(markdown);
      if (parsed?.length) richText = parsed;
    } catch (err) {
      markdownError = String(err);
    }
    await rem.setText(richText);
    await rem.setParent(section, await indexInReadingOrder(section, anchor.position, state));
    state.order[rem._id] = anchor.position;
    await initIncrementalRem(plugin, rem, { explicitParentId: section._id });
    const elapsedMs = Date.now() - started;

    state.extracts.push({ remId: rem._id, anchor });
    await plugin.storage.setSynced(stateKey(url), state);

    const saved = await plugin.rem.findOne(rem._id);
    if (!saved) throw new Error('The new Rem cannot be read back.');
    const siblings = await section.getChildrenRem();
    const positions = siblings.map((child) => state.order[child._id]).filter((p) => p !== undefined);
    const incRem = await getIncrementalRemFromRem(plugin, saved);
    return {
      remId: saved._id,
      inSection: saved.parent === section._id,
      section: chain?.map((c: { text: string }) => c.text).join(' > ') || '(top of the document)',
      sectionsCreated: created,
      inReadingOrder: positions.every((p, i) => i === 0 || positions[i - 1] <= p),
      isIncremental: await saved.hasPowerup(powerupCode),
      priority: incRem?.priority,
      richText: describeRichText(saved.text),
      markdownError,
      elapsedMs,
    };
  },

  async pageState(plugin, { url }) {
    const state = await readState(plugin, url);
    const alive: PageState['extracts'] = [];
    for (const extract of state.extracts) {
      const rem = await plugin.rem.findOne(extract.remId);
      if (rem && ((await rem.hasPowerup(powerupCode)) || (await rem.hasPowerup(dismissedPowerupCode)))) {
        alive.push(extract);
      }
    }
    if (alive.length !== state.extracts.length) {
      await plugin.storage.setSynced(stateKey(url), { ...state, extracts: alive });
    }
    return { extracts: alive, readPoint: state.readPoint, removed: state.extracts.length - alive.length };
  },

  async setReadPoint(plugin, { url, anchor, percent }) {
    await refuseInPrimaryKb(plugin);
    const state = await readState(plugin, url);
    state.readPoint = { anchor, percent, at: Date.now() };
    await plugin.storage.setSynced(stateKey(url), state);
    return { saved: true };
  },

  async importHeadings(plugin, { docId, url, headings }) {
    const started = Date.now();
    await refuseInPrimaryKb(plugin);
    const doc = await findDocument(plugin, docId);
    const state = await readState(plugin, url);
    let created = 0;
    for (const chain of headings as SectionChain[]) {
      created += (await ensureSection(plugin, doc, chain, state)).created;
    }
    await plugin.storage.setSynced(stateKey(url), state);
    return { sections: headings.length, created, elapsedMs: Date.now() - started };
  },
};

export async function startCompanionTest(plugin: ReactRNPlugin): Promise<void> {
  if (window.parent === window) return;
  console.log('[CompanionTest] Test build active');

  const toHost = (payload: unknown) => window.parent.postMessage({ ieSpike: 'fromPlugin', payload }, '*');
  let acknowledged = false;
  // One at a time: operations read and rewrite the same per-page state.
  let queue: Promise<unknown> = Promise.resolve();

  await plugin.app.registerCommand({
    id: 'companion-test-send-to-page',
    name: 'Companion Test: Send to Page',
    action: async () => {
      if (!acknowledged) {
        await plugin.app.toast('No extension has answered in this RemNote window.');
        return;
      }
      toHost({ kind: 'push', text: `Sent by the plugin at ${new Date().toLocaleTimeString()}` });
    },
  });

  window.addEventListener('message', async (event) => {
    const data = event.data;
    if (data?.ieSpike === 'ack' && !acknowledged) {
      acknowledged = true;
      const knowledgeBase = await plugin.kb.getCurrentKnowledgeBaseData().catch(() => undefined);
      toHost({
        kind: 'ready',
        info: {
          pluginId: PLUGIN_ID,
          knowledgeBase: knowledgeBase?.name,
          isPrimaryKnowledgeBase: await plugin.kb.isPrimaryKnowledgeBase(),
          platform: await getPlatform(plugin),
          lightMode: await shouldUseLightMode(plugin),
        },
      });
    } else if (data?.kind === 'ping') {
      toHost({ kind: 'pong', id: data.id, sentAt: data.sentAt });
    } else if (data?.kind === 'op' && OPS[data.op]) {
      queue = queue.then(async () => {
        try {
          toHost({ kind: 'opDone', id: data.id, ok: true, result: await OPS[data.op](plugin, data.data) });
        } catch (err) {
          toHost({ kind: 'opDone', id: data.id, ok: false, error: String((err as Error)?.message ?? err) });
        }
      });
    }
  });

  let hellos = 0;
  const timer = setInterval(() => {
    if (acknowledged || ++hellos > MAX_HELLOS) {
      clearInterval(timer);
      return;
    }
    window.parent.postMessage({ ieSpike: 'hello', from: PLUGIN_ID, href: location.href }, '*');
  }, HELLO_EVERY_MS);
}
