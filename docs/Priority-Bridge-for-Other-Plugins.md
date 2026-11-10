# Priority Bridge for Other Plugins

Other RemNote plugins can work with **flashcard priorities** through a small messaging bridge, without depending on how Incremental RemNote stores them:

- **Ask** what priority a new flashcard would get at a given place in your knowledge base, so they can show it to you before creating anything.
- **Set** a flashcard's priority. Incremental RemNote applies it as a **manual** priority, exactly as if you had set it in the Priority popup.
- **Link a video** on your computer to a flashcard, shown under its answer: a [card video](Incremental-Video.md#card-video). The other plugin asks Incremental RemNote to open its folder dialog and matches the videos to its cards. Since v1.0.195.

The typical client is an **importer**: before it creates the cards, it shows you the priority each one would inherit and lets you type a different one, and it can link each question to the video that explains it.

## What you see { #what-you-see }

- Priorities set through the bridge are ordinary **manual** card priorities. They keep their value when ancestors change, show up in the Priority Queue and the Weighted Shield, and appear in the card's **Repetition History** as **Import**.
- Nothing needs to be turned on. The bridge starts with the plugin and only answers when another plugin asks.
- The bridge only works **while Incremental RemNote is running**. A well-behaved client keeps its requests and sends them again when Incremental RemNote starts (see [Delivery](#delivery)).
- With [Priorities for Flashcards](Priorities-for-Flashcards.md) turned off, inherited and default priorities are not stored on your Rems, but a priority set through the bridge still is, because it counts as a manual one.

## For plugin developers { #for-developers }

### The channel { #channel }

Plugin storage is private: RemNote stores every key under the plugin's own id, so no plugin can read another's values. What is shared is the **change event**. When a plugin writes a session key, RemNote emits `AppEvents.StorageSessionChange` under the bare key name to **every** widget listening on that key, whichever plugin wrote it.

So both sides talk by writing to their **own session storage** and listening on the other side's keys:

```ts
// request: written by the client, received by Incremental RemNote
await plugin.storage.setSession('ie-bridge.v1.priority-query', { requestId, parentIds: [parentRemId] });

// answer: written by Incremental RemNote, received by the client
plugin.event.addListener(AppEvents.StorageSessionChange, 'ie-bridge.v1.priority-answer', (value) => { /* … */ });
```

Session storage lives in memory and never syncs, so messages do not pile up or reach other devices.

!!! note "The callback's argument"
    The listener receives the written value. Some RemNote versions wrap it as `{ value }`, so unwrap it when it has no `requestId` of its own.

### Protocol v1 { #protocol }

Every request carries a `requestId` (any unique string), and every answer echoes it. Ignore answers whose `requestId` is not yours: every listener receives every answer.

| Request key (client writes) | Payload | Answer key (Incremental RemNote writes) | Answer |
|---|---|---|---|
| `ie-bridge.v1.ping` | `{ requestId }` | `ie-bridge.v1.pong` | `{ requestId, version }` |
| `ie-bridge.v1.priority-query` | `{ requestId, parentIds: (remId \| null)[] }` | `ie-bridge.v1.priority-answer` | `{ requestId, enabled, results }` |
| `ie-bridge.v1.set-priority` | `{ requestId, items: [{ remId, priority }] }` | `ie-bridge.v1.set-priority-ack` | `{ requestId, done: remId[], failed: remId[] }` |

Incremental RemNote also writes **`ie-bridge.v1.ready`** (`{ requestId, version }`) each time it starts.

`version` is **2** since v1.0.195, which added [card videos](#card-videos); the calls above are unchanged. An older Incremental RemNote answers `1` and never answers the card-video keys, so check the version before using them.

**`priority-query`**: for each parent, the priority a **new child** of it would get. The walk starts at the parent itself, so passing an existing flashcard Rem gives that Rem's own priority.

- `results` is keyed by parent id, with `''` for `null`, meaning "no parent yet".
- Each result is `{ priority, source, ancestorName? }`:
    - `source: 'incremental'` or `'card'`: inherited from the closest ancestor with an Incremental Rem priority or a manual card priority, named in `ancestorName`.
    - `source: 'default'`: nothing to inherit, so the **Default Card Priority** setting applies.
- `enabled` is the state of **Flashcard Prioritisation**.

**`set-priority`**: each item becomes a manual card priority.

- `priority` must be a whole number from 0 to 100.
- Rems that do not exist, or have invalid values, are listed in `failed`.
- Setting a priority does not cascade it to descendants. Items are meant to be the flashcard Rems themselves.

### Card videos (version 2) { #card-videos }

A [card video](Incremental-Video.md#card-video) is a video file on the user's computer, linked to a flashcard's own Rem and shown under its answer. A plugin can neither open a file dialog nor reach the local helper that plays the videos, so the folder is picked through Incremental RemNote:

| Request key (client writes) | Payload | Answer key (Incremental RemNote writes) | Answer |
|---|---|---|---|
| `ie-bridge.v1.video-folder` | `{ requestId, prompt? }` | `ie-bridge.v1.video-folder-answer` | `{ requestId, status, error?, library?, root?, path?, videos? }` |
| `ie-bridge.v1.set-card-video` | `{ requestId, items: [{ remId, library, path }] }` | `ie-bridge.v1.set-card-video-ack` | `{ requestId, done: remId[], failed: remId[] }` |

**`video-folder`** opens the helper's macOS folder dialog, with `prompt` as its message.

- `status` is `'ok'`, `'cancelled'`, or `'error'` with the reason in `error` (for example, the helper isn't running).
- With `'ok'`, `videos` lists every video under the folder, subfolders included, as `{ name, path }`. `name` is the file name without its extension, for matching; `path` is relative to the video library `library`. Pass both back unchanged.
- Only MP4, M4V, MOV and WebM files are listed.
- The user may keep the dialog open for a while: wait minutes, not seconds.

**`set-card-video`** links each item's video to the Rem, replacing any earlier one. Link it to the Rem that holds the card, such as a multiple-choice question.

- An item `{ remId, remove: true }` unlinks the Rem's video.
- A Rem that doesn't exist, or a path that isn't a video inside the library, is listed in `failed`.
- Nothing is made Incremental, and the card's priority isn't touched.

Queue unconfirmed `set-card-video` items and resend them on `ready`, as for priorities.

### Delivery { #delivery }

Events only reach running listeners, and nothing is queued for a plugin that is off:

- Treat a missing answer, after a timeout of a few seconds, as "Incremental RemNote is not running".
- Keep unconfirmed `set-priority` items in your own synced storage. Send them again when you hear `ie-bridge.v1.ready`, and drop the ones listed in the acknowledgement.
- Incremental RemNote ignores a `requestId` it has already handled, so resending is safe. A second open window may answer too; the first answer wins.
- **One request at a time per answer key.** RemNote removes a widget's listener per key, not per callback, so two requests waiting on the same answer key in one widget would cancel each other.

### A minimal client { #example }

```ts
import { AppEvents, RNPlugin } from '@remnote/plugin-sdk';

const unwrap = (raw: any) =>
  raw && typeof raw === 'object' && 'value' in raw && !('requestId' in raw) ? raw.value : raw;

function ask<T>(plugin: RNPlugin, sendKey: string, replyKey: string, payload: object, timeoutMs = 5000) {
  return new Promise<T | null>((resolve) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const onReply = (raw: any) => {
      const msg = unwrap(raw);
      if (msg?.requestId !== requestId) return;
      finish();
      resolve(msg);
    };
    const timer = setTimeout(() => (finish(), resolve(null)), timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      plugin.event.removeListener(AppEvents.StorageSessionChange, replyKey, onReply);
    };
    plugin.event.addListener(AppEvents.StorageSessionChange, replyKey, onReply);
    void plugin.storage.setSession(sendKey, { ...payload, requestId });
  });
}

// What would a new card under `parentId` inherit?
const answer = await ask<{ results: Record<string, { priority: number; source: string }> }>(
  plugin, 'ie-bridge.v1.priority-query', 'ie-bridge.v1.priority-answer', { parentIds: [parentId] }
);

// Give a card priority 20.
await ask(plugin, 'ie-bridge.v1.set-priority', 'ie-bridge.v1.set-priority-ack', {
  items: [{ remId: cardRemId, priority: 20 }],
});
```

The implementation is in [`src/lib/external_priority_bridge.ts`](https://github.com/hugomarins/incremental-remnote/blob/main/src/lib/external_priority_bridge.ts) and, for card videos, [`src/lib/external_card_video_bridge.ts`](https://github.com/hugomarins/incremental-remnote/blob/main/src/lib/external_card_video_bridge.ts).
