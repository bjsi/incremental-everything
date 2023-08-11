## Incremental Everything

A RemNote plugin which allows you to interleave flashcard reviews with other information like notes, books, websites, videos and more!

### Features

- **Incremental Reading**: Read and review your notes, books and websites.
- **Incremental Video**: Watch and take notes on YouTube videos.
- **Incremental Writing**: Write your essays and blog posts incrementally.
- **Incremental Tasks**: Clear out your tasklist between flashcard reviews.
- **Incremental Exercises**: Spread out textbook exercises over time.
- Plugin support! Plugin widgets can easily integrate with Incremental Everything.

### Installation

- Open the [RemNote plugin store](https://www.remnote.com/plugins), search for "Incremental Everything" and install the plugin. It works on all devices.

### Usage Summary

- Tag a Rem with the `Incremental` tag using the `/Incremental Everything` command to turn it into an incremental Rem.
- You can change an incremental Rem's priority using the `/Prioritize` command, or edit the date using RemNote's tables and properties features.
- You can manually set the next repetition date using RemNote's tables and properties features.
- The plugin will automatically add incremental Rem to your regular flashcard queue and show them to you when you review flashcards.
- Inside the queue, you can control how many incremental Rem you want to see and how they are sorted using the Sorting Criteria menu button.
- All of RemNote's practice modes ("Practice with SRS", "Practice All" and "Practice in Order") should work.
- You can do subset reviews by creating a table from the `Incremental` tag.

### Scheduling

- The plugin uses an extremely simple scheduling algorithm which just doubles the interval at each repetition.

### Prioritization

- You can use the `/Prioritize` command to change the priority of an incremental Rem or change it using RemNote's tables and properties features.
- The plugin will prioritize Rem with a higher priority over Rem with a lower priority.
- You can set the balance between priority sorting and randomness using the Sorting Criteria menu button in the queue.

### Examples

#### Incremental Reading

- You can tag PDFs, websites and highlights with the `Incremental` tag to read them incrementally.
- It will work if you tag the PDF/website itself, or a Rem with the PDF/website as a source.
- The plugin will render the PDF or website in the queue.

#### Incremental Writing

- You can tag any normal Rem with the `Incremental` tag to turn it into an incremental Rem.
- The plugin will render it as a normal Rem in the document view in the queue.

#### Incremental Video

- You can tag YouTube videos with the `Incremental` tag to watch them incrementally.
- It will work if you tag the link Rem itself, or a Rem with the YouTube link as a source.
- The plugin will automatically save your progress and playback rate.
- You can open the resizable notes section to take notes while you watch.

#### Incremental Mathematics

- A quick example of plugin interoperability.
- Integrates with my [Lean theorem prover plugin](https://github.com/bjsi/remnote-lean) to schedule math proof problem sets over time.

### Development Details

- The plugin stores repetition data as powerup properties on the Rem. So these aren't "normal" RemNote flashcards. All of the scheduling is managed internally by the plugin.
