import type { PluginRem } from '@remnote/plugin-sdk';

/**
 * A descriptor ("Não pode rebocar em que método? → no cabo longo") means something only
 * under its concept ("Rebocadores com tubulão"): read alone, it names no subject. Read
 * Aloud, Pronunciation, Find Sources, Check Statement and Ask Your Sources all read it
 * with its chain.
 */

/** RemType.DESCRIPTOR (a plain number: the SDK enum is not needed at runtime). */
export const REM_TYPE_DESCRIPTOR = 2;
/** A safety net for the chain walk. */
const MAX_DESCRIPTOR_CHAIN = 10;

/**
 * A descriptor's chain, outermost first: the first ancestor that is not a descriptor
 * (its concept, marked as one or not), then the descriptors in between. Empty for a
 * Rem that is not a descriptor, so other Rems cost no bridge call.
 */
export async function descriptorChain(rem: PluginRem): Promise<PluginRem[]> {
  if ((rem.type as number) !== REM_TYPE_DESCRIPTOR) return [];
  const chain: PluginRem[] = [];
  let parent = await rem.getParentRem();
  for (let i = 0; parent && i < MAX_DESCRIPTOR_CHAIN; i++) {
    chain.unshift(parent);
    if ((parent.type as number) !== REM_TYPE_DESCRIPTOR) break;
    parent = await parent.getParentRem();
  }
  return chain;
}
