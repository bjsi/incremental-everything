# Incremental Video: two players and a switch

Started 2026-10-23. Last updated 2026-10-23. Platform facts behind every decision: [`findings/VIDEO_PLAYBACK.md`](../findings/VIDEO_PLAYBACK.md).

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
- [ ] **1. Plugin player rebuilt on the bridge.** Replace ReactPlayer for YouTube in `Video.tsx` and `VideoExtractViewer.tsx`. Open question: one reusable plugin-owned player Rem whose URL is rewritten per item, or one per video? (A reused Rem keeps the KB clean; check that rewriting the URL re-creates the iframe.) The player page lives in `docs/player/` (served by the docs site); changes to it ship when the docs deploy, not with the plugin. Extract end: arm the auto-pause only once the player reports a time inside the segment, because right after a seek the last known time is still the old one.
- [ ] **2. `vi` Rems resolve with their URL.** `action_items.ts` returns `{ type: 'youtube', url: vi.u, nativeAvailable: true }` instead of the URL-less `'video'` type. Add the queue switch (plugin player ⇄ RemNote player), defaulting from a new setting.
- [ ] **3. Review in Editor for the RemNote player.** Open the video page and start the editor review timer as today. A floating bar carries Next / Dismiss / position / extract controls while the IncRem under review is open in RemNote's player. Mirror the position into `ip.l` on entry and read it back at Next.
- [ ] **4. Extracts from the RemNote player.** Start / End from `ip.l` (with nudges), same `videoExtract` powerup as today. An extract opens in the plugin player by default; in the RemNote player it pre-sets `ip.l` = start and shows "extract ends at X / reached ✓".
- [ ] **5. Docs.** `docs/Incremental-Video.md` (the "two ways to watch" section changes completely) and the changelog, once approved.

## Later: local videos (desktop)

RemNote has no interface for local videos, so this is entirely the plugin's. `<video>` works inside the sandbox with full control. Files would come from a loopback helper server (like `yt-local-proxy.js`) serving a folder with HTTP Range support, with the path stored on the Rem. A file picker works as a fallback, but it has to be re-picked each session.
