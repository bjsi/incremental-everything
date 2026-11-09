/**
 * Local Media Bridge — the RemNote half (helper: scripts/media_bridge/media_bridge.py).
 *
 * Why: since RemNote 1.29 the desktop window is sandboxed (webSecurity on), so a
 * rem written from outside the app with `![](file:///…)` — the RemNote MCP's way
 * of inserting a local image — is never uploaded: the renderer can no longer read
 * the file and the image shows "Unable to find this image". http(s) URLs still
 * work, because RemNote's main process fetches them, but only when the image is
 * stored through one of the importer's side doors (see localize_media.ts).
 *
 * So an outside tool serves the image from the helper on 127.0.0.1:3460, writes
 * the rem with that URL, and queues a job naming the rem. This loop long-polls
 * the helper for those jobs and runs `localizeMediaInRems` on the named rems, the
 * same routine as the "Store linked images & audio in RemNote" command: the URL
 * becomes a stored %LOCAL_FILE% copy and the rem stops depending on the helper.
 *
 * The same channel carries the rem operations the RemNote MCP lacks (move,
 * untag, get-image, incrementalize), run by lib/media_bridge_ops.ts. The poll
 * sends `v=2` so the helper knows this build understands them; an older build
 * gets localize jobs only.
 *
 * The plugin cannot be called from outside its iframe, hence the polling, as in
 * the Logos bridge. Off unless the "Local Media Bridge" setting is on, so nobody
 * without the helper gets a localhost probe.
 */
import { PluginRem, ReactRNPlugin } from '@remnote/plugin-sdk';
import { mediaBridgeEnabledId } from './consts';
import { collectExternalMedia, localizeMediaInRems } from './localize_media';
import { runBridgeOp } from './media_bridge_ops';
import { getIESetting } from './settings';

export const MEDIA_BRIDGE_URL = 'http://127.0.0.1:3460';
const POLL_WAIT_S = 25;
/** The bridge protocol this build speaks; see OPS_BY_PLUGIN_VERSION in media_bridge.py. */
const PROTOCOL_VERSION = 2;
const RETRY_MS = 30_000;
/**
 * A rem written through the MCP reaches this client by sync, a moment after the
 * job is queued. Wait this long for every named rem to show an external image
 * before localizing whatever has arrived.
 */
const SYNC_WAIT_MS = 30_000;
const SYNC_POLL_MS = 1_000;
const LOG = '[MediaBridge]';

interface MediaJob {
  id: string;
  /** Absent from an older helper: localize. */
  op?: string;
  remIds: string[];
  [arg: string]: unknown;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const postJSON = (path: string, body: unknown) =>
  fetch(`${MEDIA_BRIDGE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const hasExternalMedia = (rem: PluginRem) =>
  collectExternalMedia(rem.text).length > 0 || collectExternalMedia(rem.backText).length > 0;

let loopGeneration = 0;

/** Starts or stops the poll loop as the setting changes. Call once from the index widget. */
export function registerMediaBridge(plugin: ReactRNPlugin) {
  let running = false;
  plugin.track(async (rp) => {
    const enabled = await getIESetting(rp, mediaBridgeEnabledId);
    const generation = ++loopGeneration;
    if (enabled) {
      console.log(`${LOG} on — polling ${MEDIA_BRIDGE_URL} for jobs`);
      running = true;
      void pollLoop(plugin, generation);
    } else if (running) {
      console.log(`${LOG} off — stopped polling`);
      running = false;
    }
  });
}

async function pollLoop(plugin: ReactRNPlugin, generation: number) {
  let connected = false;
  let reportedUnreachable = false;
  while (generation === loopGeneration) {
    let res: Response;
    try {
      res = await fetch(`${MEDIA_BRIDGE_URL}/next?wait=${POLL_WAIT_S}&v=${PROTOCOL_VERSION}`);
    } catch (err) {
      if (connected) console.log(`${LOG} helper went away; retrying every ${RETRY_MS / 1000}s`);
      else if (!reportedUnreachable)
        console.log(
          `${LOG} helper not reachable at ${MEDIA_BRIDGE_URL} (start it with ` +
            `scripts/media_bridge/media_bridge.py start); retrying every ${RETRY_MS / 1000}s`,
          err
        );
      reportedUnreachable = true;
      connected = false;
      await sleep(RETRY_MS);
      continue;
    }
    if (!connected) console.log(`${LOG} connected to ${MEDIA_BRIDGE_URL}`);
    connected = true;

    if (res.status === 204) continue;
    if (res.status !== 200) {
      console.warn(`${LOG} /next answered ${res.status}`);
      await sleep(RETRY_MS);
      continue;
    }
    let job: MediaJob;
    try {
      job = await res.json();
    } catch {
      continue;
    }
    // A job taken by a loop that was switched off is redelivered by the helper.
    if (generation !== loopGeneration) break;
    if (!job.op || job.op === 'localize') await handleJob(plugin, job);
    else await handleOpJob(plugin, job as MediaJob & { op: string });
  }
}

/** The named rems, re-read until each shows an external image or the wait runs out. */
async function waitForRems(plugin: ReactRNPlugin, remIds: string[]) {
  const deadline = Date.now() + SYNC_WAIT_MS;
  for (;;) {
    const found = (await plugin.rem.findMany(remIds)) ?? [];
    const ready = found.length === remIds.length && found.every(hasExternalMedia);
    if (ready || Date.now() >= deadline) return found;
    await sleep(SYNC_POLL_MS);
  }
}

/** The named rems, re-read until all exist (a rem written through the MCP arrives by sync) or the wait runs out. */
async function waitForRemsToExist(plugin: ReactRNPlugin, remIds: string[]) {
  const deadline = Date.now() + SYNC_WAIT_MS;
  for (;;) {
    const found = (await plugin.rem.findMany(remIds)) ?? [];
    if (found.length === new Set(remIds).size || Date.now() >= deadline) return;
    await sleep(SYNC_POLL_MS);
  }
}

/** Ops whose result is only read back: no toast for them. */
const QUIET_OPS = new Set(['get-image']);

async function handleOpJob(plugin: ReactRNPlugin, job: MediaJob & { op: string }) {
  console.log(`${LOG} job ${job.id} received: ${job.op} on ${job.remIds.length} rem(s)`, job);
  const ids = [...job.remIds];
  if (typeof job.parentId === 'string') ids.push(job.parentId);
  await waitForRemsToExist(plugin, ids);
  const result = await runBridgeOp(plugin, { ...job, op: job.op, remIds: job.remIds });
  console.log(`${LOG} job ${job.id} ${job.op}: ${result.summary}`, result);
  if (!QUIET_OPS.has(job.op) || !result.ok) {
    await plugin.app.toast(`Local Media Bridge: ${result.summary}`).catch(() => undefined);
  }
  await postJSON('/result', { jobId: job.id, op: job.op, ...result }).catch((err) =>
    console.error(`${LOG} job ${job.id}: could not post the result`, err)
  );
}

async function handleJob(plugin: ReactRNPlugin, job: MediaJob) {
  console.log(`${LOG} job ${job.id} received: ${job.remIds.length} rem(s)`, job.remIds);
  try {
    const remIds = [...new Set(job.remIds)];
    const rems = await waitForRems(plugin, remIds);
    const foundIds = new Set(rems.map((rem) => rem._id));
    const missing = remIds.filter((id) => !foundIds.has(id));
    const withoutMedia = rems.filter((rem) => !hasExternalMedia(rem)).map((rem) => rem._id);
    const result = await localizeMediaInRems(plugin, rems);
    const { localized, updatedRems, failed } = result;
    const problems = failed.length + missing.length;
    console.log(
      `${LOG} job ${job.id} done: ${localized} file(s) stored in RemNote, ${updatedRems} rem(s) updated, ` +
        `${failed.length} failed, ${missing.length} rem(s) not found`,
      { ...result, missing, withoutMedia }
    );
    // One toast per job, at the end: RemNote drops toasts fired in quick succession.
    await plugin.app.toast(
      `Local Media Bridge: stored ${localized} image${localized === 1 ? '' : 's'} in RemNote ` +
        `(${updatedRems} rem${updatedRems === 1 ? '' : 's'} updated)` +
        (problems ? ` — ${problems} problem${problems === 1 ? '' : 's'}, see the console` : '.')
    );
    await postJSON('/result', { jobId: job.id, ok: true, ...result, missing, withoutMedia });
  } catch (err) {
    console.error(`${LOG} job ${job.id} failed:`, err);
    await plugin.app.toast(`Local Media Bridge: job failed — ${String(err)}`).catch(() => undefined);
    await postJSON('/result', { jobId: job.id, ok: false, message: String(err) }).catch(() => undefined);
  }
}
