/**
 * Logos Bible Software bridge — the RemNote half.
 *
 * Logos for Mac has no automation API, so a local helper
 * (scripts/logos_bridge/LogosBridge.swift) does the Logos side: it copies the
 * selection through Logos's own Edit ▸ Copy, reads the text, citation and ref.ly
 * deep link Logos puts on the clipboard, and asks for priority/interval in a
 * panel floating over Logos, so reading never leaves Logos. The plugin cannot be
 * called from outside its iframe, so it long-polls the helper for jobs and does
 * the RemNote writes here, in the index widget. Off unless the "Logos Bridge"
 * setting is on, so nobody without the helper gets a localhost probe.
 *
 * Where an extract goes: the focused Rem when it sits inside the IncRem under
 * review (in the queue, or in an Editor Review session), else that IncRem;
 * with no review running, the focused Rem. Every extract
 * also moves the source's Logos bookmark to the passage, like Create IncRem does
 * for PDF highlights. ⌃⌥N creates the book's IncRem itself: a top-level
 * document tagged #Logos, so all Logos books are listed under that tag, and
 * opens it in RemNote.
 */
import { BuiltInPowerupCodes, PluginRem, ReactRNPlugin, RichTextInterface } from '@remnote/plugin-sdk';
import {
  currentIncRemKey,
  defaultPriorityId,
  editorReviewTimerRemIdKey,
  initialIntervalId,
  logosAutoOpenId,
  logosBridgeEnabledId,
  openInLogosCommandId,
  pendingIntervalBatchSaveKey,
  powerupCode,
  prioritySlotCode,
} from './consts';
import { initIncrementalRem } from './incremental_rem';
import { safeRemTextToString } from './pdfUtils';
import { findClosestAncestorWithAnyPriority } from './priority_inheritance';
import { getIESetting } from './settings';
import {
  isLogosLink,
  LOGOS_BOOKMARK_PREFIX,
  LOGOS_RESOURCE_PROPERTY_NAME,
  LOGOS_TAG_NAME,
  LogosJob,
  segmentsToRichText,
} from './logos_bridge_format';

export const LOGOS_BRIDGE_URL = 'http://localhost:3458';
const POLL_WAIT_S = 25;
const RETRY_MS = 30_000;
const LOG = '[LogosBridge]';

/** A failure worth showing the reader as-is in the helper's HUD. */
class BridgeError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const postJSON = (path: string, body: unknown) =>
  fetch(`${LOGOS_BRIDGE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

// --- polling -----------------------------------------------------------------

let loopGeneration = 0;

let openCommandRegistered = false;

/**
 * Starts or stops the poll loop as the setting changes, and registers "Open in
 * Logos" the first time the setting is found on. Call once from the index widget.
 */
export function registerLogosBridge(plugin: ReactRNPlugin) {
  plugin.track(async (rp) => {
    const enabled = await getIESetting(rp, logosBridgeEnabledId);
    const generation = ++loopGeneration;
    if (!enabled) return;
    void pollLoop(plugin, generation);
    if (!openCommandRegistered) {
      openCommandRegistered = true;
      await registerOpenInLogosCommand(plugin);
    }
  });
  registerAutoOpen(plugin);
}

/**
 * The SDK cannot unregister a command, so turning the setting off removes it
 * only after a RemNote reload; until then it just says the bridge is off.
 */
async function registerOpenInLogosCommand(plugin: ReactRNPlugin) {
  await plugin.app.registerCommand({
    id: openInLogosCommandId,
    name: 'Open in Logos',
    description: 'Open the focused extract at its Logos passage, or the book IncRem at its Logos bookmark.',
    quickCode: 'olg',
    action: async () => {
      if (!(await getIESetting(plugin, logosBridgeEnabledId))) {
        await plugin.app.toast('The Logos Bible Software Bridge setting is off.');
        return;
      }
      await openInLogos(plugin);
    },
  });
}

/**
 * "Open in Logos Automatically": when the IncRem under review changes (queue
 * card, or an Editor Review timer starting), open its Logos location once.
 * The same IncRem is not reopened until another one has come up, so going back
 * and forth between RemNote and Logos does not keep yanking Logos forward.
 */
function registerAutoOpen(plugin: ReactRNPlugin) {
  let lastOpened: string | undefined;
  plugin.track(async (rp) => {
    // Read reactively so the tracker re-runs when either review source changes.
    const [bridge, auto] = await Promise.all([
      getIESetting(rp, logosBridgeEnabledId),
      getIESetting(rp, logosAutoOpenId),
      rp.storage.getSession<string>(currentIncRemKey),
      rp.storage.getSession<string>(editorReviewTimerRemIdKey),
    ]);
    if (!bridge || !auto) return;
    const remId = await incRemUnderReview(plugin);
    if (!remId || remId === lastOpened) return;
    lastOpened = remId;
    await openInLogos(plugin, { startRemId: remId, silent: true }).catch((err) =>
      console.warn(`${LOG} auto-open failed:`, err)
    );
  });
}

async function pollLoop(plugin: ReactRNPlugin, generation: number) {
  let connected = false;
  while (generation === loopGeneration) {
    let res: Response;
    try {
      res = await fetch(`${LOGOS_BRIDGE_URL}/next?wait=${POLL_WAIT_S}`);
    } catch {
      if (connected) console.log(`${LOG} helper went away; retrying every ${RETRY_MS / 1000}s`);
      connected = false;
      await sleep(RETRY_MS);
      continue;
    }
    if (!connected) console.log(`${LOG} connected to ${LOGOS_BRIDGE_URL}`);
    connected = true;

    if (res.status === 204) continue; // nothing happened during the wait
    if (res.status !== 200) {
      console.warn(`${LOG} /next answered ${res.status}`);
      await sleep(RETRY_MS);
      continue;
    }
    let job: LogosJob;
    try {
      job = await res.json();
    } catch {
      continue;
    }
    // A job taken by a loop that was switched off is redelivered by the helper after 60 s.
    if (generation !== loopGeneration) break;
    await handleJob(plugin, job);
  }
}

async function handleJob(plugin: ReactRNPlugin, job: LogosJob) {
  try {
    if (job.type === 'context' || job.type === 'lookupBook') {
      // The helper is waiting on these. A failure still answers, so it shows
      // instead of a timeout; forJob tells the helper which question this answers.
      const answer = await (job.type === 'context' ? computeContext(plugin) : lookupBook(plugin, job)).catch(
        (err) => {
          console.error(`${LOG} ${job.type} failed:`, err);
          return { problem: `RemNote could not answer: ${String(err)}` };
        }
      );
      await postJSON('/context', { ...answer, forJob: job.id });
      return;
    }
    const message =
      job.type === 'extract'
        ? await runExtract(plugin, job)
        : job.type === 'bookmark'
          ? await runBookmark(plugin, job)
          : job.type === 'newBook'
            ? await runNewBook(plugin, job)
            : `Unknown job type ${job.type}`;
    await postJSON('/result', { jobId: job.id, ok: true, message });
  } catch (err) {
    console.error(`${LOG} ${job.type} failed:`, err);
    const message = err instanceof BridgeError ? err.message : `RemNote error: ${String(err)}`;
    await postJSON('/result', { jobId: job.id, ok: false, message }).catch(() => undefined);
  }
}

// --- where things go ---------------------------------------------------------

// safeRemTextToString, not richText.toString: the latter rejects some stored
// rich text (references carrying extra fields) as "Invalid Method Arguments".
async function remTitle(plugin: ReactRNPlugin, rem: PluginRem): Promise<string> {
  const text = (await safeRemTextToString(plugin, rem.text)).trim();
  return text.length > 70 ? `${text.slice(0, 67)}…` : text || '(untitled Rem)';
}

async function isDescendant(plugin: ReactRNPlugin, rem: PluginRem, ancestorId: string): Promise<boolean> {
  let parentId: string | null | undefined = rem.parent;
  for (let depth = 0; parentId && depth < 100; depth++) {
    if (parentId === ancestorId) return true;
    parentId = (await plugin.rem.findOne(parentId))?.parent;
  }
  return false;
}

interface Target {
  target?: PluginRem;
  incRem?: PluginRem;
  targetIsFocused: boolean;
  problem?: string;
}

/** The IncRem under review: the queue's when the queue is open, else an Editor Review session's. */
async function incRemUnderReview(plugin: ReactRNPlugin): Promise<string | undefined> {
  const url = await plugin.window.getURL();
  if (url.includes('/flashcards')) {
    // currentIncRemKey is only cleared when the queue is left, so a regular
    // flashcard on screen (getCurrentCard answers only for those) means no IncRem
    // is under review right now — the same test createExtract makes.
    if (await plugin.queue.getCurrentCard()) return undefined;
    return (await plugin.storage.getSession<string>(currentIncRemKey)) || undefined;
  }
  // Set while editor_review_timer.tsx runs; cleared by End Review and Dismiss.
  return (await plugin.storage.getSession<string>(editorReviewTimerRemIdKey)) || undefined;
}

async function resolveTarget(plugin: ReactRNPlugin): Promise<Target> {
  const incRemId = await incRemUnderReview(plugin);
  const incRem = incRemId ? await plugin.rem.findOne(incRemId) : undefined;
  const focused = await plugin.focus.getFocusedRem();

  if (incRem) {
    if (focused && focused._id !== incRem._id && (await isDescendant(plugin, focused, incRem._id))) {
      return { target: focused, incRem, targetIsFocused: true };
    }
    return { target: incRem, incRem, targetIsFocused: false };
  }
  if (focused) return { target: focused, targetIsFocused: true };
  return {
    targetIsFocused: false,
    problem: 'No Incremental Rem under review (queue or Editor Review) and no focused Rem in RemNote.',
  };
}

/** The priority a new Incremental child of `parent` starts with — what initIncrementalRem would inherit. */
async function inheritedPriority(plugin: ReactRNPlugin, parent: PluginRem): Promise<number> {
  if (await parent.hasPowerup(powerupCode)) {
    const own = parseInt((await parent.getPowerupProperty(powerupCode, prioritySlotCode)) ?? '');
    if (!isNaN(own)) return own;
  }
  const ancestor = await findClosestAncestorWithAnyPriority(plugin, parent, 'IncRem');
  if (ancestor) return ancestor.priority;
  return (await getIESetting(plugin, defaultPriorityId)) || 10;
}

const defaultInterval = async (plugin: ReactRNPlugin) => (await getIESetting(plugin, initialIntervalId)) ?? 1;

async function computeContext(plugin: ReactRNPlugin) {
  const { target, incRem, targetIsFocused, problem } = await resolveTarget(plugin);
  if (!target) return { problem };
  return {
    targetId: target._id,
    targetTitle: await remTitle(plugin, target),
    targetIsFocused,
    incRemId: incRem?._id,
    incRemTitle: incRem ? await remTitle(plugin, incRem) : undefined,
    defaultPriority: await inheritedPriority(plugin, target),
    defaultInterval: await defaultInterval(plugin),
  };
}

/** The Rem whose Logos bookmark an extract under `rem` advances: the nearest Incremental Rem at or above it. */
async function bookmarkHost(plugin: ReactRNPlugin, rem: PluginRem): Promise<PluginRem> {
  let current: PluginRem | undefined = rem;
  for (let depth = 0; current && depth < 100; depth++) {
    if (await current.hasPowerup(powerupCode)) return current;
    current = current.parent ? await plugin.rem.findOne(current.parent) : undefined;
  }
  return rem;
}

// --- jobs ----------------------------------------------------------------------

/**
 * The batch-save watcher in tracker.ts drops a job written while it is still
 * running one, so wait for it to go idle first. Capped: a stuck flag must not
 * hold extracts back forever.
 */
async function waitForBatchSaveIdle(plugin: ReactRNPlugin) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const pending = await plugin.storage.getSession(pendingIntervalBatchSaveKey);
    const busy = await plugin.storage.getSession<boolean>('plugin_operation_active');
    if (!pending && !busy) return;
    await sleep(150);
  }
}

async function logosLinkText(plugin: ReactRNPlugin, link: string, label: string) {
  const linkRem = await plugin.rem.createLinkRem(link, false);
  return linkRem ? { i: 'm', text: label, qId: linkRem._id } : `${label} (${link})`;
}

async function runExtract(plugin: ReactRNPlugin, job: LogosJob): Promise<string> {
  const capture = job.capture;
  if (!capture?.segments?.length) throw new BridgeError('The copied passage was empty.');

  let parent = job.targetId ? await plugin.rem.findOne(job.targetId) : undefined;
  if (!parent) {
    const resolved = await resolveTarget(plugin);
    if (!resolved.target) throw new BridgeError(resolved.problem ?? 'Nowhere to put the extract.');
    parent = resolved.target;
  }

  const text: any[] = segmentsToRichText(capture.segments);
  if (capture.link) {
    text.push(' ', await logosLinkText(plugin, capture.link, `📖 ${capture.label || 'Logos'}`));
  }
  const rem = await plugin.rem.createRem();
  if (!rem) throw new BridgeError('RemNote refused to create a Rem.');
  await rem.setText(text as RichTextInterface);
  await rem.setParent(parent);

  if (job.incremental !== false) {
    // skipInitialCascade: the batch save below fires the real cascade with the chosen priority.
    await initIncrementalRem(plugin, rem, { explicitParentId: parent._id, skipInitialCascade: true });
    const priority = job.priority ?? (await inheritedPriority(plugin, parent));
    const interval = job.interval ?? (await defaultInterval(plugin));
    await waitForBatchSaveIdle(plugin);
    await plugin.storage.setSession(pendingIntervalBatchSaveKey, {
      remIds: [rem._id],
      priority,
      interval,
      // One history entry: fold the chosen values into the fresh 'madeIncremental' marker.
      foldRemIds: [rem._id],
    });
  }

  let bookmarkNote = '';
  if (capture.link) {
    // The IncRem under review owns the reading position even when the extract
    // lands on a focused Rem inside it — which may itself be an earlier extract
    // (an IncRem), and must not take the bookmark away from the book.
    const { incRem } = await resolveTarget(plugin);
    const underReview =
      incRem && (parent._id === incRem._id || (await isDescendant(plugin, parent, incRem._id)));
    const host = underReview ? incRem : await bookmarkHost(plugin, parent);
    await writeBookmark(plugin, host, capture.link, capture.label || 'Logos');
    bookmarkNote = ' · bookmark moved';
  }
  const kind = job.incremental === false ? 'Added' : 'Extracted';
  return `${kind} under “${await remTitle(plugin, parent)}”${bookmarkNote}`;
}

async function runBookmark(plugin: ReactRNPlugin, job: LogosJob): Promise<string> {
  if (!job.link) throw new BridgeError('No Logos position to save.');
  const { target, incRem, problem } = await resolveTarget(plugin);
  const start = incRem ?? target;
  if (!start) throw new BridgeError(problem ?? 'Nowhere to save the bookmark.');
  const host = await bookmarkHost(plugin, start);
  await writeBookmark(plugin, host, job.link, job.label || 'Logos');
  return `Bookmark saved on “${await remTitle(plugin, host)}”`;
}

/**
 * The top-level "Logos" Rem the book IncRems are tagged with, and its
 * "Resource ID" property — both created on first use.
 */
async function logosTag(plugin: ReactRNPlugin): Promise<{ tag: PluginRem; resourceProperty: PluginRem }> {
  let tag = await plugin.rem.findByName([LOGOS_TAG_NAME], null);
  if (!tag) {
    tag = await plugin.rem.createRem();
    if (!tag) throw new BridgeError('RemNote refused to create the Logos tag.');
    await tag.setText([LOGOS_TAG_NAME]);
  }
  for (const child of await tag.getChildrenRem()) {
    if (
      (await safeRemTextToString(plugin, child.text)).trim() === LOGOS_RESOURCE_PROPERTY_NAME &&
      (await child.isProperty())
    ) {
      return { tag, resourceProperty: child };
    }
  }
  const resourceProperty = await plugin.rem.createRem();
  if (!resourceProperty) throw new BridgeError('RemNote refused to create the Resource ID property.');
  await resourceProperty.setText([LOGOS_RESOURCE_PROPERTY_NAME]);
  await resourceProperty.setParent(tag);
  await resourceProperty.setIsProperty(true);
  return { tag, resourceProperty };
}

/**
 * The book's IncRem already in this KB, if any: matched on the Resource ID
 * property, or — for books imported before it existed — on the title, which
 * then gets the id written in so the next lookup is by key.
 */
async function findExistingBook(
  plugin: ReactRNPlugin,
  resourceId: string | undefined,
  title: string
): Promise<PluginRem | undefined> {
  const { tag, resourceProperty } = await logosTag(plugin);
  let byTitle: PluginRem | undefined;
  for (const tagged of await tag.taggedRem()) {
    const stored = (await safeRemTextToString(plugin, await tagged.getTagPropertyValue(resourceProperty._id))).trim();
    if (resourceId && stored === resourceId) return tagged;
    const hasKey = stored !== '' && stored !== 'Untitled';
    if (!hasKey && !byTitle && (await safeRemTextToString(plugin, tagged.text)).trim() === title) byTitle = tagged;
  }
  if (byTitle && resourceId) await byTitle.setTagPropertyValue(resourceProperty._id, [resourceId]);
  return byTitle;
}

/** Asked by the helper before its ⌃⌥N panel: a book already imported is opened instead. */
async function lookupBook(plugin: ReactRNPlugin, job: LogosJob) {
  const title = job.title?.trim();
  if (!title) return {};
  const existing = await findExistingBook(plugin, job.resourceId, title);
  if (!existing) return {};
  await plugin.window.openRem(existing);
  return { existingBookId: existing._id, existingBookTitle: await remTitle(plugin, existing) };
}

async function runNewBook(plugin: ReactRNPlugin, job: LogosJob): Promise<string> {
  const title = job.title?.trim();
  if (!title || !job.link) throw new BridgeError('Logos did not say which book is open.');

  // Checked again here: a ⌃⌥N queued while RemNote was offline skipped the lookup.
  const existing = await findExistingBook(plugin, job.resourceId, title);
  if (existing) {
    await plugin.window.openRem(existing);
    return `“${await remTitle(plugin, existing)}” is already in your RemNote KB — opened it`;
  }

  const { tag, resourceProperty } = await logosTag(plugin);
  const rem = await plugin.rem.createRem(); // no parent: top level
  if (!rem) throw new BridgeError('RemNote refused to create a Rem.');
  await rem.setText([title]);
  await rem.setIsDocument(true);
  await rem.addTag(tag);
  if (job.resourceId) await rem.setTagPropertyValue(resourceProperty._id, [job.resourceId]);
  await initIncrementalRem(plugin, rem, { skipInitialCascade: true });
  const priority = job.priority ?? ((await getIESetting(plugin, defaultPriorityId)) || 10);
  const interval = job.interval ?? (await defaultInterval(plugin));
  await waitForBatchSaveIdle(plugin);
  await plugin.storage.setSession(pendingIntervalBatchSaveKey, {
    remIds: [rem._id],
    priority,
    interval,
    foldRemIds: [rem._id],
  });
  await writeBookmark(plugin, rem, job.link, job.label || title);
  // Opened here; the helper brings RemNote to the front once this job reports back.
  await plugin.window.openRem(rem);
  return `Created “${title}” (#${LOGOS_TAG_NAME}, priority ${priority})`;
}

async function findBookmarkChild(plugin: ReactRNPlugin, host: PluginRem): Promise<PluginRem | undefined> {
  for (const child of await host.getChildrenRem()) {
    const text = await safeRemTextToString(plugin, child.text);
    if (text.startsWith(LOGOS_BOOKMARK_PREFIX.trim())) return child;
  }
  return undefined;
}

/** The bookmark is a visible first child: "📍 Logos: <book, p. N> · <date>". */
async function writeBookmark(plugin: ReactRNPlugin, host: PluginRem, link: string, label: string) {
  const text = [
    LOGOS_BOOKMARK_PREFIX,
    await logosLinkText(plugin, link, label),
    ` · ${new Date().toLocaleDateString()}`,
  ] as RichTextInterface;
  const existing = await findBookmarkChild(plugin, host);
  if (existing) {
    await existing.setText(text);
    return;
  }
  const rem = await plugin.rem.createRem();
  if (!rem) throw new BridgeError('RemNote refused to create the bookmark Rem.');
  await rem.setText(text);
  await rem.setParent(host, 0);
}

// --- Open in Logos -----------------------------------------------------------

/** URLs of the Link Rems a Rem's text points at (inline links and references). */
async function linkUrlsIn(plugin: ReactRNPlugin, rem: PluginRem): Promise<string[]> {
  const ids = (rem.text ?? [])
    .map((el: any) => (typeof el === 'object' ? el.qId ?? (el.i === 'q' ? el._id : undefined) : undefined))
    .filter(Boolean) as string[];
  const urls: string[] = [];
  for (const id of ids) {
    const linked = await plugin.rem.findOne(id);
    if (!linked || !(await linked.hasPowerup(BuiltInPowerupCodes.Link))) continue;
    const url = await linked.getPowerupProperty(BuiltInPowerupCodes.Link, 'URL');
    if (typeof url === 'string') urls.push(url);
  }
  return urls;
}

/**
 * Opens the nearest Logos location: walking up from the focused Rem (or the
 * IncRem under review), a Rem's Logos bookmark wins over the link in its own
 * text, so a book IncRem resumes where reading stopped and an extract opens at
 * its passage.
 *
 * `silent` (automatic opening): no toasts, and a shorter walk up, since it runs
 * for every IncRem that comes up and most have nothing to do with Logos.
 */
export async function openInLogos(
  plugin: ReactRNPlugin,
  options: { startRemId?: string; silent?: boolean } = {}
) {
  let current: PluginRem | undefined;
  if (options.startRemId) {
    current = await plugin.rem.findOne(options.startRemId);
  } else {
    const { target, incRem } = await resolveTarget(plugin);
    current = target ?? incRem;
  }
  const maxDepth = options.silent ? 10 : 50;
  let url: string | undefined;
  for (let depth = 0; current && !url && depth < maxDepth; depth++) {
    const bookmark = await findBookmarkChild(plugin, current);
    const candidates = [
      ...(bookmark ? await linkUrlsIn(plugin, bookmark) : []),
      ...(await linkUrlsIn(plugin, current)),
    ];
    url = candidates.find(isLogosLink);
    current = current.parent ? await plugin.rem.findOne(current.parent) : undefined;
  }
  if (!url) {
    if (!options.silent) await plugin.app.toast('No Logos link or bookmark here or above.');
    return;
  }
  try {
    const res = await postJSON('/open', { url });
    if (!res.ok) throw new Error(`helper answered ${res.status}`);
  } catch (err) {
    console.warn(`${LOG} open failed:`, err);
    if (!options.silent) {
      await plugin.app.toast('The Logos bridge helper is not running (scripts/logos_bridge/build.sh).');
    }
  }
}
