# Incremental Video: two players and a switch

Started 2026-10-23. Last updated 2026-10-23. Platform facts behind every decision: [`findings/VIDEO_PLAYBACK.md`](../findings/VIDEO_PLAYBACK.md).

## Goal

Every YouTube IncRem can be watched in either of two players, with a switch button in both, as the queue already does between `ExtractViewer` and `IsolatedCardViewer`:

- **Plugin player**: precise control. Resume where the last Incremental session stopped, video extracts with an exact start and end, auto-pause at the end of an extract, playback speed, notes beside the video.
- **RemNote player**: RemNote's video learning page, with transcript, Highlight Moment, AI Tutor and Summary. The plugin can **observe** it (position via `ip.l`, about 3 s resolution) but can't seek or pause it. RemNote's player is origin-locked; verified, see findings.

## Decisions

| Decision | Why |
|---|---|
| The plugin player is a YouTube embed rendered **by RemNote** in an Embed Website (`ew`) Rem, driven through YouTube's postMessage protocol (`lib/youtube_embed_bridge.ts`). ReactPlayer stays only for non-YouTube URLs. | No YouTube player can boot inside the plugin's sandboxed iframe any more. The host's `ew` iframe has `allow-same-origin`. |
| The embed URL never carries `origin=`. | An origin-locked player ignores frames from other origins. |
| The RemNote player is offered only for Rems that already have the Video powerup (`vi`), i.e. made via Upload File. Clipper Rems get the plugin player only. | Adding `vi` from the plugin would bypass RemNote's metered YouTube limit (`YOUTUBE_ANNOTATION`). Not ours to do. |
| One position per video, owned by the plugin, mirrored into `ip.l` before RemNote's player opens and read back from `ip.l` after it closes. | RemNote's player only *offers* "Resume watching at…" from `ip.l`. It never seeks by itself, and it overwrites `ip.l` while it plays. |
| RemNote-player controls (Next, Dismiss, position, Extract start / end / create) live in a **PaneHeader** widget, pending probe 4. Fallbacks, in order: RightSidebar widget, FloatingWidget. | On the video page the editor review timer (`DocumentAboveToolbar`) only shows once **Notes** is pressed. The video page's toolbar (`isReaderViewer`) does host `PaneHeader` widgets. |
| Extract times taken in the RemNote player come from `ip.l`, with −5 s / +5 s nudges. | `ip.l` lags by up to 3 s while playing. |

## Phases

- [ ] **0. Probes.** "Debug Video Detection" (`video_debug.tsx`) and the `video_pane_probe` PaneHeader widget answer:
  - [ ] `vi.u` and `ip.l` read through the plugin (section 1); `ip.l` ticks live while RemNote's player plays
  - [ ] a plugin write to `ip.l` sticks and shows up as "Resume watching at…" (section 2)
  - [ ] the `ew` Rem renders a YouTube player inside a `DocumentViewer` fake embed, and the bridge connects, seeks, pauses and auto-pauses a segment (section 3). **Web and desktop**: desktop may hit YouTube Error 153 (app://js host, no referrer)
  - [ ] the PaneHeader label is visible on the video page, with and without Notes, and ticks while playing (section 4)
- [ ] **1. Plugin player rebuilt on the bridge.** Replace ReactPlayer for YouTube in `Video.tsx` and `VideoExtractViewer.tsx`. Open question: one reusable plugin-owned player Rem whose URL is rewritten per item, or one per video? (A reused Rem keeps the KB clean; check that rewriting the URL re-creates the iframe.) If desktop hits Error 153, fall back to a wrapper page on an https origin we control (not `remnoteplugins.com`; `ew` refuses it).
- [ ] **2. `vi` Rems resolve with their URL.** `action_items.ts` returns `{ type: 'youtube', url: vi.u, nativeAvailable: true }` instead of the URL-less `'video'` type. Add the queue switch (plugin player ⇄ RemNote player), defaulting from a new setting.
- [ ] **3. Review in Editor for the RemNote player.** Open the video page and start the editor review timer as today. The PaneHeader widget carries Next / Dismiss / position / extract controls whenever its pane shows the IncRem under review. Mirror the position into `ip.l` on entry and read it back at Next.
- [ ] **4. Extracts from the RemNote player.** Start / End from `ip.l` (with nudges), same `videoExtract` powerup as today. An extract opens in the plugin player by default; in the RemNote player it pre-sets `ip.l` = start and shows "extract ends at X / reached ✓".
- [ ] **5. Docs.** `docs/Incremental-Video.md` (the "two ways to watch" section changes completely) and the changelog, once approved.

## Later: local videos (desktop)

RemNote has no interface for local videos, so this is entirely the plugin's. `<video>` works inside the sandbox with full control. Files would come from a loopback helper server (like `yt-local-proxy.js`) serving a folder with HTTP Range support, with the path stored on the Rem. A file picker works as a fallback, but it has to be re-picked each session.
