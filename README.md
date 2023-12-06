# Incremental Everything

A RemNote plugin which allows you to interleave your flashcard reviews with notes, paragraphs from books, websites, video snippets and more! Heavily inspired by SuperMemo's [Incremental Reading](https://supermemo.guru/wiki/Incremental_reading) mode.

## Features

- **Incremental Reading**: Read and review 1000s of notes, books and websites in parallel. [Learn more](https://www.youtube.com/watch?v=oNCLLNZEtz0).
- **Incremental Writing**: Write your essays and blog posts incrementally to maximize creativity. [Learn more](https://www.youtube.com/watch?v=LLS_8Y744lk).
- **Incremental Video**: Watch and take notes on your YouTube video backlog.
- **Incremental Tasks**: Clear out your tasklist between flashcard reviews.
- **Incremental Exercises**: Spread out textbook exercises over time.
- Plugin support: Any RemNote plugin widget can easily integrate with Incremental Everything!

## Installation

- Open the [RemNote plugin store](https://www.remnote.com/plugins), search for "Incremental Everything" and install the plugin.
- Note that the plugin is temporarily disabled on mobile until I have time to fix some bugs.

## Usage

### Create Incremental Rem

- Tag a Rem with the `Incremental` tag using the `/Incremental Everything` command.
  ![Tagging](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/tag-inc-rem.gif)
- Turn a PDF/website highlight into an incremental Rem by clicking on the highlight and clicking the puzzle piece icon.
  ![Highlight](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/highlight.gif)
- You can also create a new row in a table created from the `Incremental` tag.
- You can use the shortcut `alt/opt+x` to create an incremental Rem.
- You can use the shortcut `alt/opt+shift+x` to create an incremental Rem and open the priority menu.

#### Disable Incremental Rem

- If you are done reviewing an incremental Rem and do not wish to see it anymore, you can disable it by removing the `Incremental` tag.

### Review

- The plugin automatically interleaves incremental Rem between your regular flashcard reviews.
- All of RemNote's practice modes ("Practice with SRS", "Practice All" and "Practice in Order") should work as expected.
  - Note that "Practice in Order" won't order the incremental Rem with flashcards. The flashcards and incremental Rem will get interleaved together.
- In "Practice with SRS" and "Practice All" modes Rem are sorted by priority. In "Practice in Order" mode they are sorted by their order in the document.
- Inside the queue, you can control how many incremental Rem you want to see and how they are sorted using the Sorting Criteria button in the queue menu.

#### Incremental Reading

- You can tag PDFs, websites and highlights with the `Incremental` tag to do classic SuperMemo-style incremental reading.
- It will work if you tag the PDF or website itself, or a Rem with a single PDF or website as a source.
- The plugin will render the PDF or website reader view inside the queue.
- If you want to turn a highlight into an incremental Rem, click on the highlight and click the puzzle piece icon (I need to add proper shortcuts still!)

![Incremental Reading](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/inc-read.gif)

#### Incremental Writing

- You can tag any normal Rem with the `Incremental` tag to turn it into an incremental Rem.
- The plugin will render it as a normal Rem in the document view in the queue.

#### Incremental Video

- You can tag YouTube videos with the `Incremental` tag to watch them incrementally.
- It will work if you tag the link Rem itself, or a Rem with the YouTube link as a source.
- The plugin will automatically save your progress and playback rate.
- You can open the resizable notes section on the left to take notes while you watch.

![Incremental Video](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/inc-vid.png)

#### Incremental Mathematics

- A quick example of plugin interoperability.
- Integrates with my [Lean theorem prover plugin](https://github.com/bjsi/remnote-lean) to schedule math proof problem sets over time.
- The Lean plugin provides the queue widget and the Incremental Everything plugin provides the scheduling.
- I hope other devs can build similar integrations with their plugins!

![Incremental Mathematics](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/lean.png)

#### Subset Review

- You can do basic subset reviews by studying a particular document. Only Rem from that document will be shown to you.
- You can also create a table from the `Incremental` tag and filter it down to a sorted subset using the table filter and sort features.
- You can review the rows of a table in order by sorting the table and using the "Practice in Order" practice mode.

There are lots of ways you can filter the table to create a subset of Rem to review. Here are some examples:

- Only Web extracts

![Only Extracts Filter](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/only-extracts.png)

- Only YouTube videos

![Only YouTube videos Filter](https://raw.githubusercontent.com/bjsi/incremental-everything/main/img/inc-vid-filter.png)

### Prioritization

- You can use the `/Prioritize` command to set the priority of an incremental Rem or change it using RemNote's tables and properties features.
- The plugin will prioritize Rem with a lower priority over Rem with a higher priority. So 0 is for your most important material and 100 is for the least important.
- You can set the balance between priority sorting and randomness using the Sorting Criteria menu button in the queue.

### Scheduling

- The plugin uses an extremely simple scheduling algorithm: `const newInterval = Math.ceil(multiplier ** Math.max(repHistory.length, 1));` where the multiplier is 1.5 by default.
- We can add custom scheduling algorithms in the future if there is demand for it.
- Note that you can manually set the next repetition date using RemNote's tables and properties features.

## Development Details

- The plugin stores repetition data as powerup properties on the Rem. So these aren't "normal" RemNote flashcards. All of the scheduling is managed internally by the plugin.
- Let me know if you want to help develop the plugin! Join the [RemNote Discord](http://bit.ly/RemNoteDiscord) and message me (Jamesb)!

### How to Develop

Run the following commands:

```sh
git clone https://github.com/bjsi/incremental-everything
cd incremental-everything
npm i
npm run dev
```

Then follow [this part of the quick start guide](https://plugins.remnote.com/getting-started/quick_start_guide#run-the-plugin-template-inside-remnote) to get the plugin running in RemNote.
