# Images, audio and file storage

How RemNote stores an image or audio element, and how a plugin can get bytes into RemNote's file storage although the SDK has no upload call. Read out of the desktop bundle (RemNote 1.28.19) and the local database, and confirmed live, on 2 October 2026. Used by `src/lib/localize_media.ts`.

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

**RemNote's own re-upload of linked images is unreliable.** The image node re-uploads an outside `url` when it renders (synced knowledge base only), and the markdown importer queues the same job for every Rem it creates. It has demonstrably run on some images and skipped others inserted the same way: about 200 images in a 400k-Rem knowledge base were still bare links. Audio elements are never touched.

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

The desktop window is created with `webSecurity: false`, so neither RemNote nor a plugin iframe is bound by CORS there, and any server can be fetched. In the browser both are: a server without `Access-Control-Allow-Origin` (most dictionary audio) cannot be fetched by either door.

## Writing the element back

`setText` rejects an audio `percent` that is not 25, 50 or 100, and stored values are sometimes floats (59.42…). Drop the field in that case. Image elements carry fields the SDK types do not model (`drawingData`, `textData`, `attributionUrl`…): copy the element and change only `url`.
