# Desktop Helpers

A RemNote plugin runs sandboxed: it cannot start programs, open files on your computer or read RemNote's own database. A few features need that, so they work with a small **helper** that you run on your computer. Each helper listens only to your own computer, and none of them is needed for the rest of the plugin.

## The helpers at a glance { #overview }

| Helper | What it is for | Program | Address | Set up in |
|---|---|---|---|---|
| **AI helper** | [AI Transcription of PDF Highlights](AI-Transcription-of-PDF-Highlights.md), [Pin Source Quote](Source-Pins.md), [Incremental Video](Incremental-Video.md#setup) screenshots and transcripts, the [review history of deleted Rems](#history-archive), and the [Search Engine](Search-Engine.md) | `ai_ocr_helper.py` + `history_archive.py` + the Search Engine's `rem_*.py` and `fsrs.py` (Python) | `127.0.0.1:3457` | [this page](#setup) |
| **Local Media Bridge** | Scripts and AI assistants writing through the RemNote MCP: local images, Rem operations, [Upscale image with ChatGPT](Local-Media-Bridge.md#upscale), [Read aloud and Add pronunciation](Read-Aloud.md) | `media_bridge.py` (Python) | `127.0.0.1:3460` | [Local Media Bridge](Local-Media-Bridge.md#setup) |
| **Logos bridge** | Reading [Logos Bible Software](Logos-Bible-Software-Integration.md) books incrementally (macOS) | `LogosBridge.app`, built by `build.sh` | `127.0.0.1:3458` | [Logos integration](Logos-Bible-Software-Integration.md#setup) |
| **Source finder** (yours) | Telling [Pin Source Quote](Source-Pins.md#no-source-open) which book a quote comes from when no PDF is open | Any program you write, run by the AI helper | — | [Source Pins](Source-Pins.md#source-finder-setup) |
| **Corpus provider** (yours) | A source finder that knows more of your library: also the exact text to search for a corrected quote, and the [parent selector](Corpus-Provider.md#in-the-plugin)'s section suggestion | Any program you write, run by the AI helper | — | [Corpus Provider](Corpus-Provider.md#setup) |

**Checking which ones are running:** open <http://127.0.0.1:3457/> (AI helper), <http://127.0.0.1:3460/health> (Local Media Bridge) or <http://127.0.0.1:3458/ping> (Logos bridge). A running helper answers with `"ok": true`; a stopped one gives a connection error.

On macOS each one can start at login, as a login item in `~/Library/LaunchAgents/` that you manage with `launchctl`:

| Helper | Login item label |
|---|---|
| AI helper | `com.incrementalremnote.ai-ocr-helper` |
| Local Media Bridge | `com.incrementalremnote.media-bridge` |
| Logos bridge | `com.incrementalremnote.logos-bridge` |

To restart one after updating it: `launchctl kickstart -k gui/$(id -u)/<label>`.

The [Chrome Companion Extension](Chrome-Companion-Extension.md) is a browser extension, not a helper: it needs nothing installed outside Chrome.

---

## The AI helper { #ai-helper }

The plugin's messages call it the **AI helper**, although most of what it does involves no AI:

| Feature | What the helper does | Also needs |
|---|---|---|
| [AI Transcription of PDF Highlights](AI-Transcription-of-PDF-Highlights.md) | Renders the highlighted region and has Claude transcribe it | Claude Code |
| [Pin Source Quote](Source-Pins.md) | Finds the quote in the PDF, and asks your [source finder](Source-Pins.md#no-source-open) which book it comes from | — |
| [Incremental Video](Incremental-Video.md#setup) | Screenshots, transcripts, extract titles and local video files | yt-dlp, ffmpeg, whisper.cpp; Claude Code for some ([details](Incremental-Video.md#setup)) |
| [Review history of deleted Rems](#history-archive) | Keeps the reviews RemNote drops two weeks after you delete a card, for the [Study Dashboard](Study-Dashboard.md#deleted-rems) | `history_archive.py` |

**Requirements:** RemNote **desktop**, **Python 3** and **PyMuPDF**. Each feature's extra needs are in the table above; without them, the rest of the helper still works.

## Setting up the AI helper { #setup }

1. **Install PyMuPDF**, the PDF renderer the helper uses:

    ```bash
    pip3 install pymupdf
    ```

2. **Download the helper:**

    ```bash
    mkdir -p ~/.incremental-remnote
    curl -o ~/.incremental-remnote/ai_ocr_helper.py \
      https://raw.githubusercontent.com/hugomarins/incremental-remnote/main/scripts/ai_ocr_helper.py
    curl -o ~/.incremental-remnote/history_archive.py \
      https://raw.githubusercontent.com/hugomarins/incremental-remnote/main/scripts/history_archive.py
    curl -o ~/.incremental-remnote/rem_search.py \
      https://raw.githubusercontent.com/hugomarins/incremental-remnote/main/scripts/rem_search.py
    curl -o ~/.incremental-remnote/rem_index.py \
      https://raw.githubusercontent.com/hugomarins/incremental-remnote/main/scripts/rem_index.py
    curl -o ~/.incremental-remnote/rem_browse.py \
      https://raw.githubusercontent.com/hugomarins/incremental-remnote/main/scripts/rem_browse.py
    curl -o ~/.incremental-remnote/fsrs.py \
      https://raw.githubusercontent.com/hugomarins/incremental-remnote/main/scripts/fsrs.py
    curl -o ~/.incremental-remnote/rem_search_ai.py \
      https://raw.githubusercontent.com/hugomarins/incremental-remnote/main/scripts/rem_search_ai.py
    ```

    The second file keeps the [review history of deleted Rems](#history-archive). The others, which need the second, run the [Search Engine](Search-Engine.md), [Search & Browse](Search-Engine.md#browse) and its [✨ AI](Search-Engine.md#ai). Without them, everything else works.

3. **Start it:**

    ```bash
    python3 ~/.incremental-remnote/ai_ocr_helper.py
    ```

    It prints `AI OCR helper on http://127.0.0.1:3457`. Leave the terminal open — or, on macOS, [start it at login](#run-at-login) instead.

4. **Pair the plugin with it.** The helper answers only requests that carry its pairing token, because any web page open in your browser can reach a program on your computer. It creates the token the first time it starts. Print it with

    ```bash
    python3 ~/.incremental-remnote/ai_ocr_helper.py --pairing-token
    ```

    and paste it into the plugin's settings, **AI Helper Pairing Token**. Every feature that uses the helper needs it. Without it they say *the plugin is not paired*. See [the pairing token](#pairing).

5. **For AI features**, install **Claude Code** ([claude.com/claude-code](https://claude.com/claude-code)) and run `claude` once in a terminal to log in. The helper uses your Claude subscription: no API key, nothing to pay beyond your plan.

**To check it is running**, open <http://127.0.0.1:3457/>. The answer shows `"ok": true` and what the helper found: `claude`, `ytDlp`, `ffmpeg` and `whisper` give where each tool is (or `null`), `historyArchive` is `true` when `history_archive.py` was loaded, and `search` is `true` when `rem_search.py` was.

### Start the AI helper at login (macOS) { #run-at-login }

So you never have to start it by hand, register it as a login item:

1. Find your Python's full path — it must be the one where you installed PyMuPDF:

    ```bash
    python3 -c "import sys; print(sys.executable)"
    ```

2. Save the following as `~/Library/LaunchAgents/com.incrementalremnote.ai-ocr-helper.plist`, replacing `PYTHON_PATH` with that path and `YOU` with your macOS user name (launchd does not expand `~`):

    ```xml
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
        <key>Label</key>
        <string>com.incrementalremnote.ai-ocr-helper</string>
        <key>ProgramArguments</key>
        <array>
            <string>PYTHON_PATH</string>
            <string>/Users/YOU/.incremental-remnote/ai_ocr_helper.py</string>
        </array>
        <key>RunAtLoad</key>
        <true/>
        <key>KeepAlive</key>
        <true/>
        <key>StandardOutPath</key>
        <string>/Users/YOU/.incremental-remnote/ai-ocr/helper.log</string>
        <key>StandardErrorPath</key>
        <string>/Users/YOU/.incremental-remnote/ai-ocr/helper.log</string>
    </dict>
    </plist>
    ```

3. Load it (stop any copy you started in a terminal first):

    ```bash
    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.incrementalremnote.ai-ocr-helper.plist
    ```

macOS now starts the helper at every login and restarts it if it stops.

| To… | Run |
|---|---|
| Restart it (after updating) | `launchctl kickstart -k gui/$(id -u)/com.incrementalremnote.ai-ocr-helper` |
| Turn it off | `launchctl bootout gui/$(id -u)/com.incrementalremnote.ai-ocr-helper` |
| Turn it back on | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.incrementalremnote.ai-ocr-helper.plist` |

On Windows or Linux the helper is the same Python script — start it by hand, or with your system's startup mechanism. Only macOS has been tested.

## Updating the AI helper { #updating }

When a changelog entry says the helper changed, download both files again ([Setup](#setup), step 2) and restart the helper. It reads its files only when it starts, so until the restart it keeps running the old version.

Updating never overwrites the instruction files you may have edited (`prompt.md` and the others in `~/.incremental-remnote/ai-ocr/`). To get a newer version's defaults, delete the file; the helper writes it again the next time it is needed.

## Review history of deleted Rems { #history-archive }

RemNote keeps a card's reviews only inside the card. When you delete a Rem, its cards go to RemNote's trash, which is emptied after two weeks, and their reviews are gone for good. With `history_archive.py` next to the helper, the helper keeps a copy:

- **When:** a minute after the helper starts, then every six hours, and each time you open the [Study Dashboard](Study-Dashboard.md#deleted-rems).
- **What:** every review of every card and Incremental Rem in the knowledge base, deleted or not, with each Rem's text and place in the tree. It reads RemNote's local database (`~/remnote/remnote-<id>/remnote.db`) and never writes to it.
- **Which knowledge bases:** every one the plugin has used the helper from. A knowledge base is added the first time it does, for example when you open the Study Dashboard in it.

The Study Dashboard and the Practiced Queues summary count these reviews; see [Deleted Rems](Study-Dashboard.md#deleted-rems). The helper only copies what is still in RemNote's database or trash when it runs. Reviews deleted earlier can sometimes be [recovered from old backups](Study-Dashboard.md#recover-from-backups).

### Finding a deleted card { #find-deleted-cards }

The archive is an ordinary SQLite file on your computer, one per knowledge base:

```
~/.incremental-remnote/history-archive/<knowledge base id>.sqlite
```

The knowledge base id is the end of RemNote's folder name for it, `~/remnote/remnote-<id>`. `kbs.json`, in the same folder as the archives, lists the knowledge bases being archived.

There are three ways to read it:

- **In RemNote:** open the Study Dashboard with **Include deleted Rems** on. Deleted Rems show with 🗑 in the hierarchy, where they used to sit, with the deletion date on hover.
- **A summary**, by year and by deleted branch:

    ```bash
    python3 ~/.incremental-remnote/history_archive.py --kb <knowledge base id> report
    ```

- **The cards themselves:** open the file in [DB Browser for SQLite](https://sqlitebrowser.org/) (free) and run the queries below in its *Execute SQL* tab, or use the `sqlite3` command. Don't open it with `sqlite3 -readonly`, which fails while the helper has the file open. Both queries only read.

    The most recently deleted cards, with their reviews and time:

    ```sql
    SELECT datetime(i.deleted_at/1000, 'unixepoch', 'localtime') AS deleted,
           i.state, i.kind, i.rem_id, m.text,
           COUNT(r.date_ms) AS reps, ROUND(SUM(r.time_ms)/60000.0, 1) AS minutes
    FROM items i
    LEFT JOIN rems m ON m.rem_id = i.rem_id
    LEFT JOIN reps r ON r.item_id = i.item_id
    WHERE i.state != 'live'
    GROUP BY i.item_id
    ORDER BY i.deleted_at DESC
    LIMIT 20;
    ```

    Every review of one of them, using the `rem_id` from that list:

    ```sql
    SELECT datetime(date_ms/1000, 'unixepoch', 'localtime') AS reviewed,
           score, time_ms/1000 AS seconds
    FROM reps
    WHERE rem_id = 'paste the rem_id here'
    ORDER BY date_ms;
    ```

What the columns mean:

| Column | Meaning |
|---|---|
| `kind` | `card`, `inc` (an Incremental Rem's history) or `dism` (a Dismissed Rem's history) |
| `state` (in `items`) | `live`; `trash` while it is still in RemNote's trash, from which RemNote can restore it; `gone` once the trash has been emptied |
| `score` | `0` Forgot, `0.5` Hard, `1` Good, `1.5` Easy. Other values are not reviews (skips, resets, manual dates). |
| `deleted_at`, `date_ms` | Milliseconds since 1970. The queries turn them into local dates. |

To find a card by its text, replace `WHERE i.state != 'live'` with `WHERE m.text LIKE '%a few words%'` in the first query. That also lists the live cards with that text; the `state` column tells them apart. A Rem with several cards (both directions, or several clozes) has one row per card.

## Searching with AND, OR and NOT { #search }

!!! warning "Mac only"
    The [Search Engine](Search-Engine.md), Search & Browse and ✨ AI run only with RemNote's desktop app on a Mac.

RemNote's search, the only one a plugin can use, looks for any of the words you type and keeps the first 1,000 Rems by a ranking that ignores your words. A Rem holding every word you typed can be cut before the plugin sees it: in one knowledge base, `bow weather wave` matched 5,874 Rems on any word and a single Rem on all three, and that one was cut.

With `rem_search.py` and `rem_index.py` next to the helper, [Find Rem](Utilities-Finding-and-Navigating.md#search-with-the-ai-helper) searches through the helper instead, with the [Search Engine](Search-Engine.md)'s query language: every word must match, and `or`, `-word`, `"phrases"`, `in:`, `tag:`, `is:`, `source:`, slot and property values work. The helper reads RemNote's local database (`~/remnote/remnote-<id>/remnote.db`) and never writes to it. For the keys beyond plain text it keeps its own index of the knowledge base in `~/.incremental-remnote/search/`: about 180 MB for 440,000 Rems, built once in about 20 seconds, then updated before each search in a few milliseconds. The plugin also asks this index which Rems have a PDF or web page as their Source, instead of checking every IncRem.

Searching needs the plugin [paired with the helper](#pairing), like every other feature of the helper.

### The pairing token { #pairing }

Any web page open in your browser can reach a program on your computer. Without a token, a page could make the helper transcribe with your Claude account, read files of your knowledge base, or query your [corpus provider](Corpus-Provider.md). So the helper answers a request (any `POST`) only when it carries the pairing token, which only the plugin knows. Its status page (<http://127.0.0.1:3457/>) and local video playback stay open: they reveal nothing to a web page.

To pair, print the token with `python3 ~/.incremental-remnote/ai_ocr_helper.py --pairing-token` and paste it into the plugin's settings, **AI Helper Pairing Token**.

The token is kept in `ai-ocr/pairing-token`, readable only by your user. To make a new one, delete that file, restart the helper and paste the new token. If you run the helper on two computers, copy the file from one to the other: the plugin setting is the same on both.

## Files the AI helper keeps { #files }

Everything is under `~/.incremental-remnote/`:

| Where | What |
|---|---|
| `ai-ocr/prompt.md`, `video-prompt.md`, `transcript-prompt.md`, `extract-title-prompt.md` | The instructions Claude follows, which you can edit (see [Customising the instructions](AI-Transcription-of-PDF-Highlights.md#prompt)) |
| `ai-ocr/source-finder.json` | Your [source finder](Source-Pins.md#no-source-open), if you set one up |
| `ai-ocr/corpus-provider.json` | Your [corpus provider](Corpus-Provider.md), if you set one up (used instead of `source-finder.json`) |
| `ai-ocr/requests.log` | One line per request, with any error |
| `ai-ocr/helper.log` | What the helper printed, when started at login |
| `ai-ocr/crops/` | The image sent for each highlight, useful when a transcription covers more or less than you highlighted |
| `ai-ocr/pdf-cache/`, `video-frames/`, `video-transcripts/`, `video-audio/`, `whisper/` | Caches and the speech model. Downloaded audio is deleted after a week. |
| `history-archive/` | The [review history archive](#history-archive), one SQLite file per knowledge base |
| `ai-ocr/pairing-token` | The token the plugin sends with every request ([pairing](#pairing)) |
| `ai-ocr/search-prompt.md` | The instructions Claude follows to turn a request into a search ([✨ AI](Search-Engine.md#ai)), which you can edit |
| `search/` | The [Search Engine](Search-Engine.md)'s index, one SQLite file per knowledge base, readable only by you. Deleting it is safe: the helper builds it again. |

## AI helper troubleshooting { #troubleshooting }

| Message | What to do |
|---|---|
| *AI helper is not running*, or *The helper is not running* | Start the helper ([Setup](#setup), step 3) and check <http://127.0.0.1:3457/>. |
| *… claude CLI not found* | Install Claude Code. The helper looks for `claude` on your `PATH` and in `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`. |
| *Include deleted Rems (helper not running)* in the Study Dashboard | Start the helper. If it is running and <http://127.0.0.1:3457/> shows `"historyArchive": false`, put `history_archive.py` next to `ai_ocr_helper.py` and restart the helper. |
| Find Rem says *The AI helper is running but not paired* | Paste the token in the plugin settings ([Searching with AND, OR and NOT](#search)). If it was pasted, the helper's token changed: print it again. |
| A feature behaves as before after an update | Restart the helper: it keeps running the version it started with. |

For anything else, look at `requests.log` and `helper.log` ([Files the AI helper keeps](#files)). Each feature's page lists the problems specific to it.

## AI helper privacy { #privacy }

The AI helper accepts connections only from your own computer. What leaves it:

- **AI features** send Anthropic, through your Claude account, only what that request needs: the image of a highlighted region and its text, a video frame, or a transcript. It is the same as pasting them into a Claude conversation.
- **Video features** download from YouTube the video or captions you asked for.
- **✨ AI in Search & Browse** sends Claude your request and some names from your knowledge base: scheduler names, your most-used tags, your top documents and folders. Never note text.
- **Pin Source Quote**, the **review history archive**, **search** and the **corpus provider** send nothing anywhere (a provider you write may, if you make it). Every request answers only the plugin, which holds the [pairing token](#pairing).
