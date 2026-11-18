import { ReactRNPlugin } from '@remnote/plugin-sdk';
import {
  askYourSourcesCommandId,
  checkStatementCommandId,
  checkStatementsInTreeCommandId,
  findSourcesCommandId,
  findSourcesInTreeCommandId,
} from '../lib/consts';
import { getCorpusStatus } from '../lib/corpus';
import {
  askYourSourcesCommand,
  checkStatementCommand,
  checkStatementsInTree,
  findSources,
  findSourcesInTree,
  SEMANTIC_SEARCH,
} from '../lib/find_sources';

/** First look shortly after startup (never on its path), then again until the provider is there. */
const FIRST_CHECK_MS = 8_000;
const RECHECK_MS = 5 * 60_000;

let registered = false;

/**
 * The commands that need a corpus provider able to search by meaning (`semantic-search`,
 * docs/Corpus-Provider.md), reached through the AI helper: Find Sources, Check Statement,
 * Ask Your Sources and their tree versions. They are not Media Bridge commands, and Pin
 * Source Quote, which only needs the AI helper, stays registered for everyone.
 *
 * Registered only once the provider reports the capability, so users without one never see
 * them: looked at shortly after startup, then every few minutes until it answers (the helper
 * may start after RemNote). The SDK cannot unregister a command, so a provider that goes
 * away later leaves them in place until the next reload; until then they explain what is
 * missing (findSourcesUnavailable). Call once from the index widget.
 */
export function registerCorpusCommands(plugin: ReactRNPlugin) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = async () => {
    if (registered) return;
    const status = await getCorpusStatus(plugin, { force: true });
    if (!status.available || !status.capabilities.includes(SEMANTIC_SEARCH)) {
      timer = setTimeout(() => void check(), RECHECK_MS);
      return;
    }
    registered = true;
    if (timer) clearTimeout(timer);
    console.log(`[Corpus] ${status.name ?? 'provider'} searches by meaning: Find Sources commands registered`);

    // Find the passages of the user's library that say what the selected Rems say, by
    // meaning; reviewed from a notice, then pinned.
    await plugin.app.registerCommand({
      id: findSourcesCommandId,
      name: 'Find Sources (by meaning)',
      quickCode: 'fsq',
      action: async () => findSources(plugin),
    });
    // Check the selected Rems' statements against the library: Find Sources, then Claude's
    // verdict (✅ ⚠️ ❌ ❔) and observation from the passages found, written as a Check Rem.
    await plugin.app.registerCommand({
      id: checkStatementCommandId,
      name: 'Check Statement against Sources',
      quickCode: 'cks',
      action: async () => checkStatementCommand(plugin),
    });
    // Ask the library a question (or about a topic) written in the Rem: the passages that
    // answer it, then Claude's answer from them, written under the Rem with its quotes.
    await plugin.app.registerCommand({
      id: askYourSourcesCommandId,
      name: 'Ask Your Sources',
      quickCode: 'ask',
      action: async () => askYourSourcesCommand(plugin),
    });
    // The same over a whole summary or course document, one review for the batch.
    await plugin.app.registerCommand({
      id: findSourcesInTreeCommandId,
      name: 'Find Sources (by meaning) in descendants',
      quickCode: 'fsqd',
      action: async () => findSourcesInTree(plugin),
    });
    await plugin.app.registerCommand({
      id: checkStatementsInTreeCommandId,
      name: 'Check Statements against Sources in descendants',
      quickCode: 'cksd',
      action: async () => checkStatementsInTree(plugin),
    });
  };
  timer = setTimeout(() => void check().catch((e) => console.warn('[Corpus] command check failed', e)), FIRST_CHECK_MS);
}
