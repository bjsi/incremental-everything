# Incremental Everything

![Incremental Everything Logo](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/inc-logo.png)

🇪🇸 [Español](https://github.com/bjsi/incremental-everything/blob/main/README_ES.md) | 🇧🇷 [Português Brasileiro](https://github.com/bjsi/incremental-everything/blob/main/README_PT-BR.md)


**A Complete Learning System for RemNote.**

Incremental Everything allows you to interleave your flashcard reviews with notes, books, websites, and videos. Heavily inspired by SuperMemo's [Incremental Reading](https://supermemo.guru/wiki/Incremental_reading), it transforms RemNote into a powerful lifelong learning tool that handles the entire lifecycle of knowledge: **Acquisition → Processing → Mastery**.

## 🚀 Features

### The Core Loop
- **Incremental Reading**: Read and review 1000s of notes, books, and websites in parallel. [Learn more](https://www.youtube.com/watch?v=oNCLLNZEtz0).
- **Incremental Writing**: Write your essays and blog posts incrementally to maximize creativity. [Learn more](https://www.youtube.com/watch?v=LLS_8Y744lk).
- **Incremental Video**: Watch and take notes on your YouTube video backlog.
- **Incremental Tasks**: Clear out your tasklist between flashcard reviews.

### 🧠 Advanced Prioritization
Manage information overload with a robust dual-priority system:
- **Absolute & Relative Priorities**: Prioritize items from 0-100 and see exactly where they rank.
- **Priority Inheritance**: New extracts and flashcards automatically inherit the priority of their source material.
- **Priority Shield & Weighted Shield**: Diagnostic tools showing your capacity to process high-priority material and the fraction of your total priority-weighted queue processed.
- **FSRS Analytics**: Real-time Difficulty (D), Stability (S), and Retrievability (R) statistics computed for flashcards.
- **Priority Review Documents**: Generate focused study sessions for your top items when overwhelmed.

### 📊 History, Dashboard & Mastery Drill *(new in v0.2.182)*
A full suite of history and practice tools now built into the right sidebar:
- **Visited Rem History**: jump back to any document you navigated to recently.
- **Flashcard History**: find and open any flashcard you've reviewed, searchable by front and back text.
- **Practiced Queues Dashboard**: real-time session metrics (speed, retention, card age) and a full history of every practice session, with Export/Import backup.
- **Mastery Drill**: a focused re-practice queue for cards you rated *Forgot* or *Hard* — inspired by SuperMemo's Final Drill. Open with the `Mastery Drill` command or via the Left Sidebar notification.

👉 [Full documentation on the wiki](https://github.com/bjsi/incremental-everything/wiki/History-Queue-Dashboard-and-Mastery-Drill)

### 📱 Performance Modes
- **Light Mode (Default for Mobile/Web)**: Fast, stable, and essential features only. Prevents crashes on phones and tablets.
- **Full Mode (Desktop Power User)**: Complete feature set with heavy statistical calculations for detailed analytics.

## Installation

- Open the [RemNote plugin store](https://www.remnote.com/plugins), search for "Incremental Everything" and install the plugin.

## 📚 Documentation & Support

This README covers the basics. For the comprehensive guides, please visit the **User's Manual**:

👉 **[Incremental Everything Wiki](https://github.com/bjsi/incremental-everything/wiki)**

### 🎥 Videos about the basics

- **Introductory Videos**: 
  * [Incremental Reading Web Pages in RemNote](https://youtu.be/eXRlfCTOQNw)
  * [Incremental Reading in RemNote](https://youtu.be/SL7wjgntrbg)

- **Priorities Playlist**: [Prioritization in Incremental Everything](https://www.youtube.com/playlist?list=PLpmcfTqNVuo9DWjeIrMZZfG140kOZD8Tl) – Covers setting priorities, inheritance, the Priority Shield, creating Priority Review Documents, and how to use prioritization to manage information overload.

- **What is Incremental Reading?**: [Incremental Journey - Incremental Reading in Simple Terms](https://youtu.be/V4xEziM8mco)

### Useful Links
- **[Changelog](https://github.com/bjsi/incremental-everything/wiki/Changelog)**: See the latest features and updates.
- **[Discord](http://bit.ly/RemNoteDiscord)**: Join the community and chat with us (look for the plugin channels).


## Usage

### Getting Started
1. **Make Incremental**: Make any Rem, PDF, or Website `Incremental` using the `/Make Incremental (Extract)` command (Shortcut: `Alt+X`).
   * **Extract Selection**: If you have text selected, `Alt+X` will extract that specific piece into a new child Rem and link it back.

![Make Incremental using the command](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/tag-inc-rem.gif)

2. **Prioritize it**: Use `Alt+P` or `Alt+Shift+X` (Extract with Priority) to set its importance.
3. **Copy/Paste Sources**: Efficiently link multiple chapters to one PDF using `Ctrl+Shift+F1` (Copy) and `Alt+Shift+V` (Paste).
4. **Create Flashcards**: Use `Alt+Z` to quickly create a **Cloze Deletion** from selected text.
5. **Review it**: The plugin interleaves these items into your regular flashcard queue.
6. **Disable it**: Remove the `Incremental` tag or press the **Dismiss** button in the queue if you are done reviewing it.

### ⚡ Prioritization & Sorting
- 0 is for your most important material and 100 is for the least important.
- **Change Priority**: Click the button in the queue or press `Alt+P` to open the full priority popup.
- **Quick Shortcuts**: Use `Ctrl+Opt+Up` / `Ctrl+Opt+Down` to adjust priority instantly without breaking flow.
- **Sorting Criteria**: Use the queue menu to adjust the balance between **Structure** (strict priority) and **Exploration** (randomness), and control the ratio of Flashcards to Reading material.

### Scheduling

- **Default Scheduler**: Uses an exponential formula — `interval = ⌈Multiplier ^ N⌉` days (multiplier defaults to 1.5). Simple and effective for items needing few reviews.
- **Beta Scheduler (Saturating Curve)**: An opt-in alternative where intervals start at a configurable *First Review Interval* (default 5 days) and gradually approach a *Max Interval* (default 30 days). Ideal for items needing many reviews (books, chapters). See the [IncRem Scheduler](https://github.com/bjsi/incremental-everything/wiki/IncRem-Scheduler) wiki page for details.
- You can manually set the next repetition date using the **Reschedule** command (**Ctrl+J**), or RemNote's tables and properties features.

### 📱 Mobile Support
The plugin now features **Automatic Light Mode**.
- When you open RemNote on iOS or Android, the plugin automatically switches to "Light Mode".
- This disables heavy background calculations to ensure a crash-free experience on mobile devices.
- Your desktop experience remains fully featured.

### Incremental Reading

- You can tag PDFs, websites and highlights with the `Incremental` tag to do classic SuperMemo-style incremental reading.
- It will work if you tag the PDF or website itself, a Rem with a single PDF or website as a source, or a Rem with multiple sources where exactly one PDF has the `#preferthispdf` tag.
- The plugin will render the PDF or website reader view inside the queue.
- If you want to turn a highlight into an incremental Rem, click on the highlight and click the puzzle piece icon.
- 📄 **PDFs & Web**
  - **Visual Status**: Highlights turn **Green** when toggled as Incremental, and **Blue** when extracted.
  - **PDF Control Panel**: Manage chapters, set page ranges, and view reading history for long documents.
  - **Position Tracking**: The plugin automatically saves your last read page when using the PDF Chapter workflow or creating extracts.
  - **Create Incremental Rem**: Select text in a PDF -> Highlight it -> Click the Funnel Icon -> **"Create Incremental Rem"**. This extracts the text to a new Rem under a parent of your choice (using the smart parent selector).

![PDF Highlight Toolbar](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/pdfhighlight-toolbar.png)

![Highlight](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/highlight.gif)

### Incremental Writing

- You can tag any normal Rem with the `Incremental` tag to turn it into an incremental Rem.
- The plugin will render it as a normal Rem in the document view in the queue.

### Incremental Video

- You can tag YouTube videos with the `Incremental` tag to watch them incrementally.
- It will work if you tag the link Rem itself, or a Rem with the YouTube link as a source.
- **Video Extracts**: Create precise sub-clips with specific start/end timestamps, each with its own schedule and priority.
- **Auto-Transcription**: Automatically fetch YouTube transcripts for extract ranges to make content searchable and ready for clozing. [P.S.: Currently down after YouTube recent anti-bot measures]
- The plugin will automatically save your progress and playback rate.
- You can open the resizable notes section on the left to take notes while you watch.

![Incremental Video](https://raw.githubusercontent.com/wiki/bjsi/incremental-everything/assets/YT-extract-mode.png)

### Incremental Mathematics

- A quick example of plugin interoperability.
- Integrates with my [Lean theorem prover plugin](https://github.com/bjsi/remnote-lean) to schedule math proof problem sets over time.
- The Lean plugin provides the queue widget and the Incremental Everything plugin provides the scheduling.
- I hope other devs can build similar integrations with their plugins!

![Incremental Mathematics](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/lean.png)

### Subset Review

- You can do basic subset reviews by studying a particular document. Only Rem from that document will be shown to you.
- You can also create a table from the `Incremental` tag and filter it down to a sorted subset using the table filter and sort features.
- You can review the rows of a table in order by sorting the table and using the "Practice in Order" practice mode.

There are lots of ways you can filter the table to create a subset of Rem to review. Here are some examples:

- Only Web extracts

![Only Extracts Filter](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/only-extracts.png)

- Only YouTube videos

![Only YouTube videos Filter](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/inc-vid-filter.png)


## Known Issues

### Incremental PDF Reading Position
Previously, reading positions for large PDFs were easily lost. 

  * **The Solution**: The plugin now supports a **Chapter-based workflow**. By splitting a PDF into multiple Incremental Rems (each with a defined page range) or using **PDF Highlights** as incremental items, the plugin **reliably saves and restores your reading position** for each specific item. 
  * **The Remaining Challenge**: While we can now track positions per item, the RemNote Plugin SDK still lacks direct programmatic control over the native PDF viewer's internal scroll engine. This means that while we can take you to the correct page, we cannot yet control the exact vertical pixel scroll within that page.
  * **How You Can Help**: We are still advocating for a more robust Plugin API. Please continue to upvote our request for better programmatic scroll control.

➡️ **[Upvote the Feature Request on the RemNote Feedback Site](https://feedback.remnote.com/p/feature-request-programmatic-control-over-pdf-scroll-position-for-plugins?b=Plugin-Requests)**

### Keyboard Shortcut Conflict:

When viewing a regular Rem card in the queue, the editor correctly appears. However, native queue keyboard shortcuts will take precedence over typing in the editor. This appears to be due to a limitation in the current plugin API that prevents a plugin from fully capturing keyboard input within the queue environment. The "Press 'P' to Edit" button has been added as a workaround. You can also use the newly created button "Review in Editor".


## Development Details

- The plugin stores repetition data as powerup properties on the Rem. These aren't "normal" RemNote flashcards. All of the scheduling is managed internally by the plugin.

### How to Develop

Run the following commands:

```sh
git clone https://github.com/bjsi/incremental-everything
cd incremental-everything
npm i
npm run dev
```

Then follow [this part of the quick start guide](https://plugins.remnote.com/getting-started/quick_start_guide#run-the-plugin-template-inside-remnote) to get the plugin running in RemNote.
