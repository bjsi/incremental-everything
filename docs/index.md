<p align="center">
  <img src="assets/inc-logo.png" width="400" alt="Incremental Everything Logo" />
</p>

> **Review notes, PDFs, Youtube videos and web articles incrementally alongside your flashcards, and tackle overload by prioritizing your learning.**

Welcome to the official **User's Manual** for the **Incremental Everything plugin** for RemNote!

This Wiki is your comprehensive guide to mastering a powerful learning technique inspired by SuperMemo's Incremental Reading. Whether you want to read books and articles in parallel, watch videos incrementally, or manage your writing projects more effectively, this plugin allows you to seamlessly interleave all of your learning material directly into your daily flashcard queue.

Use the pages in this manual to guide you from your first steps to advanced workflows. Let's get started!

___

### 🎥 Videos about the basics

- **Introductory Videos**: 
  * [Incremental Reading Web Pages in RemNote](https://youtu.be/eXRlfCTOQNw)
  * [Incremental Reading in RemNote](https://youtu.be/SL7wjgntrbg)

- **Priorities Playlist**: [Prioritization in Incremental Everything](https://www.youtube.com/playlist?list=PLpmcfTqNVuo9DWjeIrMZZfG140kOZD8Tl) – Covers setting priorities, inheritance, the Priority Shield, creating Priority Review Documents, and how to use prioritization to manage information overload.  

- **What is Incremental Reading?**: [Incremental Journey - Incremental Reading in Simple Terms](https://youtu.be/V4xEziM8mco)

___

See the latest changes and improvements in our [Changelog](Changelog.md).

---

# 🚀 Incremental Everything: Your Complete Learning System is Here

**TL;DR:** The plugin now delivers a complete learning workflow from first encounter with material to lifetime retention, with robust prioritization to handle information overload. Works seamlessly on mobile too!

---

Hey RemNote community! 👋

I'm excited to share that **Incremental Everything (Plus)** has reached a major milestone. Since implementing flashcard priorities in v0.2.0, I've been focused on completing the missing pieces of the learning puzzle. The result? A comprehensive system that handles the entire learning lifecycle while giving you the tools to manage the inevitable information overflow.

## 🎯 What Makes This Complete Now?

### The Full Learning Flow

**1. First Contact → Acquisition (Incremental Reading)**
- Import PDFs, articles, and reading material into your queue
- Read actively using page-by-page control with rem-specific progress tracking
- Extract insights and create flashcards as you read
- Priority system ensures you process your most important material first

**2. Active Processing → Understanding (Mixed Review)**
- Alternate between passive reading (IncRems) and active recall (flashcards) in a single session
- **[Priority Review Documents](Priority-Review-Document.md)** let you create custom study sessions mixing both types
- Study your top 50-100 priority items when facing thousands of due cards
- Everything sorted by priority, not just chronologically

**3. Long-term → Mastery (Spaced Repetition)**
- Flashcards inherit priorities from their parent notes
- High-priority cards get preferential review scheduling (through the [Priority Review Document](Priority-Review-Document.md))
- **[Priority Shields](Prioritization-&-Sorting.md#priority-shield)** track whether you're keeping up with critical material
- Manual priority override for any card or note

### The Prioritization Solution

Here's the reality of serious learning: **you will always have more to learn than time available**. Traditional SRS systems ignore this, treating all due cards equally. Incremental Everything embraces it:

- **Dual Priority Systems**: Separate priorities for reading material (IncRems) and [flashcards](Priorities-for-Flashcards.md)
- **[Inheritance by Default](Prioritization-&-Sorting.md#priority-inheritance-system)**: Child cards inherit priorities from parent notes automatically
- **[Priority Shields](Prioritization-&-Sorting.md#priority-shield)**: Visual feedback showing your capacity to keep up with high-priority reviews (both absolute priority and relative percentile)
- **Comprehensive Scope**: Priorities work across documents, portals, backlinks, and folder queues
- **[Priority Review Documents](Priority-Review-Document.md)**: Generate focused review sessions of your top N items when overwhelmed

### Managing the Overflow

The breakthrough feature is **[Priority Review Documents](Priority-Review-Document.md)**. When you have 5,000 due cards:

1. Press `Opt+Shift+R` (Mac) / `Alt+Shift+R` (Windows/Linux)
2. Select your scope (document/folder or full KB)
3. Choose item count (e.g., 100) and flashcard/IncRem ratio (e.g., 6:1)
4. Review a manageable session of your **highest-priority** items
5. Rest assured that your critical knowledge is protected

The priority shield graphs show you exactly how well you're keeping up with important material over time. If you're consistently processing only the top 4% of priority material, you'll see that reflected—and can adjust your workflow accordingly.

## 📱 Now Mobile-Ready!

**v0.2.9** adds automatic Light Mode switching for iOS/Android:
- Prevents mobile crashes from resource-intensive features
- Auto-detects your device and adjusts performance mode
- Desktop still gets full feature set
- Seamless experience across all devices

## 🎨 [Performance Modes](Full-Mode-x-Light-Mode.md)

**Light Mode** (default, recommended for web/mobile):
- Manual priority tools for flashcards
- Fast, stable performance
- Essential features only

**Full Mode** (Desktop App recommended):
- Automatic priority inheritance and caching
- Relative priority percentiles
- Priority shield tracking with universe size
- Background pre-tagging of flashcards
- Complete feature set

## 💡 Why This Matters for SRS Enthusiasts

If you're familiar with Anki or any SRS system (except SuperMemo), you know the pain:
- **Queue explosion** when life gets busy
- **All-or-nothing** review sessions
- **No way to triage** when overwhelmed
- **Guilt** over skipped reviews

Incremental Everything solves this by:
- ✅ **Guaranteeing** high-priority items get reviewed
- ✅ **Mixing** acquisition and retention in one flow
- ✅ **Tracking** your capacity with [priority shields](Prioritization-&-Sorting.md#priority-shield)
- ✅ **Providing** escape hatches ([Priority Review Documents](Priority-Review-Document.md)) when overwhelmed

The minimum cost comes from intelligent prioritization—you spend your limited study time on what matters most, not on whatever happens to be due today.

## 🔧 Technical Highlights

- Comprehensive scope calculation (descendants, portals, backlinks, sources, table views inside the document)
- Session-based caching for instant queue performance
- Smart priority inheritance algorithms
- Historical priority shield tracking with universe size
- Batch priority assignment tools
- Dark mode support throughout

## 🎓 Who Is This For?

- Students managing multiple courses/subjects
- Researchers tracking literature
- Professionals building knowledge bases
- Anyone serious about long-term learning
- People who've felt overwhelmed by their SRS queue

## 🚀 Getting Started

1. Install **Incremental Everything (Plus)** from RemNote plugin library
2. Tag any rem with `#Incremental` (using [Alt+X or Alt+Shift+X](Keyboard-Shortcuts.md#core-commands)) to add it to your reading queue
3. [Set priorities](Prioritization-&-Sorting.md#main-priority-popup) ([Alt+P](Keyboard-Shortcuts.md#priority-commands)) on important material
4. Enter queue and [start reviewing](Reviewing-Items-in-the-Queue.md)
5. Use [Priority Review Documents](Priority-Review-Document.md) when overwhelmed

### 📱 Mobile Users (iOS/Android)
The plugin now features **[Automatic Light Mode](Full-Mode-x-Light-Mode.md)**. When you open RemNote on a mobile device, the plugin detects this and switches to "Light Mode" (disabling some background calculations like pre-tagging to prevent crashes). This ensures a smooth experience on your phone while keeping the full power on your desktop.

The workflow is designed to grow with you—start simple, add complexity as needed.

## 🙏 Feedback Welcome

This represents months of iteration to build a complete learning system. I'd love to hear from the community:
- What workflows are you using?
- What features would enhance your process?
- How are you handling information overload?

The goal is to make RemNote the ultimate tool for serious, long-term learners. Let me know what you think!

**Where to reach us:**

- **[GitHub Issues](https://github.com/bjsi/incremental-everything/issues)** — bug reports and feature requests. Best for anything that needs tracking down, since an issue keeps its history.
- **[The plugin's thread on RemNote's Discord](https://discord.com/channels/689979930804617224/1201559830431809566)** — questions, workflows and general discussion with other users.


Happy learning! 📚✨

---

## Planned User's Manual Structure

*We will make these contents available incrementally!* 


* **1. [Getting Started](Getting-Started.md)**
    * **Purpose:** The first stop for any new user.
    * **Content:**
        * How to install the plugin.
        * Making a Rem incremental (slash command, shortcuts, menu).
        * Reviewing Incremental Rems in the queue (answer buttons overview).
        * Dismissing and re-activating Rems (with history preservation).
        * Using the [Repetition History widget](Getting-Started.md#repetition-history-statistics).
        * Setting priorities basics.

* **2. The Philosophy: [What is Incrementalism?](What-is-Incrementalism%3F.md)**
    * **Purpose:** To explain the "why" behind the plugin. "Flow of incremental reading" explained.
    * **Content:**
        * A brief introduction to the concepts of Incremental Reading, Writing, and Video.
        * Explain the benefits: avoiding burnout, fostering creativity, and tackling large volumes of material in parallel.

* **3. The Core Loop**
    * **3.1 [IR Flow: Reading, Extracting & Clozing](IR-Flow--Reading-Extracting-and-Clozing.md)**
        * **Purpose:** The SuperMemo-inspired IR loop — how to break down documents into Extracts (`Alt+X`) and convert key passages into standalone Cloze flashcards (`Alt+Z`). Includes a comparison between SuperMemo-style clozes and native RemNote clozes.

    * **3.2 [Reviewing Items in the Queue](Reviewing-Items-in-the-Queue.md)**
        * **Purpose:** This is the main "how-to" guide for daily use. Button functions explained.
        * **Content:** A guide to the Answer Buttons bar.
            * **[Next](Reviewing-Items-in-the-Queue.md#next):** How it works and what the interval text means.
            * **[Reschedule](Reviewing-Items-in-the-Queue.md#reschedule):** How to manually set a new interval.
            * **[Dismiss](Reviewing-Items-in-the-Queue.md#dismiss):** How to finish an item and remove it from the queue.
            * **[Change Priority](Reviewing-Items-in-the-Queue.md#change-priority):** Its basic function of opening the priority menu.
            * **[Review & Open](Reviewing-Items-in-the-Queue.md#review-in-editor):** The workflow for moving from the queue to the editor.
            * **[Scroll to Highlight](Utilities.md#scroll-to-highlight):** Its function for PDF extracts.
            * **[Strategic Guide to the Answer Buttons](Reviewing-Items-in-the-Queue.md#a-strategic-guide-to-the-answer-buttons):** In-depth explanation of when to use each action.

    * **3.3 [Reviewing Items in the Editor](Reviewing-Items-in-the-Editor.md)**
        * **Purpose:** Process complex items outside of the queue with maximum flexibility.
        * **Content:**
            * **Execute Repetition Command:** Register reviews directly in the editor without using the queue.
            * **Sequential Review via IncRem List:** Learn how to "Sort for Review" in a table view and sequentially process items using the Editor Review Timer's "Next" button.

* **4. Mastering the Queue: [Prioritization-&-Sorting](Prioritization-&-Sorting.md)**
    * **Purpose:** Explain the priority and sorting menus in a comprehensive guide for advanced queue management.
    * **Content:**
        * **[Prioritization-&-Sorting#the-priority-system-explained](Prioritization-&-Sorting.md#the-priority-system-explained):** Why priority is important.
        * **[Prioritization-&-Sorting#priority-inheritance-system](Prioritization-&-Sorting.md#priority-inheritance-system):** when you create a new incremental rem, it automatically inherits the priority of its closest parent or ancestor that is also an incremental rem.
        * **The [Prioritization-&-Sorting#set-priority-popup](Prioritization-&-Sorting.md#main-priority-popup):** A detailed breakdown of the redesigned popup, explaining the absolute vs. relative sliders and the color gradient.
        * **The [Prioritization-&-Sorting#sorting-criteria](Prioritization-&-Sorting.md#sorting-criteria) Menu:** An explanation of the Flashcard Ratio and Randomness sliders and how they affect what you see in the queue — including the [Prioritization-&-Sorting#how-randomness-works-the-priority-weighted-lottery](Prioritization-&-Sorting.md#how-randomness-works-the-priority-weighted-lottery) that makes randomness favor higher-priority items instead of spreading it flat.
        * **The [Prioritization-&-Sorting#priority-shield](Prioritization-&-Sorting.md#priority-shield):** diagnostic tool to help you understand and manage your learning process, giving you a clear, numerical value for your "Priority Protection" — your capacity to process high-priority material on any given day and over time.
        * **[Priorities for Flashcards](Priorities-for-Flashcards.md):** understand how can you benefit from this plugin to manage overload of due flashcards. It will allow you to intelligently focus on what is most important with only a few manual prioritization inputs, giving you confidence even when your backlog remains large.
        * **The [Priority Review Document](Priority-Review-Document.md):** this is the only reason for having a flashcard priority system. This priority review document is an intermediate step necessary to give you the ability to select flashcards by priority.
        * [Prioritization-&-Sorting#how-the-plugin-prioritizes-due-items](Prioritization-&-Sorting.md#how-the-plugin-prioritizes-due-items)

* **5. Advanced Workflows & Use Cases**
    * **Purpose:** Practical, step-by-step guides for specific tasks.
    * **Content:**
        * **Incremental Reading** with PDFs
          * [PDF Incremental Reading Workflow](PDF-Incremental-Reading-Workflow.md)
          * [Create Incremental Rem from PDF Highlights](Create-Incremental-Rem-from-PDF-Highlights.md)
        * **Incremental Reading** with web pages.
        * **[Incremental Video](Incremental-Video.md)**: Watch YouTube videos incrementally, create timed extracts, and auto-transcribe segments.
        * **[IncRem-List-and-Main-View](IncRem-List-and-Main-View.md)**: Browse, filter, and manage your Incremental Rems outside the queue. Includes the Review in Editor flow and the KB Priority Distribution Graph.
        * Tips for **Incremental Writing**.
        * How to use document/folder-specific queues for **Subset Review**.
        * **[History-Queue-Dashboard-and-Mastery-Drill](History-Queue-Dashboard-and-Mastery-Drill.md)**: Track session history, monitor real-time study metrics, find recently reviewed cards, and deliberately re-practice difficult material with the Mastery Drill.

* **6. Essential References**
    * **Purpose:** A complete index of the plugin's visual and functional capabilities.
    * **Content:**
        * **[Plugin Widgets Reference](Plugin-Widgets-Reference.md)**: Comprehensive visual manual of all widgets (History, Graphs, Trackers, etc).
        * **[Plugin Commands Reference](Plugin-Commands-Reference.md)**: Complete list of all keyboard and palette commands registered in RemNote by the plugin.
        * **[Plugin Settings Reference](Plugin-Settings-Reference.md)**: Every configurable option explained, with defaults and context.
        * **[IncRem Scheduler](IncRem-Scheduler.md)**: How the plugin calculates review intervals — default exponential and beta saturating schedulers explained.
        * **[Keyboard Shortcuts](Keyboard-Shortcuts.md)**: Quick cheatsheet mapping essential actions to default keys.
        * **[Utilities](Utilities.md)**: Additional tools built into the plugin, such as the Word-like Text Case Converter (Shift+F3), Restructure Outline by Headings (`roh`) for fixing flat or mis-pasted documents, and **Find Rem — Reference or Open** (`Opt+Shift+F`) for referencing/opening Rems that RemNote's own search can't find.

* **7. FAQ & Troubleshooting**
    * **Purpose:** A crucial section to help users solve common problems.
    * **Content:**
        * [How the Incremental Queue takes priority and due date in consideration](How-the-Incremental-Queue-takes-priority-and-due-date-in-consideration.md)
        * [Does the plugin prioritize items that are due today over older items?](Does-the-plugin-prioritize-items-that-are-due-today-over-older-items%3F.md)
        * [How to hide card priorities?](How-to-hide-card-priorities%3F.md)
        * **[Troubleshooting](Troubleshooting.md)**: 
          * [Jump to Rem by ID](Troubleshooting.md#jump-to-rem-by-id-user-guide)
          * [Pre-compute Card Priorities - Error Guide](Troubleshooting.md#pre-compute-card-priorities-error-guide)
          * [Rogue CardPriority Tags Sanitization](Troubleshooting.md#rogue-cardpriority-tags-sanitization)
          * [PDF Highlight Repair Tool](Troubleshooting.md#pdf-highlight-repair-tool)
          * [Page History Diagnostic & Cleanup](Troubleshooting.md#page-history-diagnostic-cleanup-debug-widget)
          * [Search / Linkage Diagnostics](Troubleshooting.md#search-linkage-diagnostics-debug-widget)

* **8. [Changelog](Changelog.md)**
    * **Purpose:** Detail the history of updates.

* **9. [Contributing to the Wiki](Contributing-to-the-Wiki.md)**
    * **Purpose:** Guidelines on how to suggest changes or submit updates to this documentation.
