// Warns before a Rem becomes Incremental when another Incremental or Dismissed
// Rem already has the same web page as a source.
//
// WHY THE PLUGIN KEEPS ITS OWN INDEX
//
// A page's URL lives only on its Link Rem, and the Rems reading that page point
// at the Link Rem from their Sources slot. RemNote can follow that slot backwards
// (documentsThisIsASourceOf), but the plugin bridge does not expose it, and
// remsReferencingThis reads key and value references only. So the plugin records
// page → Rems itself, in one synced key. Details in
// findings/REM_REFERENCES_AND_MERGE.md.
//
// HOW THE INDEX STAYS TRUE
//
// A Rem joins when it passes the check below, or through "Paste Sources". A scan
// at most once a week catches the rest: Rems made Incremental before this existed,
// or given a source through RemNote's own UI. Dismissal needs no update, since the
// Rem keeps its source and the index covers both powerups. An entry can go stale,
// so every match is re-read from the Rem before it is shown.

import { BuiltInPowerupCodes, PluginRem, RNPlugin } from '@remnote/plugin-sdk';
import {
  dismissedPowerupCode,
  duplicateSourceDecisionKey,
  powerupCode,
  sourceUrlIndexKey,
  sourceUrlIndexScannedAtKey,
} from '../consts';
import {
  DuplicateChoice,
  DuplicateDecision,
  DuplicateGroup,
  groupByDomain,
  indexAfterScan,
  mergedIndex,
  remsToKeep,
  SourceMatch,
  SourceUrlIndex,
  TrackedSite,
  unscannedRemIds,
  withoutEntries,
  withRemUnderKeys,
} from './rules';
import { canonicalUrlKey, domainOfPageKey } from './url_key';

export const DUPLICATE_SOURCE_POPUP = 'duplicate_source_popup';
export const SOURCE_SITES_POPUP = 'source_sites_popup';

const POLL_MS = 200;
/** Only ends the wait for a popup closed by clicking outside, which reports nothing. */
const DECISION_TIMEOUT_MS = 15 * 60 * 1000;

const SCAN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/** Each Rem costs at least two bridge calls, so the scan stays well away from saturating it. */
const SCAN_BATCH_SIZE = 20;
const SCAN_PAUSE_MS = 200;
/** A first scan interrupted by quitting RemNote still leaves most of its work behind. */
const SCAN_SAVE_EVERY = 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface PageUrl {
  key: string;
  url: string;
}

async function readIndex(plugin: RNPlugin): Promise<SourceUrlIndex> {
  return (await plugin.storage.getSynced<SourceUrlIndex>(sourceUrlIndexKey)) ?? {};
}

let indexLock: Promise<unknown> = Promise.resolve();

/** Index writes are read-then-write. This serializes them within the index widget, where all of them run. */
function update(plugin: RNPlugin, change: (index: SourceUrlIndex) => SourceUrlIndex | Promise<SourceUrlIndex>) {
  const run = indexLock.then(async () => {
    const current = await readIndex(plugin);
    const next = await change(current);
    if (next !== current) await plugin.storage.setSynced(sourceUrlIndexKey, next);
  });
  indexLock = run.catch((err) => console.error('[DuplicateSource] Index update failed', err));
  return run;
}

/** The web pages a Rem has as sources, plus its own URL if it is itself a Link Rem. */
async function readPageUrls(rem: PluginRem): Promise<PageUrl[]> {
  const sources = await rem.getSources();
  const urls = await Promise.all(
    [rem, ...sources].map(async (candidate) => {
      if (!(await candidate.hasPowerup(BuiltInPowerupCodes.Link))) return undefined;
      return candidate.getPowerupProperty(BuiltInPowerupCodes.Link, 'URL');
    })
  );
  const pages = new Map<string, PageUrl>();
  for (const url of urls) {
    const key = canonicalUrlKey(url);
    if (key && !pages.has(key)) pages.set(key, { key, url: url as string });
  }
  return [...pages.values()];
}

async function remName(plugin: RNPlugin, rem: PluginRem): Promise<string> {
  const text = rem.text ? await plugin.richText.toString(rem.text) : '';
  return text.trim() || 'Untitled Rem';
}

/** What an index entry looks like right now, or null if the Rem no longer qualifies. */
async function readMatch(plugin: RNPlugin, remId: string, key: string): Promise<SourceMatch | null> {
  const rem = await plugin.rem.findOne(remId);
  if (!rem) return null;
  const [isIncremental, isDismissed] = await Promise.all([
    rem.hasPowerup(powerupCode),
    rem.hasPowerup(dismissedPowerupCode),
  ]);
  if (!isIncremental && !isDismissed) return null;
  const page = (await readPageUrls(rem)).find((candidate) => candidate.key === key);
  if (!page) return null;
  return {
    remId,
    name: await remName(plugin, rem),
    status: isIncremental ? 'incremental' : 'dismissed',
    url: page.url,
  };
}

async function findDuplicates(plugin: RNPlugin, rems: Array<{ rem: PluginRem; pages: PageUrl[] }>) {
  const index = await readIndex(plugin);
  const groups: DuplicateGroup[] = [];
  const stale: Array<{ key: string; remId: string }> = [];

  for (const { rem, pages } of rems) {
    const matches = new Map<string, SourceMatch>();
    let url = pages[0].url;
    for (const page of pages) {
      for (const remId of index[page.key] ?? []) {
        if (remId === rem._id || matches.has(remId)) continue;
        const match = await readMatch(plugin, remId, page.key);
        if (match) {
          if (!matches.size) url = page.url;
          matches.set(remId, match);
        } else {
          stale.push({ key: page.key, remId });
        }
      }
    }
    if (matches.size) {
      groups.push({ remId: rem._id, name: await remName(plugin, rem), url, matches: [...matches.values()] });
    }
  }
  return { groups, stale };
}

let latestRequestId: string | undefined;

/** The user's answer, or null if the popup went away unanswered or a newer request replaced it. */
async function waitForChoice(plugin: RNPlugin, requestId: string): Promise<DuplicateChoice | null> {
  const deadline = Date.now() + DECISION_TIMEOUT_MS;
  while (Date.now() < deadline && latestRequestId === requestId) {
    await sleep(POLL_MS);
    const decision = await plugin.storage.getSession<DuplicateDecision | null>(duplicateSourceDecisionKey);
    if (decision?.requestId === requestId) return decision.choice;
  }
  return null;
}

/**
 * Call before making Rems Incremental. Returns the Rems to go ahead with: all of
 * them when nothing is duplicated, otherwise what the user decides. An empty list
 * means stop. A Rem that is already Incremental is passed through unchecked, and a
 * failure here never stands in the way of making a Rem Incremental.
 *
 * Must run in the index widget. It waits for the popup, so a popup's iframe could
 * be torn down under it.
 */
export async function confirmNoDuplicateSource<T extends PluginRem>(plugin: RNPlugin, rems: T[]): Promise<T[]> {
  try {
    const candidates = (
      await Promise.all(
        rems.map(async (rem) => {
          if (await rem.hasPowerup(powerupCode)) return null;
          const pages = await readPageUrls(rem);
          return pages.length ? { rem, pages } : null;
        })
      )
    ).filter((candidate): candidate is { rem: T; pages: PageUrl[] } => candidate !== null);
    if (!candidates.length) return rems;

    const { groups, stale } = await findDuplicates(plugin, candidates);
    if (stale.length) void update(plugin, (index) => withoutEntries(index, stale)).catch(() => {});

    let kept = rems;
    if (groups.length) {
      const requestId = `${Date.now()}-${Math.random()}`;
      latestRequestId = requestId;
      await plugin.storage.setSession(duplicateSourceDecisionKey, null);
      await plugin.widget.openPopup(DUPLICATE_SOURCE_POPUP, { requestId, groups, total: rems.length });
      const choice = await waitForChoice(plugin, requestId);
      // Only an answer closes the popup: otherwise the one on screen may not be this one.
      if (choice) await plugin.widget.closePopup();
      if (choice?.kind === 'open') {
        const target = await plugin.rem.findOne(choice.remId);
        if (target) await plugin.window.openRem(target);
      }
      kept = remsToKeep(rems, groups, choice ?? { kind: 'cancel' });
    }

    const keptIds = new Set(kept.map((rem) => rem._id));
    const toRegister = candidates.filter(({ rem }) => keptIds.has(rem._id));
    if (toRegister.length) {
      void update(plugin, (index) =>
        toRegister.reduce(
          (next, { rem, pages }) => withRemUnderKeys(next, pages.map((page) => page.key), rem._id),
          index
        )
      ).catch(() => {});
    }
    return kept;
  } catch (err) {
    console.error('[DuplicateSource] Check failed; carrying on without it', err);
    return rems;
  }
}

/** For a Rem that just gained a source: records it if it is Incremental or Dismissed. */
export async function registerRemPagesIfTracked(plugin: RNPlugin, rem: PluginRem): Promise<void> {
  try {
    const [isIncremental, isDismissed] = await Promise.all([
      rem.hasPowerup(powerupCode),
      rem.hasPowerup(dismissedPowerupCode),
    ]);
    if (!isIncremental && !isDismissed) return;
    const keys = (await readPageUrls(rem)).map((page) => page.key);
    if (keys.length) await update(plugin, (index) => withRemUnderKeys(index, keys, rem._id));
  } catch (err) {
    console.error('[DuplicateSource] Could not record a new source', err);
  }
}

/**
 * Rebuilds the index from every Incremental and Dismissed Rem, unless a device
 * did so within the last week. Read-only on the Rems, and slow by design.
 */
export async function refreshSourceUrlIndexIfDue(plugin: RNPlugin): Promise<void> {
  const scannedAt = await plugin.storage.getSynced<number>(sourceUrlIndexScannedAtKey);
  if (scannedAt && Date.now() - scannedAt < SCAN_INTERVAL_MS) return;

  const startedAt = Date.now();
  const [incremental, dismissed] = await Promise.all([
    plugin.powerup.getPowerupByCode(powerupCode),
    plugin.powerup.getPowerupByCode(dismissedPowerupCode),
  ]);
  const [incrementalRems, dismissedRems] = await Promise.all([
    incremental?.taggedRem() ?? Promise.resolve([]),
    dismissed?.taggedRem() ?? Promise.resolve([]),
  ]);
  const rems = [...new Map([...incrementalRems, ...dismissedRems].map((rem) => [rem._id, rem])).values()];

  let scanned: SourceUrlIndex = {};
  const scannedRemIds = new Set<string>();
  let lastSave = 0;

  for (let i = 0; i < rems.length; i += SCAN_BATCH_SIZE) {
    await Promise.all(
      rems.slice(i, i + SCAN_BATCH_SIZE).map(async (rem) => {
        try {
          const pages = await readPageUrls(rem);
          scanned = withRemUnderKeys(scanned, pages.map((page) => page.key), rem._id);
          scannedRemIds.add(rem._id);
        } catch {
          // Left out of scannedRemIds, so its existing entries survive this scan.
        }
      })
    );
    if (scannedRemIds.size - lastSave >= SCAN_SAVE_EVERY) {
      lastSave = scannedRemIds.size;
      const soFar = scanned;
      await update(plugin, (index) => mergedIndex(index, soFar));
    }
    await sleep(SCAN_PAUSE_MS);
  }

  await update(plugin, async (index) => {
    const survivors = new Set<string>();
    for (const remId of unscannedRemIds(index, scannedRemIds)) {
      const rem = await plugin.rem.findOne(remId);
      if (rem && ((await rem.hasPowerup(powerupCode)) || (await rem.hasPowerup(dismissedPowerupCode)))) {
        survivors.add(remId);
      }
    }
    return indexAfterScan(index, scanned, scannedRemIds, survivors);
  });
  await plugin.storage.setSynced(sourceUrlIndexScannedAtKey, Date.now());
  console.log(
    `[DuplicateSource] Scanned ${rems.length} Rems in ${Math.round((Date.now() - startedAt) / 1000)}s: ` +
      `${Object.keys(scanned).length} web pages.`
  );
}

/**
 * Every website in the index and the Incremental and Dismissed Rems reading it.
 * Entries are re-read, so a stale one is left out; removing it is left to the
 * weekly scan, as this runs in a popup that can be closed at any moment.
 */
export async function loadTrackedSites(plugin: RNPlugin): Promise<{ sites: TrackedSite[]; scanned: boolean }> {
  const [index, scannedAt] = await Promise.all([
    readIndex(plugin),
    plugin.storage.getSynced<number>(sourceUrlIndexScannedAtKey),
  ]);
  const pairs = Object.entries(index).flatMap(([key, remIds]) => remIds.map((remId) => ({ key, remId })));
  const entries: Array<{ domain: string; match: SourceMatch }> = [];
  for (let i = 0; i < pairs.length; i += SCAN_BATCH_SIZE) {
    const matches = await Promise.all(
      pairs.slice(i, i + SCAN_BATCH_SIZE).map(async ({ key, remId }) => {
        const match = await readMatch(plugin, remId, key).catch(() => null);
        return match ? { domain: domainOfPageKey(key), match } : null;
      })
    );
    for (const entry of matches) if (entry) entries.push(entry);
  }
  return { sites: groupByDomain(entries), scanned: !!scannedAt };
}

/**
 * The website of a Rem or its nearest ancestor with a web source, so an extract
 * inside a clipped article leads to that article's website.
 */
export async function websiteOfRem(plugin: RNPlugin, start: PluginRem | undefined): Promise<string | undefined> {
  let rem = start;
  for (let depth = 0; rem && depth < 12; depth++) {
    const [page] = await readPageUrls(rem);
    if (page) return domainOfPageKey(page.key);
    rem = rem.parent ? await plugin.rem.findOne(rem.parent) : undefined;
  }
  return undefined;
}
