import { AppEvents, ReactRNPlugin } from '@remnote/plugin-sdk';
import { openSourcesByWindowKey } from './consts';
import { sourceViews } from './pdf_source_pins';

/**
 * Sources (PDFs, web articles) open in the OTHER RemNote windows.
 *
 * Each desktop window is its own renderer with its own copy of the plugin, and
 * `window.getOpenPaneRemIds()` answers for that window alone — nothing in the SDK
 * reaches across. What the windows do share is the local store: a `setLocal` in
 * one is relayed to the others (`upsertDocsFromOtherWindow` in the app bundle).
 * So every window publishes the sources in its panes under one local key, and a
 * command that finds none in its own window reads the others' from there.
 *
 * A closed window cannot say goodbye (the iframe is torn down mid-write), so a
 * window holding sources re-publishes on a heartbeat and entries older than the
 * TTL are dropped by whoever writes or reads next.
 */

const HEARTBEAT_MS = 60_000;
const TTL_MS = 150_000;

interface WindowSources {
  sources: string[];
  at: number;
}
type SourcesByWindow = Record<string, WindowSources>;

// One per plugin instance, hence one per window.
const WINDOW_ID = Math.random().toString(36).slice(2, 10);

const readAll = async (plugin: ReactRNPlugin): Promise<SourcesByWindow> => {
  const raw = await plugin.storage.getLocal<SourcesByWindow>(openSourcesByWindowKey).catch(() => undefined);
  const now = Date.now();
  const fresh: SourcesByWindow = {};
  for (const [id, entry] of Object.entries(raw ?? {})) {
    if (Array.isArray(entry?.sources) && now - entry.at < TTL_MS) fresh[id] = entry;
  }
  return fresh;
};

async function publishOpenSources(plugin: ReactRNPlugin) {
  const sources: string[] = [];
  for (const id of await plugin.window.getOpenPaneRemIds()) {
    const rem = await plugin.rem.findOne(id);
    if (rem && (await sourceViews(rem)).length) sources.push(id);
  }
  const all = await readAll(plugin);
  // A window that holds no source and has no entry to clear stays silent.
  if (!sources.length && !all[WINDOW_ID]) return;
  if (sources.length) all[WINDOW_ID] = { sources, at: Date.now() };
  else delete all[WINDOW_ID];
  await plugin.storage.setLocal(openSourcesByWindowKey, all);
}

/** Source Rem ids open in other windows, the most recently published window first. */
export async function sourcesInOtherWindows(plugin: ReactRNPlugin): Promise<string[]> {
  const all = await readAll(plugin);
  const others = Object.entries(all)
    .filter(([id]) => id !== WINDOW_ID)
    .sort(([, a], [, b]) => b.at - a.at);
  return [...new Set(others.flatMap(([, entry]) => entry.sources))];
}

export function registerWindowSourcesPresence(plugin: ReactRNPlugin) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const publish = () =>
    publishOpenSources(plugin).catch((e) => console.warn('[WindowSources] publish failed', e));
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(publish, 400);
  };
  plugin.event.addListener(AppEvents.URLChange, undefined, schedule);
  plugin.event.addListener(AppEvents.CurrentWindowTreeChange, undefined, schedule);
  setInterval(publish, HEARTBEAT_MS);
  schedule();
}
