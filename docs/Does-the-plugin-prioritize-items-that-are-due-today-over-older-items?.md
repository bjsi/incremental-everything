>  Does the plugin still prioritise items that are due today over older items? This always caused my older items to get buried and never surface again. (username Morte_, Sept 19, 2025, Reddit)

No, the plugin is designed to prevent older, overdue items from getting buried. The primary factor for sorting is the **Priority** value you set on a Rem, not how long it has been due. You also have direct control over the queue's predictability via the "[Sorting Randomness](Prioritization-&-Sorting.md#sorting-criteria)" setting.

---
### How the Plugin Prioritizes Due Items

Here is a complete breakdown of how the plugin decides which incremental item to show you next. The process balances strict priority with controlled variability.

1.  **Sorts All Items by Priority First**
    The plugin begins by gathering *all* of your incremental rems—both due and not yet due—and sorts them into a master list. This initial sort is based purely on the **Priority** value you have set. Items with a lower number are considered higher priority and are moved to the front of the line. The due date is completely ignored during this step.

2.  **Filters for Due Items**
    Next, the plugin takes this priority-sorted list and filters it down, keeping only the items that are currently ready for review. It does this by checking if an item's `nextRepDate` is today or any day in the past. The result is a perfectly ordered list of all your due items, with the highest-priority ones at the top.

3.  **Applies Controlled Randomness (The Priority-Weighted Lottery)**
    This is where the "[Sorting Randomness](Prioritization-&-Sorting.md#sorting-criteria)" setting comes into play. After creating the perfectly sorted list of due items, the plugin randomizes a portion of it.
    * **At 0% randomness:** No shuffling occurs. The list remains perfectly sorted by priority, and the plugin will deterministically show you the highest-priority due item.
    * **At 20% (the default) and above:** The plugin randomizes a slice of the list via a **[priority-weighted lottery](Prioritization-&-Sorting.md#how-randomness-works-the-priority-weighted-lottery)**. Rather than blind swaps, the items pulled forward are drawn with probability proportional to their priority weight, so a higher-priority (but lower-ranked) item is far more likely to surface than a deep, low-priority one — while every item keeps a real, non-zero chance. This preserves strict priorities with a controlled bit of serendipity, and because it is priority-weighted, **higher settings stay safe**. *Note: the slider is non-linear (eases in), so the left portion finely tunes small amounts while the middle reaches a meaningful ~25%.*

4.  **Selects the Top Card**
    Finally, the plugin picks the item at the very top of this final, potentially shuffled list and presents it to you in the queue.

---
### Summary

To address your concern directly: by default, older items will **not** get buried. The system is built to surface your highest-priority due material first, regardless of how long it has been overdue. The **[Sorting Randomness](Prioritization-&-Sorting.md#sorting-criteria)** setting is a tool that allows you to introduce variability, preventing the queue from becoming too rigid and ensuring that even lower-priority items get a chance to surface over time.

---
### See Also
* [How the Incremental Queue takes priority and due date in consideration](How-the-Incremental-Queue-takes-priority-and-due-date-in-consideration.md)
* [IncRem-Scheduler#scheduling-and-the-queue](IncRem-Scheduler.md)