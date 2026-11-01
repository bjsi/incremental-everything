# Rem references, links and merging

How RemNote stores the ways one Rem points at another, and how its own merge repoints them all. Read from `app.asar` (RemNote desktop 1.28.x) and the local `remnote.db` on 2026-09-24. Established while building the contained-highlight merge of AI Transcribe (`src/lib/ai_ocr.ts`).

## The reference element

A reference is a rich-text element in a Rem's `key` (front) or `value` (back):

```ts
{ i: 'q', _id: RemId, aliasId?, pin?, content?, showFullName?, textOfDeletedRem?, cId? }
```

| Field | Meaning |
|---|---|
| `pin: true` | The pin-only form: renders just the 📍 and is left out of plain text and AI context. Stored pins look like `{"i":"q","_id":…,"pin":true,"content":false}`. |
| `content` | **Show Content**: render the referenced Rem's content. |
| `showFullName` | **Show Full Name**: render the ancestor path. |
| `aliasId` | Show one of the target's aliases (an alias Rem, child of the target) instead of its text. |
| `textOfDeletedRem` | Fallback text kept once the target is deleted. |
| `cId` | A cloze placed on the reference. |

`content` and `showFullName` are toggled from the reference's menu (**Reference Options**), which calls `LETransforms.setItemAttribtues` on that one element. A reference to a PDF highlight renders through the powerup's `remappedReferenceRendering`: `pin` gives `rn-highlight-reference--pin`, anything else `rn-highlight-reference--full`.

## Inline links

An inline link is not an element of its own. It is a text span carrying the target's id in `qId`:

```ts
{ i: 'm', text: 'especially when', qId: RemId }
```

**Replace with Inline Link** turns a reference into one.

## Writing references from a plugin

The bridge validates every call's arguments against a zod schema, whose reference element lists only `i`, `_id`, `aliasId`, `content`, `showFullName` and `textOfDeletedRem`. But it only calls `safeParse` to accept or reject; the handler receives the **raw** arguments. So `pin`, `cId` and any other field survive `rem.setText` / `setBackText`.

## Where the links are stored

On each Rem document in `remnote.db` (`quanta.doc`):

| Field | Holds |
|---|---|
| `tp` | the Rem's own tags (type parents) |
| `tc` | Rems tagged with this one |
| `pd` | for a portal: the Rems it includes, with their expanded/hidden state |
| `ps` | powerup slot values |
| `mh` | merge history |
| `srcRemId`, `srcRemC` | the Rem it was created from |

The reverse indexes `kr` (Rems whose front references this one), `vr` (whose back does) and `di` (portals directly including it) are **lazy caches built at runtime and never persisted**. The database cannot answer "who references X". Ask the live app through `rem.remsReferencingThis()`.

## Native merge repoints everything

`rem.merge(idToMergeIn)` in the SDK is the same merge as joining two bullets in the editor (`mergeAll` → `moveInformationToOtherRem`). It moves onto the kept Rem:

- **references in other Rems' front and back text**, through `replaceRemWithOtherRem`: it clones each element and swaps only `_id` (and `qId` on inline links), so pin, Show Content, Show Full Name, alias and cloze are kept;
- **tags both ways**: Rems tagged with the merged one (`tc`) and the merged one's own tags (`tp`). Powerups flagged `dontChangeTagsOnMerge` or `onlyMoveTypeParentWhenMergeWithSibling` opt out;
- **sources** (the union of both lists);
- **portal inclusion**, with its expanded and hidden-explicitly-included state;
- **every applied powerup, with its slot values written over the kept Rem's** (see the warning below);
- type (concept/descriptor), card-direction flags, multiple-choice answer;
- `srcRemId`, and any open window pane showing the merged Rem;
- **all its cards: their Rem id is rewritten, so the repetition history moves with them.**

`mergeAll` also moves aliases and children, records the merge in `mh`, and deletes the merged Rem (reason `MERGE_MERGED`). If both Rems have different back text, it opens a picker and waits for the user.

Powerups flagged `dontAllowMergingInstances` (UploadedFile `f`, and `qe`, `b`, `dv`, `cl`, `sc`, `ssd`, `ssa`, `sslo`, `vi`, `au`) make it raise *"You cannot merge this bullet because of its power-up tags"*. In 1.28.x that guard only shows the toast: the merge still runs. PDF Highlight (`n`) is not flagged.

## Merge copies powerup slots

Because merge copies every slot value of the merged Rem's powerups onto the kept one, merging PDF highlight A into highlight B **overwrites B's `Data` (position) and `PdfId` with A's**. The same goes for any plugin powerup both carry.

So before merging, remove from the merged Rem every powerup whose values must not win. `mergeHighlightInto` in `src/lib/ai_ocr.ts`:
1. removes the PDF Highlight powerup, the tags the plugin derives (image, priority bands), and plugin state the kept highlight already has;
2. merges;
3. re-checks the kept highlight's `Data`, `PdfId` and colour.

Merge only rewrites `key` and `value` rich text. **References stored in other Rems' powerup slot values are not repointed**, and neither is anything a plugin keeps in its own JSON (the plugin's PDF bookmarks, for instance, are moved by `repointBookmarksInState` in `src/lib/pdf_state.ts`).

## Web pages: Link Rems, Sources and the Clipper

Read from the RemNote 1.29.1-beta bundle and the Clipper 1.0.12 extension, and measured in the main KB's `remnote.db` (Nov 1, 2026). The plugin-side `remsReferencingThis` behaviour below comes from reading the code and was not run.

A clipped page is **two Rems**:

| Rem | Parent | Holds |
|---|---|---|
| Link Rem (powerup `b`) | the host Rem (`supermemo.guru`) under the `Website` powerup Rem | `b_u` URL, `b_t` title, and the singleton key `e = "p.b.<url>"` |
| Document (powerup `o`) | `Links` at first; the user may move it | Sources slot `os_os` = a rich-text reference `{i:'q',_id:<Link Rem>}` |

In newer Rems the slots are in `doc.ps` and `doc.apu`; older ones use `doc.bpc`. The document has no copy of the URL.

**The Link Rem is unique per URL string.** `getOrCreateLinkRem` looks up the indexed `e` field KB-wide, and creates a Link Rem only on a miss. The main KB has 2,413 Link Rems and no repeated `e`. The only normalization is `sanitize-url` (it strips control characters and blocks `javascript:`), so `http`/`https`, `www`, `#fragment`, query strings and letter case all give different Link Rems. URLs ending in `.pdf`, and arXiv/OpenReview PDF links, take the uploaded-file path instead.

**The Clipper reuses the document.** The extension only opens an iframe at `/clipper?clipperURL=<tab.url>&clipperTitle=…`, or posts `getOrCreatePageDocument`, and the app does the rest in `getOrCreateDocumentWithSourceURL(url, parent)`:

1. Get or create the Link Rem.
2. Take `documentsThisIsASourceOf(link)[0]`, a WASM graph query, and return it if there is one. Moving the document does not break this.
3. Otherwise create a new Rem under `Links` and set the Link Rem as its source.

A new document follows when the URL string differs, or when no Rem has that source any more (document deleted, or source removed). The iframe route does not tag the document; `getOrCreatePageDocument` also adds the `Clipped Document` tag, but only when the title is empty.

**What a plugin can reach:**

- Forward: `rem.getSources()`, then `getPowerupProperty(BuiltInPowerupCodes.Link, 'URL')`.
- URL to Link Rem: `plugin.rem.createLinkRem(url, false)`, which creates one on a miss. There is no read-only lookup.
- Link Rem to documents: **no API.** `documentsThisIsASourceOf` and `powerupSlotReferenceRemsAsync` are not on the bridge. `remsReferencingThis` calls `referenceRemsAsync`, which reads only the key and value reference caches (`kr`, `vr`), while the source reference is in a powerup slot. `Sources` has no powerup Rem to enumerate either.

Counting from `remnote.db`: built-in powerups show in `doc.apu`, but plugin powerups are tags, in `doc.tp.<tag Rem id>.t`. A query on `apu` finds no Dismissed Rems at all. On Nov 1, 2026 the main KB had 6,494 Incremental and 388 Dismissed Rems; 86 of them had a Link source, and none shared a page.
