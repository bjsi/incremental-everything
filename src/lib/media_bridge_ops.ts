/**
 * Local Media Bridge — the rem operations besides localize.
 *
 * The RemNote MCP can write text, tags and documents, but cannot move a rem,
 * remove a tag, hand back an image, pin a source, set a card's type and direction,
 * set a heading level, make a portal, build an outline,
 * add a playable audio file, rewrite rich text exactly, or make a rem Incremental the way this
 * plugin does (its slots, history, cache and inheritance cascade). Outside tools
 * queue these as jobs on the media-bridge helper (scripts/media_bridge/
 * media_bridge.py), and lib/media_bridge.ts hands them here. Each returns the
 * JSON the helper passes back to the caller, with `ok` false when any rem failed.
 */
import {
  BuiltInPowerupCodes,
  PluginRem,
  ReactRNPlugin,
  RichTextElementRemInterface,
  RichTextInterface,
  SetRemType,
} from '@remnote/plugin-sdk';
import { dismissedPowerupCode, powerupCode } from './consts';
import {
  getIncrementalRemFromRem,
  initIncrementalRem,
  setIncRemPriority,
  updateIncrementalRemCache,
} from './incremental_rem';
import { imageUrlsOf, isRemNoteHostedUrl, localizeMediaInRems } from './localize_media';
import { restoreMislabelledAudio } from './audio_restore';
import { isPin, pinFromSourceFinder, pinOneQuote, SourceView, sourceViews } from './pdf_source_pins';
import { quoteCandidates } from './pdf_source_pins/quote';
import { applyHeadingLevel, clearHeading, getHeadingLevel, HeadingLevel } from './outline_restructure';
import { removeCardPriorityFromRems } from './card_priority/remove_scoped';

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

/**
 * Adds a tag, given by its rem id, to each rem (the MCP's tag_rems refuses some rems,
 * such as PDF rems). Already tagged counts as done.
 */
export async function runTag(plugin: ReactRNPlugin, job: BridgeOpJob): Promise<BridgeOpResult> {
  const tagId = String(job.tag ?? '').trim();
  if (!tagId) throw new OpError('No tag id given.');
  const tagRem = await plugin.rem.findOne(tagId);
  if (!tagRem) throw new OpError(`No rem with id “${tagId}” to use as the tag.`);
  if (tagRem._id === (await plugin.powerup.getPowerupByCode(powerupCode))?._id) {
    throw new OpError('The Incremental tag is not added here: use incrementalize instead.');
  }
  const tagName = await plugin.richText.toString(tagRem.text ?? []);
  const { byId } = await findRems(plugin, job.remIds);
  const isTagged = async (rem: PluginRem) =>
    ((await rem.getTagRems()) ?? []).some((tag) => tag._id === tagRem._id);

  const results = [];
  for (const remId of job.remIds) {
    const rem = byId.get(remId);
    if (!rem) {
      results.push({ remId, tagged: false, error: 'rem not found' });
      continue;
    }
    try {
      const already = await isTagged(rem);
      if (!already) await rem.addTag(tagRem._id);
      const tagged = await isTagged(rem);
      results.push({ remId, tagged, already, ...(tagged ? {} : { error: 'not tagged after adding' }) });
    } catch (err) {
      results.push({ remId, tagged: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const done = results.filter((r) => r.tagged).length;
  return {
    ok: done === results.length,
    summary: `tagged ${done}/${results.length} with “${tagName}”`,
    tagId: tagRem._id,
    tagName,
    results,
  };
}

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

// --- pin ---------------------------------------------------------------------

/** Highlights: what `pin` turns into pins when no reference ids are given. */
const HIGHLIGHT_POWERUPS = [
  BuiltInPowerupCodes.PDFHighlight,
  BuiltInPowerupCodes.HTMLHighlight,
  BuiltInPowerupCodes.WebHighlight,
];
/** How long `pin --refs` waits for a rem just written through the MCP to show them. */
const PIN_SYNC_WAIT_MS = 15_000;

const isRemRef = (el: unknown): el is RichTextElementRemInterface =>
  typeof el === 'object' && el !== null && (el as any).i === 'q' && typeof (el as any)._id === 'string';

const refIdsOf = (rem: PluginRem) =>
  new Set([...(rem.text ?? []), ...(rem.backText ?? [])].filter(isRemRef).map((el) => el._id));

/**
 * Show references as pins (📌), as RemNote does for a highlight pinned by hand:
 * `{i:'q', _id, pin: true, content: false}`. The RemNote MCP can only write a
 * plain reference, which spells out the highlight's whole text. `refIds` limits it
 * to those references; without it, every reference to a PDF/web highlight is
 * pinned. `unpin` turns pins back into plain references.
 */
export async function runPin(plugin: ReactRNPlugin, job: BridgeOpJob): Promise<BridgeOpResult> {
  const unpin = job.unpin === true;
  const only = Array.isArray(job.refIds) && job.refIds.length ? new Set(job.refIds.map(String)) : undefined;
  const { byId } = await findRems(plugin, job.remIds);

  const highlightVerdicts = new Map<string, Promise<boolean>>();
  const isHighlight = (id: string) => {
    if (!highlightVerdicts.has(id)) {
      highlightVerdicts.set(
        id,
        (async () => {
          const target = await plugin.rem.findOne(id);
          if (!target) return false;
          for (const code of HIGHLIGHT_POWERUPS) if (await target.hasPowerup(code).catch(() => false)) return true;
          return false;
        })()
      );
    }
    return highlightVerdicts.get(id)!;
  };

  const results = [];
  for (const remId of job.remIds) {
    let rem = byId.get(remId);
    if (!rem) {
      results.push({ remId, ok: false, error: 'rem not found' });
      continue;
    }
    try {
      // A rem just written through the MCP reaches the plugin by sync a moment
      // later; rewriting a stale copy would undo that write. With named refs, wait
      // until they are all there.
      if (only) {
        const deadline = Date.now() + PIN_SYNC_WAIT_MS;
        while ([...only].some((id) => !refIdsOf(rem!).has(id)) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          rem = (await plugin.rem.findOne(remId)) ?? rem;
        }
      }
      const changed: { field: string; refId: string }[] = [];
      const rewrite = async (field: 'text' | 'backText', richText: RichTextInterface | undefined) => {
        if (!richText?.length) return undefined;
        let touched = false;
        const next: RichTextInterface = [];
        for (const el of richText) {
          const wanted =
            isRemRef(el) &&
            !!el.pin === unpin &&
            !el.aliasId &&
            (only ? only.has(el._id) : await isHighlight(el._id));
          if (!wanted) {
            next.push(el);
            continue;
          }
          const ref = el as RichTextElementRemInterface;
          if (unpin) {
            const { content: _content, ...rest } = ref;
            next.push({ ...rest, pin: false });
          } else {
            next.push({ ...ref, pin: true, content: false });
          }
          changed.push({ field, refId: ref._id });
          touched = true;
        }
        return touched ? next : undefined;
      };
      const text = await rewrite('text', rem.text);
      const backText = await rewrite('backText', rem.backText);
      if (text) await rem.setText(text);
      if (backText) await rem.setBackText(backText);

      const notFound = only ? [...only].filter((id) => !refIdsOf(rem!).has(id)) : [];
      results.push({
        remId,
        ok: notFound.length === 0,
        title: await remTitle(plugin, rem),
        [unpin ? 'unpinned' : 'pinned']: changed,
        ...(notFound.length ? { error: `no reference to ${notFound.join(', ')} in this rem` } : {}),
      });
    } catch (err) {
      results.push({ remId, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const count = results.reduce((n, r: any) => n + ((r.pinned ?? r.unpinned)?.length ?? 0), 0);
  return {
    ok: results.every((r) => r.ok),
    summary: `${unpin ? 'unpinned' : 'pinned'} ${plural(count, 'reference')} in ${plural(job.remIds.length, 'rem')}`,
    results,
  };
}

// --- pin-quote ---------------------------------------------------------------

/**
 * Pin Source Quote run from outside: find each rem's text in the given PDF or
 * saved article, reuse or create the highlight, and pin it at the end of the
 * rem's back (or front) — the same code as the command, without needing the
 * source open in a pane or asking which view. `quote` replaces the rem's own
 * text as the passage to look for (a card whose answer is not verbatim).
 */
/**
 * pin-quote without a source: each rem's book comes from the user's source finder
 * (pinFromSourceFinder) and the first of its RemNote PDFs holding the passage is pinned.
 */
async function runPinQuoteFromIndex(plugin: ReactRNPlugin, job: BridgeOpJob): Promise<BridgeOpResult> {
  const quote = typeof job.quote === 'string' && job.quote.trim() ? job.quote.trim() : undefined;
  if (quote && job.remIds.length > 1) throw new OpError('--quote goes with a single rem.');
  const { byId } = await findRems(plugin, job.remIds);
  const plain = (rt: RichTextInterface | undefined) =>
    plugin.richText.toString(((rt ?? []) as RichTextInterface).filter((el) => !isPin(el)));
  const requests = [];
  const results: Record<string, unknown>[] = [];
  for (const remId of job.remIds) {
    const rem = byId.get(remId);
    const candidates = !rem ? [] : quote ? [quote] : quoteCandidates(await plain(rem.text), await plain(rem.backText));
    if (!rem) results.push({ remId, ok: false, error: 'rem not found' });
    else if (!candidates.length) results.push({ remId, ok: false, error: 'the rem has no text to look for' });
    else requests.push({ remId, candidates });
  }
  const run = await pinFromSourceFinder(plugin, requests);
  if (run.unavailable !== undefined) throw new OpError(`No --source given and no source finder is available: ${run.unavailable}`);
  for (const row of run.rows) {
    const p = row.pinned;
    results.push(
      p
        ? {
            remId: row.remId,
            ok: true,
            pdf: p.pdfRemId,
            pdfName: p.pdfName,
            page: p.page,
            book: p.book.id ?? p.book.title,
            how: p.book.how,
            detail: p.book.detail,
            pins: p.pins,
            reused: p.reused,
            created: p.created,
          }
        : { remId: row.remId, ok: false, books: row.books.map((b) => b.id ?? b.title), tried: row.tried, error: 'passage not found in the PDFs of its book' }
    );
  }
  const pinned = results.filter((r) => r.ok).length;
  return {
    ok: pinned === job.remIds.length && !run.stopped,
    summary: `📌 ${pinned} of ${plural(job.remIds.length, 'rem')} pinned from the PDFs the source finder names`,
    ...(run.stopped ? { stopped: run.stopped } : {}),
    results,
  };
}

export async function runPinQuote(plugin: ReactRNPlugin, job: BridgeOpJob): Promise<BridgeOpResult> {
  const sourceId = String(job.sourceId ?? '');
  if (!sourceId) return runPinQuoteFromIndex(plugin, job);
  const source = await plugin.rem.findOne(sourceId);
  if (!source) throw new OpError(`Source not found: ${sourceId || '(none given)'}`);
  const available = await sourceViews(source);
  if (!available.length) throw new OpError(`${sourceId} is not a PDF or a saved web article.`);
  const view = String(job.view ?? 'default');
  const views: SourceView[] =
    view === 'both' ? available : view === 'default' ? available.slice(0, 1) : ([view] as SourceView[]);
  if (!views.every((v) => available.includes(v))) {
    throw new OpError(`View “${view}” is not available for this source (it has: ${available.join(', ')}).`);
  }
  const quote = typeof job.quote === 'string' && job.quote.trim() ? job.quote.trim() : undefined;
  if (quote && job.remIds.length > 1) throw new OpError('--quote goes with a single rem.');

  const { byId } = await findRems(plugin, job.remIds);
  const plain = (rt: RichTextInterface | undefined) =>
    plugin.richText.toString(((rt ?? []) as RichTextInterface).filter((el) => !isPin(el)));

  const results = [];
  for (const remId of job.remIds) {
    const rem = byId.get(remId);
    if (!rem) {
      results.push({ remId, ok: false, error: 'rem not found' });
      continue;
    }
    const candidates = quote ? [quote] : quoteCandidates(await plain(rem.text), await plain(rem.backText));
    if (!candidates.length) {
      results.push({ remId, ok: false, error: 'the rem has no text to look for' });
      continue;
    }
    const { result, error } = await pinOneQuote(plugin, { remId, sourceRemId: sourceId, candidates }, views);
    if (error) {
      // The helper or the source failed: every other rem would fail the same way.
      results.push({ remId, ok: false, error: error.message });
      break;
    }
    results.push(
      result
        ? {
            remId,
            ok: true,
            title: await remTitle(plugin, rem),
            pins: result.pins,
            reused: result.reused.length,
            created: result.created.length,
            views: result.views.map((v) => ({ view: v.view, found: v.found, page: v.page })),
          }
        : { remId, ok: false, title: await remTitle(plugin, rem), error: 'passage not found in the source' }
    );
  }
  const pinned = results.filter((r) => r.ok).length;
  return {
    ok: pinned === job.remIds.length,
    summary: `📌 ${pinned} of ${plural(job.remIds.length, 'rem')} pinned to “${await remTitle(plugin, source)}”`,
    results,
  };
}

// --- card --------------------------------------------------------------------

const REM_TYPES: Record<string, SetRemType> = {
  default: SetRemType.DEFAULT_TYPE,
  concept: SetRemType.CONCEPT,
  descriptor: SetRemType.DESCRIPTOR,
};
const DIRECTIONS = ['forward', 'backward', 'both', 'none'] as const;
type Direction = (typeof DIRECTIONS)[number];
const TYPE_NAMES = ['default', 'concept', 'descriptor'];

/**
 * Set a rem's type (concept / descriptor / default) and practice direction
 * without rewriting its text, so pins, references and review history stay. The
 * RemNote MCP has no syntax for a bidirectional descriptor (`;<` makes a
 * backward-only one), and editing a rem to change its delimiter turns its pins
 * back into plain references.
 */
export async function runCard(plugin: ReactRNPlugin, job: BridgeOpJob): Promise<BridgeOpResult> {
  const typeName = job.remType === undefined ? undefined : String(job.remType);
  const direction = job.direction === undefined ? undefined : (String(job.direction) as Direction);
  // RemNote's own enable flag (the Rem's `forget` field, what /Disable Card writes).
  const enablePractice = typeof job.enablePractice === 'boolean' ? job.enablePractice : undefined;
  if (typeName === undefined && direction === undefined && enablePractice === undefined) {
    throw new OpError('Give --type, --direction and/or --practice.');
  }
  if (typeName !== undefined && !(typeName in REM_TYPES)) throw new OpError(`Unknown type “${typeName}”.`);
  if (direction !== undefined && !DIRECTIONS.includes(direction)) throw new OpError(`Unknown direction “${direction}”.`);
  const { byId } = await findRems(plugin, job.remIds);

  const results = [];
  for (const remId of job.remIds) {
    const rem = byId.get(remId);
    if (!rem) {
      results.push({ remId, ok: false, error: 'rem not found' });
      continue;
    }
    try {
      if (typeName !== undefined) await rem.setType(REM_TYPES[typeName]);
      if (direction !== undefined) await rem.setPracticeDirection(direction);
      if (enablePractice !== undefined) await rem.setEnablePractice(enablePractice);
      const after = (await plugin.rem.findOne(remId)) ?? rem;
      const nowType = TYPE_NAMES[after.type as number] ?? String(after.type);
      const nowDirection = await after.getPracticeDirection();
      const nowPractice = !(after as unknown as { forget?: boolean }).forget;
      const ok =
        (typeName === undefined || nowType === typeName) &&
        (direction === undefined || nowDirection === direction) &&
        (enablePractice === undefined || nowPractice === enablePractice);
      results.push({
        remId,
        ok,
        title: await remTitle(plugin, after),
        type: nowType,
        direction: nowDirection,
        ...(enablePractice !== undefined ? { enablePractice: nowPractice } : {}),
        ...(ok ? {} : { error: 'RemNote did not keep the change' }),
      });
    } catch (err) {
      results.push({ remId, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const done = results.filter((r) => r.ok).length;
  const what = [
    typeName,
    direction,
    enablePractice === undefined ? undefined : enablePractice ? 'practice on' : 'practice off',
  ]
    .filter(Boolean)
    .join(', ');
  return {
    ok: done === job.remIds.length,
    summary: `${plural(done, 'rem')} set to ${what}` + (done < job.remIds.length ? `, ${job.remIds.length - done} failed` : ''),
    results,
  };
}


// --- strip-priority ----------------------------------------------------------

/**
 * Strip the CardPriority tag from rems through the plugin's own scoped removal:
 * slot values first (priority, hidden priorityValue, source, lastUpdated, the
 * priority history), then the powerup, then the band tag, then the cache entry.
 * For rems that stopped being flashcards. The captured rows come back so the
 * caller can keep them for an undo.
 */
export async function runStripPriority(plugin: ReactRNPlugin, job: BridgeOpJob): Promise<BridgeOpResult> {
  const { byId } = await findRems(plugin, job.remIds);
  const targets = [];
  const results: Array<{ remId: string; ok: boolean; error?: string; skipped?: string }> = [];
  for (const remId of job.remIds) {
    const rem = byId.get(remId);
    if (!rem) results.push({ remId, ok: false, error: 'rem not found' });
    else if (!(await rem.hasPowerup('cardPriority'))) results.push({ remId, ok: true, skipped: 'no CardPriority tag' });
    else targets.push({ remId, text: await remTitle(plugin, rem) });
  }
  const outcome = await removeCardPriorityFromRems(plugin, targets, 'media bridge strip-priority');
  const failed = new Map(outcome.failed.map((f) => [f.remId, f.error]));
  for (const { remId } of targets) {
    const rem = await plugin.rem.findOne(remId);
    const still = rem ? await rem.hasPowerup('cardPriority') : false;
    const error = failed.get(remId) ?? (still ? 'still tagged after removal' : undefined);
    results.push({ remId, ok: !error, ...(error ? { error } : {}) });
  }
  const done = results.filter((r) => r.ok).length;
  return {
    ok: done === job.remIds.length,
    summary: `CardPriority removed from ${plural(outcome.removed, 'rem')}` + (done < job.remIds.length ? `, ${job.remIds.length - done} failed` : ''),
    results,
    removedRows: outcome.removal.rows,
  };
}

// --- portal ------------------------------------------------------------------

/**
 * Create a portal under `parentId` showing the given rems (in that order), so a
 * rem that lives in one place of the outline also shows, in full and editable,
 * in another (e.g. a concept rem in its section, shown inside a summary). The
 * RemNote MCP cannot make portals: a `[[ref]]` only references. Position as in
 * `move`: first | last | index | before | after (a sibling id).
 */
export async function runPortal(plugin: ReactRNPlugin, job: BridgeOpJob): Promise<BridgeOpResult> {
  const parentId = String(job.parentId ?? '');
  const position = String(job.position ?? 'last');
  const siblingId = job.siblingId === undefined ? undefined : String(job.siblingId);
  const parent = parentId ? await plugin.rem.findOne(parentId) : undefined;
  if (!parent) throw new OpError(`Parent not found: ${parentId || '(none given)'}`);
  const { rems, byId } = await findRems(plugin, job.remIds);
  const missing = job.remIds.filter((id) => !byId.has(id));
  if (missing.length) throw new OpError(`Rem(s) not found: ${missing.join(', ')}`);

  const children = (await parent.getChildrenRem()) ?? [];
  let at = children.length;
  if (position === 'first') at = 0;
  else if (position === 'index') {
    const n = Number(job.index);
    if (!Number.isInteger(n) || n < 0) throw new OpError(`Bad index: ${job.index}`);
    at = Math.min(n, children.length);
  } else if (position === 'before' || position === 'after') {
    const i = children.findIndex((child) => child._id === siblingId);
    if (i === -1) throw new OpError(`${siblingId} is not a child of ${parentId}.`);
    at = position === 'before' ? i : i + 1;
  } else if (position !== 'last') throw new OpError(`Unknown position: ${position}`);

  const portal = await plugin.rem.createPortal();
  if (!portal) throw new OpError('RemNote did not create the portal.');
  await portal.setParent(parent, at);
  for (const rem of rems) await rem.addToPortal(portal);

  const shown = ((await portal.getPortalDirectlyIncludedRem()) ?? []).map((r) => r._id);
  const notShown = job.remIds.filter((id) => !shown.includes(id));
  const titles = await Promise.all(rems.map((rem) => remTitle(plugin, rem)));
  return {
    ok: notShown.length === 0,
    summary: `portal to ${titles.map((t) => `“${t}”`).join(', ')} under “${await remTitle(plugin, parent)}”`,
    portalId: portal._id,
    parentId: parent._id,
    shown,
    ...(notShown.length ? { message: `not in the portal: ${notShown.join(', ')}` } : {}),
  };
}

// --- heading -----------------------------------------------------------------

/**
 * Set rems' heading level, like the "Set Next Heading Level" command but without
 * its dialog and without touching any other rem. `level`:
 *   - 'next' (default): one level deeper than the nearest heading ancestor, however
 *     many plain rems lie between (parent H3 → H4; parent plain, grandparent H3 → H4
 *     too), clamped at H6. Counting generations made a concept under a plain bullet
 *     H6 where H5 reads right.
 *     No heading ancestor → the rem fails (give a level).
 *   - 1–6: that level.
 *   - 'none': back to a plain paragraph.
 */
export async function runHeading(plugin: ReactRNPlugin, job: BridgeOpJob): Promise<BridgeOpResult> {
  const raw = job.level === undefined ? 'next' : String(job.level);
  if (!['next', 'none', '1', '2', '3', '4', '5', '6'].includes(raw))
    throw new OpError(`Unknown level “${raw}”: use next, none or 1–6.`);
  const { byId } = await findRems(plugin, job.remIds);

  const results = [];
  for (const remId of job.remIds) {
    const rem = byId.get(remId);
    if (!rem) {
      results.push({ remId, ok: false, error: 'rem not found' });
      continue;
    }
    try {
      let level: HeadingLevel | null = null;
      let from: string | undefined;
      if (raw === 'next') {
        let current: PluginRem | undefined = rem.parent ? await plugin.rem.findOne(rem.parent) : undefined;
        for (let generations = 1; current && generations < 100; generations++) {
          const found = await getHeadingLevel(current);
          if (found) {
            level = Math.min(found + 1, 6) as HeadingLevel;
            from = `${current._id} (H${found})`;
            break;
          }
          current = current.parent ? await plugin.rem.findOne(current.parent) : undefined;
        }
        if (!level) {
          results.push({ remId, ok: false, error: 'no heading above this rem: give a level (1–6)' });
          continue;
        }
      } else if (raw !== 'none') {
        level = Number(raw) as HeadingLevel;
      }
      if (level) await applyHeadingLevel(rem, level);
      else await clearHeading(rem);
      const after = (await plugin.rem.findOne(remId)) ?? rem;
      const now = await getHeadingLevel(after);
      const ok = now === level;
      results.push({
        remId,
        ok,
        title: await remTitle(plugin, after),
        level: now ? `H${now}` : 'none',
        ...(from ? { from } : {}),
        ...(ok ? {} : { error: 'RemNote did not keep the change' }),
      });
    } catch (err) {
      results.push({ remId, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const done = results.filter((r) => r.ok).length;
  return {
    ok: done === job.remIds.length,
    summary: `${plural(done, 'rem')} set to heading ${raw}` + (done < job.remIds.length ? `, ${job.remIds.length - done} failed` : ''),
    results,
  };
}

// --- outline -----------------------------------------------------------------

/**
 * Build or fix an outline in one job (`media_bridge.py outline`, used by the
 * /book-outline command). Three lists, run in this order:
 *   - `create`: [{key, parent, text, tag?}] new plain-text rems, put at the end of
 *     `parent` (an order step places them). `key` is the caller's name for the new
 *     rem ("new:3.1.2"); later steps (and later jobs, through `keys`) refer to it.
 *   - `order`: [{parent, children}] makes `children` the parent's first children, in
 *     that order, moving each from wherever it is. The parent's other children keep
 *     their relative order after them.
 *   - `heading`: [{rem, level}] level 1–6, or 0 for a plain paragraph.
 *   - `document`: [rem] made documents (a block moved out to stand on its own).
 * `parent`, `children[]` and `rem` are rem ids or keys; `keys` maps keys made by an
 * earlier job to their ids. Returns `keys` (every key → id) and each failure.
 */
export async function runOutline(plugin: ReactRNPlugin, job: BridgeOpJob): Promise<BridgeOpResult> {
  const keys: Record<string, string> = { ...((job.keys as Record<string, string>) ?? {}) };
  const failures: { step: string; ref: string; error: string }[] = [];
  const resolve = async (ref: string) => {
    const id = ref.startsWith('new:') ? keys[ref] : ref;
    return id ? await plugin.rem.findOne(id) : undefined;
  };
  type Create = { key: string; parent: string; text: string; tag?: string };
  type Order = { parent: string; children: string[] };
  type Head = { rem: string; level: number };
  const creates = (Array.isArray(job.create) ? job.create : []) as Create[];
  const orders = (Array.isArray(job.order) ? job.order : []) as Order[];
  const heads = (Array.isArray(job.heading) ? job.heading : []) as Head[];

  let created = 0;
  for (const c of creates) {
    try {
      if (keys[c.key]) continue; // made by an earlier try of this job
      const parent = await resolve(c.parent);
      if (!parent) throw new Error(`parent not found: ${c.parent}`);
      const rem = await plugin.rem.createRem();
      if (!rem) throw new Error('RemNote did not create the rem');
      await rem.setText([c.text]);
      await rem.setParent(parent, ((await parent.getChildrenRem()) ?? []).length);
      if (c.tag) await rem.addTag(c.tag);
      keys[c.key] = rem._id;
      created++;
    } catch (err) {
      failures.push({ step: 'create', ref: c.key, error: err instanceof Error ? err.message : String(err) });
    }
  }

  let placed = 0;
  for (const o of orders) {
    const parent = await resolve(o.parent);
    if (!parent) {
      failures.push({ step: 'order', ref: o.parent, error: 'parent not found' });
      continue;
    }
    let slot = 0;
    for (const ref of o.children) {
      try {
        const rem = await resolve(ref);
        if (!rem) throw new Error('rem not found');
        if (await isSelfOrAncestorOf(plugin, rem, parent)) throw new Error('cannot go under itself');
        const current = (await parent.getChildrenRem()) ?? [];
        if (current[slot]?._id !== rem._id) {
          await rem.setParent(parent, slot);
          placed++;
        }
        slot++;
      } catch (err) {
        failures.push({ step: 'order', ref, error: err instanceof Error ? err.message : String(err) });
      }
    }
    // Check what RemNote kept: the placed rems first, in this order.
    const after = ((await parent.getChildrenRem()) ?? []).map((c) => c._id);
    const want = (await Promise.all(o.children.map(async (ref) => (await resolve(ref))?._id))).filter(
      (id): id is string => !!id
    );
    if (after.slice(0, want.length).join() !== want.join())
      failures.push({ step: 'order', ref: o.parent, error: 'children not in the asked order after the moves' });
  }

  let headed = 0;
  for (const h of heads) {
    try {
      const rem = await resolve(h.rem);
      if (!rem) throw new Error('rem not found');
      const level = Number(h.level);
      const now = await getHeadingLevel(rem);
      if ((now ?? 0) === level) continue;
      if (level >= 1 && level <= 6) await applyHeadingLevel(rem, level as HeadingLevel);
      else await clearHeading(rem);
      headed++;
    } catch (err) {
      failures.push({ step: 'heading', ref: h.rem, error: err instanceof Error ? err.message : String(err) });
    }
  }

  let documents = 0;
  for (const ref of (Array.isArray(job.document) ? job.document : []) as string[]) {
    try {
      const rem = await resolve(ref);
      if (!rem) throw new Error('rem not found');
      if (!(await rem.isDocument())) {
        await rem.setIsDocument(true);
        documents++;
      }
    } catch (err) {
      failures.push({ step: 'document', ref, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    ok: failures.length === 0,
    summary:
      `outline: ${plural(created, 'rem')} created, ${placed} moved, ${headed} heading(s) set` +
      (documents ? `, ${plural(documents, 'document')} made` : '') +
      (failures.length ? `, ${failures.length} failed` : ''),
    keys,
    created,
    placed,
    headed,
    documents,
    failures,
  };
}

// --- audio -------------------------------------------------------------------

/**
 * Adds a child rem that plays an audio file, with an optional caption before
 * the player. The file arrives as a helper URL (`media_bridge.py audio` stores
 * it first); the rem is written with a RemNote audio element and then stored
 * through the import door, so it ends up as a file RemNote keeps (`%LOCAL_FILE%…` or its own S3 host).
 */
export async function runAudio(plugin: ReactRNPlugin, job: BridgeOpJob): Promise<BridgeOpResult> {
  const url = String(job.url ?? '').trim();
  if (!url) throw new OpError('No audio URL given.');
  const caption = typeof job.caption === 'string' ? job.caption.trim() : '';
  const parentId = job.remIds[0];
  const parent = parentId ? await plugin.rem.findOne(parentId) : undefined;
  if (!parent) throw new OpError(`Parent not found: ${parentId || '(none given)'}`);

  const rem = await plugin.rem.createRem();
  if (!rem) throw new OpError('RemNote did not create the rem.');
  const audio = { i: 'a', url, onlyAudio: true } as unknown as RichTextElementRemInterface;
  await rem.setText([...(caption ? [`${caption} `] : []), audio] as RichTextInterface);
  await rem.setParent(parent._id);

  const placed = await runMove(plugin, {
    id: job.id,
    op: 'move',
    remIds: [rem._id],
    parentId: parent._id,
    position: job.position ?? 'first',
    ...(job.siblingId === undefined ? {} : { siblingId: job.siblingId }),
    ...(job.index === undefined ? {} : { index: job.index }),
  });

  const fresh = await plugin.rem.findOne(rem._id);
  const localized = fresh ? await localizeMediaInRems(plugin, [fresh]) : undefined;
  const after = await plugin.rem.findOne(rem._id);
  const element = (after?.text ?? []).find(
    (el) => typeof el === 'object' && el !== null && (el as any).i === 'a'
  ) as { url?: string } | undefined;
  const storedUrl = element?.url;
  const stored = typeof storedUrl === 'string' && isRemNoteHostedUrl(storedUrl);
  return {
    ok: stored && placed.ok,
    summary: stored
      ? `audio added${caption ? ` (“${caption}”)` : ''} and stored in RemNote`
      : 'audio rem added, but the file was not stored in RemNote',
    remId: rem._id,
    parentId: parent._id,
    storedUrl,
    placed: placed.ok,
    ...(localized?.failed?.length ? { failed: localized.failed } : {}),
  };
}

// --- restore-audio -----------------------------------------------------------

/** Audio RemNote stored as an image (no extension, served as image/…): stored again as audio. */
export async function runRestoreAudio(plugin: ReactRNPlugin, job: BridgeOpJob): Promise<BridgeOpResult> {
  const rems: PluginRem[] = [];
  const missing: string[] = [];
  for (const id of job.remIds) {
    const rem = await plugin.rem.findOne(id);
    if (rem) rems.push(rem);
    else missing.push(id);
  }
  const result = await restoreMislabelledAudio(plugin, rems);
  return {
    ...result,
    ok: result.ok && missing.length === 0,
    failed: [...result.failed, ...missing],
    summary: missing.length ? `${result.summary}; ${missing.length} not found` : result.summary,
  };
}

// --- set-text / remove -------------------------------------------------------

/** JSON with object keys sorted, so rich text read from the DB compares equal to the SDK's copy. */
const canon = (value: unknown): string =>
  JSON.stringify(value ?? [], (_key, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, (val as Record<string, unknown>)[k]]))
      : val
  );

type TextField = 'text' | 'backText';
interface FieldEdit {
  before: RichTextInterface;
  after: RichTextInterface;
}
interface TextEdit {
  remId: string;
  text?: FieldEdit;
  backText?: FieldEdit;
}

/**
 * Replace a rem's front and/or back rich text with the exact elements given, so
 * cloze ids, formatting, references, powerups and review history all stay. Each
 * field is written only if it still equals `before` (sorted-key JSON); otherwise
 * the rem is reported as a conflict and left alone. The MCP's edit_rem goes
 * through markdown, which renumbers clozes and cannot address the back text.
 */
export async function runSetText(plugin: ReactRNPlugin, job: BridgeOpJob): Promise<BridgeOpResult> {
  const edits = (Array.isArray(job.edits) ? job.edits : []) as TextEdit[];
  if (!edits.length) throw new OpError('No edits given.');
  const { byId } = await findRems(plugin, edits.map((e) => e.remId));
  const results = [];
  for (const edit of edits) {
    const rem = byId.get(edit.remId);
    if (!rem) {
      results.push({ remId: edit.remId, ok: false, error: 'rem not found' });
      continue;
    }
    try {
      const fields = (['text', 'backText'] as TextField[]).filter((f) => edit[f]);
      const conflicts = fields.filter((f) => canon(rem[f]) !== canon(edit[f]!.before));
      if (conflicts.length) {
        results.push({ remId: edit.remId, ok: false, error: `changed since it was read: ${conflicts.join(', ')}`, current: Object.fromEntries(conflicts.map((f) => [f, rem[f] ?? null])) });
        continue;
      }
      if (edit.text) await rem.setText(edit.text.after);
      if (edit.backText) await rem.setBackText(edit.backText.after);
      const after = (await plugin.rem.findOne(edit.remId)) ?? rem;
      const differs = fields.filter((f) => canon(after[f]) !== canon(edit[f]!.after));
      results.push({
        remId: edit.remId,
        ok: true,
        title: await remTitle(plugin, after),
        ...(differs.length ? { normalized: Object.fromEntries(differs.map((f) => [f, after[f] ?? null])) } : {}),
      });
    } catch (err) {
      results.push({ remId: edit.remId, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const done = results.filter((r) => r.ok).length;
  return {
    ok: done === edits.length,
    summary: `text set on ${plural(done, 'rem')}` + (done < edits.length ? `, ${edits.length - done} skipped` : ''),
    results,
  };
}

/**
 * Delete rems that have no children, each only if its front and back text still
 * equal what the caller read (`expect[remId] = {text, backText}`).
 */
export async function runRemove(plugin: ReactRNPlugin, job: BridgeOpJob): Promise<BridgeOpResult> {
  const expect = (job.expect ?? {}) as Record<string, { text?: RichTextInterface; backText?: RichTextInterface }>;
  const { byId } = await findRems(plugin, job.remIds);
  const results = [];
  for (const remId of job.remIds) {
    const rem = byId.get(remId);
    const want = expect[remId];
    if (!rem) {
      results.push({ remId, ok: false, error: 'rem not found' });
      continue;
    }
    if (!want) {
      results.push({ remId, ok: false, error: 'no expected text given' });
      continue;
    }
    try {
      if (canon(rem.text) !== canon(want.text) || canon(rem.backText) !== canon(want.backText)) {
        results.push({ remId, ok: false, error: 'changed since it was read' });
        continue;
      }
      // rem.children is a lazy cache, [] for a document not opened this session, and
      // removing a rem takes its subtree with it, so ask for the children for real.
      const children = await rem.getChildrenRem();
      if (children.length) {
        results.push({ remId, ok: false, error: `has ${children.length} children` });
        continue;
      }
      await rem.remove();
      results.push({ remId, ok: true });
    } catch (err) {
      results.push({ remId, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const done = results.filter((r) => r.ok).length;
  return {
    ok: done === job.remIds.length,
    summary: `${plural(done, 'rem')} deleted` + (done < job.remIds.length ? `, ${job.remIds.length - done} kept` : ''),
    results,
  };
}

// --- dispatch ----------------------------------------------------------------

const OPS: Record<string, (plugin: ReactRNPlugin, job: BridgeOpJob) => Promise<BridgeOpResult>> = {
  move: runMove,
  untag: runUntag,
  tag: runTag,
  'get-image': runGetImage,
  incrementalize: runIncrementalize,
  pin: runPin,
  'pin-quote': runPinQuote,
  card: runCard,
  'strip-priority': runStripPriority,
  heading: runHeading,
  portal: runPortal,
  audio: runAudio,
  'restore-audio': runRestoreAudio,
  'set-text': runSetText,
  remove: runRemove,
  outline: runOutline,
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
