# Troubleshooting & Error Guides

This page contains guides for troubleshooting common issues and using diagnostic tools.

---

## 🚀 Jump to Rem by ID - User Guide

### 📖 Overview

The "Jump to Rem by ID" feature allows you to quickly navigate to any rem in your knowledge base using its RemId. This is especially useful when investigating errors from the pre-computation process or debugging issues with specific rems.

### ⚡ Quick Start

#### Using the Plugin Command (Recommended)

1. **Press `Ctrl+/`** (or `Cmd+/` on Mac)
2. **Type:** `Jump to Rem by ID`
3. **Enter the RemId** in the popup dialog
4. **Press Enter** or click "Jump to Rem"
5. **Done!** The rem opens automatically

**Example:**
```
Ctrl+P → "Jump to Rem" → tfhQYD3Q2wDw4VWUH → Enter → ✅
```

### 🎯 Common Use Cases

#### 1. Investigating Pre-computation Errors

When you run "Pre-compute Card Priorities" and see errors:

**Step 1:** Check the console for error details
```
Error 15/268:
  RemId: tfhQYD3Q2wDw4VWUH  ← Copy this
  Reason: Processing exception
```

**Step 2:** Jump to the rem
- `Ctrl+/` → "Jump to Rem by ID"
- Paste: `tfhQYD3Q2wDw4VWUH`
- Press Enter

**Step 3:** Investigate
- View the rem's content
- Check if it's corrupted
- Fix any issues
- Re-run pre-computation

#### 2. Checking Multiple Failed Rems

When you have a list of failed RemIds:

```
=== FAILED REM IDs ===
abc123xyz
def456uvw
ghi789rst
```

**Quick workflow:**
1. `Ctrl+/` → "Jump to Rem by ID"
2. Paste first RemId → Enter
3. Investigate the rem
4. Repeat for next RemId (command stays in recent commands)

**Pro tip:** The command stays in your command history, so just press `Ctrl+P` and it will be at the top of your recent commands!

#### 3. Verifying Orphaned Cards

When you see "Rem not found" errors:

**Use Jump to Rem to confirm:**
- If popup shows "Rem not found" → The rem was deleted (orphaned)
- If rem opens → The rem exists (error was temporary)

### 🎨 The Popup Dialog

When you run the command, a popup appears with:

```
┌─────────────────────────────────────┐
│  Jump to Rem by ID                  │
│                                     │
│  Enter RemId:                       │
│  ┌─────────────────────────────┐   │
│  │ e.g., tfhQYD3Q2wDw4VWUH    │   │
│  └─────────────────────────────┘   │
│                                     │
│          [Cancel]  [Jump to Rem]   │
│                                     │
│  💡 Tip: Find RemIds in the         │
│     pre-computation error log       │
└─────────────────────────────────────┘
```

#### Features:
- ✅ **Auto-focused input** - Start typing immediately
- ✅ **Enter key support** - Press Enter to submit
- ✅ **Error messages** - Clear feedback if RemId is invalid
- ✅ **Cancel button** - Close without action
- ✅ **Dark mode** - Adapts to your theme

### 🔍 Understanding RemIds

#### What is a RemId?

A RemId is a unique identifier for every rem in RemNote. It looks like this:
```
tfhQYD3Q2wDw4VWUH
```

#### Where to Find RemIds:

1. **Pre-computation error logs** (Console, F12)
   ```
   Error 15/268:
     RemId: tfhQYD3Q2wDw4VWUH
   ```

2. **URL bar** when viewing a rem
   ```
   https://www.remnote.com/document/tfhQYD3Q2wDw4VWUH
   ```

3. **Developer tools** (for debugging)
   ```javascript
   const rem = await plugin.focus.getFocusedRem();
   console.log(rem._id); // Prints RemId
   ```

### ✅ Success Messages

#### When rem is found:
```
🔍 Searching for rem: tfhQYD3Q2wDw4VWUH...
✅ Found rem: "What is the capital of France?"
📍 Opening rem in RemNote...
```

**Result:** 
- Popup closes automatically
- Rem opens in RemNote
- Toast notification: "✅ Found: What is the capital..."

#### When rem is not found:
```
🔍 Searching for rem: tfhQYD3Q2wDw4VWUH...
❌ Rem not found: tfhQYD3Q2wDw4VWUH
💡 Possible reasons:
   • The rem was deleted
   • The RemId is incorrect
   • The rem is from a different knowledge base
```

**Result:**
- Error message shown in popup: "Rem not found: tfhQYD3Q2wDw4VWUH"
- Popup stays open so you can try again
- Toast notification: "❌ Rem not found"

### 🚨 Error Messages & Solutions

#### Error: "RemId cannot be empty"
**Cause:** You clicked "Jump to Rem" without entering anything

**Solution:** Enter a RemId in the input field

---

#### Error: "Rem not found: [RemId]"
**Cause:** The rem with this ID doesn't exist in your knowledge base

**Possible reasons:**
1. The rem was deleted
2. You copied the RemId incorrectly
3. The rem is in a different knowledge base
4. Typo in the RemId

**Solutions:**
- Double-check you copied the full RemId
- Verify you're in the correct knowledge base
- Check if the rem was recently deleted
- Try another RemId from your error list

---

#### Error: "Error: [technical message]"
**Cause:** Unexpected error during processing

**Solutions:**
1. Try again (might be temporary)
2. Reload the plugin (Settings → Plugins → Toggle off/on)
3. Check console for detailed error (F12)
4. Report bug if error persists

---

## 🛠 Pre-compute Card Priorities - Error Guide

### Understanding the Error Report

When you run the pre-computation, you'll now see an enhanced error report like this:

```
✅ Pre-computation complete!

• Total rems processed: 41010
• Newly tagged: 40948
• Preserved manual priorities: 62
• Errors: 268
• Error breakdown:
  - Rem not found: 245
  - Processing exceptions: 23
• Total time: 443s
• Cache build time: 142s

Check console for detailed error log.

Future startups will be much faster!
```

### Error Types Explained

#### 1. "Rem not found" Errors
**What it means:** The card references a Rem that no longer exists in your knowledge base.

**Why this happens:**
- The Rem was deleted but the card still exists
- Database inconsistency
- The card's parent Rem was removed

**Impact:** 
- ❌ The card was **NOT** tagged with cardPriority
- ❌ No priority was assigned
- The card may not appear correctly in the queue

**How to fix:**

The plugin now handles this automatically! When you run **"Update all inherited Card Priorities"**, if any "Rem not found" errors are found, it will immediately offer to clean them up:

1. A summary confirms how many orphan cards were found and across how many missing Rems.
2. **You choose whether to preserve reviewed cards.** If some orphans carry a review history (past reps and time-spent records, which still show up in some RemNote statistics), the cleanup asks whether to **delete only the cards without history** (keeping the reviewed ones so their stats stay retrievable) or **delete all** (a second confirmation warns you'll lose those records). When no orphan has any history, this step is skipped.
3. The list of cards to be removed is shown in pages of 25 (so the dialog always fits on screen).
4. Each page asks for your confirmation before proceeding — you can cancel at any point.
5. The chosen set is removed in parallel batches of 25 with live progress toasts, and the final summary reports how many were removed and how many were **preserved**.

Each candidate is **double-checked** with a fresh live lookup before removal, so cards belonging to Rems that were only transiently unavailable are never deleted.

> [!NOTE]
> Orphan cards are also detected at **startup**. When the Card Priority cache finishes its background pass, it counts any Rem whose cards exist but which can't be found, and shows a toast suggesting you run **"Update all inherited Card Priorities"**. **Nothing is deleted automatically at startup** — a Rem can briefly appear missing before sync finishes hydrating, so removal always stays behind the confirmed, on-demand cleanup above.

> [!TIP]
> If you prefer to investigate manually first, you can cancel the cleanup dialog and use the **"Jump to Rem by ID"** command (`Ctrl+/`) to inspect individual RemIds from the console log.

#### 2. "Processing exceptions" Errors
**What it means:** An unexpected error occurred while processing the Rem.

**Common causes:**
- Permission issues
- Corrupted Rem data
- Network timeout during processing
- Bug in the code logic

**Impact:**
- ❌ The card was **NOT** tagged with cardPriority
- ❌ No priority was assigned
- The Rem needs manual investigation

**How to fix:**
1. Check the detailed error log in console
2. Look for the specific error message
3. Try to open the Rem manually in RemNote
4. If the Rem is accessible, you can manually set priority using [`Alt+P`](Keyboard-Shortcuts.md#priority-commands)
5. Report the error details if it seems like a plugin bug

### How to Investigate Errors

#### Step 1: Check the Console
After pre-computation, open your browser's Developer Console (F12) and look for:

```
=== DETAILED ERROR LOG ===
Total errors: 268

Error 1/268:
  RemId: abc123xyz
  Reason: Rem not found - may have been deleted
  
Error 2/268:
  RemId: def456uvw
  Reason: Exception during processing: Cannot read property 'text' of undefined
  Details: [error object]
  
...
```

#### Step 2: Get the List of Failed RemIds
At the end of the error log, you'll find:

```
=== FAILED REM IDs (for investigation) ===
abc123xyz
def456uvw
ghi789rst
...
=== END FAILED REM IDS ===
```

You can copy this list and:
1. Search for these Rems in RemNote
2. Check if they still exist
3. Manually assign priorities if needed

#### Step 3: Re-run Pre-computation
After fixing issues:
1. Run pre-computation again
2. Check if error count decreased
3. Most "Rem not found" errors should auto-resolve after card cleanup

### Important Notes

#### Error Count vs Failed Tagging
- **Error count** = Rems that failed to process
- **Newly tagged** = Rems that were successfully tagged

#### When to Worry
- **< 100 errors out of 10,000+ rems:** Normal, likely deleted/orphaned cards
- **> 1,000 errors:** May indicate a systemic issue, investigate
- **All errors are "exceptions":** Likely a plugin bug, report it

---

## 🧹 Rogue CardPriority Tags Sanitization

### Overview
A "rogue" `CardPriority` tag is the powerup sitting on a rem that is **not** a flashcard — a tag slot (`Subtítulo`, `Autor`, …), a property value, a reading-log entry, a chapter heading, or a plain list item. Rogue tags don't affect your real flashcards, but they clutter the knowledge base and inflate the "rems processed" counts.

**Where they came from (fixed in v0.2.272).** The inheritance cascade used to walk *every* descendant of a rem whose priority changed and tag all of them, regardless of whether they had cards. As of v0.2.272 the cascade only touches descendants that genuinely own flashcards, so **no new rogue tags are created**. The sanitizer below cleans up tags created by older versions.

### How to run the Sanitizer

#### For the Entire Knowledge Base (Batch)
Use the global command to scan your entire knowledge base and remove rogue tags in bulk:
1. **Press `Ctrl+/`** (or `Cmd+/` on Mac)
2. **Type:** `Sanitize Rogue CardPriority Tags`
3. **Press Enter**

You'll get a batch confirmation dialog (in chunks of 20) listing the rems about to be cleaned, then a summary toast — including how many legitimate anchors were **preserved**.

#### For a Specific Rem (Debug Widget)
To inspect and clean a single rem and its descendants:
1. Navigate to the rem in the editor.
2. Type `/debug` to open the **Debug Widget** below the rem.
3. Under **Card Priority Powerup**, click **Sanitize Rogue Tags**. This runs the *same* authoritative scan as the global command, scoped to this rem's subtree.

> [!TIP]
> Before cleaning, click **Dump Slot Structure** (same section of the Debug Widget) to print a `console.table` of every node carrying `CardPriority` and/or cards — with card counts, source, and a per-node classification (`ok-card` / `inheritance-anchor` / `rogue-no-card`). This lets you confirm exactly what will be removed and what will be kept.

### How a tag is classified

Detection is **authoritative**: it uses the global card index (`plugin.card.getAll()`) — not `rem.getCards()`, which under-reports cards on paused/disabled rems — to decide whether a tagged rem owns any flashcards. A rem with cards is always left alone. A rem with **no cards** is then classified by the powerup's **source**:

| Source | Meaning | Action |
|---|---|---|
| `inherited` / `default` / *(empty)* | A cascade artifact — the tag was propagated/defaulted, not set on purpose. | **Rogue** → offered for bulk removal. |
| `manual` | You set this priority yourself (e.g. a priority anchor on a folder/document). | **Preserved** — never offered for deletion. |
| `incremental` | Left behind when an IncRem was dismissed, so its descendants keep inheriting its priority (second only to `manual` in importance). | **Preserved** — never offered for deletion. |

Card-less `manual` and `incremental` tags are legitimate **inheritance anchors**. The sanitizer reports how many it preserved (and lists them in the console) but **never deletes them**. To remove one deliberately, use the **Clear Card Priority** button in the [Priority widget](Priorities-for-Flashcards.md#setting-managing-priorities).

### Safety Guarantees
- The sanitizer **never** touches a rem that owns flashcards (verified against the global card index, which counts cards on paused and disabled rems too).
- Legitimate inheritance anchors (`manual` / `incremental` source, no cards) are preserved and are not offered for deletion.
- Detection is read-only; nothing is written until you confirm a removal batch.

---

## 📄 PDF Highlight Repair Tool

### Overview

In some cases, clicking a PDF highlight pin in RemNote does not scroll the PDF to the correct page — it either does nothing or jumps to the wrong location. This section explains why that happens and how to use the plugin's built-in **Debug PDF** and **Repair PDF** tools to diagnose and fix it.

### What Causes Broken Highlights?

Every PDF highlight in RemNote is stored as a rem with a **PDFHighlight** powerup and a `PdfId` slot that points back to the PDF document rem. Navigation works by looking up this slot to find the PDF, then reading the highlight's position data.

The structure under a healthy PDF looks like this:

```
PDF Document [UploadedFile, Document, Automatically Sort]
└── Highlights [Automatically Sort]          ← canonical container
    └── Page 08 [PDFPageNumber]
        └── "Some highlighted text..." [PDFHighlight]
            ├── PDF           ← internal slot rem (PdfId)
            └── Data          ← internal slot rem (position JSON)
```

> [!NOTE]
> After RemNote's mid-2026 storage/sync overhaul, the `Highlights` container is no longer marked by a `PDF Highlight Section` tag (or any other tag, property, or slot). It is now identifiable **only by its name** (`Highlights`) and its **position** — a direct child of the PDF/`UploadedFile` rem. It carries just the `Automatically Sort` powerup, the same one the PDF root has, so there is no unique powerup to key off either.

Highlights can break in two ways:

1. **Wrong tree structure** — Page nodes (`PDFPageNumber`) end up directly under the PDF root instead of under the `Highlights` container. RemNote cannot resolve the highlight → PDF path when pages sit outside the container.

2. **Wrong `PdfId` slot** — The `PdfId` slot on a `PDFHighlight` rem points to a stale or incorrect rem ID. This is the root cause of pin navigation failures even when the tree structure looks correct.

Both issues can be introduced by manual reorganization of a PDF rem, restoring from a backup, merging knowledge bases, or the storage/sync overhaul leaving older highlights stranded under the PDF root while new ones go into the `Highlights` container.

### Diagnosing with "Debug PDF"

1. Open the rem you want to inspect in the RemNote editor (the PDF document rem itself, or any rem that has the PDF as a source).
2. Type `/debug` in the editor to open the **Debug Widget** below the rem.
3. Scroll to the **PDF Structure Debug** section at the bottom of the widget.
4. Click **Debug PDF**.

This scans every descendant of the PDF rem and prints a full annotated tree to the browser console (F12 → Console tab). For each **PDFHighlight** rem, it shows:

- Its `PdfId` value — should match the PDF document rem's ID.
- Its `Data` slot (abbreviated) — contains the page number and position.
- All powerups and tags — lets you spot misclassified or missing nodes.

```
• "IMO AIS PDF" (6BAhWRZ…) [AutoSort, Document, UploadedFile]
  • "Page 05" (82oKTS…) [PDFPageNumber]          ← ⚠️ orphaned directly under the PDF root
    • "10 The AIS is able to detect…" (gQpiEc…) [PDFHighlight] PdfId:6BAhWRZ…
  • "Highlights" (vxiCdI…) [AutoSort]              ← ✅ canonical container (name + direct child of PDF)
    • "Page 05" (QXN8ZE…) [PDFPageNumber]
      • "10 The AIS is able to detect…" (2XXvJB…) [PDFHighlight] PdfId:6BAhWRZ…
```

### Repairing with "Repair PDF"

After diagnosing, click **Repair PDF**. The tool runs several independent checks and lists any issues it finds before asking for confirmation:

| Issue | What the tool does |
|---|---|
| Page nodes (`PDFPageNumber`) sitting directly under the PDF root | Merges/moves them into the `Highlights` container (see merge note below) |
| Duplicate `Highlights` containers | Folds their pages into the main container and removes the emptied duplicates |
| `PdfId` slots pointing to the wrong rem | Updates each to the correct PDF rem ID |
| PDF root missing the `Document` powerup | Adds the `Document` powerup |

**Merge, not just move:** when an orphaned page has the same page number as a page already inside the `Highlights` container (e.g. both have a `Page 05`), the tool moves the orphan's highlights into the existing page and **deletes the emptied orphan**, so you never end up with two `Page 05` nodes side by side.

> [!IMPORTANT]
> The **Repair PDF** tool needs a `Highlights` container to move pages into. RemNote creates this container automatically the first time you highlight anything in the PDF viewer. If the PDF has never had a highlight (no `Highlights` child at all in the Debug output), the tool will tell you to create one first.

### Step-by-Step: Complete Repair Workflow

**Scenario:** You have a PDF with broken highlight pins.

**Step 1 — Create one new highlight (only if there is no `Highlights` container yet)**

Open the PDF in RemNote's PDF viewer and make **any single highlight** anywhere. This forces RemNote to create the `Highlights` container. You can delete this test highlight afterwards if you like.

> [!TIP]
> Skip this step if the **Debug PDF** output already shows a `Highlights` container (any child literally named `Highlights` directly under the PDF). The container already exists.

**Step 2 — Run Repair PDF**

1. Navigate to the PDF rem (or any rem that has it as a source).
2. Type `/debug` → open the **Debug Widget**.
3. Click **Repair PDF**.
4. Review the list of detected issues in the confirmation dialog.
5. Click **OK** to proceed.

The tool merges/moves all misplaced page nodes into the `Highlights` container and fixes any `PdfId` slots in a single pass. A toast reports the result (pages re-parented, duplicates merged, highlights folded in, PdfIds fixed), and the console log shows each move, merge, and PdfId fix for auditing.

**Step 3 — Verify**

Click **Debug PDF** again and confirm:
- All page nodes now sit **under** the `Highlights` container, with one page per page number (no duplicates).
- All `PDFHighlight` rems show the correct `PdfId` (matching the PDF document rem ID).
- Clicking a highlight pin in the PDF viewer navigates to the right page.

### What the Tool Does Not Do

- It does not alter the position data stored in each highlight's `Data` slot.
- It does not touch unrelated children of the PDF root (e.g. search-portal rems).
- Detection is by the container's **name** (`Highlights`); if you run RemNote in a non-English UI where the container is localized, the tool may not recognize it.

---

## 📊 Page History Diagnostic & Cleanup (Debug Widget)

### Why These Tools Exist

Up to v0.2.257, `addPageToHistory` — the function that records reading sessions into the per-(IncRem, PDF) page-history storage — had an "auto-compute" code path that read the queue's review start-time anchor (`incremReviewStartTimeKey`) and stamped a duration onto every page-history entry it wrote, even when the caller was a bookmark or highlight event rather than a session boundary. The anchor was set when the queue picked an IncRem and only cleared on manual reschedule, so every subsequent bookmark in the same review compounded a longer and longer duration from the same starting point.

The visible symptom was that the **Total Time** on the [PDF Control panel](PDF-Incremental-Reading-Workflow.md) drifted away from the authoritative **Total Time** in [Repetition History](IncRem-List-and-Main-View.md) — in extreme cases by more than 5× (e.g. 9h 58m vs 1h 47m on the same rem). The fix in v0.2.258 stops new entries from being inflated; the tools below let you inspect and clean up the historical data already written under the old behavior.

### When to Use

- **Page History Dump** — anytime you want to inspect the raw per-entry contents of `incremental_page_history_<remId>_<pdfRemId>` storage for a given Incremental (or Dismissed) Rem, e.g. to investigate a discrepancy between PDF Control and Repetition History totals, or to confirm that recent reviews were recorded correctly.
- **Clean Inflated Page-History Durations** — when the dump (or PDF Control vs Repetition History) shows that this rem has inflated entries to strip.
- **Clean Inflated Page-History — Global Scan** — once, after upgrading to v0.2.258, to clean up every IncRem and Dismissed rem in the knowledge base in a single pass.

### How to Open the Debug Widget

1. Navigate to the rem you want to inspect (any Incremental or Dismissed rem with PDF sources).
2. Type `/debug` in the editor to insert the **Debug Widget** below the rem.
3. Scroll to the relevant section.

### 📥 Page History Dump

Click **Dump Page History**. For every PDF source on the focused rem, the widget will:

- Print the raw storage value and the parsed `PageHistoryEntry[]` to the console (F12 → Console).
- Render a per-PDF summary card in the widget showing:
  - **Total entries** vs **entries with `sessionDuration > 0`**.
  - **Sum of durations** vs **`getReadingStatistics` total** (these should always match; mismatch indicates a parsing bug).
  - **Min/Max** duration and **count of entries hitting the 4h cap** (14400 s).
  - The exact storage key (`incremental_page_history_<remId>_<pdfRemId>`).
- A `<details>` toggle exposes the full raw JSON of every entry.

This is purely diagnostic — nothing is mutated.

### 🧹 Clean Inflated Page-History Durations (per rem)

The detection rule applied to every entry in the focused rem's page-history:

| Entry timestamp | Has matching rep in `incRem.history`? | Action |
|---|---|---|
| < 2026-02-04 UTC | — | **Keep** (always) |
| ≥ 2026-02-04 UTC | yes (±5 s timestamp, ±2 s duration) | **Keep** |
| ≥ 2026-02-04 UTC | no | **Strip** `sessionDuration` |

> [!IMPORTANT]
> The **2026-02-04 cutoff** is the date when the Dismissed powerup started preserving `reviewTimeSeconds` on its History slot. Reps recorded *before* that date may have lost their `reviewTimeSeconds` value on dismissal — meaning page-history is sometimes the only surviving record of legitimate review time. Entries with timestamps before the cutoff are therefore always preserved, even if no matching rep can be found.

**Workflow:**

1. Click **Preview**. The widget shows per-PDF before/after totals, count of entries to strip vs keep, and collapsible lists of each entry with its decision reason. The same data is logged to the console.
2. Verify the proposed changes — pay particular attention to any PDF where the **After total** drops to zero (this is correct when the rem only has bookmark-event entries with no actual reps recorded).
3. Click **Apply**. The widget rewrites the affected `incremental_page_history_*` keys, leaving every other field on each entry (`page`, `timestamp`, `highlightId`) intact so bookmark navigation continues to work.

Only `sessionDuration` is modified. The IncRem/Dismissed History slot — which is authoritative for review time — is never touched.

### 🌐 Clean Inflated Page-History — Global Scan

This variant enumerates every IncRem and Dismissed rem in the knowledge base via the powerup tag lookup and runs the same per-rem analysis on each. Designed to be run once, immediately after upgrading.

**Workflow:**

1. Click **Scan All**. Progress is shown in the widget; the console prints a full per-rem breakdown of detected inflation. For a knowledge base with a few thousand IncRems the scan typically takes 30–90 seconds.
2. Review the summary card: scanned rems, affected rems, total entries to strip, total inflated time. Each affected rem expands to show its PDFs and per-PDF before/after totals.
3. (Recommended) Spot-check one or two affected rems by opening Debug on them individually and running the per-rem **Preview** — confirm the global scan's numbers match.
4. Click **Apply to All**. A confirmation dialog summarizes the total impact before any writes happen.

### What the Cleanup Does Not Touch

- The `IncrementalRep[]` History slot on the Incremental or Dismissed powerup — Repetition History continues to display the same `reviewTimeSeconds` it always did.
- `highlightId`, `page`, or `timestamp` fields on page-history entries — bookmark pin navigation and the Reading History list view are unaffected.
- Entries with timestamps before the 2026-02-04 cutoff.
- Entries whose `sessionDuration` matches a rep's `reviewTimeSeconds` (within ±2 s) at a matching timestamp (within ±5 s) — these are legitimate end-of-session records written by the queue **Next** button or the Editor Review Timer.

### Verifying After Cleanup

For a given rem, the **Total Time** in PDF Control and the **Total Time** in Repetition History should now agree (or PDF Control should be a strict subset, in cases where some legitimate sessions were recorded against a different PDF source on the same IncRem). If they still diverge significantly, run **Page History Dump** on the rem and inspect the remaining entries against the History slot to identify the discrepancy.

---

## 🔎 Search / Linkage Diagnostics (Debug Widget)

### The Problem

Sometimes a perfectly normal Rem — even a **Concept** referenced dozens of times — **cannot be found by typing its name** in RemNote's `[[` reference search. You end up opening its source document to copy/paste it every time you want to reference it. The most common trigger is a name made entirely of **high-frequency words** (e.g. `Navegação Interior`, `mar territorial`): RemNote's search builds its candidate list **per token, with a cap**, so when no word in the name is distinctive enough, the exact-name Rem never makes any token's candidate cut and is buried under a flood of partial matches.

This is a property of the **search ranking**, not a corruption of the Rem — which is why **"Reload Search Cache", retyping the name, toggling the Rem's type, or deleting an alias do _not_ fix it.**

### How to Open the Debug Widget

The Debug Widget now opens on **any** focused Rem (not just IncRem/CardPriority/Dismissed ones):

1. Focus the Rem you want to inspect.
2. Run **`Debug Incremental Everything`** from the command palette.
3. Scroll to the **Search / Linkage Diagnostics** section (at the bottom of the widget) and click **Probe Searchability**.

### What It Reports

The probe reproduces the editor's search via `plugin.search.search()` and dumps a full report to the widget and the console (F12 → Console), including:

- **Verdict** — a plain-language summary of the likely cause.
- **Own-text search rank** (top 50) and **Deep search rank** (top 1000) — whether the Rem appears in its *own* name search and at what position. "NOT FOUND" with many partial matches above it is the signature of common-token saturation.
- **Found under alias? / Found under prefix?** — whether a distinctive word *does* surface the Rem (it usually does — which is exactly what the [Find Rem picker](Utilities.md#find-rem-reference-or-open) exploits).
- **Type & flags** (Concept/Descriptor, isProperty/isSlot/isPowerup…), **literal character count**, **Unicode normalization** (NFC vs NFD), **hidden/zero-width characters**, **leading/trailing whitespace** — rarer causes of invisibility, each ruled in or out.
- **Aliases**, **duplicate same-name Rems**, and the **ancestor chain** (flagging search-excluding powerups such as `SuperPrivate`, `SearchPortal`, `ImportedDocument`, `RestoredFromTrash`).
- **`timesSelectedInSearch`** and reference counts.

Run it on a Rem that *works* and one that *doesn't* to compare — the difference (e.g. a distinctive vs. all-common-word name) makes the cause obvious.

### The Fix

There is **no API to boost a Rem's search ranking**, and the Rem itself is healthy — so the solution is to bypass RemNote's ranking. Use the **[Find Rem — Reference or Open](Utilities.md#find-rem-reference-or-open)** picker (`Opt+Shift+F`): it searches each word separately and floats the exact-name match to the top, so you can insert a reference or open the otherwise-invisible Rem.

---

## 📦 Priorities Lost When Importing Between Knowledge Bases

### The Symptom

You export a document from one knowledge base and import it into another. The flashcards arrive at the **default** priority instead of the ones you set. Incremental Rems usually come through untouched — priority *and* full review history — which makes the loss look arbitrary.

It is not consistent: the **same export file** can import perfectly into one knowledge base and lose every card priority in another.

### What Causes It

**This is a defect in RemNote's importer, not in the plugin.** It reproduces with the plugin completely disabled.

A powerup is an ordinary Rem, and the import has to connect incoming tags to the powerup already registered in the target knowledge base. In the affected knowledge bases it does not manage that in one step. It first attaches a **transient CardPriority powerup** — a freshly generated Rem that does not resolve to anything — and roughly 250 milliseconds later corrects itself: it tags the Rem with the real registered CardPriority, discards the transient one, and **loses the slot values in the swap**.

Reading the raw export files makes the sequence visible. In a knowledge base where the import succeeds, a card's tag and its values are written together, eight milliseconds apart, and the values are intact. In one where it fails, the tag is swapped and all three priority fields are blanked in the *same millisecond*.

**Incremental Rems escape this** because their powerup is matched correctly on the importer's first pass, so no swap ever happens. That asymmetry — same import, same document, one powerup preserved and the other destroyed — is the clearest fingerprint of the problem.

The failure appears to correlate with how much the target knowledge base already uses card priorities: it was reproducible in a knowledge base with over 2,000 prioritised Rems and not in one with 18.

> [!IMPORTANT]
> The values are **destroyed, not hidden**. Nothing is left behind to recover, and no plugin setting or command can prevent it. The priorities the plugin then displays — 50 for flashcards, 10 for Incremental Rems — are fallbacks shown when nothing can be read, not values that were written over your data.

### Checking What Actually Happened

The plugin ships a script that reads a `.rem` export directly. It involves neither RemNote nor the plugin, so nothing can have altered the data before you look:

```
node scripts/analyze_rem_export.js path/to/export.rem
```

It lists, per Rem, the Incremental and CardPriority values the file carries. Export the **same document from both knowledge bases** and compare:

| Source export | Target export | Meaning |
|---|---|---|
| values present | values present | The transfer worked. |
| values present | values blank | RemNote's importer lost them. Nothing to recover in the target. |
| values absent | — | They never left the source knowledge base. |

There is also a **Diagnose Read Path** button in the debug widget's Card Priority section. For the focused Rem it compares the powerup the plugin resolves by code against the tags the Rem actually carries, and probes every slot of both powerups. Use it to confirm that a Rem is correctly tagged and still reads empty — the signature of this bug. Both tools are read-only.

### What To Do

- **Re-import does not help** — it fails the same way each time.
- **Reapply in bulk instead.** Note the priorities before transferring (a [Priority Review Document](Priority-Review-Document.md) is a convenient snapshot) and use **[Batch Assign Card Priority](Priorities-for-Flashcards.md#assigning-priorities-in-bulk)** in the target knowledge base afterwards.
- **Incremental Rem data is safe** to move as-is.
- If you hit this, it is worth reporting to RemNote: the same export file succeeding in one knowledge base and failing in another, with the plugin disabled, is a precise reproduction.
