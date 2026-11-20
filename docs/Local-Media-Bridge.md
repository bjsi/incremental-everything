# Local Media Bridge

Lets tools outside RemNote — scripts, or an AI assistant writing through the RemNote MCP — put **local images** into your rems and have RemNote **store them itself**, as if you had pasted them. It also lets them [move rems, remove tags, read out images, make rems Incremental, pin sources, set a card's type, remove card priorities, set heading levels and make portals](#operations), and it runs the commands [Upscale image with ChatGPT](#upscale), [Read aloud](Read-Aloud.md) and [Add pronunciation](Read-Aloud.md#pronunciation), which appear only while the setting is on. **Desktop app only; the helper is a small Python script (macOS, Linux or Windows).**

## Why it is needed { #why }

Since RemNote 1.29 the desktop window runs sandboxed. An image written into a rem from outside the app with a `file:///…` link is no longer uploaded: RemNote cannot read the file, and the rem shows *"Unable to find this image"*.

RemNote can still fetch an image from an `http://` address and store its own copy. The bridge uses that:

1. A **helper** on your computer serves the image at `http://127.0.0.1:3460/files/…`.
2. The outside tool writes the rem with that link.
3. The tool asks the helper to have the image stored. The plugin, which listens to the helper while the setting is on, runs **Store linked images & audio in RemNote** on those rems: the link is replaced by a copy RemNote keeps (`%LOCAL_FILE%…`), and the rem no longer depends on the helper.

## Setup { #setup }

1. Turn on **Settings → Integrations → Local Media Bridge**.
2. Keep `scripts/media_bridge/media_bridge.py` from the plugin repository somewhere on your computer. It needs only Python 3, and it starts itself in the background the first time it is used.

While the setting is on, the plugin checks the helper every 25 seconds; when the helper is not running it just retries every 30 seconds. Each failed try shows as a red `ERR_CONNECTION_REFUSED` line for `127.0.0.1:3460/next` in the developer console. These lines are harmless. To stop them, turn the setting off when you are not using the bridge, or keep the helper running by [starting it at login](#run-at-login).

### Start the helper at login (macOS) { #run-at-login }

To keep the helper running all the time, register it as a login item:

1. Find your Python's full path (the helper needs only the standard library, so any Python 3 works):

    ```bash
    python3 -c "import sys; print(sys.executable)"
    ```

2. Create the helper's folder, which also holds its log:

    ```bash
    mkdir -p ~/.remnote-media-bridge
    ```

3. Save the following as `~/Library/LaunchAgents/com.incrementalremnote.media-bridge.plist`. Replace `PYTHON_PATH` with that path, `/path/to/media_bridge.py` with where you keep the script, and `YOU` with your macOS user name (launchd does not expand `~`):

    ```xml
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
        <key>Label</key>
        <string>com.incrementalremnote.media-bridge</string>
        <key>ProgramArguments</key>
        <array>
            <string>PYTHON_PATH</string>
            <string>-I</string>
            <string>/path/to/media_bridge.py</string>
            <string>serve</string>
        </array>
        <key>WorkingDirectory</key>
        <string>/Users/YOU/.remnote-media-bridge</string>
        <key>RunAtLoad</key>
        <true/>
        <key>KeepAlive</key>
        <dict>
            <key>SuccessfulExit</key>
            <false/>
        </dict>
        <key>StandardOutPath</key>
        <string>/Users/YOU/.remnote-media-bridge/bridge.log</string>
        <key>StandardErrorPath</key>
        <string>/Users/YOU/.remnote-media-bridge/bridge.log</string>
    </dict>
    </plist>
    ```

4. Load it:

    ```bash
    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.incrementalremnote.media-bridge.plist
    ```

macOS now starts the helper at every login and restarts it if it crashes. `python3 media_bridge.py status` shows `"ok": true`, and, with the setting on, `pluginSeenSecondsAgo` shows a number within 30 seconds, once the plugin has reconnected.

`python3 media_bridge.py stop` still stops the helper: it exits cleanly, and launchd restarts it only after a crash. It comes back at the next login, or the next time `put` or `localize` needs it.

| To… | Run |
|---|---|
| Restart it (after updating the script) | `launchctl kickstart -k gui/$(id -u)/com.incrementalremnote.media-bridge` |
| Turn it off | `launchctl bootout gui/$(id -u)/com.incrementalremnote.media-bridge` |
| Turn it back on | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.incrementalremnote.media-bridge.plist` |

On Windows or Linux, use your system's startup mechanism to run `python3 media_bridge.py serve` at login. Only macOS has been tested.

## Use { #use }

```bash
# 1. Store the image with the helper and get its link
python3 media_bridge.py put figure.png
# → http://127.0.0.1:3460/files/1a2b3c4d5e-figure.png

# 2. Write the rem with ![](http://127.0.0.1:3460/files/1a2b3c4d5e-figure.png)

# 3. Ask RemNote to store the images of those rems (one call for all of them)
python3 media_bridge.py localize <remId> <remId> …
```

`localize` waits for the plugin and prints the result (`localized`, `failed`, `missing`). It exits with an error when something could not be stored or the plugin did not answer in time. The job stays queued, so it runs as soon as RemNote is open with the setting on. The plugin waits up to 30 seconds for a rem written from outside to sync before processing it.

When a job finishes, RemNote shows a toast (*"Local Media Bridge: stored 1 image in RemNote…"*) and logs the details to the console under `[MediaBridge]`.

Other commands: `start`, `status`, `stop`. Files are kept in `~/.remnote-media-bridge/files` and removed after 30 days.

!!! warning "Do not leave the link behind"
    Until `localize` has run, the image shows only while the helper is running, and only on this computer.

## Upscale an image with ChatGPT { #upscale }

A figure taken from a scanned book is often blurry. ChatGPT's image model can redraw it at a higher resolution and usually keeps it exactly as it was: the same curves, labels and formulas. The command **Upscale image with ChatGPT** (`upi`) does this from inside RemNote, using your ChatGPT subscription rather than a paid API key.

1. Put the cursor in the Rem that has the image and run **Upscale image with ChatGPT**.
2. The helper sends the image to ChatGPT **in the background**: about 45 seconds per image, while you keep working. When it is done, a notice appears at the top right, **Upscale image: ready to review**, saying whether the check found differences.
3. Press **Review** on the notice. A popup shows the original beside the result and the outcome of an automatic check:
    - **✓ Same content**: no line, colour or word changed.
    - **⚠ Check before replacing**: something differs. The popup lists what, and shows zoomed views of each region that changed (original on the left, new on the right). **Differences** colours the overlay: grey is in both images, red only in the original, blue only in the new one.
4. Compare the two images yourself, especially digits, symbols and formulas, which the check cannot read. Then press **Replace image**, or **Try again**, optionally with an instruction such as *the dashed lines must stay dashed*: the image goes back to the background, and a new notice follows.

**Replace image** stores the new image in RemNote and swaps it into the Rem in place: the caption, the display width and the flashcards stay as they were. A Rem with several images goes through them one at a time, and **Skip this image** passes one by. **Cancel** closes the popup but keeps the notice, so the review can be opened again; the notice goes once every image has been replaced, skipped or tried again. Nothing touches the Rem until you press Replace image. The job and its notice belong to this RemNote window: reloading RemNote drops them (the files stay in the folder below). Every run is saved under `~/Pictures/remnote-upscale/<remId>/<date-time>/`, including the original, so a replaced image can always be put back by hand.

### Setup { #upscale-setup }

The upscaling runs in the helper on your computer, not in RemNote:

1. The **Local Media Bridge** setting on and the helper running (see [Setup](#setup)). After updating the plugin, restart the helper so it is version 3 or later: the command says so if it is not.
2. The [Codex CLI](https://learn.chatgpt.com/docs/codex/cli), signed in with your ChatGPT account. This needs a paid ChatGPT plan (Go, Plus, Pro…): image generation is not available on the Free plan. Each image counts against the plan's Codex usage limits, about 3–5 times a normal request.

    ```bash
    npm install -g @openai/codex
    codex login          # choose "Sign in with ChatGPT"
    ```

3. For the check, the Python that runs the helper needs `Pillow`, `numpy` and `scipy` (`python3 -m pip install pillow numpy scipy`). On macOS, `pyobjc-framework-Vision` adds the check of words; without it that part is skipped.

The same script works from a terminal, without RemNote: `python3 upscale_image.py upscale figure.png` makes and checks an upscaled copy of a file, and `python3 upscale_image.py compare original.png new.png` only runs the check. Both print the result as JSON.

## Rem operations { #operations }

The same helper also carries a few operations that the RemNote MCP cannot do. The plugin runs them with its own code, so an outside tool (or an AI assistant) gets the same result as doing it by hand in RemNote:

| Command | What it does |
|---|---|
| `move <rem>[,<rem>…] <parent> [position]` | Moves the rems under `parent`, in the order given. `position` is `first`, `last` (default), a 0-based index among the parent's visible children, `before:<remId>` or `after:<remId>`. `--expect-parent <id>` refuses unless each rem is still where you think it is; `--dry-run` only reports. A rem cannot be moved under itself or its own descendants. |
| `tag <rem>[,<rem>…] <tag rem id>` | Adds a tag, given by its rem id, to the rems. It works on PDF rems too, which the MCP's `tag_rems` refuses, for example to mark the [preferred PDF](PDF-Incremental-Reading-Workflow.md#multiple-pdf-sources-active-pdf-switcher-and-preferthispdf) with `#preferthispdf`. A rem that already has the tag counts as done. The **Incremental** tag is refused: use `incrementalize`. |
| `untag <rem>[,<rem>…] <tag>` | Removes a tag, given by id or by name as shown in RemNote. Also removes built-in powerups such as **Extra Card Detail** or **Quote**, by name or as `powerup:<code>` (`powerup:x`). `--drop-properties` also deletes the tag's property values. The **Incremental** tag is refused: dismiss the rem instead, which keeps its history. |
| `get-image <rem> [--out DIR]` | Copies the images of the rem (front and back) to files, by default in `~/.remnote-media-bridge/out/`, and prints their paths. Images stored in RemNote are read from RemNote's own folder on this computer; linked ones are downloaded. |
| `incrementalize <rem>[,<rem>…] [--priority N]` | Makes the rems Incremental exactly like the plugin's own command: first date from the Initial Interval, the history entry, the cache and the inheritance cascade. Without `--priority` the priority is inherited or the default. On a rem that is already Incremental, `--priority` changes its priority (recorded in its history as *Local bridge* 🔌). |
| `pin <rem>[,<rem>…] [--refs <id>[,<id>…]] [--unpin]` | Shows references as **pins** (📌), as RemNote does for a highlight pinned by hand, instead of spelling out the referenced text. Without `--refs`, every reference to a PDF or web highlight in the rems (front and back) is pinned; with it, only the references to those rems. `--unpin` turns pins back into plain references. |
| `pin-quote <rem>[,<rem>…] [--source <rem>] [--view pdf\|html\|both] [--quote TEXT]` | Runs [Pin Source Quote](Source-Pins.md#pin-source-quote) on each rem against the PDF or saved web article `--source` (without it, each rem's book and PDF come from your [source finder](Source-Pins.md#no-source-open), and the answer says which PDF and page each quote was pinned from): finds the rem's text there, reuses or creates the highlight, and pins it at the end of the rem's back (or front). The source does not need to be open. `--view` picks the views of a PDF with a Text Reader version (default: the page view). `--quote` looks for that passage instead of the rem's own text, for a card whose answer is not taken word for word from the source (one rem at a time). Like the command, it needs the [AI helper](Desktop-Helpers.md#ai-helper) running (only its PyMuPDF part). |
| `restore-audio <rem>[,<rem>…] [--chunk 5]` | Stores again, as audio, the audio files RemNote holds as images, and points the players at the new copies. A plugin that uploaded audio disguised as an image (`data:image/mp3`) left it with no file extension and the type `image/mp3`: the desktop app plays it, the iOS app says *"The operation is not supported"*. The file is read from RemNote's folder on this computer (or downloaded from RemNote), and its old copy stays unused. Rems with no such audio are reported as untouched. |
| `card <rem>[,<rem>…] [--type concept\|descriptor\|default] [--direction forward\|backward\|both\|none] [--practice on\|off]` | Makes the rems Concepts or Descriptors (or neither) and sets which way they are practiced, without touching their text, so pins and review history stay. `--practice off` switches the Rem's cards off as RemNote's `/Disable Card` does (`on` switches them back). For example a bidirectional Descriptor, which RemNote's markdown cannot write, or a Concept with no flashcard: a Rem with no back text made a Concept makes no card, but RemNote lists it first in searches and in the `[` reference menu when you link that concept from another note. |
| `strip-priority <rem>[,<rem>…]` | Removes the [card priority](Prioritization-&-Sorting.md) from the rems the way the plugin's own removal does: the values first (including the hidden one and the priority history), then the tag, then the priority band badge and the cached entry. For Rems that stopped being flashcards. The answer lists the values removed, so they can be put back. |
| `heading <rem>[,<rem>…] [--level next\|1-6\|none]` | Sets the rems' heading level. `next` (default) does what [Set Next Heading Level](Utilities-Outline-and-Headings.md#set-next-heading-level) does, without its dialog: one level deeper than the nearest heading above, however many plain rems lie between (under an `H3` parent, or under a plain parent whose own parent is `H3`: `H4`), clamped at `H6`. Unlike the command, it never changes the parent; a rem with no heading above it is reported and left as it is. `1`–`6` sets that level, and `none` makes the rem a plain paragraph again. |
| `portal <rem>[,<rem>…] <parent> [position]` | Creates a **portal** under `parent` that shows the rems, in the order given, as typing `((` does in RemNote: the rem lives in one place of your notes and shows in full, editable, in another (for example a concept filed in its chapter, shown inside a summary of the chapter). `position` is as in `move`. The answer gives the new portal's id and the rems it shows. The RemNote MCP cannot make portals: its `[[…]]` only references. |
| `set-text <edits.json> [--chunk 25]` | Replaces the front and/or back text of rems with the exact rich text given, so cloze ids, formatting, references, pins and review history stay (an edit through RemNote's markdown renumbers clozes and cannot reach the back). The file lists `{remId, text?: {before, after}, backText?: {before, after}}`; a rem whose text no longer equals `before` is left alone and reported with its current text. An empty back (`[]`) makes no card but still shows *→ Back of card* in the editor; no plugin call can remove a back altogether, so to turn a card into a plain Rem, edit it once through RemNote's markdown (the MCP's `edit_rem`, with no delimiter) and then `set-text` its exact front again. |
| `outline <plan.json> [--chunk 30] [--dry-run]` | Builds or fixes an outline in a few jobs: `create` new plain-text rems under a parent (optionally tagged), make a parent's children come first in a given `order` (moving each from wherever it is; the parent's other children keep their relative order after them), set `heading` levels (1–6, or 0 for plain), and make rems `document`s. New rems are named by keys (`"new:3.1.2"`) that later steps use as parents and children; their ids are saved in `<plan>.keys.json` as they come back, so a run that stopped half-way resumes without creating anything twice. Used by tools that mirror a book's table of contents in its notes. |
| `remove <expect.json> [--chunk 25]` | Deletes rems, each only if it has no children and its front and back text still equal what the file gives (`{remId: {text, backText}}`). Anything else is kept and reported, so a rem edited since it was read is never lost. |

```bash
python3 media_bridge.py move AbC123 XyZ789 after:QrS456
python3 media_bridge.py tag PdF000,PdF111 TaG222
python3 media_bridge.py untag AbC123 "Extra Card Detail"
python3 media_bridge.py get-image AbC123
python3 media_bridge.py incrementalize AbC123,DeF456 --priority 20
python3 media_bridge.py pin AbC123 --refs HiG789
python3 media_bridge.py pin-quote AbC123,DeF456 --source PdF000
python3 media_bridge.py pin-quote AbC123,DeF456          # source found by your source finder
python3 media_bridge.py card DeF456 --type descriptor --direction both
python3 media_bridge.py card AbC123 --type concept   # a Concept with no card
python3 media_bridge.py card AbC123 --practice off   # as /Disable Card
python3 media_bridge.py strip-priority AbC123,DeF456
python3 media_bridge.py heading AbC123               # one level deeper than the heading above
python3 media_bridge.py portal AbC123 XyZ789 before:QrS456   # show AbC123 inside XyZ789
python3 media_bridge.py restore-audio AbC123,DeF456
python3 media_bridge.py set-text edits.json
python3 media_bridge.py remove expect.json
python3 media_bridge.py outline plan.json --dry-run   # counts only
```

An `outline` plan:

```json
{"create":  [{"key": "new:1.3.3", "parent": "AbC123", "text": "1.3.3 Basic Definitions", "tag": "TaG222"}],
 "order":   [{"parent": "AbC123", "children": ["DeF456", "new:1.3.3", "GhI789"]}],
 "heading": [{"rem": "new:1.3.3", "level": 3}],
 "document": ["XyZ789"]}
```

Each command prints the plugin's answer as JSON and exits with `0` when everything worked, `1` when something failed (the message says what), and `2` when the plugin did not answer in time. RemNote shows a toast for each operation except `get-image`; the console logs them under `[MediaBridge]`.

Unlike `localize`, these commands never run late: if the plugin does not answer before the command gives up, a job still waiting is cancelled, and a job the plugin took but never finished (for example because the plugin reloaded) is reported as lost rather than run again. Check the rems and run the command again.

## Notices from outside tools { #notice }

`notice` shows a message in RemNote, in the plugin's notice card at the top right, the same card that says a [Read aloud](Read-Aloud.md#use) audio is in. With `--rem`, the card has an **Open Rem** button that opens that rem. An outside tool, or an AI assistant that just wrote an explanation into RemNote, uses it to say *it is done, and here it is*:

```bash
python3 media_bridge.py notice --title "Paralelos: Regra 13" --message "4 books, 1 divergence" --rem AbC123
```

`--tone` is `success` (default), `info` or `error`; `--detail` adds a smaller line. The card never takes the focus or closes a popup you are working in, and it stays until you dismiss it. If it covers something, drag it anywhere but its buttons to move it out of the way; a new card always opens at the top right again. The command never fails its caller: when RemNote is closed it prints `"status": "queued"`, and the notice shows as soon as a RemNote window connects to the helper.

### Questions with buttons { #ask }

`ask` shows the same card with one button per answer, for an outside tool that needs a decision before it changes something: by default **Accept** and **Reject**, or the labels given in `--choices` (the first is the primary button). `--items` takes a JSON file of boxes, `[{title, lines: [...]}]`, one per proposed change; `--rem` adds **Open Rem**, which opens the rem and leaves the question up. The command prints an `askId`; `answer` reads the answers, and waits for them with `--wait` (`--any` returns at the first):

```bash
python3 media_bridge.py ask --title "Move the annotation?" --message "Into 2.1.2.4 Ship Squat (PDF p. 37)" \
    --rem AbC123 --choices "→ 2.1.2.4,→ D.4,Leave"            # prints {"askId": "…"}
python3 media_bridge.py answer 3ac21c70f41a,138ff0c45f91 --any --wait 3600
```

The answer is the label pressed, or `dismissed` when the card was closed without one (**Dismiss all**, Esc). Answers are kept in `~/.remnote-media-bridge/answers.json`, so they survive a restart of the helper; a question not yet answered disappears with the RemNote window that shows it (reloading RemNote), and the tool can ask again. Ask one thing per card: put several changes in one card only when a single answer fits them all.

!!! note "Plugin and helper versions"
    These operations need this plugin version and the matching `media_bridge.py`; **Upscale image with ChatGPT** needs helper version 3, [Read aloud](Read-Aloud.md) version 12, [Copy Rem ID](Utilities-Finding-and-Navigating.md#copy-rem-id) copies silently only with version 4, `pin`, `pin-quote` and `card` need version 5, `tag` needs version 6, `restore-audio` needs version 13, `notice` version 14, `set-text` and `remove` version 15, `heading` version 16, `portal` version 17, `ask`, `answer` and `outline` version 18, and `strip-priority` and `card --practice` version 19 (`media_bridge.py status` shows the version). An older plugin still gets `localize` jobs; the others wait, and the command warns that the plugin does not know them yet. After updating the script, restart the helper (`media_bridge.py stop`, or `launchctl kickstart -k …` when it runs at login).
