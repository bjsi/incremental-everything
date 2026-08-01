> I do wonder - because there is priority and due date - how is next element in Incremental Queue prioritised? does it take priority first and then what is "due" the most? (@kamilsien on Discord, March 3, 2026)

To answer your question directly: 

The queue prioritizes items in the following way:

1. **Due Date (Filter)**: First, it looks at the Due Date. It filters out any Incremental Rem that is *not* due yet. It only considers items where the due date is today or in the past (`Date.now() >= nextRepDate`).
2. **Priority (Sort)**: Then, among all the items that *are* currently due, it sorts them strictly by **Priority** (e.g., Priority 1 comes before Priority 10).

**Key Takeaway**: 
It does **not** care about "what is due the most" (i.e., how overdue an item is). If two items are both due right now, it will always show the one with the higher priority (lower number), regardless of which one has been overdue for longer  (strictly speaking, it will also apply the degree of randomness of your Sorting Criteria). Due date is purely a yes/no filter to let the item into the queue.

---
### See also
* [Does the plugin prioritize items that are due today over older items?](Does-the-plugin-prioritize-items-that-are-due-today-over-older-items%3F.md)
* [IncRem-Scheduler#scheduling-and-the-queue](IncRem-Scheduler.md)
