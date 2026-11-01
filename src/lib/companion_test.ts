// TEST BRANCH ONLY: the plugin's half of spikes/companion-extension. Lets a Chrome
// extension hosting RemNote in its side panel turn a page selection into an
// Incremental Rem. Refuses to write in a primary knowledge base.

import { ReactRNPlugin } from '@remnote/plugin-sdk';
import { powerupCode } from './consts';
import { getIncrementalRemFromRem, initIncrementalRem } from './incremental_rem';
import { getPlatform, shouldUseLightMode } from './mobileUtils';

const PLUGIN_ID = 'incremental-everything-plus';
const HELLO_EVERY_MS = 2000;
const MAX_HELLOS = 90;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The page's document may have been created a moment ago in this same client. */
async function findDocument(plugin: ReactRNPlugin, docId: string) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const doc = await plugin.rem.findOne(docId);
    if (doc) return doc;
    await sleep(300);
  }
  return undefined;
}

async function addExtract(plugin: ReactRNPlugin, docId: string, text: string) {
  const started = Date.now();
  if (await plugin.kb.isPrimaryKnowledgeBase()) {
    throw new Error('Refused: this is your primary knowledge base. Switch to the throwaway KB.');
  }
  const doc = await findDocument(plugin, docId);
  if (!doc) throw new Error(`The page's document ${docId} was not found.`);

  const rem = await plugin.rem.createRem();
  if (!rem) throw new Error('Could not create a Rem.');
  await rem.setText([text]);
  await rem.setParent(doc);
  await initIncrementalRem(plugin, rem, { explicitParentId: doc._id });
  const elapsedMs = Date.now() - started;

  // Read back from a fresh object: this is the part being proven.
  const saved = await plugin.rem.findOne(rem._id);
  if (!saved) throw new Error('The new Rem cannot be read back.');
  const incRem = await getIncrementalRemFromRem(plugin, saved);
  return {
    remId: saved._id,
    documentId: doc._id,
    underDocument: saved.parent === doc._id,
    isIncremental: await saved.hasPowerup(powerupCode),
    priority: incRem?.priority,
    nextRepDate: incRem ? new Date(incRem.nextRepDate).toISOString() : undefined,
    elapsedMs,
  };
}

export async function startCompanionTest(plugin: ReactRNPlugin): Promise<void> {
  if (window.parent === window) return;
  console.log('[CompanionTest] Test build active');

  const toHost = (payload: unknown) => window.parent.postMessage({ ieSpike: 'fromPlugin', payload }, '*');
  let acknowledged = false;

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
    } else if (data?.kind === 'addExtract') {
      try {
        toHost({ kind: 'extractDone', id: data.id, ok: true, result: await addExtract(plugin, data.docId, data.text) });
      } catch (err) {
        toHost({ kind: 'extractDone', id: data.id, ok: false, error: String((err as Error)?.message ?? err) });
      }
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
