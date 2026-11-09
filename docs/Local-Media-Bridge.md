# Local Media Bridge

Lets tools outside RemNote — scripts, or an AI assistant writing through the RemNote MCP — put **local images** into your rems and have RemNote **store them itself**, as if you had pasted them. It also lets them [move rems, remove tags, read out images and make rems Incremental](#operations), and it runs the command [Upscale image with ChatGPT](#upscale). **Desktop app only; the helper is a small Python script (macOS, Linux or Windows).**

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
2. A popup opens and the helper sends the image to ChatGPT. This takes about 45 seconds per image. **Keep the popup open**: if you close it, the generation finishes but nothing is replaced (the result is only saved on disk).
3. The popup shows the original beside the result and the outcome of an automatic check:
    - **✓ Same content**: no line, colour or word changed.
    - **⚠ Check before replacing**: something differs. The popup lists what, and shows zoomed views of each region that changed (original on the left, new on the right). **Differences** colours the overlay: grey is in both images, red only in the original, blue only in the new one.
4. Compare the two images yourself, especially digits, symbols and formulas, which the check cannot read. Then press **Replace image**, or **Try again**, optionally with an instruction such as *the dashed lines must stay dashed*.

**Replace image** stores the new image in RemNote and swaps it into the Rem in place: the caption, the display width and the flashcards stay as they were. A Rem with several images goes through them one at a time, and **Skip this image** passes one by. Every run is saved under `~/Pictures/remnote-upscale/<remId>/<date-time>/`, including the original, so a replaced image can always be put back by hand.

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
| `untag <rem>[,<rem>…] <tag>` | Removes a tag, given by id or by name as shown in RemNote. Also removes built-in powerups such as **Extra Card Detail** or **Quote**, by name or as `powerup:<code>` (`powerup:x`). `--drop-properties` also deletes the tag's property values. The **Incremental** tag is refused: dismiss the rem instead, which keeps its history. |
| `get-image <rem> [--out DIR]` | Copies the images of the rem (front and back) to files, by default in `~/.remnote-media-bridge/out/`, and prints their paths. Images stored in RemNote are read from RemNote's own folder on this computer; linked ones are downloaded. |
| `incrementalize <rem>[,<rem>…] [--priority N]` | Makes the rems Incremental exactly like the plugin's own command: first date from the Initial Interval, the history entry, the cache and the inheritance cascade. Without `--priority` the priority is inherited or the default. On a rem that is already Incremental, `--priority` changes its priority (recorded in its history as *Local bridge* 🔌). |

```bash
python3 media_bridge.py move AbC123 XyZ789 after:QrS456
python3 media_bridge.py untag AbC123 "Extra Card Detail"
python3 media_bridge.py get-image AbC123
python3 media_bridge.py incrementalize AbC123,DeF456 --priority 20
```

Each command prints the plugin's answer as JSON and exits with `0` when everything worked, `1` when something failed (the message says what), and `2` when the plugin did not answer in time. RemNote shows a toast for each operation except `get-image`; the console logs them under `[MediaBridge]`.

Unlike `localize`, these commands never run late: if the plugin does not answer before the command gives up, a job still waiting is cancelled, and a job the plugin took but never finished (for example because the plugin reloaded) is reported as lost rather than run again. Check the rems and run the command again.

!!! note "Plugin and helper versions"
    These operations need this plugin version and the matching `media_bridge.py`; **Upscale image with ChatGPT** needs helper version 3 (`media_bridge.py status` shows the version). An older plugin still gets `localize` jobs; the others wait, and the command warns that the plugin does not know them yet. After updating the script, restart the helper (`media_bridge.py stop`, or `launchctl kickstart -k …` when it runs at login).
