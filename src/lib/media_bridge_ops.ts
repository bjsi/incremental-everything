/**
 * Local Media Bridge — the rem operations besides localize.
 *
 * The RemNote MCP can write text, tags and documents, but cannot move a rem,
 * remove a tag, hand back an image, or make a rem Incremental the way this
 * plugin does (its slots, history, cache and inheritance cascade). Outside tools
 * queue these as jobs on the media-bridge helper (scripts/media_bridge/
 * media_bridge.py), and lib/media_bridge.ts hands them here. Each returns the
 * JSON the helper passes back to the caller, with `ok` false when any rem failed.
 */
import { BuiltInPowerupCodes, PluginRem, ReactRNPlugin } from '@remnote/plugin-sdk';
import { dismissedPowerupCode, powerupCode } from './consts';
import {
  getIncrementalRemFromRem,
  initIncrementalRem,
  setIncRemPriority,
  updateIncrementalRemCache,
} from './incremental_rem';
import { imageUrlsOf } from './localize_media';

export interface BridgeOpJob {
  id: string;
  op: string;
  remIds: string[];
  [arg: string]: unknown;
}

export interface BridgeOpResult {
  ok: boolean;
  /** One line for the toast. */
  summary: string;
  [field: string]: unknown;
}

/** A failure to report to the caller as-is. */
class OpError extends Error {}

const remTitle = async (plugin: ReactRNPlugin, rem: PluginRem) => {
  try {
    // Images left out: toString spells out their URLs.
    const words = (rem.text ?? []).filter((el) => typeof el === 'string' || (el as any).i !== 'i');
    const text = (await plugin.richText.toString(words)).trim();
    return text.length > 80 ? `${text.slice(0, 79)}…` : text;
  } catch {
    return '';
  }
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function findRems(plugin: ReactRNPlugin, remIds: string[]) {
  const found = (await plugin.rem.findMany(remIds)) ?? [];
  const byId = new Map(found.map((rem) => [rem._id, rem]));
  return { rems: remIds.map((id) => byId.get(id)).filter((rem): rem is PluginRem => !!rem), byId };
}

// --- move --------------------------------------------------------------------

/** Children the editor does not show: powerup slots/properties and aliases. */
async function isHiddenChild(child: PluginRem, aliasIds: Set<string>) {
  if (aliasIds.has(child._id)) return true;
  const checks = await Promise.all([
    child.isPowerupProperty(),
    child.isPowerupSlot(),
    child.isPowerupPropertyListItem(),
    child.isPowerupEnum(),
  ]);
  return checks.some(Boolean);
}

async function isSelfOrAncestorOf(plugin: ReactRNPlugin, rem: PluginRem, target: PluginRem) {
  let current: PluginRem | undefined = target;
  for (let depth = 0; current && depth < 500; depth++) {
    if (current._id === rem._id) return true;
    current = current.parent ? await plugin.rem.findOne(current.parent) : undefined;
  }
  return false;
}

export async function runMove(plugin: ReactRNPlugin, job: BridgeOpJob): Promise<BridgeOpResult> {
  const parentId = String(job.parentId ?? '');
  const position = String(job.position ?? 'last');
  const siblingId = job.siblingId === undefined ? undefined : String(job.siblingId);
  const dryRun = job.dryRun === true;
  const expectParentId = job.expectParentId === undefined ? undefined : String(job.expectParentId);

  const parent = parentId ? await plugin.rem.findOne(parentId) : undefined;
  if (!parent) throw new OpError(`New parent not found: ${parentId || '(none given)'}`);
  const { rems, byId } = await findRems(plugin, job.remIds);
  const missing = job.remIds.filter((id) => !byId.has(id));
  if (missing.length) throw new OpError(`Rem(s) not found: ${missing.join(', ')}`);

  for (const rem of rems) {
    if (await isSelfOrAncestorOf(plugin, rem, parent)) {
      throw new OpError(`Cannot move ${rem._id} under itself or one of its descendants.`);
    }
    if (expectParentId !== undefined && rem.parent !== expectParentId) {
      throw new OpError(`${rem._id}'s parent is ${rem.parent ?? 'none'}, not ${expectParentId}; nothing moved.`);
    }
  }

  // The sibling the moved rems land before (undefined = at the end), chosen
  // among the children with the moving rems left out. The index is looked up
  // again before each setParent: the SDK counts a rem's old slot when it moves
  // within its own parent, so an index computed once lands one place early when
  // a rem moves down.
  const moving = new Set(job.remIds);
  const children = ((await parent.getChildrenRem()) ?? []).filter((child) => !moving.has(child._id));
  let anchor: PluginRem | undefined;
  if (position === 'first') {
    anchor = children[0];
  } else if (position === 'last') {
    anchor = undefined;
  } else if (position === 'index') {
    const n = Number(job.index);
    if (!Number.isInteger(n) || n < 0) throw new OpError(`Bad index: ${job.index}`);
    const aliasIds = new Set(((await parent.getAliases()) ?? []).map((alias) => alias._id));
    const hidden = await Promise.all(children.map((child) => isHiddenChild(child, aliasIds)));
    anchor = children.filter((_, i) => !hidden[i])[n];
  } else if (position === 'before' || position === 'after') {
    const at = children.findIndex((child) => child._id === siblingId);
    if (at === -1) throw new OpError(`${siblingId} is not a child of ${parentId} (or is one of the rems moved).`);
    anchor = position === 'before' ? children[at] : children[at + 1];
  } else {
    throw new OpError(`Unknown position: ${position}`);
  }

  const parentTitle = await remTitle(plugin, parent);
  const moved = [];
  for (const rem of rems) {
    const from = rem.parent ?? null;
    if (!dryRun) {
      const current = (await parent.getChildrenRem()) ?? [];
      const at = anchor ? current.findIndex((child) => child._id === anchor!._id) : -1;
      await rem.setParent(parent, at === -1 ? current.length : at);
    }
    moved.push({ remId: rem._id, title: await remTitle(plugin, rem), from, to: parent._id });
  }

  if (dryRun) {
    return { ok: true, dryRun, summary: `would move ${plural(rems.length, 'rem')} under “${parentTitle}”`, moved };
  }
  // Report where they actually landed, among the children the editor shows.
  const after = (await parent.getChildrenRem()) ?? [];
  const afterAliases = new Set(((await parent.getAliases()) ?? []).map((alias) => alias._id));
  const afterHidden = await Promise.all(after.map((child) => isHiddenChild(child, afterAliases)));
  const visibleAfter = after.filter((_, i) => !afterHidden[i]).map((child) => child._id);
  const landed = moved.map((entry) => ({ ...entry, visibleIndex: visibleAfter.indexOf(entry.remId) }));
  const notThere = landed.filter((entry) => entry.visibleIndex === -1);
  return {
    ok: notThere.length === 0,
    summary: `moved ${plural(rems.length, 'rem')} under “${parentTitle}”`,
    parentTitle,
    moved: landed,
  };
}

// --- untag -------------------------------------------------------------------

const IE_POWERUP_CODES = [powerupCode, dismissedPowerupCode, 'cardPriority'];
const CANDIDATE_POWERUP_CODES: string[] = [
  ...(Object.values(BuiltInPowerupCodes) as string[]),
  ...IE_POWERUP_CODES,
];

/** code → powerup rem, filled lazily once per job. */
async function powerupRems(plugin: ReactRNPlugin) {
  // Some codes the SDK lists do not exist in every knowledge base, and looking
  // one up then throws ("Cannot find powerup id"): skip those.
  const entries = await Promise.all(
    CANDIDATE_POWERUP_CODES.map(
      async (code) => [code, await plugin.powerup.getPowerupByCode(code).catch(() => undefined)] as const
    )
  );
  return entries.filter((entry): entry is readonly [string, PluginRem] => !!entry[1]);
}

const norm = (s: string) => s.trim().toLowerCase();

export async function runUntag(plugin: ReactRNPlugin, job: BridgeOpJob): Promise<BridgeOpResult> {
  const spec = String(job.tag ?? '').trim();
  if (!spec) throw new OpError('No tag given.');
  const removeProperties = job.removeProperties === true;
  const { rems, byId } = await findRems(plugin, job.remIds);

  let powerupList: Awaited<ReturnType<typeof powerupRems>> | undefined;
  const powerups = async () => (powerupList ??= await powerupRems(plugin));
  const codeOfPowerupRem = async (tagRem: PluginRem) =>
    (await powerups()).find(([, rem]) => rem._id === tagRem._id)?.[0];

  const results = [];
  for (const remId of job.remIds) {
    const rem = byId.get(remId);
    if (!rem) {
      results.push({ remId, removed: false, error: 'rem not found' });
      continue;
    }
    try {
      const tags = (await rem.getTagRems()) ?? [];
      let tagRem: PluginRem | undefined;
      let code: string | undefined;
      if (spec.startsWith('powerup:')) {
        code = spec.slice('powerup:'.length);
        tagRem = (await plugin.powerup.getPowerupByCode(code).catch(() => undefined)) ?? undefined;
        if (!tagRem) throw new OpError(`No powerup with code “${code}”.`);
      } else {
        tagRem = tags.find((tag) => tag._id === spec);
        if (!tagRem) {
          const named = [];
          for (const tag of tags) if (norm(await plugin.richText.toString(tag.text ?? [])) === norm(spec)) named.push(tag);
          if (named.length > 1) throw new OpError(`${named.length} of its tags are named “${spec}”; pass the tag's id.`);
          tagRem = named[0];
        }
        if (!tagRem) {
          // A built-in powerup the rem carries without a visible tag (Extra Card Detail, Quote…).
          for (const [candidate, powerupRem] of await powerups()) {
            if (norm(await plugin.richText.toString(powerupRem.text ?? [])) !== norm(spec)) continue;
            if (await rem.hasPowerup(candidate).catch(() => false)) {
              code = candidate;
              tagRem = powerupRem;
              break;
            }
          }
        }
        if (tagRem && !code && (await tagRem.isPowerup())) code = await codeOfPowerupRem(tagRem);
      }
      if (!tagRem && !code) {
        results.push({ remId, removed: false, error: `not tagged “${spec}”` });
        continue;
      }
      if (code === powerupCode) {
        throw new OpError(
          'The Incremental tag is not removed here: dismiss the rem in Incremental Everything instead, which keeps its history.'
        );
      }
      const tagName = tagRem ? await plugin.richText.toString(tagRem.text ?? []) : code;
      if (code && (await rem.hasPowerup(code))) await rem.removePowerup(code);
      if (tagRem && ((await rem.getTagRems()) ?? []).some((tag) => tag._id === tagRem!._id)) {
        await rem.removeTag(tagRem._id, removeProperties);
      }
      const stillTagged =
        (tagRem && ((await rem.getTagRems()) ?? []).some((tag) => tag._id === tagRem!._id)) ||
        (code ? await rem.hasPowerup(code) : false);
      results.push({
        remId,
        removed: !stillTagged,
        tagId: tagRem?._id,
        tagName,
        ...(code ? { powerupCode: code } : {}),
        ...(stillTagged ? { error: 'still tagged after removal' } : {}),
      });
    } catch (err) {
      results.push({ remId, removed: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const removed = results.filter((r) => r.removed).length;
  return {
    ok: removed === job.remIds.length,
    summary: `removed “${spec}” from ${removed} of ${plural(job.remIds.length, 'rem')}`,
    results,
    found: rems.length,
  };
}

// --- get-image ---------------------------------------------------------------

export async function runGetImage(plugin: ReactRNPlugin, job: BridgeOpJob): Promise<BridgeOpResult> {
  const rem = await plugin.rem.findOne(job.remIds[0]);
  if (!rem) throw new OpError(`Rem not found: ${job.remIds[0]}`);
  const images = [
    ...imageUrlsOf(rem.text).map((url) => ({ field: 'text', url })),
    ...imageUrlsOf(rem.backText).map((url) => ({ field: 'backText', url })),
  ].filter((image) => image.url);
  const kb = await plugin.kb.getCurrentKnowledgeBaseData();
  return {
    ok: true,
    summary: `found ${plural(images.length, 'image')}`,
    remId: rem._id,
    title: await remTitle(plugin, rem),
    kbId: kb?._id,
    images,
  };
}

// --- incrementalize ----------------------------------------------------------

export async function runIncrementalize(plugin: ReactRNPlugin, job: BridgeOpJob): Promise<BridgeOpResult> {
  const priority = job.priority === undefined || job.priority === null ? undefined : Number(job.priority);
  if (priority !== undefined && !(Number.isInteger(priority) && priority >= 0 && priority <= 100)) {
    throw new OpError('The priority must be a whole number from 0 to 100.');
  }
  const { byId } = await findRems(plugin, job.remIds);

  const results = [];
  const cascade: string[] = [];
  // One flag bracket for the whole job, as the batch tools do: initIncrementalRem
  // skips its own, and the cascade below runs once for every rem touched.
  await plugin.storage.setSession('plugin_operation_active', true);
  try {
    for (const remId of job.remIds) {
      const rem = byId.get(remId);
      if (!rem) {
        results.push({ remId, ok: false, error: 'rem not found' });
        continue;
      }
      try {
        const wasIncremental = await rem.hasPowerup(powerupCode);
        let action: string;
        if (!wasIncremental) {
          await initIncrementalRem(plugin, rem, { priority, skipFlagManagement: true, skipInitialCascade: true });
          if (!(await rem.hasPowerup(powerupCode))) throw new OpError('RemNote did not keep the Incremental tag.');
          action = 'made incremental';
          cascade.push(remId);
        } else if (priority !== undefined) {
          await setIncRemPriority(plugin, rem, priority, { event: 'bridge' });
          const updated = await getIncrementalRemFromRem(plugin, rem);
          if (updated) await updateIncrementalRemCache(plugin, updated);
          action = 'priority set';
          cascade.push(remId);
        } else {
          action = 'already incremental';
        }
        const incRem = await getIncrementalRemFromRem(plugin, rem);
        results.push({
          remId,
          ok: true,
          action,
          title: await remTitle(plugin, rem),
          priority: incRem?.priority,
          nextRepDate: incRem?.nextRepDate ? new Date(incRem.nextRepDate).toISOString().slice(0, 10) : undefined,
        });
      } catch (err) {
        results.push({ remId, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
  } finally {
    // The cascade watcher raises the flag again itself, so set it before clearing ours.
    if (cascade.length) await plugin.storage.setSession('pendingInheritanceCascade', cascade);
    await plugin.storage.setSession('plugin_operation_active', false);
  }
  const done = results.filter((r) => r.ok).length;
  return {
    ok: done === job.remIds.length,
    summary:
      `${plural(done, 'rem')} Incremental` +
      (priority !== undefined ? ` at priority ${priority}` : '') +
      (done < job.remIds.length ? `, ${job.remIds.length - done} failed` : ''),
    results,
  };
}

// --- dispatch ----------------------------------------------------------------

const OPS: Record<string, (plugin: ReactRNPlugin, job: BridgeOpJob) => Promise<BridgeOpResult>> = {
  move: runMove,
  untag: runUntag,
  'get-image': runGetImage,
  incrementalize: runIncrementalize,
};

/** Runs a non-localize job. Errors come back as `{ok: false, message}`, never thrown. */
export async function runBridgeOp(plugin: ReactRNPlugin, job: BridgeOpJob): Promise<BridgeOpResult> {
  const run = OPS[job.op];
  if (!run) return { ok: false, summary: `unknown operation “${job.op}”`, message: `unknown op ${job.op}` };
  try {
    return await run(plugin, job);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!(err instanceof OpError)) console.error(`[MediaBridge] ${job.op} failed`, err);
    return { ok: false, summary: `${job.op} failed — ${message}`, message };
  }
}
