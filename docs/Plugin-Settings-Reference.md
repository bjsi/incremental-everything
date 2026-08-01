# Plugin Settings Reference

This page documents all configurable settings available in the **Incremental Everything (Plus)** plugin. Access them via **RemNote Settings → Plugins → Incremental Everything**.

---

## Scheduling

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| **Initial Interval** | Number | `1` | Number of days until the first repetition of a new Incremental Rem. |
| **Multiplier** | Number | `1.5` | Base of the exponential spacing formula: after your Nth review, the next interval is `⌈Multiplier ^ N⌉` days. The interval depends only on how many reviews you have done, not on the previous interval. With the default `1.5`: 1st review → 2 days, 2nd → 3, 3rd → 4, 5th → 8, 6th → 12. Ignored when the Beta Scheduler is enabled. See [IncRem Scheduler](IncRem-Scheduler.md). |
| **Use Beta Scheduler (Saturating Curve)** | Boolean | `false` | Enable the beta saturating scheduler. Intervals start at the First Review Interval and gradually approach the Max Interval, instead of growing exponentially. See [IncRem Scheduler](IncRem-Scheduler.md) for full details. |
| **First Review Interval (Beta)** | Number | `5` | Interval in days assigned after completing the first review. Different from *Initial Interval* above, which controls when a new IncRem first appears in the queue. Only used when the Beta Scheduler is enabled. |
| **Max Interval (Beta)** | Number | `30` | Upper bound in days the interval gradually approaches. The interval will never exceed this value. Only used when the Beta Scheduler is enabled. |

---

## Priority

| Setting | Type | Default | Range | Description |
|---------|------|---------|-------|-------------|
| **Default Priority** | Number | `10` | 0–100 | Priority assigned to new Incremental Rems. Lower = more important. |
| **Default Card Priority** | Number | `50` | 0–100 | Priority assigned to flashcards without inherited priority. Lower = more important. |
| **Priority Step Size** | Number | `5` | 1–50 | Amount the priority number changes when using the [Quick Increase/Decrease Priority](Plugin-Commands-Reference.md#prioritization-commands) shortcuts (`Ctrl+Opt+Up/Down`). |
| **Priority Editor in Editor** | Dropdown | `Show for IncRem and Cards` | — | Controls when the priority widget appears in the right-hand margin of the editor. Options: *Show for IncRem and Cards*, *Show only for IncRem*, or *Disable*. |

---

## Queue Display

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| **Enable Hide-in-Queue powerups and commands** | Boolean | `false` | Registers five additional [Queue Display](Utilities.md#queue-display-utilities) powerups and their commands — **Hide in Queue**, **Remove from Queue**, **No Hierarchy**, **Hide Parent**, and **Hide Grandparent** — that were originally part of the standalone Hide in Queue plugin. These powerup codes are identical to those in that plugin; enabling this setting while the standalone plugin is still installed causes a fatal `Duplicated powerup` error and prevents Incremental Everything from loading. **Uninstall the standalone Hide in Queue plugin before enabling this.** The two new powerups added by Incremental Everything itself — **Remove Parent** and **Remove Grandparent** — are always registered regardless of this setting. A RemNote reload is required after changing. |
| **Use Isolated Card View in Queue for** | Dropdown | `Highlights (PDF/HTML)` | Chooses which incremental items use the [Isolated Card Viewer](Plugin-Widgets-Reference.md) as their default view in the queue. Options: *Highlights (PDF/HTML)*, *Regular Rems*, *Both*, *None*. Highlights that do **not** use the isolated card view are shown inside the PDF/HTML reader; regular Rems that do **not** use it are shown in the full document context. The toggle button in the queue is **always** available regardless of this setting — it determines only the *initial* view for each item. |
| **Display Priority Shield in Queue** | Boolean | `true` | Shows a real-time count of your highest-priority due items in the queue. Appears below the Answer Buttons for IncRems and in the card priority widget for flashcards. |
| **Display Weighted Priority Shield in Queue** | Boolean | `true` | If enabled, shows what fraction of your total priority-weighted workload has been processed. High-priority items carry exponentially more weight (~10× at the top vs bottom), so processing them gives a bigger boost. Always increases as you review items. |
| **Auto focus Queue Dashboard** | Boolean | `false` | When enabled, opens the **Practiced Queues** dashboard in the Right Sidebar automatically every time you enter a queue, **and restores it after you press Next or Dismiss on an Incremental Rem** (returning you to the live session metrics once the sidebar was used for editing a Rem, or after RemNote auto-focused its own Summary pane for a PDF/HTML). Useful if you always want the live session metrics visible without opening the sidebar manually. Does not apply to mobile, where it would be annoying and counterproductive.


---

## Visual Indicators in Editor

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| **Hide CardPriority Tag in Editor** | Boolean | `true` | Hides the `CardPriority` powerup tag in the editor to reduce visual clutter. Requires reload after changing. |
| **Show a green left Border for IncRems in Editor** | Boolean | `true` | Adds a green left border to IncRems in the editor, making your "extracts" easy to spot. |
| **Show Yellow Left Border for Dismissed Rems** | Boolean | `true` | Rems dismissed from Incremental learning (via the Dismiss button/command) display a yellow left border to indicate they have been already processed (and preserved history). |
| **Show Priority Badges in Table Cells** | Boolean | `true` | Draws a coloured band badge (e.g. `50s`) at the top-right of each table row's first cell — the one place the Priority Editor widget cannot render. Run **Refresh Priority Badges (Tables)** once to fill in existing Rems. Governs **tables only** — [PDF highlight badges](Prioritization-&-Sorting#priorities-on-pdf-highlights\.md) are not affected by it. Requires reload after changing. 📖 See [Priorities in Tables](Prioritization-&-Sorting#priorities-in-tables\.md). |
| **Hide Dismissed Tag in Editor** | Boolean | `true` | Hides the `Dismissed` powerup tag in the editor to reduce clutter. Requires reload after changing. |

---

## Performance Mode

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| **[Performance Mode](Full-Mode-x-Light-Mode.md)** | Dropdown | `Light` | Choose between *Full* (all features, high resource use — best on Desktop App) and *Light* (faster, no relative priority/shield). Full mode starts a background pretagging and caching process that may temporarily slow RemNote. |
| **Always use Light Mode on Mobile** | Boolean | `true` | Auto-switches to Light mode on iOS/Android to prevent crashes and improve performance. |
| **Always use Light Mode on Web Browser** | Boolean | `true` | Auto-switches to Light mode on web browsers where Full mode can be slow or unstable. |

---

## FSRS Integration

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| **Display FSRS DSR Stats (Flashcards)** | Boolean | `true` | Shows calculated FSRS Difficulty (D), Stability (S), and Retrievability (R) for flashcards in the [Card Info Bar](Plugin-Widgets-Reference.md#11-card-info-bar) widget. Requires FSRS v6 scheduler. |
| **FSRS Global Weights** | String | *(empty)* | Comma-separated list of 21 FSRS v6 weights (w0–w20). Paste from your RemNote scheduler settings. If left blank, the official FSRS v6.1.1 defaults are used. See [FSRS Configuration](Reviewing-Items-in-the-Queue.md#fsrs-configuration) for details. |

---

## Environment

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| **RemNote Environment** | Dropdown | `Regular` | Choose which RemNote environment documents open in when using the "Open Editor in New Tab" button. Options: *Regular (www.remnote.com)* or *Beta (beta.remnote.com)*. |

---

## History & Mastery Drill

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| **Flashcard Response Time Limit** | Number | `180` s | Caps the recorded study time per card. If you step away from your device mid-card, only up to this limit is counted toward speed and total time metrics, mirroring RemNote's native behavior. |
| **Skip Mastery Drill** | Boolean | `false` | Master switch to disable all [Mastery Drill](History-Queue-Dashboard-and-Mastery-Drill.md#mastery-drill) features. When enabled: the drill popup and sidebar notification widgets are not registered, the `Mastery Drill` command is not available, and cards rated *Again* or *Hard* are no longer tracked or added to the drill queue. Turn this on if you do not want to use the Mastery Drill workflow at all. Flashcard and Practiced Queue history are not affected. |
| **Old Items Threshold** | Number | `7` days | Number of days after which a card lingering in the [Mastery Drill](History-Queue-Dashboard-and-Mastery-Drill.md#mastery-drill) queue is flagged as stale. A warning appears in the widget and you can clear these items with a single click. |
| **Disable Mastery Drill Notification** | Boolean | `false` | Hides the periodic Left Sidebar notification widget that appears when ≥ 10 cards are pending in the Mastery Drill queue. |
