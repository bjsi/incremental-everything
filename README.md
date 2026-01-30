# Incremental Everything

![Incremental Everything Logo](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/inc-logo.png)

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
- **Absolute & Relative Priorities**: Prioritize items from 0-100 and see exactly where they rank in your knowledge base.
- **Priority Inheritance**: New extracts and flashcards automatically inherit the priority of their source material.
- **Priority Shield**: A real-time diagnostic tool that shows your capacity to process high-priority material.
- **Priority Review Documents**: Generate focused study sessions for your top N most important items (passive reading and flashcards) when you're overwhelmed.

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
1. **Make Incremental**: Make any Rem, PDF, or Website `Incremental` using the `/Incremental Everything` command (Shortcut: `Alt+X`).

![Make Incremental using the command](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/tag-inc-rem.gif)

2. **Prioritize it**: Use `Alt+P` to set its importance.
3. **Review it**: The plugin interleaves these items into your regular flashcard queue.
4. **Disable it**: Remove the `Incremental` tag or press the **Done** button in the queue if you are done reviewing it.

### ⚡ Prioritization & Sorting
- 0 is for your most important material and 100 is for the least important.
- **Change Priority**: Click the button in the queue or press `Alt+P` to open the full priority popup.
- **Quick Shortcuts**: Use `Ctrl+Opt+Up` / `Ctrl+Opt+Down` to adjust priority instantly without breaking flow.
- **Sorting Criteria**: Use the queue menu to adjust the balance between **Structure** (strict priority) and **Exploration** (randomness), and control the ratio of Flashcards to Reading material.

### Scheduling

- The plugin uses an extremely simple scheduling algorithm: `const newInterval = Math.ceil(multiplier ** Math.max(repHistory.length, 1));` where the multiplier is 1.5 by default.
- Note that you can manually set the next repetition date using the **Reschedule** command (**Ctrl+J**), or RemNote's tables and properties features.

### 📱 Mobile Support
The plugin now features **Automatic Light Mode**.
- When you open RemNote on iOS or Android, the plugin automatically switches to "Light Mode".
- This disables heavy background calculations to ensure a crash-free experience on mobile devices.
- Your desktop experience remains fully featured.

### Incremental Reading

- You can tag PDFs, websites and highlights with the `Incremental` tag to do classic SuperMemo-style incremental reading.
- It will work if you tag the PDF or website itself, or a Rem with a single PDF or website as a source.
- The plugin will render the PDF or website reader view inside the queue.
- If you want to turn a highlight into an incremental Rem, click on the highlight and click the puzzle piece icon.
- ** 📄 PDFs & Web**
  - **Visual Status**: Highlights turn **Green** when toggled as Incremental, and **Blue** when extracted.
  - **Create Incremental Rem**: Select text in a PDF -> Highlight it -> Click the Puzzle Icon -> **"Create Incremental Rem"**. This extracts the text to a new Rem under a parent of your choice (using the smart parent selector).
![Highlight](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/highlight.gif)

### Incremental Writing

- You can tag any normal Rem with the `Incremental` tag to turn it into an incremental Rem.
- The plugin will render it as a normal Rem in the document view in the queue.

### Incremental Video

- You can tag YouTube videos with the `Incremental` tag to watch them incrementally.
- It will work if you tag the link Rem itself, or a Rem with the YouTube link as a source.
- The plugin will automatically save your progress and playback rate.
- You can open the resizable notes section on the left to take notes while you watch.

![Incremental Video](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/inc-vid.png)

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

When reading a large PDF (like a book) as a regular incremental Rem, the plugin may not reliably return you to your last incremental reading spot.

  * **The Problem**: If you open and scroll the same PDF in another window or tab, your incremental reading position will be lost. RemNote's native PDF viewer only remembers the single most recent position for a document, which overwrites the position from your incremental reading session. This also means you cannot have multiple incremental Rems for different chapters of the same PDF file, as they would all share the same scroll position.
  * **The Cause**: This is due to a limitation in the current RemNote Plugin SDK. The plugin lacks the necessary tools to programmatically save and restore a specific scroll position for a PDF and must rely on RemNote's default behavior.
  * **How You Can Help**: To fix this, we need the RemNote developers to expand the capabilities of their Plugin API. We have submitted a Feature Request asking for these tools. Please help us by upvoting the request on the RemNote feedback platform. More upvotes will increase its priority.

➡️ **[Upvote the Feature Request on the RemNote Feedback Site](https://feedback.remnote.com/p/feature-request-programmatic-control-over-pdf-scroll-position-for-plugins?b=Plugin-Requests)**

### Keyboard Shortcut Conflict:

When viewing a regular Rem card in the queue, the editor correctly appears. However, native queue keyboard shortcuts will take precedence over typing in the editor. This appears to be due to a limitation in the current plugin API that prevents a plugin from fully capturing keyboard input within the queue environment. The "Press 'P' to Edit" button has been added as a workaround. You can also use the newly created button "Review & Open".


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
