# Images, audio and file storage

How RemNote stores an image or audio element, and how a plugin can get bytes into RemNote's file storage although the SDK has no upload call. Read out of the desktop bundle (RemNote 1.28.19) and the local database, and confirmed live, on 2 October 2026; the sandboxing that RemNote 1.29 brought, and what still works under it, was added on 5 November 2026 (1.29.8-beta, see [RemNote 1.29: the sandboxed window](#remnote-129-the-sandboxed-window)). Used by `src/lib/localize_media.ts` and `src/lib/media_bridge.ts`.

## Linked vs stored

An image is a rich-text element `{ i: 'i', url }`, an audio or video `{ i: 'a', url, onlyAudio }`. What `url` holds depends on how the element was inserted:

| Inserted through | `url` | Copy kept by RemNote |
|---|---|---|
| **Embed Link**, **Audio Search**, Wikimedia image search | the outside address, verbatim | none |
| **Upload**, **Record**, paste, drag and drop | `%LOCAL_FILE%<128 random chars>.<ext>` | yes |

- `%LOCAL_FILE%…` is how the element is stored and how a plugin reads it; RemNote resolves it to `https://remnote-user-data.s3.amazonaws.com/<name>`. A plugin can meet either spelling: an element written with the S3 address keeps it.
- The desktop app also keeps the file in `~/remnote/remnote-<kbId>/files/<name>`, which is what makes it play offline.
- An uploaded MP3 gets the extension `.mpga` (the MIME library's name for `audio/mpeg`).
- A linked element is never copied later, with one exception below. If the outside server drops the file, the element is dead.

**RemNote's own re-upload of linked images is unreliable.** The image node re-uploads an outside `url` when it mounts (synced knowledge base only, and only where the editor gives it a way to write the new address back), and the markdown importer queues the same job for every Rem it creates. It has demonstrably run on some images and skipped others inserted the same way: about 200 images in a 400k-Rem knowledge base were still bare links. Audio elements are never touched.

## The audio player's DOM

An `onlyAudio` element renders RemNote's own player, not the browser's controls (read from the bundle, 1.28.19; the stored-file `src` forms below are inferred from the URL resolver, not observed):

```
span.AudioVideoNode
  div.max-w-full > div.w-full.h-full
    div[data-prevent-editor-refocus="true"]     ← the bordered box, a flex row
      audio[src]                                ← no `controls`; the buttons around it drive it
      [data-test="Inline Audio Play Button"] … [data-test="Inline Audio More Menu"]
```

`audio[src]` is the only place the address reaches the DOM, and it is the *resolved* one: the outside address for a linked file; for a stored file the S3 address or a local/blob URL, never `%LOCAL_FILE%`. So `audio[src^="http"]:not([src*="remnote-user-data"])` selects linked audio, and `:has()` lifts that to the box. The "Mark Audio That Is Only Linked" setting is built on it (`src/register/settings.ts`).

## Uploading from a plugin

The SDK (0.0.46) exposes nothing that uploads. Two calls reach RemNote's upload code as a side effect:

**1. `richText.parseFromMarkdown` uploads a data-URI image.** The markdown image rule hands `![](data:image/…;base64,…)` to `uploadPastedDataURIImage`, which stores the bytes and puts the stored address in the returned image element. The answer comes back in the same call.
- The URI must match `^data:(image\/[a-z0-9.+-]+);base64,…$`: an `image/` MIME with no parameters. Audio cannot go this way.
- RemNote raises its own "Uploading pasted image…" toast.

**2. `rem.createSingleRemWithMarkdown` queues the created Rem for re-upload.** The Rem goes through the paste importer, which ends with `reUploadExternalImagesInBackground()`. That job fetches the `url` of every *image element* in the Rem, uploads whatever comes back, and rewrites the element. It does not check that the response is a picture, so `![](https://…/word.mp3)` ends up as a stored `.mpga`.
- It runs in the background: poll the Rem's `text` until the address changes. Measured at about 2 seconds per small file; several images in one Rem are swapped one after another, in place.
- **It leaves a stray Rem.** The bridge handler creates *two* Rems, the one it returns and an empty one used as a portal context. The second stays behind, top-level and empty, and nothing links the two, so a plugin cannot find it afterwards. Put every address into one call rather than one call each.
- The fetch is RemNote's, not the plugin's.

Neither is SDK contract. Both fail soft: the address simply does not change.

## Fetching

Up to RemNote 1.28 the desktop window was created with `webSecurity: false`, so neither RemNote nor a plugin iframe was bound by CORS there. **Since 1.29 it is `webSecurity: true`** (with `sandbox: true`), so in the desktop app, as in the browser, a plugin's own `fetch` (door 1) needs a server that sends `Access-Control-Allow-Origin`. Door 2 is unaffected for http(s): RemNote fetches those addresses in its main process (below), where CORS does not apply. In the browser both doors still need CORS.

## Writing the element back

`setText` rejects an audio `percent` that is not 25, 50 or 100, and stored values are sometimes floats (59.42…). Drop the field in that case. Image elements carry fields the SDK types do not model (`drawingData`, `textData`, `attributionUrl`…): copy the element and change only `url`.

## RemNote 1.29: the sandboxed window

Read from the 1.29.8-beta bundle (`build/electron/main.js` and the renderer chunks) and confirmed live on 5 November 2026.

The main window is created with `webSecurity: true, sandbox: true, contextIsolation: true`. Consequences:

- **The window cannot read `file://`.** Displaying `![](file:///…)` logs *Not allowed to load local resource*, and the re-upload of such an element (an axios request made in the window) fails with *AxiosError: Network Error*. The element keeps its `file://` address and shows *Unable to find this image*. Before 1.29 the same element was uploaded on its first render, which is how images written through the RemNote MCP used to land.
- **http(s) is fetched by the main process.** The re-upload routine sends `http:`/`https:` addresses to the `ipc_fetch_http_file` handler, which downloads them with Electron's `net.request`: no CORS, no restriction on `127.0.0.1`. So an image served from a local HTTP server *can* be stored, provided something runs the re-upload: door 2 above. On its own, the image node's mount-time re-upload did not fire for such an element in the queue view; the image merely displayed from the server.
- **Displaying** an http image is a CORS request from origin `app://js`: a server that does not send `Access-Control-Allow-Origin` (for example `python -m http.server`) shows a broken image.
- **The main process reads only RemNote's own folders.** Every file IPC (`ipc_read_file`, `get_data_url_for_file`…) passes the path through a guard that accepts `~/remnote`, `~/remnote-dev`, the knowledge-base folders, and paths the user picked in an open dialog (a picked file grants only that file; a picked folder grants the folder). Anything else throws *RemNote can only use files inside its own folders, not …*.
- **Markdown import.** A bare `.md` whose images are `file://` links imports with every image broken, even when the image sits next to the `.md`: picking the `.md` grants only the `.md`. A **`.zip`** is handled by a different path: each image's address is looked up *inside the archive* (exact path, `./`-prefixed, or by trailing file name) and the bytes are uploaded, so the Rem gets a `%LOCAL_FILE%` copy. Package the `.md` with its images, linked by relative path, into a zip (`~/.claude/tools/pdf-remnote/mdzip.py` does this).
- **Getting a local image in from outside the app** (scripts, the MCP): serve it over http and have the plugin run door 2 on the Rem. That is the Local Media Bridge (`scripts/media_bridge/media_bridge.py`, `src/lib/media_bridge.ts`, docs `Local-Media-Bridge.md`).

