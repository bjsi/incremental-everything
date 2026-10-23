# Video playback: YouTube in the plugin, RemNote's video Rems, local files

Established 2026-10-23 on RemNote 1.28.56 (live `build_overrides` bundle), the local DB of the "Incremental Everything" KB, and a Chrome reproduction of the plugin sandbox. Plugin at v1.0.164.

## Why the plugin's YouTube player is black (ReactPlayer, `src/components/Video.tsx`)

Plugin widgets are iframes with

```
PLUGIN_IFRAME_SANDBOX = "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
```

with no `allow-same-origin`, so the plugin runs on an opaque (`null`) origin. Nested iframes inherit the sandbox, so the YouTube embed ReactPlayer creates also gets an opaque origin. YouTube's embed bootstrap (`m=root,base`) now reads `window.caches`. On an opaque origin that read throws `SecurityError: Failed to read the 'caches' property … lacks the 'allow-same-origin' flag`. The bootstrap dies, so `writeEmbed is not defined` and the frame stays black. The `postMessage … target origin … ('null')` warning comes from the same cause. The `cdn-cgi/rum` CORS errors and `web-share` warnings in the console are unrelated noise.

**Reproduced** with a local page that copies those exact flags around a YouTube IFrame-API player:

| Frame | Result |
|---|---|
| plugin flags, `www.youtube.com` | black, never `onReady` |
| plugin flags, `www.youtube-nocookie.com` | black, never `onReady` |
| plugin flags + `allow-same-origin` | plays; `start`/`end`/`seekTo` work |
| no sandbox | plays |

No URL, host or ReactPlayer option can fix this from inside the plugin iframe. `requestNative: true` is not an option either: the marketplace review screen says "Request Native … (REJECT IF TRUE FOR NOW)". HTML5 `<video>` with a URL the frame can load is unaffected.

## A way out: Embed Website (`ew`) and postMessage

The Embed Website powerup (`ew`, slots URL `u`, WIDTH `w`, HEIGHT `h`; the SDK knows it as `BuiltInPowerupCodes.EmbedWebsite`, so pass slot *names*) is rendered **by the host** in an iframe with

```
"allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-presentation allow-storage-access-by-user-activation"
```

as long as the URL is a valid https URL, is not RemNote's own origin, and is **not on `remnoteplugins.com`**. RemNote deliberately keeps plugin-CDN pages out of same-origin frames. The bridge lets plugins `addPowerup` a built-in code and `setPowerupProperty` any registered slot.

**Tested (Chrome, simulated layout):** a frame with the plugin's sandbox finds a sibling frame through `window.top.frames` (cross-origin `WindowProxy` indexing and `postMessage` are allowed) and drives:

1. **A raw `https://www.youtube.com/embed/<id>?enablejsapi=1` frame**, using YouTube's own widget protocol: post `{"event":"listening","id":1,"channel":"widget"}` to every frame, and YouTube answers `event.source` with `infoDelivery` (`currentTime`, `playerState`, …). `{"event":"command","func":"seekTo","args":[200,true]}` and `pauseVideo` worked: it seeked to 200 s and paused at 205 s. Ignore your own echo, because `window.top.frames` includes the plugin frame.
2. **A hosted wrapper page** with its own message protocol, which also worked (seek to 100 s, pause at 105.4 s).

Not yet verified inside RemNote:
- that a `<RemViewer>`/`<DocumentViewer>` of an `ew` Rem renders the iframe in the queue;
- the desktop app. Its host origin is `app://js`, and YouTube may refuse an embed with no usable referrer (Error 153). That is why RemNote serves its own wrapper (see below), and why a self-hosted wrapper on an https origin (e.g. the docs site) is the fallback.

RemNote's wrapper, `https://backend.remnote.com/embed/youtube/<id>?start=&controls=`, messages of type `remnote-youtube-embed`, accepts commands only from `window.parent` and posts only to `window.parent`. A plugin cannot use it.

## RemNote's own video Rems (Create › Upload File › YouTube URL)

Read from `remnote.db` (Rem `eVTm6KiURagOtwomR`) and the bundle:

| Powerup | Slot | Meaning |
|---|---|---|
| Video `vi` | URL `u` | the pasted URL, e.g. `https://youtu.be/g5r7xD-f4nk?si=…` |
| | Name `n`, Title `t`, TranscriptURL `tu` | name, fetched title, transcript (unset here) |
| In Progress `ip` | LastWatchedTime `l` | seconds as a string, e.g. `"327.710334"` |
| | TotalDuration `d` | seconds (`"3744"`) |
| | DesiredCardsState `s` | Learn-video goal JSON |
| | VideoPlayerSettings `v` | |
| VideoHighlight `vh` | Data `d` | `{"startCueIndex","endCueIndex","text"}`: **transcript cue indexes, not seconds** |
| | RemVideoId `p` | reference to the `vi` Rem |

- `vi` and `ip` are not in the SDK enum, so the SDK passes the slot code through unchanged: `rem.getPowerupProperty('vi','u')` and `('ip','l')`. The host's `getPowerupProperty` handler does no slot validation. `setPowerupProperty` checks only that the slot is registered (`ip.l` is), so a plugin write is accepted. Writes were not tested live.
- **Who writes `ip.l`:** the learning-page video controller, `storeLastWatchedTime = _.throttle(…, 3000)` on every progress tick, so the stored position lags by up to 3 s while playing.
- **Who reads it:** `onReady` sets `lastWatchedSecond` from it, and the page shows a **"Resume watching at {{timestamp}}"** button. It does **not** auto-seek; the user has to click. `onPlay` clears the button.
- The player has internal `seekTo` and time-range auto-pause triggers (AI sections). None of them are reachable from a plugin.
- The video learning suite is YouTube-only: `getOrCreateVideoRemFromURL` accepts only YouTube URL shapes, and usage is metered (`YOUTUBE_ANNOTATION`).
- The transcript cues are not stored in `remnote.db`.

## Local video files

- RemNote has no interface for local video files and does not store them; the KB holds none. A plugin feature for local video would be entirely the plugin's own. (Even the local media RemNote does store, i.e. audio and images as `%LOCAL_FILE%`, reaches the host as **host-origin blob URLs** via `getAudioURLForCurrentDevice`, which a sandboxed plugin can't load.)
- In the plugin frame, `<video>` works with `blob:` URLs the frame creates itself (file `<input>`), with media URLs from anywhere, and with `http://127.0.0.1:<port>/…` (loopback counts as potentially trustworthy, so it is not mixed content). The opaque origin has no IndexedDB, so a picked file handle can't be kept between sessions.
