import { ReactRNPlugin, RemId, RNPlugin } from '@remnote/plugin-sdk';
import dayjs from 'dayjs';
import { initIncrementalRem } from './incremental_rem';
import { incRemCacheReloadKey, localVideoPowerupCode } from './consts';
import { LocalVideoFile, readLocalVideo, setLocalVideo, VideoFolder } from './local_video';

/**
 * Bulk import of a folder of local videos: a document named after the folder,
 * one Rem per subfolder and one Incremental Rem per video, in natural file
 * order. Videos already in RemNote (same library and path) are skipped, so
 * importing a folder again adds only what's new in it.
 */

export interface LocalVideoImportOptions {
  library: string;
  tree: VideoFolder;
  /** Where the folder's document goes; top level when unset. */
  parentId?: RemId;
  makeIncremental: boolean;
  priority: number;
  /** 0: all due today; N: the first today, then one more every N days, in file order. */
  spreadDays: number;
}

export interface LocalVideoImportProgress {
  stage: 'checking' | 'creating' | 'scheduling';
  done: number;
  total: number;
}

const keyOf = (f: LocalVideoFile) => `${f.library}\n${f.path}`;

/** How many videos the tree holds. */
export const countVideos = (folder: VideoFolder): number =>
  folder.videos.length + folder.folders.reduce((n, f) => n + countVideos(f), 0);

/** Library + path of every local video Rem already in the knowledge base. */
export async function existingLocalVideos(plugin: RNPlugin): Promise<Set<string>> {
  const powerup = await plugin.powerup.getPowerupByCode(localVideoPowerupCode);
  const rems = (await powerup?.taggedRem()) ?? [];
  const keys = new Set<string>();
  for (const rem of rems) {
    const file = await readLocalVideo(rem);
    if (file) keys.add(keyOf(file));
  }
  return keys;
}

/** Videos of the tree not in RemNote yet, in import order. */
export function newVideosInOrder(library: string, folder: VideoFolder, existing: Set<string>): LocalVideoFile[] {
  return [
    ...folder.videos.map((v) => ({ library, path: v.path })).filter((f) => !existing.has(keyOf(f))),
    ...folder.folders.flatMap((sub) => newVideosInOrder(library, sub, existing)),
  ];
}

async function createChild(plugin: ReactRNPlugin, parentId: RemId | undefined, text: string, document: boolean) {
  const rem = await plugin.rem.createRem();
  if (!rem) throw new Error('Could not create a Rem.');
  await rem.setText([text]);
  if (parentId) await rem.setParent(parentId);
  if (document) await rem.setIsDocument(true);
  return rem;
}

export async function importLocalVideos(
  plugin: ReactRNPlugin,
  options: LocalVideoImportOptions,
  onProgress?: (p: LocalVideoImportProgress) => void
): Promise<{ documentId: RemId; created: number; skipped: number }> {
  const { library, tree } = options;
  onProgress?.({ stage: 'checking', done: 0, total: 0 });
  const existing = await existingLocalVideos(plugin);
  const total = countVideos(tree);
  const wanted = new Set(newVideosInOrder(library, tree, existing).map(keyOf));

  // The Rems first, one at a time, so each lands after the one before it.
  const created: { remId: RemId; order: number }[] = [];
  const build = async (folder: VideoFolder, parentId: RemId | undefined): Promise<RemId> => {
    const folderRem = await createChild(plugin, parentId, folder.name, true);
    for (const video of folder.videos) {
      const file = { library, path: video.path };
      if (!wanted.has(keyOf(file))) continue;
      const rem = await createChild(plugin, folderRem._id, video.name, false);
      await setLocalVideo(rem, file);
      created.push({ remId: rem._id, order: created.length });
      onProgress?.({ stage: 'creating', done: created.length, total: wanted.size });
    }
    for (const sub of folder.folders) {
      // A subfolder with nothing new stays out.
      if (newVideosInOrder(library, sub, existing).length) await build(sub, folderRem._id);
    }
    return folderRem._id;
  };
  const documentId = await build(tree, options.parentId);

  // Then the Incremental powerup, a few at a time: each one is many writes.
  if (options.makeIncremental && created.length) {
    await plugin.storage.setSession('plugin_operation_active', true);
    try {
      let done = 0;
      const today = dayjs().startOf('day');
      const queue = [...created];
      const worker = async () => {
        for (let item = queue.shift(); item; item = queue.shift()) {
          const rem = await plugin.rem.findOne(item.remId);
          if (rem) {
            await initIncrementalRem(plugin, rem, {
              skipFlagManagement: true,
              skipInitialCascade: true,
              deferCacheUpdate: true,
              recordCreation: false,
              priority: options.priority,
              nextRepDate: today.add(item.order * options.spreadDays, 'day').toDate(),
            });
          }
          onProgress?.({ stage: 'scheduling', done: ++done, total: created.length });
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
    } finally {
      await plugin.storage.setSession('plugin_operation_active', false);
      // One reload of the IncRem cache for the lot, instead of one write each.
      await plugin.storage.setSession(incRemCacheReloadKey, Date.now());
    }
  }

  return { documentId, created: created.length, skipped: total - created.length };
}
