import { ReactRNPlugin, RNPlugin } from '@remnote/plugin-sdk';
import { AI_OCR_HELPER_URL } from './ai_ocr';
import { aiHelperPairingTokenId } from './consts';
import { getIESetting } from './settings';

/**
 * The shared client for the local AI helper (scripts/ai_ocr_helper.py): every
 * POST route goes through `helperPost`, so features that depend on the helper
 * fail the same way and can tell "not running" apart from "answered with an error".
 */

/**
 * Every POST route of the helper needs the pairing token (header X-IR-Token): the
 * helper listens on localhost, where any web page could otherwise call it. The
 * token is the plugin setting "AI Helper Pairing Token".
 */
export const PAIRING_MESSAGE =
  'The AI helper refused the request because the plugin is not paired with it. Run ' +
  '`python3 scripts/ai_ocr_helper.py --pairing-token` and paste the token in the plugin setting "AI Helper Pairing Token".';

export async function helperToken(plugin: ReactRNPlugin | RNPlugin): Promise<string> {
  return ((await getIESetting(plugin, aiHelperPairingTokenId)) ?? '').trim();
}

/** Headers for a POST to the helper: JSON, and the pairing token. */
export async function helperHeaders(plugin: ReactRNPlugin | RNPlugin): Promise<Record<string, string>> {
  return { 'Content-Type': 'application/json', 'X-IR-Token': await helperToken(plugin) };
}

/** The helper's answer when the token is missing or wrong (HTTP 403, error "pairing"). */
export const isPairingRefusal = (status: number, body: any) => status === 403 && body?.error === 'pairing';

/** The helper did not answer at all: it is not running (or the port is wrong). */
export class HelperUnreachableError extends Error {}

/** The helper answered, but with an error (its message is the reason). */
export class HelperRequestError extends Error {}

export interface HelperPostOptions {
  /** Abort after this many milliseconds (no limit by default). */
  timeoutMs?: number;
}

/**
 * POST to the local helper. Every request names the current knowledge base: the
 * helper looks for local copies of source files only in that KB's folder.
 */
export async function helperPost<T>(
  plugin: ReactRNPlugin | RNPlugin,
  path: string,
  body: object,
  options: HelperPostOptions = {}
): Promise<T> {
  const kbId = (await plugin.kb.getCurrentKnowledgeBaseData())?._id;
  const controller = options.timeoutMs ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), options.timeoutMs) : undefined;
  let res: Response;
  try {
    res = await fetch(`${AI_OCR_HELPER_URL}${path}`, {
      method: 'POST',
      headers: await helperHeaders(plugin),
      body: JSON.stringify({ ...body, kbId }),
      signal: controller?.signal,
    });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') {
      throw new HelperRequestError(`AI helper: no answer from ${path} within ${options.timeoutMs} ms`);
    }
    throw new HelperUnreachableError(`AI helper is not running (${AI_OCR_HELPER_URL}). Start scripts/ai_ocr_helper.py.`);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const json = await res.json().catch(() => null);
  if (isPairingRefusal(res.status, json)) throw new HelperRequestError(PAIRING_MESSAGE);
  if (!json?.ok) throw new HelperRequestError(`AI helper: ${json?.error ?? `HTTP ${res.status}`}`);
  return json as T;
}
