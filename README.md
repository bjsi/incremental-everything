## Incremental Everything

A RemNote plugin which allows you to interleave flashcard reviews with other information like notes, books, websites, videos and more!

Still a work in progress, but almost there!

### Features

- **Incremental Reading**: Read and review your notes, books and websites.
- **Incremental Video**: Watch and take notes on YouTube videos.
- **Incremental Writing**: Write your essays and blog posts incrementally.
- **Incremental Tasks**: Clear out your tasklist between flashcard reviews.
- **Incremental Exercises**: Spread out textbook exercises over time.
- Plugin support! Any plugin widget can easily integrate with Incremental Everything. See the guitar, mathematics and AI examples.

### Installation

- Open the [RemNote plugin store](https://www.remnote.com/plugins), search for "Incremental Everything" and install the plugin. It works on all devices.

### Usage

- Tag a Rem with the `Incremental` tag using the `/Incremental Everything` command to turn it into an incremental Rem.
- Change an incremental Rem's priority using the `/Prioritize` command.
- The plugin will automatically add incremental Rem to your regular flashcard queue and show them to you when you review flashcards.
- Inside the queue, you can control how many incremental Rem you want to see and how they are sorted using the Sorting Criteria menu button.

### Scheduling

- By default the plugin uses an extremely simple scheduling algorithm.
- You can tune the scheduling to your preferences by...
- You can assign different schedulers by...

### Plugin Interoperability

- The coolest part about RemNote is how open-ended and extensible it is. Making this plugin integrate cleanly with other plugins was trivial. Here are a few examples I have been toying around with.

#### Incremental Guitar

- TODO

#### Incremental Mathematics

- Integrates with my [Lean theorem prover plugin](https://github.com/bjsi/remnote-lean) to schedule proofs over time.
- Future ideas: scheduling LeetCode problems, ... etc over time.

#### AI Gratitude Journal

- Prompts you to reflect and expand upon things you've written about in your daily document reflections and gratitude journal sections.

#### AI "K-Probes"

- Prompts you to refine your ideas over time by randomly picking paragraphs from articles you have written and critiques them.
- Uses metadata from the articles to pick a relevant persona.

#### AI Edit Later

- Get card refactoring suggestions for your Edit Later cards from GPT.

### Development Details

- The plugin stores repetition data as hidden slots on the Rem. So these aren't "normal" RemNote flashcards. All of the scheduling is managed by the plugin.
