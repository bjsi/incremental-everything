# IncRem Scheduler

This page explains how the plugin calculates the **next review interval** each time you press **Next** on an Incremental Rem in the queue.

> [!NOTE]
> "Interval" here means _days until the next review **after** pressing Next_. This is separate from the **Initial Interval** setting, which controls how many days pass between tagging a Rem as incremental and its first appearance in the queue (before any review happens).

---

## Default Scheduler (Exponential)

The default scheduler uses a simple **exponential** formula:

```
interval = ⌈Multiplier ^ N⌉  days
```

where **N** is the review number (1st, 2nd, 3rd…) and **Multiplier** is a configurable setting (default `1.5`).

### Example progression (Multiplier = 1.5)

| Review | Exponent | Raw | Interval |
|--------|----------|-----|----------|
| 1st | 1.5¹ | 1.50 | **2 d** |
| 2nd | 1.5² | 2.25 | **3 d** |
| 3rd | 1.5³ | 3.38 | **4 d** |
| 5th | 1.5⁵ | 7.59 | **8 d** |
| 8th | 1.5⁸ | 25.63 | **26 d** |
| 10th | 1.5¹⁰ | 57.67 | **58 d** |

### Strengths

- Extremely simple — only one setting to tune.
- Grows naturally for items you only need to revisit a few times.

### The problem with pure exponential growth

Incremental Rems cover a **wide range of processing depth**. A single Rem may be:

| Stage | Example | Typical reviews |
|-------|---------|-----------------|
| 📕 Raw import | An entire PDF book | 20–50+ |
| 📄 First extract | A chapter or section | 10–20 |
| 📝 Refined extract | A paragraph | 5–10 |
| 💡 Atomic fact | A sentence to cloze | 2–4 |

With the default scheduler:

- **Books/chapters (many reviews needed):** After the 8th review the interval is already **26 days** and keeps growing. This means you'll barely touch the material, making it nearly impossible to finish processing.
- **Single sentences (few reviews needed):** The early intervals might feel too short (2 → 3 → 4 days) when you've already extracted the key idea and just want to space things out.

---

## Beta Scheduler — Saturating Curve ✨ { #beta-scheduler }

> Enable this via **Settings → Use Beta Scheduler (Saturating Curve)**.

The beta scheduler solves both problems with a **saturating curve** that:

1. **Starts at a comfortable interval** you choose (default **5 days**).
2. **Gradually approaches a ceiling** you set (default **30 days**), growing slower the closer it gets.
3. **Never exceeds the ceiling**, so high-volume items are always revisited in time.

### Formula

```
interval = ⌈ firstReviewInterval + (maxInterval − firstReviewInterval) × (N−1) / (N−1+4) ⌉
```

The constant `4` controls how quickly the curve saturates: by review 5 you're **halfway** between your first-review interval and the max.

### Example progression (First Review Interval = 5, Max Interval = 30)

| Review | Fraction | Interval |
|--------|----------|----------|
| 1st | 0 % | **5 d** |
| 2nd | 20 % | **10 d** |
| 3rd | 33 % | **14 d** |
| 4th | 43 % | **16 d** |
| 5th | 50 % | **18 d** |
| 6th | 56 % | **19 d** |
| 8th | 64 % | **21 d** |
| 10th | 69 % | **23 d** |
| 15th | 78 % | **25 d** |
| 20th | 83 % | **26 d** |

### Why one global setting works for all item types

Because the curve **saturates**, the same settings naturally adapt to different items:

- **Books and chapters**: You can do 20+ reviews and the interval stays under your Max. You'll reliably come back often enough to continue processing.
- **Single sentences**: The first interval is already 5 days (not 2), giving you room to breathe before the next review, especially when you've already made a cloze deletion.
- **Everything in between**: The curve automatically adapts — early reviews grow quickly, later reviews settle into a steady rhythm.

---

## Settings Reference

| Setting | Type | Default | Scheduler | Description |
|---------|------|---------|-----------|-------------|
| **Initial Interval** | Number | `1` | Both | Days before a **new** IncRem first appears in the queue (before any review). |
| **Multiplier** | Number | `1.5` | Default | Base of the exponential formula (`Multiplier ^ N`). Ignored when the Beta Scheduler is enabled. |
| **Use Beta Scheduler** | Boolean | `false` | — | Toggle between the default exponential and the beta saturating curve. |
| **First Review Interval** | Number | `5` | Beta | Interval in days after the **first** review. |
| **Max Interval** | Number | `30` | Beta | Ceiling the interval gradually approaches but never exceeds. |

---

## Why we do not adopt A-Factors

SuperMemo brings in its [documentation](https://help.supermemo.org/wiki/Incremental_learning):

>The algorithm for determining inter-review intervals for **topics** is much simpler and is entirely under your control. Each article receives a specific priority. The priority determines which articles are reviewed first and which can be postponed in case you run out of time. Each article is also assigned a number called the **A-Factor** that *determines how much intervals increase between subsequent reviews*. For example, if A-Factor is 2, review intervals will double with each review. Priority and A-Factors are set automatically, but you can change them manually at any time. Priorities and A-Factors are determined and modified heuristically on the basis of the length of the text, the way it is processed, the way it is postponed or advanced, and by many other factors.

As we understand it, SuperMemo uses A-factor for topics (passive material, analogous to our IncRems) only because, when they implemented Topics and Incremental Reading, they decided to use the same frame already existing for items (flashcards), that, at that time, had this so called Absolute Difficult Factor governing the scheduling. But there is no theoretical ground to support an element-based (or IncRem based) multiplier. Science proved that spacing reviews of a given study subject improves learning and memory retention compared to massed practice. But the optimum interval theory is applicable only to active recall items (flashcards). Theoretically speaking, there is no such a thing as an "optimum interval" for passive reading. So, the aim to be achieved is a scheduler convenient enough to cope with the diverse learning situations and needs in a satisfactory way.

We evaluated that implementing an IncRem level set multiplier would be too complex and bring few value, as we already have the [Reschedule](Reviewing-Items-in-the-Queue.md#Reschedule) feature, where the user can set an arbitrary interval length, and as we have implemented the Beta Scheduler aiming to achieve larger initial intervals and also cap intervals when they get too long (this way catering with the most commom and general needs).

---

## Scheduling and the Queue

The scheduler described above determines **when** an Incremental Rem becomes due again. But once an item is due, how does the queue decide which item to show you first?

### Due Date is a Yes/No Gate

The due date is **not** a ranking factor. The queue does not care about *how overdue* an item is — whether it was due 1 hour ago or 3 months ago makes no difference. The due date serves purely as a **binary filter**:

- **Due** (`Date.now() >= nextRepDate`) → the item enters the pool of candidates.
- **Not due** → the item is excluded entirely.

An item that has been overdue for months receives no special treatment over an item that became due just now. This is by design: in the context of passive reading material, there is no meaningful "urgency" metric tied to overdue time the way there is for flashcards.

### Priority is the Sole Sorting Criterion

Among all items that pass the due-date filter, the queue sorts them strictly by **Priority** (lower number = higher priority). A Priority 5 item will always appear before a Priority 30 item, regardless of how long either has been waiting.

### Controlled Randomness

After sorting by priority, the [Sorting Randomness](Prioritization-&-Sorting.md#sorting-criteria) setting introduces a configurable degree of shuffling:

- **0% randomness**: The queue is fully deterministic — always the highest-priority due item first.
- **20% randomness** (default) **and above**: A slice of the sorted list is randomized via a [priority-weighted lottery](Prioritization-&-Sorting.md#how-randomness-works-the-priority-weighted-lottery) — lower-priority items get a chance to surface, but the items pulled forward are drawn in proportion to their priority weight (not uniformly). This prevents the queue from becoming too rigid while keeping the priority gradient intact, so **higher settings stay safe**. *(Note: the slider is non-linear and eases in, so the left portion finely tunes small amounts while the middle reaches a meaningful ~25%.)*

### See Also

- [How the Incremental Queue takes priority and due date in consideration](How-the-Incremental-Queue-takes-priority-and-due-date-in-consideration.md)
- [Does the plugin prioritize items that are due today over older items?](Does-the-plugin-prioritize-items-that-are-due-today-over-older-items%3F.md)
