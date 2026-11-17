// Which Rem "Copy Rem ID" means when nothing is selected.
//
// The focused Rem cannot be trusted on its own: RemNote keeps reporting the
// last Rem the caret was in after you move to a PDF or web reader, so the
// command used to copy a Rem that was no longer on screen, or none at all when
// the reader had cleared it. What the focused pane is showing is reliable
// (getOpenPaneRemId reads the pane tree), and a pane that shows a PDF or a web
// page shows exactly that Rem.
//
// So the command collects every Rem the user could mean (the queue card or the
// focused Rem, that Rem's sources, the document open in a reader pane) and
// copies at once only when there is exactly one; otherwise copy_rem_id_popup
// lets the user pick.

import { BuiltInPowerupCodes, PluginRem, RNPlugin } from '@remnote/plugin-sdk';
import { safeRemTextToString } from './pdfUtils';

export const copyRemIdPopupWidgetId = 'copy_rem_id_popup';

export type RemIdRole = 'card' | 'focused' | 'source' | 'pane';
export type RemIdKind = 'pdf' | 'file' | 'web' | 'rem';

export interface RemIdChoice {
  remId: string;
  name: string;
  role: RemIdRole;
  kind: RemIdKind;
  /** URL of a web source, or the parent's name for a plain Rem. */
  detail?: string;
}

export interface RemIdChoices {
  choices: RemIdChoice[];
  /** Row selected when the picker opens: what the screen is showing. */
  preferred: number;
}

const NAME_MAX = 120;

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + '…' : s);

async function kindOf(plugin: RNPlugin, rem: PluginRem): Promise<{ kind: RemIdKind; detail?: string }> {
  if (await rem.hasPowerup(BuiltInPowerupCodes.UploadedFile)) {
    const url = String((await rem.getPowerupProperty(BuiltInPowerupCodes.UploadedFile, 'URL')) ?? '');
    return { kind: /\.pdf(\?|#|$)/i.test(url) || !url ? 'pdf' : 'file' };
  }
  if (await rem.hasPowerup(BuiltInPowerupCodes.Link)) {
    const url = String((await rem.getPowerupProperty(BuiltInPowerupCodes.Link, 'URL')) ?? '');
    return { kind: 'web', detail: url || undefined };
  }
  const parent = rem.parent ? await rem.getParentRem() : undefined;
  const parentName = parent ? (await safeRemTextToString(plugin, parent.text)).trim() : '';
  return { kind: 'rem', detail: parentName ? clip(parentName, 80) : undefined };
}

async function describe(plugin: RNPlugin, rem: PluginRem, role: RemIdRole): Promise<RemIdChoice> {
  const name = (await safeRemTextToString(plugin, rem.text)).trim();
  const { kind, detail } = await kindOf(plugin, rem);
  return { remId: rem._id, name: clip(name || 'Untitled', NAME_MAX), role, kind, detail };
}

/**
 * Every Rem the command could mean. `primaryId` is the queue card or the
 * focused Rem (possibly stale); `paneRemId` is what the focused pane shows.
 */
export async function collectRemIdChoices(
  plugin: RNPlugin,
  primaryId: string | undefined,
  primaryRole: 'card' | 'focused',
  paneRemId: string | undefined
): Promise<RemIdChoices> {
  const choices: RemIdChoice[] = [];
  const seen = new Set<string>();
  const add = async (rem: PluginRem | undefined, role: RemIdRole) => {
    if (!rem || seen.has(rem._id)) return;
    seen.add(rem._id);
    choices.push(await describe(plugin, rem, role));
  };

  const primary = primaryId ? await plugin.rem.findOne(primaryId) : undefined;
  await add(primary, primaryRole);
  if (primary) {
    for (const source of (await primary.getSources()) ?? []) await add(source, 'source');
  }

  // The pane only adds something when it is a reader: a normal document pane
  // holds the focused Rem, and listing the document would make the picker
  // appear for every plain copy.
  let preferred = 0;
  const pane = paneRemId ? await plugin.rem.findOne(paneRemId) : undefined;
  if (pane) {
    const { kind } = await kindOf(plugin, pane);
    if (kind !== 'rem') {
      const at = choices.findIndex((c) => c.remId === pane._id);
      if (at >= 0) {
        choices[at] = { ...choices[at], role: 'pane' };
        preferred = at;
      } else if (!primary) {
        await add(pane, 'pane');
      } else {
        // A Rem focused before the reader opened: the reader is what is on screen.
        choices.unshift(await describe(plugin, pane, 'pane'));
        seen.add(pane._id);
      }
    }
  }
  return { choices, preferred };
}
