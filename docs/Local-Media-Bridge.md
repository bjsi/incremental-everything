# Local Media Bridge

Lets tools outside RemNote — scripts, or an AI assistant writing through the RemNote MCP — put **local images** into your rems and have RemNote **store them itself**, as if you had pasted them. **Desktop app only; the helper is a small Python script (macOS, Linux or Windows).**

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
