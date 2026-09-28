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
