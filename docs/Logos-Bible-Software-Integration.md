# Logos Bible Software Integration

![Logos Bible Software](assets/Logos.webp){ width="200" }

Read your **Logos Bible Software** books incrementally without leaving Logos: import a book as an Incremental Rem, send passages to RemNote as extracts, and keep a bookmark of where you stopped — all with keyboard shortcuts pressed in Logos. **macOS only.**

What you get:

- **`Ctrl+Opt+N`** imports the open book as a top-level Incremental Rem tagged **#Logos**, once per book.
- **`Ctrl+Opt+X`** sends the selected passage to RemNote as an extract, asking priority and interval in a small panel over Logos. **`Ctrl+Opt+Shift+X`** does it without asking.
- Every extract keeps its formatting, links back to its exact place in Logos, and moves the book's **bookmark** there.
- **`Ctrl+Opt+B`** saves where you stopped reading.
- **Open in Logos** jumps from RemNote to the book's bookmark or the extract's passage — on demand, or automatically when the book comes up for review.
- Optionally, each extracted passage gets a **highlight in Logos**, so you can see what you have already extracted.

## How it works { #how-it-works }

Logos for Mac has no automation interface, and a RemNote plugin cannot reach other programs, so a **small helper app (LogosBridge)** runs in the background and connects the two:

1. When you press a shortcut in Logos, the helper runs Logos's own **Copy** on your selection. Logos puts the passage on the clipboard with its formatting, the book, and a link to the exact spot. The helper reads that, then **puts your clipboard back** as it was.
2. The plugin picks the passage up from the helper and creates the Rem in RemNote.

The helper only accepts connections from your own computer, and its shortcuts exist only while Logos is the app in front.

**Requirements:** macOS, **Logos** desktop, **RemNote** desktop, and Apple's **Command Line Tools** (to build the helper).

## Setup { #setup }

1. **Install the Command Line Tools** (skip if you have Xcode):

    ```bash
    xcode-select --install
    ```

2. **Download and build the helper:**

    ```bash
    mkdir -p ~/.incremental-remnote/logos-bridge-src && cd ~/.incremental-remnote/logos-bridge-src
    curl -O https://raw.githubusercontent.com/hugomarins/incremental-remnote/main/scripts/logos_bridge/LogosBridge.swift
    curl -O https://raw.githubusercontent.com/hugomarins/incremental-remnote/main/scripts/logos_bridge/build.sh
    bash build.sh
    ```

    This builds `~/.incremental-remnote/logos-bridge/LogosBridge.app`, starts it, and registers it to [start at every login](#start-at-login).

3. **Allow Accessibility.** macOS asks for it the first time; if not, open **System Settings ▸ Privacy & Security ▸ Accessibility**, click **+**, press `⌘⇧.` to show hidden folders, and choose `~/.incremental-remnote/logos-bridge/LogosBridge.app`. The helper needs it to press Copy in Logos.

4. **Turn on the plugin side:** IE Settings ▸ Integrations ▸ **Logos Bible Software Bridge**.

To check the helper is running, open <http://127.0.0.1:3458/ping>: the answer shows `"ok": true`.

### Start at login { #start-at-login }

`build.sh` does this for you: it installs a login item at `~/Library/LaunchAgents/com.incrementalremnote.logos-bridge.plist`, so the helper starts whenever you log in and is restarted if it ever quits. There is nothing to open by hand — it has no window or Dock icon, and shows only its messages over Logos.

- **Restart it** (after editing the port in `config.json`, for example):

    ```bash
    launchctl kickstart -k gui/$(id -u)/com.incrementalremnote.logos-bridge
    ```

- **Update it:** download the two files again and rerun `bash build.sh`; it replaces the app and restarts it.
- **Stop it and remove it from login:**

    ```bash
    launchctl bootout gui/$(id -u)/com.incrementalremnote.logos-bridge
    rm ~/Library/LaunchAgents/com.incrementalremnote.logos-bridge.plist
    ```

### Keep the permission after updates { #signing }

macOS ties the Accessibility permission to the app's signature. Without a certificate, every rebuild is a new app to macOS and the permission must be granted again. To avoid that, create a certificate once:

1. Open **Keychain Access ▸ Certificate Assistant ▸ Create a Certificate**.
2. Name it `LogosBridge Code Signing`, Identity Type **Self Signed Root**, Certificate Type **Code Signing**, and click **Create**.

From then on `build.sh` signs with it (it prints `Signed with "LogosBridge Code Signing"`), and the permission survives rebuilds. The first build with the certificate still needs the permission once: remove the old LogosBridge entry with **−** and add the app again.

## Reading a book { #reading-a-book }

### 1. Import the book { #import }

In Logos, **select any word in the book** and press **`Ctrl+Opt+N`**. A panel shows the book's title, priority and interval (empty = your default priority and initial interval); `Enter` creates it, `Esc` cancels.

RemNote then gets:

- a **top-level document** named after the book, tagged **#Logos** — open the tag to see all your Logos books;
- the book's Logos identifier in the tag's **Resource ID** property;
- **Incremental** status with the priority and interval you chose;
- a **bookmark** at your current position.

The new Rem opens in RemNote, and the helper switches to RemNote.

**Each book is imported once.** If the book is already in your knowledge base, no panel appears: RemNote opens the existing Rem and the helper tells you it is already there. The match is by the Logos identifier, so it works even if you renamed the Rem; books imported before the identifier existed are matched once by title and then get it.

!!! tip "Why select a word"
    The selection tells the helper exactly which book and where. Without one, it falls back to Logos's history — but Logos records a book there only once you move inside it, so right after opening a book the history still names the previous one. The helper uses history only when it matches the page Logos shows; otherwise it asks you to select a word.

### 2. Review it { #review }

The book comes up like any Incremental Rem — in the queue, or with [Review in Editor](Reviewing-Items-in-the-Editor.md). Run **Open in Logos** (`olg`) to jump to its bookmark in Logos, or turn on [Open in Logos Automatically](#settings) to have Logos come forward on its own.

### 3. Extract { #extract }

Select a passage in Logos and press **`Ctrl+Opt+X`**. The panel shows where the extract will go, a preview, and the priority and interval:

| Key | Action |
|---|---|
| `↑` / `↓` | Adjust the field (`Shift` for ±10) |
| `Tab` | Switch between priority and interval |
| `Enter` | Create the extract |
| `⌘Enter` | Add it as a plain child, not incremental |
| `Esc` | Cancel |

**Where it goes:** under the **Incremental Rem you are reviewing** — in the queue or in an Editor Review session — or under the Rem you have focused inside it. With no review running, under the focused Rem.

**What it contains:** the passage with its bold and italics (the book's own footnote markers are left out), ending with a **📖 link** back to its exact place in Logos. It inherits the book's priority unless you change it.

**`Ctrl+Opt+Shift+X`** extracts without the panel, with the inherited priority and your default interval.

A short message over Logos confirms each extract.

### 4. The bookmark { #bookmark }

The bookmark is the book's **first child**: `📍 Logos: <book>, p. 37 · <date>`, where the book and page are a link to the spot. There is one per book, updated in place:

- **every extract** moves it to the start of the passage you extracted;
- **`Ctrl+Opt+B`** saves where you stopped — select a word there for the exact spot.

**Open in Logos** resumes from the bookmark. On an extract, it opens the extract's own passage instead. Clicking the link in the bookmark also works, through your browser.

## Mark extracted passages in Logos { #highlight }

The helper can press a **Logos highlighter shortcut** right after each extract, so extracted passages stand out in Logos the way extracts do in RemNote. Set it up once:

1. In Logos, open **Tools ▸ Highlighting**.
2. In any palette choose **Add a new style**, name it `RemNote Extract` and give it a blue background — or use an existing blue style.
3. Right-click the style, choose **Shortcut key:**, and pick a letter, for example `B`.
4. Put the same letter in `~/.incremental-remnote/logos-bridge/config.json`:

    ```json
    "highlightKey": "b"
    ```

The file is read on every shortcut, so no restart is needed.

## Shortcuts { #shortcuts }

Pressed **in Logos**; they are free in every other app.

| Shortcut | Action |
|---|---|
| `Ctrl+Opt+X` | [Extract the selection](#extract), with the priority panel |
| `Ctrl+Opt+Shift+X` | Extract without the panel |
| `Ctrl+Opt+B` | [Save the bookmark](#bookmark) |
| `Ctrl+Opt+N` | [Import the open book](#import) |

In RemNote: **Open in Logos** — `quick: olg`.

## Settings { #settings }

In IE Settings ▸ Integrations:

- **Logos Bible Software Bridge** — turns the plugin side on. Leave it off unless the helper is installed; the plugin then never contacts it, and **Open in Logos** is not registered.
- **Open in Logos Automatically** — when an Incremental Rem comes up in the queue, or an Editor Review timer starts, Logos comes forward at its bookmark or passage. Each Rem opens once per appearance, and Rems without a Logos link are left alone.

## Troubleshooting { #troubleshooting }

- **"LogosBridge needs Accessibility"** — the permission is missing, usually after an update. Remove LogosBridge from the Accessibility list and add it again; see [Keep the permission after updates](#signing).
- **"Select a word in the book first"** — the helper could not tell which book is open. Select any word in the book and press the shortcut again.
- **The panel says RemNote is not connected** — check that RemNote is open and the **Logos Bible Software Bridge** setting is on. What you send waits in the helper until RemNote connects.
- **Links in Uploaded Files** — every Logos link RemNote shows is a Link Rem, kept in your **Uploaded Files** document, as when you paste a link yourself.
- The helper writes a log at `~/.incremental-remnote/logos-bridge/bridge.log`.
