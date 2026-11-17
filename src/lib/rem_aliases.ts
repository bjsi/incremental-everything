/**
 * A Rem's aliases WITH their ids.
 *
 * Since RemNote's storage overhaul an alias is not a Rem: it is stored on its owner
 * as `al: [{aliasId, alias}]`, and `plugin.rem.findOne(aliasId)` finds nothing. The
 * plugin bridge still answers `getAliases` / `getOrCreateAliasWithText` with
 * `{aliasId, text}`, but the SDK (0.0.46) wraps each answer as a Rem object, which
 * keeps only `.text` and drops `aliasId`. An alias reference (`{i:'q', _id, aliasId}`)
 * cannot be read or written without that id, so these helpers make the same bridge
 * calls through the Rem object's own `call`, which returns the answer unwrapped.
 * See findings/REM_REFERENCES_AND_MERGE.md and the SDK bug report in findings/.
 *
 * Every helper falls back to the SDK's route (an alias that is still a Rem, as
 * aliases made before the overhaul can be), so a future SDK fix or bridge change
 * degrades to the old behaviour instead of breaking.
 */
import type { PluginRem, RichTextInterface, RNPlugin } from '@remnote/plugin-sdk';

export interface RemAlias {
  aliasId: string;
  text: RichTextInterface;
}

/** The raw bridge answer, unwrapped by the SDK. Undefined when the call is unavailable. */
async function rawCall(rem: PluginRem | undefined, name: string, args?: object): Promise<unknown> {
  const call = (rem as any)?.call;
  if (typeof call !== 'function') return undefined;
  try {
    return await call.call(rem, name, args);
  } catch {
    return undefined;
  }
}

const asAlias = (a: any): RemAlias | undefined => {
  const aliasId = a?.aliasId ?? a?._id;
  return typeof aliasId === 'string' && aliasId && Array.isArray(a?.text)
    ? { aliasId, text: a.text }
    : undefined;
};

/** A Rem's aliases with their ids; an alias with no recoverable id is left out. */
export async function aliasesWithIds(rem: PluginRem | undefined): Promise<RemAlias[]> {
  const raw = await rawCall(rem, 'getAliases');
  const list: any[] = Array.isArray(raw) ? raw : ((await rem?.getAliases().catch(() => [])) ?? []);
  return list.map(asAlias).filter((a): a is RemAlias => !!a);
}

/**
 * The text of the alias `aliasId` of `owner` (the Rem a reference's `_id` points at),
 * or undefined when it no longer exists.
 */
export async function aliasTextOf(
  plugin: RNPlugin,
  owner: PluginRem | undefined,
  aliasId: string
): Promise<RichTextInterface | undefined> {
  const stored = (await aliasesWithIds(owner)).find((a) => a.aliasId === aliasId)?.text;
  if (stored?.length) return stored;
  const aliasRem = await plugin.rem.findOne(aliasId).catch(() => undefined);
  return aliasRem?.text?.length ? aliasRem.text : undefined;
}

/**
 * The id of the alias of `owner` with this text, created when missing ("if an
 * equivalent alias already exists, that alias will be returned"). Pass the alias's own
 * rich text so the lookup matches instead of creating a near-duplicate.
 */
export async function aliasIdForText(
  owner: PluginRem | undefined,
  aliasText: RichTextInterface
): Promise<string | undefined> {
  const raw = await rawCall(owner, 'getOrCreateAliasWithText', { aliasText });
  const fromRaw = asAlias(raw)?.aliasId;
  if (fromRaw) return fromRaw;
  const wrapped: any = await owner?.getOrCreateAliasWithText(aliasText).catch(() => undefined);
  return typeof wrapped?._id === 'string' && wrapped._id ? wrapped._id : undefined;
}
