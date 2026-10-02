# Findings

How RemNote actually behaves, established by measurement or read out of the desktop app bundle, wherever the Plugin SDK's typings and docs are silent or wrong. Maintainer notes, not published: the docs site is built from `docs/` only.

A finding earns a file here when getting it wrong costs real time: a silent failure, a wrong assumption the code once shipped with, or a fact that took a bundle dig to settle. Each one records **what was established, how, and when** (RemNote version or date), because RemNote changes underneath the plugin. Re-verify before relying on an old one.

| File | What it covers |
|---|---|
| [CARD_STATE_REFERENCE.md](CARD_STATE_REFERENCE.md) | Disabled, paused and not-generated cards: what each looks like through the API, and how to tell them apart |
| [REMNOTE_POWERUP_CODES.md](REMNOTE_POWERUP_CODES.md) | RemNote's built-in powerup and slot codes compared with the SDK's (e.g. Card Cluster `cc`, missing from the SDK) |
| [REM_REFERENCES_AND_MERGE.md](REM_REFERENCES_AND_MERGE.md) | References, pins, inline links, tags, portals: how they are stored, and how RemNote's merge repoints them |
| [PDF_AND_HTML_HIGHLIGHTS.md](PDF_AND_HTML_HIGHLIGHTS.md) | PDF and web-article highlight Rems: `Data` shapes, text vs area highlights, creating highlights, the Highlights container |
| [QUEUE_AND_PRACTICE.md](QUEUE_AND_PRACTICE.md) | The flashcard queue from a plugin: the GetNextCard deadline, queue events, bury, Need to Learn cards, launching queues, the `<Queue>` embed, flashcard widget slots and the Beautiful queue bottom layout |
| [EDITOR_DOM_AND_CSS.md](EDITOR_DOM_AND_CSS.md) | The editor's DOM and what plugin CSS can reach: `data-rem-tags`, the bullet, the tag bar, table cells |
| [MEDIA_AND_FILE_STORAGE.md](MEDIA_AND_FILE_STORAGE.md) | Linked vs stored images and audio (`%LOCAL_FILE%`), and the two importer calls through which a plugin can upload |
| [PLUGIN_BRIDGE_AND_SDK.md](PLUGIN_BRIDGE_AND_SDK.md) | Plugin bridge and SDK traps: storage limits, built-in powerup membership, retired slots, lazy children, shortcuts, build pitfalls |
| [support-reports/](support-reports/) | Reports sent to RemNote support, with their follow-ups |

## How findings are established

**Read the app bundle.** `/Applications/RemNote.app/Contents/Resources/app.asar` (~270 MB, minified but readable) answers what a UI button really writes, what values a hidden slot takes, and how the plugin bridge handles a call:

```bash
cd /Applications/RemNote.app/Contents/Resources
LC_ALL=C grep -aobF 'Pin To Sidebar' app.asar                   # byte offsets of a label or method name
LC_ALL=C dd if=app.asar bs=1 skip=$((off-2500)) count=5000 2>/dev/null \
  | tr -c '[:print:]' '\n' | grep -v '^$'                       # a readable window around one
LC_ALL=C grep -oa 'rem-bullet__container[^A-Za-z_-].\{0,220\}' app.asar | sort -u   # class names, CSS
```

Search for a user-visible label, a camelCase method name, a class name or an enum value, then read a few KB around the offset. Keep patterns bounded (`.\{0,N\}`): unbounded ones and ripgrep choke on the binary. The bridge's handlers are registered as `name:"<sdkMethod>"`, so `grep -aobF 'name:"setText"'` lands on exactly what a plugin call does.

**Read the local database.** `~/remnote/remnote-<kbId>/remnote.db` is SQLite; open it read-only (`file:…?mode=ro`). Table `quanta(_id, doc)` holds each Rem as JSON, with powerup slots under `doc.ps["<code>_<slot>"].v.v` (older Rems: `doc.bpc.<code>.<slot>.v`) and powerup membership in `doc.apu`. `deleted_quanta` keeps deleted Rems, slot history included. It is the fastest way to see real slot values the SDK and MCP don't expose.

**Measure through the plugin.** The debug widget (`src/widgets/debug.tsx`) carries probes for the questions above (Probe Card Enablement, Probe Spoiler State, Calibrate size ceiling…). Probe one Rem and read it back before any bulk write.
