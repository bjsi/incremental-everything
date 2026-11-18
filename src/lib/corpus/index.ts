import { ReactRNPlugin, RNPlugin } from '@remnote/plugin-sdk';
import { HelperRequestError, HelperUnreachableError, helperPost } from '../helper_client';

/**
 * The corpus provider: a program on the user's computer that knows their library
 * (docs/Corpus-Provider.md). The plugin reaches it through the AI helper's
 * `POST /corpus { op, … }`. Every feature that uses it checks its own capability
 * first, never blocks on it, and behaves as before when it is missing.
 */

export type CorpusCapability = 'find-source' | 'quote-literal' | 'suggest-parent' | (string & {});

export interface CorpusStatus {
  available: boolean;
  name?: string | null;
  version?: string | null;
  capabilities: CorpusCapability[];
  /** Why it is not available (no helper, no provider configured, provider failed). */
  reason?: string;
  /** When this status was fetched (ms since epoch). */
  checkedAt: number;
}

/** Re-check after a minute when the provider is there; sooner when it is not. */
const TTL_AVAILABLE_MS = 60_000;
const TTL_UNAVAILABLE_MS = 15_000;
const STATUS_TIMEOUT_MS = 4_000;
/** Shared between widgets (each widget is its own JS context). */
const STATUS_SESSION_KEY = 'corpus_provider_status';

let memo: CorpusStatus | null = null;
let inFlight: Promise<CorpusStatus> | null = null;

const fresh = (s: CorpusStatus | null | undefined): s is CorpusStatus =>
  !!s && Date.now() - s.checkedAt < (s.available ? TTL_AVAILABLE_MS : TTL_UNAVAILABLE_MS);

/**
 * The provider's status, cached (in memory and in session storage, so all widgets
 * share it). `force` skips the cache. Never throws: a missing helper or provider
 * is `available: false` with the reason.
 */
export async function getCorpusStatus(
  plugin: ReactRNPlugin | RNPlugin,
  options: { force?: boolean } = {}
): Promise<CorpusStatus> {
  if (!options.force) {
    if (fresh(memo)) return memo;
    const shared = await plugin.storage.getSession<CorpusStatus>(STATUS_SESSION_KEY).catch(() => undefined);
    if (fresh(shared)) return (memo = shared);
    if (inFlight) return inFlight;
  }
  inFlight = (async () => {
    let status: CorpusStatus;
    try {
      const res = await helperPost<{
        available: boolean;
        name?: string;
        version?: string;
        capabilities?: string[];
        reason?: string;
      }>(plugin, '/corpus', { op: 'status' }, { timeoutMs: STATUS_TIMEOUT_MS });
      status = {
        available: !!res.available,
        name: res.name ?? null,
        version: res.version ?? null,
        capabilities: res.available ? res.capabilities ?? [] : [],
        reason: res.reason,
        checkedAt: Date.now(),
      };
    } catch (e) {
      // An old helper without /corpus answers 404 ("POST /ocr or /locate").
      const reason =
        e instanceof HelperUnreachableError
          ? e.message
          : e instanceof HelperRequestError && /POST \/ocr/.test(e.message)
          ? 'The AI helper is older than the corpus provider: update and restart it.'
          : (e as Error).message;
      status = { available: false, capabilities: [], reason, checkedAt: Date.now() };
    }
    memo = status;
    await plugin.storage.setSession(STATUS_SESSION_KEY, status).catch(() => undefined);
    return status;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export async function hasCorpusCapability(plugin: ReactRNPlugin | RNPlugin, capability: CorpusCapability) {
  const status = await getCorpusStatus(plugin);
  return status.available && status.capabilities.includes(capability);
}

export class CorpusUnavailableError extends Error {}

/**
 * Run one provider operation. Throws CorpusUnavailableError when the provider does
 * not offer the capability the operation belongs to: `options.capability`, or the
 * operation's own name (`find-source`, `suggest-parent`). An operation can belong to a
 * capability of another name (`find-passages` is `semantic-search`).
 */
export async function corpusRequest<T>(
  plugin: ReactRNPlugin | RNPlugin,
  op: string,
  payload: object,
  options: { timeoutMs?: number; capability?: CorpusCapability } = {}
): Promise<T> {
  const capability = options.capability ?? op;
  if (!(await hasCorpusCapability(plugin, capability))) {
    throw new CorpusUnavailableError(`The corpus provider does not offer "${capability}".`);
  }
  const res = await helperPost<{ available: boolean; reason?: string } & T>(
    plugin,
    '/corpus',
    { op, ...payload },
    { timeoutMs: options.timeoutMs }
  );
  if (!res.available) throw new CorpusUnavailableError(res.reason ?? 'No corpus provider.');
  return res;
}

// --- suggest-parent -----------------------------------------------------------

export interface CorpusParentSuggestion {
  remId: string;
  /** Breadcrumb in the user's notes, from the book down to the section. */
  path: string[];
  confidence: 'high' | 'medium';
  /** How the provider knew, shown as is. */
  how: string;
  /** The provider's name, for the tooltip. */
  provider?: string | null;
}

/**
 * The provider's best parent for a highlight: the Rem of the section it comes from,
 * in the user's notes. Null when there is no provider, it does not offer
 * `suggest-parent`, it has no answer, the answer is too weak, the Rem no longer
 * exists, or it takes longer than `timeoutMs`. Never throws.
 */
export async function suggestParentFromCorpus(
  plugin: ReactRNPlugin | RNPlugin,
  input: { remId: string; sourceRemId: string; page?: number | null; texts: string[]; ancestors?: string[] },
  options: { timeoutMs?: number } = {}
): Promise<CorpusParentSuggestion | null> {
  try {
    const status = await getCorpusStatus(plugin);
    if (!status.available || !status.capabilities.includes('suggest-parent')) return null;
    const res = await corpusRequest<{
      items?: { remId: string; parents?: Partial<CorpusParentSuggestion>[] }[];
    }>(
      plugin,
      'suggest-parent',
      {
        items: [
          {
            remId: input.remId,
            sourceRemId: input.sourceRemId,
            page: input.page ?? null,
            texts: input.texts.filter(Boolean),
            ancestors: input.ancestors ?? [],
          },
        ],
      },
      { timeoutMs: options.timeoutMs ?? 5_000 }
    );
    const parents = res.items?.find((it) => it.remId === input.remId)?.parents ?? [];
    for (const p of parents) {
      if (!p?.remId || (p.confidence !== 'high' && p.confidence !== 'medium')) continue;
      if (!(await plugin.rem.findOne(p.remId))) continue;
      return {
        remId: p.remId,
        path: Array.isArray(p.path) ? p.path.map(String) : [],
        confidence: p.confidence,
        how: String(p.how ?? ''),
        provider: status.name,
      };
    }
    return null;
  } catch (e) {
    console.warn('[Corpus] suggest-parent failed:', e);
    return null;
  }
}
