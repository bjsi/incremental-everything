# IR Flow: Reading, Extracting, and Clozing

This page describes the **Incremental Reading workflow** supported by the plugin — a SuperMemo-inspired loop for breaking down large documents into smaller, reviewable pieces and converting key passages into flashcards, all without leaving the editor.

The three commands that drive this workflow are:

| Command | Shortcut | Action |
|---|---|---|
| **Create Extract** | `Alt+X` / `Alt+Shift+X` | Pulls selected text into a new child Rem and initializes it as an Incremental Rem |
| **Create Cloze** | `Alt+Z` | Creates a standalone cloze-deletion child Rem from the selected text |
| **Create Cloze with Priority** | `Alt+Shift+Z` | Same as above, then opens the Light Priority popup to set a Card Priority |
| **PDF Control Panel** | Command Palette → *PDF Control Panel* | Central hub for splitting a PDF into chapters/sections, assigning page ranges, and tracking reading progress |

---

## Step 0: Splitting — Breaking Complexity Before Extracting

Before you extract sentences or cloze individual words, there is a more fundamental step: **breaking the material itself into manageable pieces**. This is what separates sustainable incremental reading from the exhausting attempt to process a 300-page book in one sitting.

The core principle is simple: **you cannot review what you cannot schedule**. A single Incremental Rem pointing at an entire book will appear in your queue as one monolithic item. You will open it, skim a few pages, feel overwhelmed, and hit "Next" — making no real progress. The solution is to split the material into units small enough to meaningfully review in a single session.

### The Splitting Cascade

Incremental Reading works as a **top-down cascade of decreasing granularity**:

```
Book (folder rem)
  └── Chapter 1                ← Incremental Rem, pages 1–50
        └── Key passage A      ← Extract (Alt+X): a paragraph worth returning to
              └── "X is Y"     ← Cloze (Alt+Z): the atomic testable fact
        └── Key passage B
  └── Chapter 2
  └── Chapter 3
```

At each level, you only go deeper on the material that **deserves** it. Most of a chapter may be skipped entirely on the first pass; a few dense paragraphs will generate multiple extracts; a handful of those will generate clozes. The queue handles each piece on its own schedule.

### You Do Not Need to Get It Right on the First Pass

This is the most important thing to internalize: **the split does not need to be perfect**. You do not need to identify every chapter, section, and sub-section before you start reading. The process is iterative and self-correcting:

- Start with a rough split (e.g., one Rem per chapter, even without correct page ranges).
- As you read Chapter 1 and encounter a natural section break, split it into two children on the spot.
- The next time Chapter 1's sub-sections come up in the queue, one of them may itself be subdivided further.
- After a few passes, the hierarchy naturally reflects the structure of the material — not because you planned it, but because the queue kept bringing you back to what mattered.

The PDF Control Panel's **coverage badge** (visible on parent rows) helps you see at a glance how much of a chapter has already been sub-divided, so you always know where more granularity is needed.

### How to Split a Long PDF

For a full, step-by-step setup guide see the **[PDF Incremental Reading Workflow](PDF-Incremental-Reading-Workflow.md)** page. In summary:

1. **Create a parent rem** for the book and add the PDF as its source.
2. **Create one child rem per chapter** (or per rough section if the book has no clear chapters). Do not worry about exact page boundaries yet.
3. **Tag the first chapter as Incremental** (`Alt+X`) and add the PDF as its source. Use **Copy & Paste Rem Sources** (`Ctrl+Shift+F1` then `Alt+Shift+V`) to propagate the PDF to all other chapters without repetition.
4. **Open the PDF Control Panel** (Command Palette → *PDF Control Panel*) on any chapter to assign page ranges to all of them in one place.
5. **Start reading**. When Chapter 1 appears in the queue, read until a natural break, then split by extracting the sub-section as a child rem with its own page range. Dismiss or schedule Chapter 1 for later.

> [!TIP]
> You do not need to split every chapter before you start. Queue only the chapters you are ready to engage with now and leave the rest at low priority. The queue will bring them forward when their turn comes.

### Splitting Text-Based Material (Articles, Web Pages, Notes)

Not all incremental reading involves PDFs. For articles pasted into RemNote, long notes, or imported web content, the same cascade applies — but splitting is even simpler:

- Use **`Alt+X`** on a paragraph or section heading to extract it as a child Incremental Rem.
- The parent (the full article) becomes a coarse-grained item you will eventually dismiss once all its important sub-sections have been extracted.
- There is no need to pre-structure the document before you start. One pass through the material with `Alt+X` creates the structure organically.

### Tips for Sustainable Splitting

- **Err on the side of larger chunks first.** It is always easier to split a large rem into two than to merge two overly-granular ones. Start with chapters; refine into sections only when the chapter proves too long to read in one session.
- **Use the Priority System to sequence your splits.** Assign the most important chapter the highest priority. You will naturally split it more finely because you encounter it more often.
- **A rem that is "too long" is a signal, not a problem.** When you open a rem in the queue and feel you cannot make progress in one session, that is the cue to split it — right there, immediately, before hitting Next. Create two or three child rems from the headings you see, schedule the first, and dismiss the parent.
- **The parent rem is not wasted after splitting.** After its children are created and queued, apply the **Remove from Queue** powerup to the parent (via the `/rfq` command, or the editor command palette) to suppress it from the queue. Its children are now doing the work. *Requires the [Hide-in-Queue integration](Utilities.md#queue-display-utilities) enabled or the standalone Hide in Queue plugin installed.*

---

## Create Extract (`Alt+X` / `Alt+Shift+X`)

When reading a long Incremental Rem (a chapter, article, or section), you isolate the most important passage and turn it into its own Incremental Rem for deeper review later.

**How it works:**

1. Select the text you want to extract.
2. Press `Alt+X` (or `Alt+Shift+X` to set a specific priority immediately).
3. The plugin:
   - Creates a **child Rem** containing the selected text.
   - Highlights the original selection in **blue** in the parent Rem and inserts a **reference pin** (↗) next to it — clicking the pin navigates to the new child.
   - Adds a **back-reference pin** at the end of the child Rem pointing back to the parent, maintaining full traceability.
   - If the parent Rem was itself extracted from a **PDF highlight**, the child inherits a direct pin to the original PDF source as well.
   - **Hides the parent Rem from queue display** so its original slot is suppressed — the children take over. The mechanism depends on what's installed: if the **Remove from Queue** powerup is registered (via the [Hide-in-Queue integration](Utilities.md#queue-display-utilities) setting *or* the standalone Hide in Queue plugin), it's applied to the parent directly (survives extract relocation cleanly); otherwise the **Remove Parent** powerup is applied to the extract itself as a fallback (works for normal review, but if you later move the extract under a different parent, that new parent will be hidden too — see [Create Extract behavior](Utilities.md#create-extract-source-rem-hiding-behavior)).
   - Initializes the new Rem as an **Incremental Rem** (with `Alt+X`: inherited or default priority; with `Alt+Shift+X`: opens the Priority popup).

This process is called **"shredding"** a document: you pass through it incrementally, pulling out what matters and leaving the rest behind.

![Extract Selection Demo](assets/extract-selected-text.gif)

---

## Create Cloze (`Alt+Z` / `Alt+Shift+Z`)

While reading, you often encounter a key term, definition, or fact that you want to memorize — not just re-read. `Alt+Z` converts the selected text into a **cloze deletion flashcard** in the SuperMemo style.

> **`Alt+Shift+Z` — Create Cloze with Priority:** Identical to `Alt+Z`, but immediately opens the **Light Priority popup** after creating the cloze child Rem so you can review and optionally adjust the auto-computed Card Priority before saving.

### Auto-Priority Graduation

Both commands automatically assign a **Card Priority** to every new cloze, implementing the standard incremental reading workflow: the first fact you extract from a passage is the most important, so it should get the highest scheduling priority — which, since [lower numbers mean higher priority](Prioritization-&-Sorting.md#priority-value-absolute-priority), means the **lowest number**. Each successive cloze from the same extract is inherently less critical, so its number goes **up by one step**, ranking it below the ones before it.

**Formula:**

> `Card Priority = clamp(parentPriority + min(existingCount, 10) × stepSize, 0, 100)`

- **`parentPriority`** — resolved from the parent extract in order: IncRem priority → own Card Priority → ancestor IncRem/Card Priority → plugin default.
- **`existingCount`** — sum of two live counts read **before** the new cloze is created:
  - the parent's `#cloze-extract` children (clozes previously extracted from it as siblings of the new one), plus
  - the cards the parent rem owns itself — native cloze markers inside its text and front/back-direction cards if it is a flashcard.
  A first cloze from a plain text extract sees `existingCount = 0` and inherits the parent's priority exactly. A first cloze from a Concept/Descriptor extract (which already has 2 own cards) or from a rem that already contains native clozes starts with a non-zero count, reflecting that the material is already partially cardified.
- **`stepSize`** — how much the number moves per cloze, set by **[Priority Step Size](Plugin-Settings-Reference.md#priority)** (default: `5`). The same setting drives the [Quick Priority shortcuts](Prioritization-&-Sorting.md#quick-priority-shortcuts), so one value defines "one step" everywhere in the plugin.
- The count is **capped at 10 steps**, so even the 15th cloze from the same extract is only 10 steps below the parent — a long cloze session cannot push a card all the way to priority 100.

**Example** — parent extract at priority 30, step size 5:

| Cloze # | Existing clozes | Formula | Assigned priority |
|---|---|---|---|
| 1st (most important) | 0 | 30 + 0×5 | **30** |
| 2nd | 1 | 30 + 1×5 | **35** |
| 3rd | 2 | 30 + 2×5 | **40** |
| 11th and beyond | 10 (cap) | 30 + 10×5 | **80** |

**Choosing between the two variants:**

- **`Alt+Z`** — Applies the auto-priority silently and returns focus to the editor immediately. Best when you trust the computed value and want to stay in reading flow.
- **`Alt+Shift+Z`** — Opens the Light Priority popup pre-filled with the computed value. The popup shows a **parent extract context panel** (parent text, its priority with source label, existing cloze count, and the formula breakdown), so you can verify the calculation and override if needed. Best when the extract has an unusual priority or when you want deliberate control over the card's rank.

### What happens

1. Select the word or phrase to test yourself on.
2. Press `Alt+Z`.
3. The plugin:
   - Creates a **child Rem** as a standalone cloze flashcard.
   - The child's text contains the **full content of the parent Rem** (front and back, if it is a flashcard), with the card delimiter replaced by a directional arrow (`⇒`, `⇐`, or `⇔` — derived from the card's practice direction).
   - Any **existing cloze marks** in the parent's text are stripped from the child copy and re-marked with **yellow highlight + red font**, so you can see where other holes existed without them interfering with the new cloze.
   - The **selected text** is marked as the new **cloze deletion** in the child.
   - If the parent is a **Concept rem**, the front portion of the child is rendered in **bold**. If it is a **Descriptor**, it is rendered in **italic** — matching RemNote's native UI conventions.
   - A **back-reference pin** to the parent Rem is appended at the end of the child's text.
   - The parent's selection is marked with **yellow highlight + red font** to signal that this passage has already been cloze-extracted.
   - The new **cloze child Rem** is tagged with the **Remove Parent** powerup, so the parent (the extract) is hidden from queue display *only* while reviewing this specific cloze. Other flashcard descendants of the same parent (e.g. Descriptor children) still see the parent normally — see [Remove Parent](Utilities.md#remove-parent-rp-new) in Queue Display Utilities.
   - The child Rem receives a **`cloze-extract` tag**. In the Queue, this tag renders a small violet **↑** badge (hover for a tooltip) to identify its origin. **In the Editor**, these tagged clozes deliberately appear **less conspicuous** (faded, grayscaled, and zoomed out). This visual cue signals that the Rem merely contains material copied from a parent Rem for priority scheduling purposes, so you can safely skip past it when reviewing your notes.

### Visual result in the child Rem

> *The child inherits the full context.* If the parent says:
>
> `Navigation systems :: GPS cannot be relied upon alone`
>
> and you select "GPS", the child becomes:
>
> `Navigation systems ⇒ [GPS] cannot be relied upon alone ↗`
>
> where `[GPS]` is the cloze deletion and `↗` is the back-reference pin.

---

## Comparing `Alt+Z` (SuperMemo-style) with Native RemNote Clozes

RemNote has its own built-in cloze system — marking text with `{curly braces}` or via the cloze toolbar. The two approaches have distinct advantages:

### Native RemNote Clozes

- **Spoiler protection**: RemNote's scheduler automatically **buries** (hides for ~1 hour) other cards (clozes or front/back) from the same Rem after one is reviewed. This prevents you from accidentally getting spoiled on a related answer you haven't been tested on yet.
- **Compact**: Multiple clozes live inside a single Rem. No extra Rems are created.
- **Simpler workflow**: Just highlight and mark — no child Rem is generated.
- **Best for**: Dense material where multiple facts in a single sentence all need to be tested, and you trust RemNote's bury logic to prevent spoilers.

### `Alt+Z` SuperMemo-style Clozes

- **Standalone Rem**: Each cloze becomes its **own independent Rem** in the knowledge base. This means it has its own scheduling history, its own priority, and can be edited, simplified, or reorganized entirely independently of the parent.
- **Prioritized approach**: Each cloze carries its own [Card Priority](Priorities-for-Flashcards.md), and the plugin assigns it for you. Every new cloze taken from the same rem gets a priority **number one step higher** than the one before it — and since [lower numbers mean higher priority](Prioritization-&-Sorting.md#priority-value-absolute-priority), each successive cloze is scheduled as slightly *less* important than its predecessor. That matches how you actually read: the fact you cloze first is the one you judged most worth keeping. One step is the **[Priority Step Size](Plugin-Settings-Reference.md#priority)** setting (default `5`), the same step the [Quick Priority shortcuts](Prioritization-&-Sorting.md#quick-priority-shortcuts) use. The full rule — where the parent's priority comes from, what already counts as an existing cloze, and the 10-step ceiling — is in [Auto-Priority Graduation](#auto-priority-graduation) above.
- **Atomic by design**: Because the child is a separate Rem, and rewording it won't make you lose content (it already lives in the parent), you are naturally encouraged to make each card as atomic as possible. Over time, you can simplify the child's wording — removing irrelevant context — making it faster to review and easier to memorize.
- **Full context preserved**: The parent rem will continue to carry the whole content, so you are free to edit the child cloze fearlessly.
- **Best for**: The incremental approach, where you return to the same passage over several rounds and go one level deeper each time — the most important fact first, the finer detail later. Creating several clozes in one sitting does **not** put them on equal footing: with a parent at priority 30 and a step of 5, they come out at 30, 35, 40, … so the queue reaches them in the order you judged them, spread across sessions rather than bunched into one.

### Summary

| | Native RemNote Cloze | `Alt+Z` SuperMemo-style Cloze |
|---|---|---|
| Spoiler protection (bury) | Yes | No (each card is independent) |
| Standalone Rem | No | Yes |
| Individually schedulable | No | Yes |
| Can be simplified over time | No | Yes |
| Atomic card design | Encouraged by discipline | Structurally enforced |
| Number of Rems created | 0 (inline) | 1 per cloze |
| Back-reference to source | No | Yes (pin appended) |
| Visual queue badge | No | Yes (violet ↑ badge) |

The two approaches are **complementary**. Use native clozes for quick, spoiler-safe multi-cloze sentences. Use `Alt+Z` when you are reading incrementally and want each fact to stand on its own: ranked in the order you found it, arriving in the queue according to their priority rather than alongside its siblings, and free to be simplified over time — because the parent still holds the full context, nothing is lost when you cut the card down to its essentials.
