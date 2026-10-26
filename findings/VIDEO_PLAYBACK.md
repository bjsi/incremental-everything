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

**Not every URL gets that iframe** (1.28.56, verified in the app 2026-10-23). The component branches on the URL: Vimeo → a Vimeo player; Google Drive → a Drive preview; **`youtube.com` / `youtu.be`** (hostname check `Eg`, after stripping `www.`/`m.`) → **RemNote's own YouTube component**, i.e. the origin-locked `backend.remnote.com` wrapper. Only everything else gets the plain same-origin iframe. A probe `ew` Rem with a `youtube.com/embed/…?enablejsapi=1` URL played fine, on desktop too, but the bridge got no message at all. **Use `https://www.youtube-nocookie.com/embed/<id>?enablejsapi=1`**: it isn't matched, so it gets the plain iframe, and a raw nocookie embed answers the bridge (Chrome: seek to 200 s, pause at 205 s).

**Tested (Chrome, simulated layout):** a frame with the plugin's sandbox finds a sibling frame through `window.top.frames` (cross-origin `WindowProxy` indexing and `postMessage` are allowed) and drives:

1. **A raw `https://www.youtube.com/embed/<id>?enablejsapi=1` frame** (and the same with `www.youtube-nocookie.com`), using YouTube's own widget protocol: post `{"event":"listening","id":1,"channel":"widget"}` to every frame, and YouTube answers `event.source` with `infoDelivery` (`currentTime`, `playerState`, …). `{"event":"command","func":"seekTo","args":[200,true]}` and `pauseVideo` worked: it seeked to 200 s and paused at 205 s. Ignore your own echo, because `window.top.frames` includes the plugin frame.
2. **A hosted wrapper page** with its own message protocol, which also worked (seek to 100 s, pause at 105.4 s).

Inside RemNote: a `<DocumentViewer>` (in a popup) of a document holding an `ew` Rem does render the embed, on web and desktop.

**Desktop: a raw embed gets Error 153** (verified in the app 2026-10-23). The nocookie `ew` iframe connected to the bridge (`initialDelivery`, `onReady`), then reported `onError(153)` ("Video player configuration error"). YouTube needs a Referer, and `app://js` pages send none. Reproduced in Chrome with `referrerpolicy="no-referrer"`.

**Fix: our own https player page** (`docs/player/youtube.html`, published at `https://hugomarins.github.io/incremental-remnote/player/youtube.html`). It mirrors RemNote's wrapper: IFrame API with the nocookie host. It relays `{type:'ie-youtube-player', command}` from any frame and posts state to every frame that said hello. YouTube sees the page's own origin as referrer. In Chrome, loaded with no referrer from its parent, it played, and the sandboxed frame's seek, pause and progress (every 250 ms) all worked. Embed Website accepts `http:` too, so `http://localhost:<port>/player/youtube.html` works for local testing.

**Autoplay (browser).** RemNote's `ew` iframe has no `allow="autoplay"`. Without it, a `play` command that arrives by message, with no click in that frame, is refused (it buffers, then goes back to unstarted). Muted play is allowed, but `unMute` without a click pauses it. Seek and pause are always allowed. Once the user has clicked the video once, `play` commands work. Electron's default autoplay policy needs no user gesture, so the desktop app shouldn't need that first click (to confirm).

**RemNote re-creates the embed's iframe on hover** (desktop, queue, 2026-10-23). Inside the plugin's `<DocumentViewer>` in the queue, the first time the mouse moves over the embed, while RemNote's row hover controls appear (⋮⋮ grip, "⋯" menu), the iframe goes black and the page loads afresh. That reload restarts the video from the URL's start time at 1×. The plugin's own React tree did not remount (no unmount logged), so it is host-side. Hovering the same document opened directly in RemNote web did not reload it. The plugin can't prevent it, so it survives it. The page sends `{event:'loaded', instance}` to every frame on load, and every message carries `instance`, which is new on each load. The plugin then restores the last position, speed and play/pause state (`components/PluginYouTubePlayer.tsx`). The reload can't be detected without `instance`: by the time the bridge re-says hello (after 3 s of silence), the fresh player is already ready and answers `ready`, exactly like the old one.

**An origin-locked player can't be driven.** The IFrame API always passes `origin=` (the embedding page's origin). A copy of RemNote's wrapper (IFrame API, `origin=https://backend.remnote.com`, nested one frame deep) neither answered the handshake nor obeyed a blind `seekTo(600)` sent to every frame: it stayed at 10 s. So the plugin can't seek or pause RemNote's own video player. Only a raw `/embed/` URL without `origin=` answers.

RemNote's wrapper, `https://backend.remnote.com/embed/youtube/<id>?start=&controls=`, messages of type `remnote-youtube-embed`, accepts commands only from `window.parent` and posts only to `window.parent`. A plugin cannot use it.

**Screenshots of the player can't be taken inside RemNote** (1.28.57, 2026-10-23). A canvas can't read the frame: the video sits in YouTube's cross-origin frame, and its media comes from googlevideo without CORS. Screen capture is out too. No RemNote iframe `allow` list includes `display-capture`, and the desktop app's `app.asar` has no `setDisplayMediaRequestHandler` or `desktopCapturer`, so Electron rejects `getDisplayMedia`. The local helper does it instead (`/video-frame` in `scripts/ai_ocr_helper.py`). `yt-dlp -g` gives a stream URL, which is cached for an hour, and `ffmpeg -ss <t> -i <url> -frames:v 1` grabs the exact frame. That takes about 6 s cold and 1.5 s with the cached URL, at the video's own resolution, with no player controls in it.

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

- `vi` and `ip` are not in the SDK enum, so the SDK passes the slot code through unchanged: `rem.getPowerupProperty('vi','u')` and `('ip','l')`. The host's `getPowerupProperty` handler does no slot validation. `setPowerupProperty` checks only that the slot is registered (`ip.l` is). **Verified in the app (2026-10-23):** both reads work, `ip.l` follows playback live, and a plugin write to `ip.l` sticks and becomes the "Resume watching at…" time.
- **`ip.l` is reset when the video page opens (very likely).** It read 342.7 s; after the page was reopened it read 0, with no plugin write in between (2026-10-23). Earlier a probe label had also shown 0 right after the page loaded. Possibly the player's first progress event (time 0) is stored after `onReady` has already read the resume time, so leaving without resuming would lose the position. So the plugin must keep its own position, and trust `ip.l` only as the live position while RemNote's player is open.
- **Who writes `ip.l`:** the learning-page video controller, `storeLastWatchedTime = _.throttle(…, 3000)` on every progress tick, so the stored position lags by up to 3 s while playing.
- **Who reads it:** `onReady` sets `lastWatchedSecond` from it, and the page shows a **"Resume watching at {{timestamp}}"** button. It does **not** auto-seek; the user has to click. `onPlay` clears the button.
- The player has internal `seekTo` and time-range auto-pause triggers (AI sections). None of them are reachable from a plugin.
- The video learning suite is YouTube-only: `getOrCreateVideoRemFromURL` accepts only YouTube URL shapes, and usage is metered (`YOUTUBE_ANNOTATION`).
- The transcript cues are not stored in `remnote.db`.

## A plugin can't show a video Rem as a plain document

Checked in the 1.28.57 bundle on 2026-10-23. The host's `Document` component opens a Rem as its "learning source" (the video page with player, outline, transcript, AI) when `!props.dontShowLearningSource && document.isLearningSourceFile()`. `isLearningSourceFile()` is true for a Rem with any of these powerups: UploadedFile, Video (`vi`), Link, AudioRecording, SavedSharedArticleStudy or SavedSharedLearningOutline. The plugin's `DocumentViewer` fake embed passes only `knowledgeBaseId, mosaicId, scrollRef, focusId, readOnly, toggleReadOnly, allowToggleReadOnly, shouldTakeGlobalFocus` plus `documentId`. So it always shows a `vi` Rem as RemNote's video page. The plain document view, with **Re-Open Video** in the pills, comes from a pane that sets `dontShowLearningSource`, which a plugin can't reach. `RemHierarchyEditorTree` renders the Rem's children as an editable tree without that switch. It is the closest a plugin can get. It leaves out the root Rem itself, its slot rows and its property rows; it shows only the body, as on a document page. So the plugin draws the name itself (tested 2026-10-26).

## Where a plugin widget can sit on the video page

- **`PaneHeader` does not render on the video page** (verified in the app 2026-10-23). The video pane's "Notes · AI Learning Tools · ⋯" header isn't the toolbar that hosts it; a probe label showed only in the editor pane opened by **Notes**. (The bundle's `isReaderViewer` branch that renders `PaneHeader` is some other reader.) `PaneHeader` context is `{ paneId }`; `plugin.window.getOpenPaneRemId(paneId)` maps it to a Rem (not reactive).
- `DocumentAboveToolbar` (the editor review timer) also appears only once **Notes** opens the document beside the video.
- **`RightSidebar`** plugin widgets are reachable on the video page (the sidebar there has Learn Video / AI Tutor / Summary / Highlights / Plugins tabs plus plugin icons).
- **`FloatingWidget`** (`openFloatingWidget(name, {bottom, right}, undefined, false)`) is drawn above every page. Verified in the desktop app (2026-10-23): it stays bottom-right over the video page, is clickable, and its tracker shows `ip.l` ticking with the right position.
- `TopBar` was not tried: as soon as any widget is registered there, RemNote changes its own top-right chrome (`hasTopWidgets`).

## Transcripts (checked 2026-10-26)

- **The plugin's proxy is dead.** `yt-local-proxy.js` asks Innertube `youtubei/v1/player` with the ANDROID client 19.02.39. YouTube now answers `400 FAILED_PRECONDITION` ("Precondition check failed"). The reply has no `playabilityStatus`, so the proxy reports `playability_error: Video status: undefined`, which is what `/tmp/yt-transcript-proxy.log` shows. The plugin turns it into a "⚠️ Transcript unavailable" toast, raised right after "✅ Created video extract", so it is likely swallowed (see the memory note on plugin toasts).
- **RemNote's player gets its transcript from RemNote's server.** The video page calls the RPC `getYoutubeTranscript({videoId})` (client `fetchTranscript` in bundle 21129, 3 retries). Errors handled there: `transcript_not_found`, `out_of_ai_credits`, `transcript_fetch_failed`. The server side runs it with the user's id and IP. The cues come back as `{start, end, text}`, indexed by position, and **aren't stored in the KB** (`vi.tu` stays unset). A Highlight Moment keeps its own text in `vh.d.text` with cue indexes, not seconds. A plugin can't call the RPC: it isn't in the SDK, and it is RemNote's private, metered API.
- **yt-dlp still works (2026.10.21, with deno for YouTube's JS challenges).** `yt-dlp -J` lists the video's `language` and its `subtitles` / `automatic_captions`. The original-language ASR track is `<lang>-orig` (e.g. `pt-orig`). Its `json3` URL fetches fine directly (200, 2129 cues for `O_XN2pCKH-w`). **Translated auto tracks** (e.g. `en` on a Portuguese video) got `HTTP 429`, so ask for the original track.

## Local video files

- RemNote has no interface for local video files and does not store them; the KB holds none. A plugin feature for local video would be entirely the plugin's own. (Even the local media RemNote does store, i.e. audio and images as `%LOCAL_FILE%`, reaches the host as **host-origin blob URLs** via `getAudioURLForCurrentDevice`, which a sandboxed plugin can't load.)
- In the plugin frame, `<video>` works with `blob:` URLs the frame creates itself (file `<input>`), with media URLs from anywhere, and with `http://127.0.0.1:<port>/…` (loopback counts as potentially trustworthy, so it is not mixed content). The opaque origin has no IndexedDB, so a picked file handle can't be kept between sessions.
