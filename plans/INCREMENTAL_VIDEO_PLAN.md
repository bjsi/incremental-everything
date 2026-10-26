# Incremental Video: two players and a switch

Started 2026-10-23. Last updated 2026-10-26. Platform facts behind every decision: [`findings/VIDEO_PLAYBACK.md`](../findings/VIDEO_PLAYBACK.md).

## Goal

Every YouTube IncRem can be watched in either of two players, with a switch button in both, as the queue already does between `ExtractViewer` and `IsolatedCardViewer`:

- **Plugin player**: precise control. Resume where the last Incremental session stopped, video extracts with an exact start and end, auto-pause at the end of an extract, playback speed, notes beside the video.
- **RemNote player**: RemNote's video learning page, with transcript, Highlight Moment, AI Tutor and Summary. The plugin can **observe** it (position via `ip.l`, about 3 s resolution) but can't seek or pause it. RemNote's player is origin-locked; verified, see findings.

## Decisions

| Decision | Why |
|---|---|
| The plugin player is **our own https player page** (`docs/player/youtube.html`, nocookie IFrame API inside) rendered **by RemNote** in an Embed Website (`ew`) Rem, driven through YouTube's postMessage protocol (`lib/youtube_embed_bridge.ts`). ReactPlayer stays only for non-YouTube URLs. | No YouTube player can boot inside the plugin's sandboxed iframe any more. The host's `ew` iframe has `allow-same-origin`. A youtube.com URL would be swapped for RemNote's own locked player, and a raw nocookie embed gets Error 153 (no referrer) in the desktop app. |
| The embed URL never carries `origin=`. | An origin-locked player ignores frames from other origins. |
| The RemNote player is offered only for Rems that already have the Video powerup (`vi`), i.e. made via Upload File. Clipper Rems get the plugin player only. | Adding `vi` from the plugin would bypass RemNote's metered YouTube limit (`YOUTUBE_ANNOTATION`). Not ours to do. |
| One position per video, owned by the plugin, mirrored into `ip.l` before RemNote's player opens and read back from `ip.l` after it closes. | RemNote's player only *offers* "Resume watching at…" from `ip.l`. It never seeks by itself, and it overwrites `ip.l` while it plays. |
| RemNote-player controls (Next, Dismiss, position, Extract start / end / create) live in a **FloatingWidget** bar, pending probe 4. Fallback: a RightSidebar widget. | On the video page the editor review timer (`DocumentAboveToolbar`) only shows once **Notes** is pressed, and `PaneHeader` widgets don't show there at all (tested). |
| Extract times taken in the RemNote player come from `ip.l`, with −5 s / +5 s nudges. | `ip.l` lags by up to 3 s while playing. |

## Phases

- [ ] **0. Probes.** "Debug Video Detection" (`video_debug.tsx`) and the `video_floating_probe` floating widget answer:
  - [x] `vi.u` and `ip.l` read through the plugin (section 1); `ip.l` ticks live while RemNote's player plays
  - [x] a plugin write to `ip.l` sticks and shows up as "Resume watching at…" (section 2)
  - [x] does opening the video page reset `ip.l` to 0 before the user resumes? **Very likely yes.** It read 342.7 s, and after the page was reopened it read 0 with no plugin write in between. So the plugin keeps its own position and treats `ip.l` only as the live position while RemNote's player is open
  - [x] the `ew` Rem renders a player inside a `DocumentViewer` fake embed, on web and desktop
  - [x] ~~youtube.com URL~~: swapped for RemNote's locked player. ~~raw nocookie URL~~: connects, but Error 153 on desktop
  - [x] with the player page (local copy), the bridge connects, plays, pauses, seeks, sets speed and mutes in the **desktop app** (2026-10-23)
  - [ ] segment auto-pause, after the probe fix (it fired on the pre-seek position); the published page; web
  - [x] ~~PaneHeader on the video page~~: not rendered there, only on editor panes
  - [x] a floating bar stays on screen and clickable over the video page, and shows `ip.l` ticking with the right position (desktop, 2026-10-23)
- [x] **1. Plugin player rebuilt on the bridge.** Tested in the app 2026-10-23, plus a resizable notes divider, resume-time chip, player controls (±30 s, play/pause, speed) and 📸 / 📸✨ screenshots through the helper. ReactPlayer is gone from `Video.tsx` and `VideoExtractViewer.tsx`; both use `components/PluginYouTubePlayer.tsx` (`useYouTubeBridge` + `PluginYouTubePlayerFrame`).
  - **Decided: one reusable player Rem per KB** (`lib/video_player_rem.ts`): a document "▶️ Incremental RemNote video player" with one `ew` child, ids in synced storage `video-player-rem_<kbId>`, re-created if deleted. The URL is rewritten per video; an unchanged URL is left alone.
  - The embed is sized to the viewer (16:9, WIDTH + HEIGHT slots, debounced). The title and padding overheads are guesses to tune in the app.
  - On the first answer from each page load: seek to the start (the page may be left over from an earlier card), apply the saved speed, play.
  - The position (`<url>-position`, same key as before) is saved every 5 s while playing, on pause and on close, and only once playback has started near the start position.
  - Extract end: the auto-pause arms only once the player reports a time inside the segment.
  - Still to check: rewriting the URL reloads the iframe; the sizing overheads; the web app.
  - The player page lives in `docs/player/` (served by the docs site); changes to it ship when the docs deploy, not with the plugin.
- [x] **2. `vi` Rems resolve with their URL.** `action_items.ts` returns `{ type: 'youtube', url: vi.u, nativeAvailable: true }` instead of the URL-less `'video'` type. Add the queue switch (plugin player ⇄ RemNote player), defaulting from a new setting.
  - Tested in the app 2026-10-26. A `vi` Rem whose URL isn't YouTube still resolves as `'video'` (RemNote's player only).
  - Setting **Default Player for RemNote Videos** (`default-video-player`, Queue Display group, default: the plugin's player). The card's switch overrides it for that card only.
  - The switch is a button in each player's own top bar (🎬 RemNote player / ▶️ Plugin player), not a floating overlay: RemNote paints the embeds above anything the plugin floats over them.
  - Position hand-over (`lib/video_position.ts`): the plugin's position is written to `ip.l` before RemNote's page opens, but only if the Rem already has `ip`, because the plugin doesn't add RemNote's built-in powerups. While RemNote's player plays, `ip.l` is copied back (non-zero changes ≥ 2 s), and once more when switching back.
  - In the plugin player, a `vi` Rem's notes pane is an editable `RemHierarchyEditorTree` of its children under a title drawn by the plugin. A DocumentViewer of a `vi` Rem would be RemNote's whole video page, player included.
- [x] **3. Review in Editor for the RemNote player.** Open the video page and start the editor review timer as today. A floating bar carries Next / Dismiss / position / extract controls while the IncRem under review is open in RemNote's player. Mirror the position into `ip.l` on entry and read it back at Next.
  - Tested in the app 2026-10-26.
  - The timer's session and its End / Next / Dismiss / Pause moved to `lib/editor_review_session.ts`, shared by the timer bar and the new floating bar (`widgets/video_review_bar.tsx`).
  - `lib/video_review_bar.ts` (index widget) opens the bar while the timer's Rem is a `vi` Rem open in a pane, and closes it otherwise. It re-checks on timer session changes, URL changes and window-tree changes.
  - Position in: every path that opens an IncRem for a review goes through `openIncRemForReview` (`lib/incRemHelpers.ts`), which first writes the plugin's position into `ip.l`. Position out: the bar mirrors `ip.l` while it plays (`components/useNativeVideoMirror.ts`, shared with `NativeVideoViewer`), and End / Next / Dismiss copy it once more.
  - The bar reports engagement to Practiced Queues itself, since the timer bar isn't mounted on the video page. Known gap: if Notes is pressed and then closed, the timer bar's unmount ends the engagement while the bar is still up.
  - Extract controls come with phase 4.
- [x] **4. Extracts from the RemNote player.** Start / End from `ip.l` (with nudges), same `videoExtract` powerup as today. An extract opens in the plugin player by default; in the RemNote player it pre-sets `ip.l` = start and shows "extract ends at X / reached ✓".
  - Tested in the app 2026-10-26.
  - Creation moved from `Video.tsx` to `lib/video_extract.ts` (`createVideoExtract`: powerup, transcript children, priority popup), shared by both players.
  - `components/NativeExtractButtons.tsx`: ✂️ Extract → Start from `ip.l` (−5 / +5) → ■ Set End from `ip.l` → End (−5 / +5) → ✓ Create. Shown in `NativeVideoViewer`'s top bar (queue) and in the floating review bar (editor).
  - Extracts of `vi` videos resolve with `nativeAvailable`; the queue offers 🎬 RemNote player / ▶️ Plugin player on them. The plugin's player is always the starting one for an extract, whatever the default setting, because only it stops at the end.
  - In RemNote's player an extract shows the parent's video page with `ip.l` pre-set to the start (only if the Rem already has `ip`), a ✂️ start – end chip, and "ends at X · now Y", then "✓ end of extract reached". Its position isn't mirrored back: the whole video's position stays where it was.
  - Not covered: Review in Editor on an extract opens the extract Rem itself, a plain document, not the video page.
- [x] **4b. Transcripts back, through the helper.** Tested in the app 2026-10-26.
  - The old proxy (`yt-local-proxy.js`, port 3456) is dead: YouTube refuses its Innertube ANDROID request. The helper's new `/video-transcript` route uses `yt-dlp -J` to pick the track (the uploader's captions in the video's language, else `<lang>-orig`, never a translation) and caches it in `~/.incremental-remnote/ai-ocr/video-transcripts/` for 30 days.
  - `lib/video_transcript.ts`: an extract gets ~300-character blocks under it, as before; a whole video gets a "📜 Transcript (lang, kind)" Rem with ~600-character blocks that start with their time.
  - 📜 in the plugin player, the extract player, RemNote's player view (whole video or extract) and the floating review bar; the command **Add Video Transcript** (`avt`) on the queue item, the focused Rem, the Rem under review, or an open pane's Rem, walking up from a note to its video or extract.
  - Extract creation skips the transcript quietly when the helper can't fetch it; a failed fetch opens a dialog in place of the priority popup.
  - With the docs: drop `yt-local-proxy.js` and its plist, and rewrite the docs page's "Automatic Transcription" section around the helper.
- [x] **4c. Transcripts from the audio (Whisper) and tidied by Claude.** Tested in the app 2026-10-26. Groundwork for local videos.
  - Helper: `whisper.cpp` (`brew install whisper-cpp`), model `ggml-large-v3-turbo-q5_0.bin` (574 MB) and the Silero VAD model in `~/.incremental-remnote/ai-ocr/whisper/`. `GET /` reports `whisper`. `/video-transcript` takes `source` (`captions` / `audio` / `auto` = captions, else Whisper) and `start` / `end`. The audio is downloaded whole once (`video-audio/`, a week) and cut locally; a whole video's Whisper transcript is cached, a range is cut from it or transcribed alone. `transcribe_audio(path, start, end)` takes any local file, ready for local videos.
  - Measured (M4 Pro): 1 min of audio in 3.5 s with VAD (8 s without); the whole 43-min video in 104 s; audio download 11 s.
  - `/transcript-tidy` (prompt `transcript-prompt.md`): Claude returns the same number of blocks, punctuated, misrecognitions fixed, key terms in **bold**; line breaks are joined by the helper. Only YouTube's automatic captions are tidied (setting **Tidy Automatic Captions with Claude**, default on), 15 blocks per call; raw blocks are written first and replaced as each batch returns. Bold only (`boldMarkupToRichText`): speech has "R$ 500", which the PDF markup parser would read as a formula.
  - Settings: both video settings moved to their own **Incremental Video** group.
  - Plugin: 📜 and `avt` use `auto`; new command **Add Video Transcript from Audio** (`avta`) forces Whisper. Extract creation tidies in the background, behind the priority popup.
- [ ] **5. Docs.** `docs/Incremental-Video.md` (the "two ways to watch" section changes completely) and the changelog, once approved.

## 6. Local videos (desktop)

Started 2026-10-26. RemNote has no interface for local videos, so this is entirely the plugin's: a `<video>` element in the plugin frame (full control, no bridge), fed by the helper over loopback. The first library: `/Volumes/PortableSSD`, four course folders, ~426 MP4 (H.264, some HEVC; HEVC verified to play in RemNote's `<video>` on 2026-10-26), 40 min – 2.5 h each, mostly flat folders.

| Decision | Why |
|---|---|
| **Libraries**: named root folders registered in the helper (`video-libraries.json`), chosen with the macOS folder dialog the helper opens (`osascript choose folder`). A Rem stores **library name + path relative to it**. | Several places (internal disk, external SSD) with no extra concept; a moved or remounted folder is fixed once by re-pointing its library, not per Rem. The plugin frame can't browse the disk or learn a picked file's path. |
| The helper serves **only video files under registered libraries**, with HTTP Range, and never with `Access-Control-Allow-Origin` on media. | `<video>` needs no CORS; without it no website can read the files through the helper, and nothing outside the libraries is reachable. |
| A `localVideo` powerup (slots `library`, `path`) marks the Rem. Its URL for the shared code is `local-video://<library>/<path>`: the position key, the extract powerup's `videoUrl`, transcripts. | One id scheme lets resume, speed, extracts, screenshots and transcripts work as for YouTube. |
| `components/useHtmlVideo` gives a `<video>` the same `{ info, connected, send }` interface as the YouTube bridge. | `PlayerControls`, the resume chip, extract auto-pause and the snapshot / transcript buttons are reused as they are. |
| Screenshots and transcripts read the **file** in the helper: ffmpeg frame grab, Whisper on the audio (no captions exist). | `transcribe_audio(path, …)` and `grab_frame` already take a local input. |

- [x] **6a. Helper** (tested with curl 2026-10-26: scan, Range, `../` refused, frame and Whisper from the file; the dialogs need the in-app test): libraries (`GET /video-libraries`, `POST /video-choose` folder or file dialog → library + relative path, registering a new library when needed, `POST /video-library-relink`), `POST /video-scan` (videos under a folder, natural order, nested by subfolder), `GET /media/<library>/<path>` with Range; `/video-frame` and `/video-transcript` accept `file: {library, path}`.
- [ ] **6b. Player** (code written 2026-10-26, awaiting the in-app test): `localVideo` powerup; action items `local-video` and `local-video-highlight` (an extract whose URL is `local-video://`); `LocalVideoViewer` (notes pane, resume, speed, extracts with auto-pause, 📸, 📜 from audio). Missing library or file: say so, with a relink button.
- [ ] **6c. Getting videos in** (code written 2026-10-26, awaiting the in-app test; bulk: Rems created one at a time in order, then `initIncrementalRem` four at a time with `priority`, `nextRepDate`, no cache write, no creation history, then one cache reload): **Import Local Videos** (folder dialog → popup with the tree, where to put it, priority, and how to introduce them: all now, or one every N days in file order) and **Link Local Video** (file dialog → the focused Rem).
- [ ] **6d. Editor review**: Review in Editor of a local video IncRem opens a plain document with no player. Candidate: a `DocumentBelowTitle` widget that plays the document's local video, but the queue's notes pane (a DocumentViewer of the same Rem) hosts that widget too, so it would need to tell the two apart. To decide after 6b.

