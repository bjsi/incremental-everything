# RemNote Native Shortcuts

Every default keyboard shortcut of RemNote itself, read out of the desktop app (RemNote 1.28.19, September 15, 2026): 236 commands, 39 of them unbound by default. The plugin's own shortcuts are on [Keyboard Shortcuts](Keyboard-Shortcuts.md).

The same shortcuts are listed **twice**:

- **[By function](#by-function)** — in the sections and order of RemNote's own keyboard-shortcut settings.
- **[By key](#by-key)** — grouped by modifier, with the plugin's shortcuts mixed in. Use it to check whether a combination is free before assigning your own.

!!! note "Defaults only"
    A shortcut you changed in RemNote's settings overrides what is listed here. Not listed either: keys the editor handles directly rather than as a command, such as `Ctrl + →` to jump a word on Windows or `Cmd/Ctrl + →` to move a selected table column.

**Reading the tables**

- `Cmd` on Mac is `Ctrl` on Windows and Linux, and `Opt` is `Alt`. A `Ctrl` in the Mac column is the Control key itself.
- **Old default**: the key RemNote used before it revised its shortcuts. It still applies with *Use old keyboard shortcuts* turned on.
- **single key**: no modifier, so it only works outside text editing — in the queue, the PDF viewer, a drawing. **fixed**: cannot be changed in settings. **may clash**: RemNote lets it share its key with another command. **desktop global**: handled by the desktop app itself.
- **⚠️ Same keys as…**: a plugin shortcut presses the same keys, on the platform named.

---
## By function { #by-function }

### Global

| Command | Mac | Windows / Linux | Notes |
| :--- | :--- | :--- | :--- |
| Zoom In (Entire App) | `Cmd + +` | `Ctrl + +` |  |
| Zoom Out (Entire App) | `Cmd + -` | `Ctrl + -` |  |
| Go to Flashcard Home | `Cmd + Opt + U` | `Ctrl + Alt + U` |  |
| Practice Flashcards in Global Queue | `Cmd + Shift + L` | `Ctrl + Shift + L` |  |
| Open Edit Later Queue | — | — |  |
| Search All Notes | `Cmd + P` | `Ctrl + P` | Old default: `Cmd + O` / `Ctrl + O` |
| Open Command Omnibar | `Cmd + /` | `Ctrl + /` |  |
| Go to All Notes | `Cmd + Opt + O` | `Ctrl + Alt + O` |  |
| Quick Add | `` Cmd + Fn + ` `` | `` Ctrl + ` `` | Old default: `Cmd + E` / `Ctrl + E` |
| Show Keyboard Shortcuts | `Cmd + Opt + Shift + H` | `Ctrl + Alt + Shift + H` | Old default: `Cmd + ?` / `Ctrl + ?` |
| Toggle Sidebar | `Opt + S` | `Alt + S` |  |
| Toggle Right Sidebar | `Opt + Shift + S` | `Alt + Shift + S` |  |
| Add Document | `Opt + N` | `Alt + N` |  |
| Open Create Menu | `Opt + Shift + N` | `Alt + Shift + N` |  |
| Add Today's Document | `Opt + D` | `Alt + D` |  |
| Add Today's Document In New Pane | `Opt + Shift + D` | `Alt + Shift + D` |  |
| Go Forward | `Cmd + ]` | `Alt + →` |  |
| Go Backward | `Cmd + [` | `Alt + ←` |  |
| Open Knowledge Base Switcher | `Cmd + Opt + Shift + O` | `Ctrl + Alt + Shift + O` |  |
| Operating System: Quick Add | `` Cmd + Opt + Shift + ` `` | `` Ctrl + Alt + Shift + ` `` | desktop global |
| Operating System: Focus on RemNote | `Cmd + Opt + Shift + R` | `Ctrl + Alt + Shift + R` | desktop global |
| Toggle Disable Custom CSS | `Cmd + Opt + Shift + C` | `Ctrl + Alt + Shift + C` |  |
| Open/Close AI Tutor | `` Opt + ` `` | `` Alt + ` `` |  |
| Open AI Tutor Full Screen | `Cmd + Opt + Shift + Y` | `Ctrl + Alt + Shift + Y` |  |
| Restart AI Chat (when in chat window) | `Opt + Shift + X` | `Alt + Shift + X` | ⚠️ Same keys as *Extract with Priority* (Mac & Windows) |

### Flashcard Queue

| Command | Mac | Windows / Linux | Notes |
| :--- | :--- | :--- | :--- |
| “Easy” / “Easily Recalled” Response #1 | `;` | `;` | single key |
| “Forgot All List Items” Response | `Shift + H` | `Shift + H` | single key |
| “Easy” / “Easily Recalled” Response #2 | `4` | `4` | single key |
| “Good” / “Recalled with Effort” Response #1 | `L` | `L` | single key |
| “Good” / “Recalled with Effort” Response #2 | `3` | `3` | single key |
| “Partially Recalled” Response #1 | `K` | `K` | Old default: `,`; single key |
| “Hard” / “Partially Recalled” Response #2 | `2` | `2` | single key |
| “Again” / “Forgot” Response #1 | `J` | `J` | Old default: `M`; single key |
| “Again” / “Forgot” Response #2 | `1` | `1` | single key |
| "Skip" Response #1 | `H` | `H` | single key |
| "Skip" Response #2 | `` ` `` | `` ` `` | single key |
| Reveal Multiple Choice Answer | `R` | `R` | single key |
| Check Multiple Choice Answer | `Enter` | `Enter` | single key, may clash |
| Highlight Key Information | `Space` | `Space` | single key |
| Disable All Flashcards of this Bullet | `F` | `F` | single key |
| Go to Flashcard's Bullet | `G` | `G` | single key |
| Enable/Disable Flashcard | `B` | `B` | single key |
| View Flashcard's Documents In | `N` | `N` | single key |
| Edit Flashcard Later | `A` | `A` | single key |
| Edit Flashcard Later with Message | `M` | `M` | single key |
| Add Tag to Flashcard | `T` | `T` | single key |
| Edit Flashcard Now | `E` | `E` | single key |
| View Practice History | `/` | `/` | single key |
| Skip Current Flashcard | `→` | `→` | single key |
| Preview Flashcard's Document | `P` | `P` | single key |
| Go Back to Previous Flashcard | `←` | `←` | single key |
| "Don't Import" Response | `U` | `U` | single key |
| Practice All Flashcards in Document | `Cmd + Shift + A` | `Ctrl + Shift + A` |  |
| Practice in Order | `Cmd + Shift + O` | `Ctrl + Shift + O` |  |
| Practice with Spaced Repetition | `Cmd + Shift + P` | `Ctrl + Shift + P` |  |
| Toggle Hide Other Boxes on Image Occlusions | `X` | `X` | single key |
| Play Front of Flashcard Using Text to Speech | `Shift + F` | `Shift + F` | single key |
| Play Back of Flashcard Using Text to Speech | `Shift + B` | `Shift + B` | single key |
| Stop Text to Speech Playback | `Shift + S` | `Shift + S` | single key |

### Copying References

| Command | Mac | Windows / Linux | Notes |
| :--- | :--- | :--- | :--- |
| Copy Bullet as Tag | `Cmd + Shift + S` | `Ctrl + Shift + S` |  |
| Copy Bullet as Portal | `Cmd + Shift + E` | `Ctrl + Shift + E` | Old default: `Cmd + Shift + P` / `Ctrl + Shift + P` |
| Copy Bullet as Reference | `Cmd + Shift + R` | `Ctrl + Shift + R` |  |
| Copy Deeplink to Bullet on Desktop App | — | — |  |

### Changing Bullet Types

| Command | Mac | Windows / Linux | Notes |
| :--- | :--- | :--- | :--- |
| Turn Into a Concept | `Cmd + Opt + C` | `Ctrl + Alt + C` |  |
| Turn Into a Descriptor | `Cmd + Opt + D` | `Ctrl + Alt + D` |  |
| Unset as Concept/Descriptor | `Cmd + Opt + Q` | `Ctrl + Alt + Q` |  |
| Turn Into a Property | `Cmd + Opt + S` | `Ctrl + Alt + S` |  |
| Turn Into a Document | `Cmd + Opt + Shift + D` | `Ctrl + Alt + Shift + D` |  |
| Turn Into a Folder | `Cmd + Opt + Shift + F` | `Ctrl + Alt + Shift + F` |  |

### Editor Navigation

| Command | Mac | Windows / Linux | Notes |
| :--- | :--- | :--- | :--- |
| Zoom Into Bullet | `Cmd + '` | `Ctrl + '` | Old default: `Cmd + K` / `Ctrl + K` |
| Zoom Into Bullet & Open in Other Pane | `Cmd + Shift + '` | `Ctrl + Shift + '` | Old default: `Cmd + Shift + +` / `Ctrl + Shift + +` |
| Zoom Out of Bullet | `Cmd + ;` | `Ctrl + ;` |  |
| Zoom Out of Bullet & Open in Other Pane | `Cmd + Shift + ;` | `Ctrl + Shift + ;` |  |
| Search Descendants in Editor | `Cmd + Shift + C` | `Ctrl + Shift + C` |  |
| Go to Parent | `Cmd + \\` | `Ctrl + \\` |  |
| Find Text in Document | `Cmd + F` | `Ctrl + F` |  |
| Filter Document | `Cmd + Shift + F` | `Ctrl + Shift + F` |  |

### Editor Scope Showing / Hiding

| Command | Mac | Windows / Linux | Notes |
| :--- | :--- | :--- | :--- |
| Expand | `Cmd + ↓` | `Ctrl + ↓` |  |
| Include All Descendants | `Cmd + Shift + ↓` | `Ctrl + Shift + ↓` |  |
| Collapse | `Cmd + ↑` | `Ctrl + ↑` |  |
| Collapse All Descendants | `Cmd + Shift + ↑` | `Ctrl + Shift + ↑` |  |
| Collapse Children to 1st Level | `Cmd + Opt + Shift + ↑` | `Ctrl + Alt + Shift + ↑` |  |
| Hide Bullet From Document | `Cmd + Opt + H` | `Ctrl + Alt + H` | Old default: `Cmd + H` / `Ctrl + H` |
| Hide Parents & Siblings From Document | `Cmd + Shift + H` | `Ctrl + Shift + H` | ⚠️ Same keys as *Open Repetition History* (Windows) |
| Add a Portal | `Cmd + S` | `Ctrl + S` | Old default: `Cmd + I` / `Ctrl + I` |

### Bullet-Level Editing

| Command | Mac | Windows / Linux | Notes |
| :--- | :--- | :--- | :--- |
| Indent | `Tab` | `Tab` | fixed |
| Outdent | `Shift + Tab` | `Shift + Tab` | fixed |
| Add Child | `Enter` | `Enter` | fixed |
| Add Child Without Splitting Text | `Opt + Enter` | `Alt + Enter` | fixed |
| Add Line Break | `Shift + Enter` | `Shift + Enter` | fixed |
| Undo | `Cmd + Z` | `Ctrl + Z` |  |
| Cut | `Cmd + X` | `Ctrl + X` |  |
| Copy | `Cmd + C` | `Ctrl + C` |  |
| Paste | `Cmd + V` | `Ctrl + V` |  |
| Paste Without Formatting | `Cmd + Shift + V` | `Ctrl + Shift + V` |  |
| Paste as Single Bullet | `Cmd + Opt + Shift + V` | `Ctrl + Alt + Shift + V` |  |
| Add Portal | `Cmd + Shift + Enter` | `Ctrl + Shift + Enter` |  |
| Toggle Practice | `Cmd + Opt + F` | `Ctrl + Alt + F` |  |
| Toggle Practice Backward | `Cmd + Shift + B` | `Ctrl + Shift + B` | Old default: `Cmd + Opt + B` / `Ctrl + Alt + B` |
| Toggle Practice Forward | `Cmd + Shift + G` | `Ctrl + Shift + G` | Old default: `Cmd + Opt + G` / `Ctrl + Alt + G` |
| Edit SRS Data | — | — |  |
| Enable/Disable 'Hide All, Test One [Clozes]' | `Opt + T` | `Alt + T` |  |
| Merge All Clozes | `Cmd + Opt + Shift + M` | `Ctrl + Alt + Shift + M` |  |
| Tag With Parent | `Cmd + Opt + X` | `Ctrl + Alt + X` |  |
| Set New Parent (Move) | `Cmd + Opt + M` | `Ctrl + Alt + M` | Old default: `Cmd + M` / `Ctrl + M` |
| Set New Parent (Move) and Unmark as Edit Later | `Cmd + Opt + Shift + M` | `Ctrl + Alt + Shift + M` | Old default: `Cmd + Shift + M` / `Ctrl + Shift + M` |
| Merge Bullet and Set Alias | `Cmd + Opt + Shift + E` | `Ctrl + Alt + Shift + E` |  |
| Merge Bullet With Duplicate Name | `Cmd + Opt + E` | `Ctrl + Alt + E` |  |
| Display References | `Cmd + Opt + Shift + R` | `Ctrl + Alt + Shift + R` | Old default: `Cmd + R` / `Ctrl + R` |
| Add All Properties | `Cmd + Opt + P` | `Ctrl + Alt + P` | ⚠️ Same keys as *Quick Set Priority* (Windows) |
| Add Alias | `Opt + A` | `Alt + A` |  |
| Add Source or PDF | — | — |  |
| Toggle Todo Status | `Cmd + Enter` | `Ctrl + Enter` |  |
| Toggle Private | `Cmd + Opt + Shift + P` | `Ctrl + Alt + Shift + P` | Old default: `Cmd + P` / `Ctrl + P` |
| Toggle Edit Later Tag | `Cmd + Opt + A` | `Ctrl + Alt + A` |  |
| Pin Document | `Cmd + Shift + 8` | `Ctrl + Shift + 8` |  |
| View Bullet Metadata | — | — |  |
| Delete Bullet | `Cmd + Opt + Shift + Backspace` | `Ctrl + Alt + Shift + Backspace` |  |
| Turn Into a List Item | `Cmd + Opt + L` | `Ctrl + Alt + L` |  |
| Turn Into a Card Item | `Cmd + Opt + R` | `Ctrl + Alt + R` |  |
| Toggle Callout | `Cmd + Opt + V` | `Ctrl + Alt + V` |  |
| Insert Block Code | `Cmd + Shift + 0` | `Ctrl + Shift + 0` |  |

### Text-Level Editing

| Command | Mac | Windows / Linux | Notes |
| :--- | :--- | :--- | :--- |
| Embed Audio | `Cmd + E` | `Ctrl + E` | Old default: `Cmd + L` / `Ctrl + L` |
| Embed Video | — | — |  |
| Embed Image | `Cmd + G` | `Ctrl + G` |  |
| Insert Cloze | — | — | fixed |
| Insert Reference | — | — | fixed |
| Insert Portal | — | — | fixed |
| Insert Tag | — | — | fixed |
| Insert LaTeX | — | — | fixed |
| Insert Date | — | — | fixed |
| Insert Emoji | — | — | fixed |
| Insert Inline Code #2 | `Cmd + Opt + Shift + I` | `Ctrl + Alt + Shift + I` |  |
| Insert Inline Code #1 | — | — | fixed |
| Swap Up | `Opt + ↑` | `Alt + ↑` | fixed |
| Swap Down | `Opt + ↓` | `Alt + ↓` | fixed |
| Cloze Selected Text | `{` | `{` | single key |
| Bold Text | `Cmd + B` | `Ctrl + B` | fixed |
| Italicize Text | `Cmd + I` | `Ctrl + I` | fixed |
| Underline Text | `Cmd + U` | `Ctrl + U` | fixed |
| Link Selected Text | `Cmd + Opt + K` | `Ctrl + Alt + K` |  |
| Reference Selected Text | `[` | `[` | single key, fixed |
| Tag Selected Text | `#` | `#` | single key, fixed |
| Toggle Latex Block Mode | `Opt + B` | `Alt + B` |  |
| Superscript Text | `Cmd + Shift + .` | `Ctrl + Shift + .` |  |
| Subscript Text | `Cmd + Shift + ,` | `Ctrl + Shift + ,` |  |
| Strikethrough Text | `Cmd + Shift + K` | `Ctrl + Shift + K` |  |
| Explain Selected Text | `Cmd + Opt + .` | `Ctrl + Alt + .` |  |

### Headings (Bullet-Level)

| Command | Mac | Windows / Linux | Notes |
| :--- | :--- | :--- | :--- |
| Heading 1 | `Cmd + Opt + 1` | `Ctrl + Alt + 1` | Old default: `Cmd + Shift + !` / `Ctrl + Shift + !` |
| Heading 2 | `Cmd + Opt + 2` | `Ctrl + Alt + 2` | Old default: `Cmd + Shift + @` / `Ctrl + Shift + @` |
| Heading 3 | `Cmd + Opt + 3` | `Ctrl + Alt + 3` | Old default: `Cmd + Shift + #` / `Ctrl + Shift + #` |
| Heading 4 | `Cmd + Opt + [` | `Ctrl + Alt + [` |  |
| Heading 5 | `Cmd + Opt + ]` | `Ctrl + Alt + ]` |  |
| Heading 6 | `Cmd + Opt + \\` | `Ctrl + Alt + \\` |  |
| Clear Heading | `` Cmd + Opt + ` `` | `` Ctrl + Alt + ` `` | Old default: `Cmd + Shift + ~` / `Ctrl + Shift + ~` |

### Highlight (Bullet-Level & Text-Level)

| Command | Mac | Windows / Linux | Notes |
| :--- | :--- | :--- | :--- |
| Highlight Red | `Cmd + Opt + 4` | `Ctrl + Alt + 4` | Old default: `Cmd + Opt + 1` / `Ctrl + Alt + 1` |
| Highlight Orange | `Cmd + Opt + 5` | `Ctrl + Alt + 5` | Old default: `Cmd + Opt + 2` / `Ctrl + Alt + 2` |
| Highlight Yellow | `Cmd + Opt + 6` | `Ctrl + Alt + 6` | Old default: `Cmd + Opt + 3` / `Ctrl + Alt + 3` |
| Highlight Green | `Cmd + Opt + 7` | `Ctrl + Alt + 7` | Old default: `Cmd + Opt + 4` / `Ctrl + Alt + 4` |
| Highlight Blue | `Cmd + Opt + 8` | `Ctrl + Alt + 8` | Old default: `Cmd + Opt + 5` / `Ctrl + Alt + 5` |
| Highlight Purple | `Cmd + Opt + 9` | `Ctrl + Alt + 9` | Old default: `Cmd + Opt + 6` / `Ctrl + Alt + 6` |
| Highlight Gray | `Cmd + Opt + ;` | `Ctrl + Alt + ;` |  |
| Clear Highlight | `Cmd + Opt + 0` | `Ctrl + Alt + 0` |  |

### Text Color (Bullet-Level & Text-Level)

| Command | Mac | Windows / Linux | Notes |
| :--- | :--- | :--- | :--- |
| Text Color Red | `Cmd + Opt + Shift + 4` | `Ctrl + Alt + Shift + 4` | Old default: `Cmd + Opt + 1` / `Ctrl + Alt + 1` |
| Text Color Orange | `Cmd + Opt + Shift + 5` | `Ctrl + Alt + Shift + 5` | Old default: `Cmd + Opt + 2` / `Ctrl + Alt + 2` |
| Text Color Yellow | `Cmd + Opt + Shift + 6` | `Ctrl + Alt + Shift + 6` | Old default: `Cmd + Opt + 3` / `Ctrl + Alt + 3` |
| Text Color Green | `Cmd + Opt + Shift + 7` | `Ctrl + Alt + Shift + 7` | Old default: `Cmd + Opt + 4` / `Ctrl + Alt + 4` |
| Text Color Blue | `Cmd + Opt + Shift + 8` | `Ctrl + Alt + Shift + 8` | Old default: `Cmd + Opt + 5` / `Ctrl + Alt + 5` |
| Text Color Purple | `Cmd + Opt + Shift + 9` | `Ctrl + Alt + Shift + 9` | Old default: `Cmd + Opt + 6` / `Ctrl + Alt + 6` |
| Text Color Gray | `Cmd + Opt + Shift + 3` | `Ctrl + Alt + Shift + 3` |  |
| Clear Text Color | `Cmd + Opt + Shift + 0` | `Ctrl + Alt + Shift + 0` |  |

### Drawing

| Command | Mac | Windows / Linux | Notes |
| :--- | :--- | :--- | :--- |
| Select Tool | `S` | `S` | single key, may clash |
| PDF Text Select Tool | `Z` | `Z` | single key, may clash |
| PDF Area Select Tool | `V` | `V` | single key, may clash |
| Pen Tool | `P` | `P` | single key, may clash |
| Highlight Tool | `H` | `H` | single key, may clash |
| Arrow Tool | `A` | `A` | single key, may clash |
| Shape Tool | `X` | `X` | single key, may clash |
| Text Tool | `T` | `T` | single key, may clash |
| Eraser Tool | `E` | `E` | single key, may clash |
| Crop Tool | `C` | `C` | single key, may clash |
| Occlusion Box Tool | `O` | `O` | single key, may clash |
| Occlusion Tape Tool | `U` | `U` | single key, may clash |
| Bring Forward | `]` | `]` | single key, may clash |
| Send Backward | `[` | `[` | single key, may clash |
| Bring to Front | `Shift + ]` | `Shift + ]` | may clash |
| Send to Back | `Shift + [` | `Shift + [` | may clash |

### Hierarchical Search

| Command | Mac | Windows / Linux | Notes |
| :--- | :--- | :--- | :--- |
| Only Search Concepts + Documents | `Opt + C` | `Alt + C` |  |
| Pin Search Context | `Opt + P` | `Alt + P` | ⚠️ Same keys as *Set Priority* (Mac & Windows) |

### Tabs

| Command | Mac | Windows / Linux | Notes |
| :--- | :--- | :--- | :--- |
| Add New Tab (Browser Alternative) | `Cmd + Opt + T` | `Ctrl + Alt + T` |  |
| Close Tab (Browser Alternative) | `Cmd + Opt + W` | `Ctrl + Alt + W` |  |
| Add New Tab (Desktop App Only) | `Cmd + T` | `Ctrl + T` | fixed, desktop global |
| Close Tab (Desktop App Only) | `Cmd + W` | `Ctrl + W` | fixed, desktop global |
| Restore Last Closed Tab | `Opt + Shift + R` | `Alt + Shift + R` |  |
| Open Selected Bullet in New Tab | `Cmd + Opt + '` | `Ctrl + Alt + '` |  |
| Rename Tab | `Cmd + F3` | `Ctrl + F3` |  |
| Switch to Next Tab | `Cmd + Opt + →` | `Ctrl + Alt + →` |  |
| Switch to Previous Tab | `Cmd + Opt + ←` | `Ctrl + Alt + ←` |  |
| Switch to Tab 1 | — | — |  |
| Switch to Tab 2 | — | — |  |
| Switch to Tab 3 | — | — |  |
| Switch to Tab 4 | — | — |  |
| Switch to Tab 5 | — | — |  |
| Switch to Tab 6 | — | — |  |
| Switch to Tab 7 | — | — |  |
| Switch to Tab 8 | — | — |  |
| Switch to Tab 9 | — | — |  |
| Switch to Tab 10 | — | — |  |
| Cycle Tab Forward | `Cmd + Tab` | `Ctrl + Tab` | fixed, desktop global |
| Cycle Tab Backward | `Cmd + Shift + Tab` | `Ctrl + Shift + Tab` | fixed, desktop global |

### Split Pane

| Command | Mac | Windows / Linux | Notes |
| :--- | :--- | :--- | :--- |
| Split Pane Vertically | — | — |  |
| Split Pane Horizontally | — | — |  |
| Close Pane | — | — |  |
| Resize Pane Up | — | — |  |
| Resize Pane Down | — | — |  |
| Resize Pane Right | — | — |  |
| Resize Pane Left | — | — |  |
| Shift Pane Focus Down | — | — |  |
| Shift Pane Focus Left | — | — |  |
| Shift Pane Focus Right | — | — |  |
| Shift Pane Focus Up | — | — |  |
| Swap Pane Down | — | — |  |
| Swap Pane Left | — | — |  |
| Swap Pane Right | — | — |  |
| Swap Pane Up | — | — |  |

### PDF Reader

| Command | Mac | Windows / Linux | Notes |
| :--- | :--- | :--- | :--- |
| Toggle Editor on Learning Source | `Cmd + Opt + Shift + T` | `Ctrl + Alt + Shift + T` |  |

### Learning Page

| Command | Mac | Windows / Linux | Notes |
| :--- | :--- | :--- | :--- |
| Increase Video Playback Speed on Learning Page | `Cmd + Opt + ↑` | `Ctrl + Alt + ↑` | ⚠️ Same keys as *Quick Increase Priority Number (Less Important)* (Windows) |
| Decrease Video Playback Speed on Learning Page | `Cmd + Opt + ↓` | `Ctrl + Alt + ↓` | ⚠️ Same keys as *Quick Decrease Priority Number (More Important)* (Windows) |

### Not listed in the settings screen

Commands in RemNote's defaults table that its settings screen does not show — PDF highlight actions, drawing arrangement, debug tools. They still respond to their keys.

| Command | Mac | Windows / Linux | Notes |
| :--- | :--- | :--- | :--- |
| Redo | `Cmd + Y` | `Ctrl + Y` |  |
| Copy Debug Info | `Cmd + Opt + Shift + L` | `Ctrl + Alt + Shift + L` |  |
| Open Test Recorder | `Cmd + Opt + Shift + T` | `Ctrl + Alt + Shift + T` |  |
| Open Command Omnibar | `Cmd + K` | `Ctrl + K` |  |
| Include All Hidden Children | `Cmd + Opt + Shift + A` | `Ctrl + Alt + Shift + A` |  |
| Create Highlight Reference | `Cmd + C` | `Ctrl + C` | Also: `Enter`; single key, may clash |
| Create Highlight Note | `N` | `N` | single key, may clash |
| Copy as Image/Plain Text | `Cmd + Shift + C` | `Ctrl + Shift + C` | may clash |

---
## By key { #by-key }

Grouped by the modifiers you hold. Rows marked **Incremental RemNote** are the plugin's; everything else is RemNote. A combination that appears in no table is free in both.

### Single keys

Active only outside text editing: in the queue, the PDF viewer and drawings.

| Keys | Command | Where | Notes |
| :--- | :--- | :--- | :--- |
| `A` | Arrow Tool | Drawing | may clash |
| `A` | Edit Flashcard Later | Flashcard Queue |  |
| `B` | Enable/Disable Flashcard | Flashcard Queue |  |
| `C` | Crop Tool | Drawing | may clash |
| `E` | Edit Flashcard Now | Flashcard Queue |  |
| `E` | Eraser Tool | Drawing | may clash |
| `F` | Disable All Flashcards of this Bullet | Flashcard Queue |  |
| `G` | Go to Flashcard's Bullet | Flashcard Queue |  |
| `H` | "Skip" Response #1 | Flashcard Queue |  |
| `H` | Highlight Tool | Drawing | may clash |
| `J` | “Again” / “Forgot” Response #1 | Flashcard Queue |  |
| `K` | “Partially Recalled” Response #1 | Flashcard Queue |  |
| `L` | “Good” / “Recalled with Effort” Response #1 | Flashcard Queue |  |
| `M` | Edit Flashcard Later with Message | Flashcard Queue |  |
| `N` | Create Highlight Note | — | may clash |
| `N` | View Flashcard's Documents In | Flashcard Queue |  |
| `O` | Occlusion Box Tool | Drawing | may clash |
| `P` | Pen Tool | Drawing | may clash |
| `P` | Preview Flashcard's Document | Flashcard Queue |  |
| `R` | Reveal Multiple Choice Answer | Flashcard Queue |  |
| `S` | Select Tool | Drawing | may clash |
| `T` | Add Tag to Flashcard | Flashcard Queue |  |
| `T` | Text Tool | Drawing | may clash |
| `U` | "Don't Import" Response | Flashcard Queue |  |
| `U` | Occlusion Tape Tool | Drawing | may clash |
| `V` | PDF Area Select Tool | Drawing | may clash |
| `X` | Shape Tool | Drawing | may clash |
| `X` | Toggle Hide Other Boxes on Image Occlusions | Flashcard Queue |  |
| `Z` | PDF Text Select Tool | Drawing | may clash |
| `1` | “Again” / “Forgot” Response #2 | Flashcard Queue |  |
| `2` | “Hard” / “Partially Recalled” Response #2 | Flashcard Queue |  |
| `3` | “Good” / “Recalled with Effort” Response #2 | Flashcard Queue |  |
| `4` | “Easy” / “Easily Recalled” Response #2 | Flashcard Queue |  |
| `Space` | Highlight Key Information | Flashcard Queue |  |
| `#` | Tag Selected Text | Text-Level Editing | fixed |
| `/` | View Practice History | Flashcard Queue |  |
| `;` | “Easy” / “Easily Recalled” Response #1 | Flashcard Queue |  |
| `[` | Reference Selected Text | Text-Level Editing | fixed |
| `[` | Send Backward | Drawing | may clash |
| `]` | Bring Forward | Drawing | may clash |
| `` ` `` | "Skip" Response #2 | Flashcard Queue |  |
| `{` | Cloze Selected Text | Text-Level Editing |  |
| `←` | Go Back to Previous Flashcard | Flashcard Queue |  |
| `→` | Skip Current Flashcard | Flashcard Queue |  |
| `Enter` | Add Child | Bullet-Level Editing | fixed |
| `Enter` | Check Multiple Choice Answer | Flashcard Queue | may clash |
| `Enter` | Create Highlight Reference | — | may clash |
| `Tab` | Indent | Bullet-Level Editing | fixed |

### Cmd/Ctrl + key

| Keys | Command | Where | Notes |
| :--- | :--- | :--- | :--- |
| `Cmd + B` / `Ctrl + B` | Bold Text | Text-Level Editing | fixed |
| `Cmd + C` / `Ctrl + C` | Copy | Bullet-Level Editing |  |
| `Cmd + C` / `Ctrl + C` | Create Highlight Reference | — | may clash |
| `Cmd + E` / `Ctrl + E` | Embed Audio | Text-Level Editing |  |
| `Cmd + F` / `Ctrl + F` | Find Text in Document | Editor Navigation |  |
| `Cmd + G` / `Ctrl + G` | Embed Image | Text-Level Editing |  |
| `Cmd + I` / `Ctrl + I` | Italicize Text | Text-Level Editing | fixed |
| `Cmd + K` / `Ctrl + K` | Open Command Omnibar | — |  |
| `Cmd + L` / `Ctrl + L` | [Learn - Practice Priority Queue (Full Knowledge Base)](Keyboard-Shortcuts.md) | **Incremental RemNote** |  |
| `Cmd + P` / `Ctrl + P` | Search All Notes | Global |  |
| `Cmd + S` / `Ctrl + S` | Add a Portal | Editor Scope Showing / Hiding |  |
| `Cmd + T` / `Ctrl + T` | Add New Tab (Desktop App Only) | Tabs | fixed; desktop global |
| `Cmd + U` / `Ctrl + U` | Underline Text | Text-Level Editing | fixed |
| `Cmd + V` / `Ctrl + V` | Paste | Bullet-Level Editing |  |
| `Cmd + W` / `Ctrl + W` | Close Tab (Desktop App Only) | Tabs | fixed; desktop global |
| `Cmd + X` / `Ctrl + X` | Cut | Bullet-Level Editing |  |
| `Cmd + Y` / `Ctrl + Y` | Redo | — |  |
| `Cmd + Z` / `Ctrl + Z` | Undo | Bullet-Level Editing |  |
| `Cmd + '` / `Ctrl + '` | Zoom Into Bullet | Editor Navigation |  |
| `Cmd + +` / `Ctrl + +` | Zoom In (Entire App) | Global |  |
| `Cmd + -` / `Ctrl + -` | Zoom Out (Entire App) | Global |  |
| `Cmd + /` / `Ctrl + /` | Open Command Omnibar | Global |  |
| `Cmd + ;` / `Ctrl + ;` | Zoom Out of Bullet | Editor Navigation |  |
| `Cmd + [` | Go Backward | Global | Mac only |
| `Cmd + ]` | Go Forward | Global | Mac only |
| `` Ctrl + ` `` | Quick Add | Global | Windows / Linux only |
| `Cmd + →` / `Ctrl + →` | [Next Item in Queue](Keyboard-Shortcuts.md) | **Incremental RemNote** |  |
| `Cmd + ↑` / `Ctrl + ↑` | Collapse | Editor Scope Showing / Hiding |  |
| `Cmd + ↓` / `Ctrl + ↓` | Expand | Editor Scope Showing / Hiding |  |
| `Cmd + \\` / `Ctrl + \\` | Go to Parent | Editor Navigation |  |
| `Cmd + Enter` / `Ctrl + Enter` | Toggle Todo Status | Bullet-Level Editing |  |
| `Cmd + Tab` / `Ctrl + Tab` | Cycle Tab Forward | Tabs | fixed; desktop global |
| `Cmd + F3` / `Ctrl + F3` | Rename Tab | Tabs |  |

### Ctrl + key

| Keys | Command | Where | Notes |
| :--- | :--- | :--- | :--- |
| `Ctrl + D` | [Dismiss Incremental Rem](Keyboard-Shortcuts.md) | **Incremental RemNote** |  |
| `Ctrl + J` | [Reschedule Incremental Rem](Keyboard-Shortcuts.md) | **Incremental RemNote** |  |
| `Ctrl + F7` | [Set Read Point (Bookmark)](Keyboard-Shortcuts.md) | **Incremental RemNote** |  |

### Opt/Alt + key

| Keys | Command | Where | Notes |
| :--- | :--- | :--- | :--- |
| `Opt + A` / `Alt + A` | Add Alias | Bullet-Level Editing |  |
| `Opt + B` / `Alt + B` | Toggle Latex Block Mode | Text-Level Editing |  |
| `Opt + C` / `Alt + C` | Only Search Concepts + Documents | Hierarchical Search |  |
| `Opt + D` / `Alt + D` | Add Today's Document | Global |  |
| `Opt + N` / `Alt + N` | Add Document | Global |  |
| `Opt + O` / `Alt + O` | [Open Hovered Source in Popup](Keyboard-Shortcuts.md) | **Incremental RemNote** |  |
| `Opt + P` / `Alt + P` | Pin Search Context | Hierarchical Search | ⚠️ Same keys as *Set Priority* (Mac & Windows) |
| `Opt + P` / `Alt + P` | [Set Priority](Keyboard-Shortcuts.md) | **Incremental RemNote** | ⚠️ Same keys as *Pin Search Context* (Mac & Windows) |
| `Opt + S` / `Alt + S` | Toggle Sidebar | Global |  |
| `Opt + T` / `Alt + T` | Enable/Disable 'Hide All, Test One [Clozes]' | Bullet-Level Editing |  |
| `Opt + X` / `Alt + X` | [Make Incremental (Extract)](Keyboard-Shortcuts.md) | **Incremental RemNote** |  |
| `Opt + Z` / `Alt + Z` | [Create Cloze Deletion](Keyboard-Shortcuts.md) | **Incremental RemNote** |  |
| `` Opt + ` `` / `` Alt + ` `` | Open/Close AI Tutor | Global |  |
| `Alt + ←` | Go Backward | Global | Windows / Linux only |
| `Alt + →` | Go Forward | Global | Windows / Linux only |
| `Opt + ↑` / `Alt + ↑` | Swap Up | Text-Level Editing | fixed |
| `Opt + ↓` / `Alt + ↓` | Swap Down | Text-Level Editing | fixed |
| `Opt + Enter` / `Alt + Enter` | Add Child Without Splitting Text | Bullet-Level Editing | fixed |

### Shift + key

| Keys | Command | Where | Notes |
| :--- | :--- | :--- | :--- |
| `Shift + B` | Play Back of Flashcard Using Text to Speech | Flashcard Queue |  |
| `Shift + F` | Play Front of Flashcard Using Text to Speech | Flashcard Queue |  |
| `Shift + H` | “Forgot All List Items” Response | Flashcard Queue |  |
| `Shift + S` | Stop Text to Speech Playback | Flashcard Queue |  |
| `Shift + [` | Send to Back | Drawing | may clash |
| `Shift + ]` | Bring to Front | Drawing | may clash |
| `Shift + Enter` | Add Line Break | Bullet-Level Editing | fixed |
| `Shift + Tab` | Outdent | Bullet-Level Editing | fixed |
| `Shift + F3` | [Text Case Converter](Keyboard-Shortcuts.md) | **Incremental RemNote** |  |
| `Shift + F8` | [Bulletize Inline Selected Text](Keyboard-Shortcuts.md) | **Incremental RemNote** |  |

### Cmd/Ctrl + Opt/Alt + key

| Keys | Command | Where | Notes |
| :--- | :--- | :--- | :--- |
| `Cmd + Opt + A` / `Ctrl + Alt + A` | Toggle Edit Later Tag | Bullet-Level Editing |  |
| `Cmd + Opt + C` / `Ctrl + Alt + C` | Turn Into a Concept | Changing Bullet Types |  |
| `Cmd + Opt + D` / `Ctrl + Alt + D` | Turn Into a Descriptor | Changing Bullet Types |  |
| `Cmd + Opt + E` / `Ctrl + Alt + E` | Merge Bullet With Duplicate Name | Bullet-Level Editing |  |
| `Cmd + Opt + F` / `Ctrl + Alt + F` | Toggle Practice | Bullet-Level Editing |  |
| `Cmd + Opt + H` / `Ctrl + Alt + H` | Hide Bullet From Document | Editor Scope Showing / Hiding |  |
| `Cmd + Opt + K` / `Ctrl + Alt + K` | Link Selected Text | Text-Level Editing |  |
| `Cmd + Opt + L` / `Ctrl + Alt + L` | Turn Into a List Item | Bullet-Level Editing |  |
| `Cmd + Opt + M` / `Ctrl + Alt + M` | Set New Parent (Move) | Bullet-Level Editing |  |
| `Cmd + Opt + O` / `Ctrl + Alt + O` | Go to All Notes | Global |  |
| `Cmd + Opt + P` / `Ctrl + Alt + P` | Add All Properties | Bullet-Level Editing | ⚠️ Same keys as *Quick Set Priority* (Windows) |
| `Cmd + Opt + Q` / `Ctrl + Alt + Q` | Unset as Concept/Descriptor | Changing Bullet Types |  |
| `Cmd + Opt + R` / `Ctrl + Alt + R` | Turn Into a Card Item | Bullet-Level Editing |  |
| `Cmd + Opt + S` / `Ctrl + Alt + S` | Turn Into a Property | Changing Bullet Types |  |
| `Cmd + Opt + T` / `Ctrl + Alt + T` | Add New Tab (Browser Alternative) | Tabs |  |
| `Cmd + Opt + U` / `Ctrl + Alt + U` | Go to Flashcard Home | Global |  |
| `Cmd + Opt + V` / `Ctrl + Alt + V` | Toggle Callout | Bullet-Level Editing |  |
| `Cmd + Opt + W` / `Ctrl + Alt + W` | Close Tab (Browser Alternative) | Tabs |  |
| `Cmd + Opt + X` / `Ctrl + Alt + X` | Tag With Parent | Bullet-Level Editing |  |
| `Cmd + Opt + 0` / `Ctrl + Alt + 0` | Clear Highlight | Highlight (Bullet-Level & Text-Level) |  |
| `Cmd + Opt + 1` / `Ctrl + Alt + 1` | Heading 1 | Headings (Bullet-Level) |  |
| `Cmd + Opt + 2` / `Ctrl + Alt + 2` | Heading 2 | Headings (Bullet-Level) |  |
| `Cmd + Opt + 3` / `Ctrl + Alt + 3` | Heading 3 | Headings (Bullet-Level) |  |
| `Cmd + Opt + 4` / `Ctrl + Alt + 4` | Highlight Red | Highlight (Bullet-Level & Text-Level) |  |
| `Cmd + Opt + 5` / `Ctrl + Alt + 5` | Highlight Orange | Highlight (Bullet-Level & Text-Level) |  |
| `Cmd + Opt + 6` / `Ctrl + Alt + 6` | Highlight Yellow | Highlight (Bullet-Level & Text-Level) |  |
| `Cmd + Opt + 7` / `Ctrl + Alt + 7` | Highlight Green | Highlight (Bullet-Level & Text-Level) |  |
| `Cmd + Opt + 8` / `Ctrl + Alt + 8` | Highlight Blue | Highlight (Bullet-Level & Text-Level) |  |
| `Cmd + Opt + 9` / `Ctrl + Alt + 9` | Highlight Purple | Highlight (Bullet-Level & Text-Level) |  |
| `Cmd + Opt + '` / `Ctrl + Alt + '` | Open Selected Bullet in New Tab | Tabs |  |
| `Cmd + Opt + .` / `Ctrl + Alt + .` | Explain Selected Text | Text-Level Editing |  |
| `Cmd + Opt + ;` / `Ctrl + Alt + ;` | Highlight Gray | Highlight (Bullet-Level & Text-Level) |  |
| `Cmd + Opt + [` / `Ctrl + Alt + [` | Heading 4 | Headings (Bullet-Level) |  |
| `Cmd + Opt + ]` / `Ctrl + Alt + ]` | Heading 5 | Headings (Bullet-Level) |  |
| `` Cmd + Opt + ` `` / `` Ctrl + Alt + ` `` | Clear Heading | Headings (Bullet-Level) |  |
| `Cmd + Opt + ←` / `Ctrl + Alt + ←` | Switch to Previous Tab | Tabs |  |
| `Cmd + Opt + →` / `Ctrl + Alt + →` | Switch to Next Tab | Tabs |  |
| `Cmd + Opt + ↑` / `Ctrl + Alt + ↑` | Increase Video Playback Speed on Learning Page | Learning Page | ⚠️ Same keys as *Quick Increase Priority Number (Less Important)* (Windows) |
| `Cmd + Opt + ↓` / `Ctrl + Alt + ↓` | Decrease Video Playback Speed on Learning Page | Learning Page | ⚠️ Same keys as *Quick Decrease Priority Number (More Important)* (Windows) |
| `Cmd + Opt + \\` / `Ctrl + Alt + \\` | Heading 6 | Headings (Bullet-Level) |  |

### Cmd/Ctrl + Shift + key

| Keys | Command | Where | Notes |
| :--- | :--- | :--- | :--- |
| `Cmd + Shift + A` / `Ctrl + Shift + A` | Practice All Flashcards in Document | Flashcard Queue |  |
| `Cmd + Shift + B` / `Ctrl + Shift + B` | Toggle Practice Backward | Bullet-Level Editing |  |
| `Cmd + Shift + C` / `Ctrl + Shift + C` | Copy as Image/Plain Text | — | may clash |
| `Cmd + Shift + C` / `Ctrl + Shift + C` | Search Descendants in Editor | Editor Navigation |  |
| `Cmd + Shift + E` / `Ctrl + Shift + E` | Copy Bullet as Portal | Copying References |  |
| `Cmd + Shift + F` / `Ctrl + Shift + F` | Filter Document | Editor Navigation |  |
| `Cmd + Shift + G` / `Ctrl + Shift + G` | Toggle Practice Forward | Bullet-Level Editing |  |
| `Cmd + Shift + H` / `Ctrl + Shift + H` | Hide Parents & Siblings From Document | Editor Scope Showing / Hiding | ⚠️ Same keys as *Open Repetition History* (Windows) |
| `Cmd + Shift + K` / `Ctrl + Shift + K` | Strikethrough Text | Text-Level Editing |  |
| `Cmd + Shift + L` / `Ctrl + Shift + L` | Practice Flashcards in Global Queue | Global |  |
| `Cmd + Shift + O` / `Ctrl + Shift + O` | Practice in Order | Flashcard Queue |  |
| `Cmd + Shift + P` / `Ctrl + Shift + P` | Practice with Spaced Repetition | Flashcard Queue |  |
| `Cmd + Shift + R` / `Ctrl + Shift + R` | Copy Bullet as Reference | Copying References |  |
| `Cmd + Shift + S` / `Ctrl + Shift + S` | Copy Bullet as Tag | Copying References |  |
| `Cmd + Shift + V` / `Ctrl + Shift + V` | Paste Without Formatting | Bullet-Level Editing |  |
| `Cmd + Shift + 0` / `Ctrl + Shift + 0` | Insert Block Code | Bullet-Level Editing |  |
| `Cmd + Shift + 8` / `Ctrl + Shift + 8` | Pin Document | Bullet-Level Editing |  |
| `Cmd + Shift + '` / `Ctrl + Shift + '` | Zoom Into Bullet & Open in Other Pane | Editor Navigation |  |
| `Cmd + Shift + ,` / `Ctrl + Shift + ,` | Subscript Text | Text-Level Editing |  |
| `Cmd + Shift + .` / `Ctrl + Shift + .` | Superscript Text | Text-Level Editing |  |
| `Cmd + Shift + ;` / `Ctrl + Shift + ;` | Zoom Out of Bullet & Open in Other Pane | Editor Navigation |  |
| `Cmd + Shift + ↑` / `Ctrl + Shift + ↑` | Collapse All Descendants | Editor Scope Showing / Hiding |  |
| `Cmd + Shift + ↓` / `Ctrl + Shift + ↓` | Include All Descendants | Editor Scope Showing / Hiding |  |
| `Cmd + Shift + Enter` / `Ctrl + Shift + Enter` | Add Portal | Bullet-Level Editing |  |
| `Cmd + Shift + Tab` / `Ctrl + Shift + Tab` | Cycle Tab Backward | Tabs | fixed; desktop global |

### Cmd/Ctrl + Fn + key

| Keys | Command | Where | Notes |
| :--- | :--- | :--- | :--- |
| `` Cmd + Fn + ` `` | Quick Add | Global | Mac only |

### Ctrl + Opt/Alt + key

| Keys | Command | Where | Notes |
| :--- | :--- | :--- | :--- |
| `Ctrl + Opt + P` / `Ctrl + Alt + P` | [Quick Set Priority](Keyboard-Shortcuts.md) | **Incremental RemNote** | ⚠️ Same keys as *Add All Properties* (Windows) |
| `Ctrl + Opt + ↑` / `Ctrl + Alt + ↑` | [Quick Increase Priority Number (Less Important)](Keyboard-Shortcuts.md) | **Incremental RemNote** | ⚠️ Same keys as *Increase Video Playback Speed on Learning Page* (Windows) |
| `Ctrl + Opt + ↓` / `Ctrl + Alt + ↓` | [Quick Decrease Priority Number (More Important)](Keyboard-Shortcuts.md) | **Incremental RemNote** | ⚠️ Same keys as *Decrease Video Playback Speed on Learning Page* (Windows) |

### Ctrl + Shift + key

| Keys | Command | Where | Notes |
| :--- | :--- | :--- | :--- |
| `Ctrl + Shift + H` | [Open Repetition History](Keyboard-Shortcuts.md) | **Incremental RemNote** | ⚠️ Same keys as *Hide Parents & Siblings From Document* (Windows) |
| `Ctrl + Shift + I` | [Toggle Ignore Tag](Keyboard-Shortcuts.md) | **Incremental RemNote** |  |
| `Ctrl + Shift + J` | [Review in Editor (Execute Repetition)](Keyboard-Shortcuts.md) | **Incremental RemNote** |  |
| `Ctrl + Shift + F1` | [Copy Rem Sources](Keyboard-Shortcuts.md) | **Incremental RemNote** |  |
| `Ctrl + Shift + F7` | [View Read Points (History)](Keyboard-Shortcuts.md) | **Incremental RemNote** |  |

### Opt/Alt + Shift + key

| Keys | Command | Where | Notes |
| :--- | :--- | :--- | :--- |
| `Opt + Shift + C` / `Alt + Shift + C` | [Batch Assign Card Priority for tagged/referencing rems](Keyboard-Shortcuts.md) | **Incremental RemNote** |  |
| `Opt + Shift + D` / `Alt + Shift + D` | Add Today's Document In New Pane | Global |  |
| `Opt + Shift + F` / `Alt + Shift + F` | [Find Rem (insert reference / open in pane)](Keyboard-Shortcuts.md) | **Incremental RemNote** |  |
| `Opt + Shift + I` / `Alt + Shift + I` | [Open Incremental Rems Main View](Keyboard-Shortcuts.md) | **Incremental RemNote** |  |
| `Opt + Shift + L` / `Alt + Shift + L` | [Priority Queue](Keyboard-Shortcuts.md) | **Incremental RemNote** |  |
| `Opt + Shift + M` / `Alt + Shift + M` | [Convert extracted markup to rich text](Keyboard-Shortcuts.md) | **Incremental RemNote** |  |
| `Opt + Shift + N` / `Alt + Shift + N` | Open Create Menu | Global |  |
| `Opt + Shift + O` / `Alt + Shift + O` | [Open Hovered Source in Floating Window](Keyboard-Shortcuts.md) | **Incremental RemNote** |  |
| `Opt + Shift + Q` / `Alt + Shift + Q` | [Pin Source Quote](Keyboard-Shortcuts.md) | **Incremental RemNote** |  |
| `Opt + Shift + R` / `Alt + Shift + R` | Restore Last Closed Tab | Tabs |  |
| `Opt + Shift + S` / `Alt + Shift + S` | Toggle Right Sidebar | Global |  |
| `Opt + Shift + V` / `Alt + Shift + V` | [Paste Rem Sources](Keyboard-Shortcuts.md) | **Incremental RemNote** |  |
| `Opt + Shift + X` / `Alt + Shift + X` | Restart AI Chat (when in chat window) | Global | ⚠️ Same keys as *Extract with Priority* (Mac & Windows) |
| `Opt + Shift + X` / `Alt + Shift + X` | [Extract with Priority](Keyboard-Shortcuts.md) | **Incremental RemNote** | ⚠️ Same keys as *Restart AI Chat (when in chat window)* (Mac & Windows) |
| `Opt + Shift + Z` / `Alt + Shift + Z` | [Create Cloze Deletion with Priority](Keyboard-Shortcuts.md) | **Incremental RemNote** |  |

### Cmd/Ctrl + Opt/Alt + Shift + key

| Keys | Command | Where | Notes |
| :--- | :--- | :--- | :--- |
| `Cmd + Opt + Shift + A` / `Ctrl + Alt + Shift + A` | Include All Hidden Children | — |  |
| `Cmd + Opt + Shift + C` / `Ctrl + Alt + Shift + C` | Toggle Disable Custom CSS | Global |  |
| `Cmd + Opt + Shift + D` / `Ctrl + Alt + Shift + D` | Turn Into a Document | Changing Bullet Types |  |
| `Cmd + Opt + Shift + E` / `Ctrl + Alt + Shift + E` | Merge Bullet and Set Alias | Bullet-Level Editing |  |
| `Cmd + Opt + Shift + F` / `Ctrl + Alt + Shift + F` | Turn Into a Folder | Changing Bullet Types |  |
| `Cmd + Opt + Shift + H` / `Ctrl + Alt + Shift + H` | Show Keyboard Shortcuts | Global |  |
| `Cmd + Opt + Shift + I` / `Ctrl + Alt + Shift + I` | Insert Inline Code #2 | Text-Level Editing |  |
| `Cmd + Opt + Shift + L` / `Ctrl + Alt + Shift + L` | Copy Debug Info | — |  |
| `Cmd + Opt + Shift + M` / `Ctrl + Alt + Shift + M` | Merge All Clozes | Bullet-Level Editing |  |
| `Cmd + Opt + Shift + M` / `Ctrl + Alt + Shift + M` | Set New Parent (Move) and Unmark as Edit Later | Bullet-Level Editing |  |
| `Cmd + Opt + Shift + O` / `Ctrl + Alt + Shift + O` | Open Knowledge Base Switcher | Global |  |
| `Cmd + Opt + Shift + P` / `Ctrl + Alt + Shift + P` | Toggle Private | Bullet-Level Editing |  |
| `Cmd + Opt + Shift + R` / `Ctrl + Alt + Shift + R` | Display References | Bullet-Level Editing |  |
| `Cmd + Opt + Shift + R` / `Ctrl + Alt + Shift + R` | Operating System: Focus on RemNote | Global | desktop global |
| `Cmd + Opt + Shift + T` / `Ctrl + Alt + Shift + T` | Open Test Recorder | — |  |
| `Cmd + Opt + Shift + T` / `Ctrl + Alt + Shift + T` | Toggle Editor on Learning Source | PDF Reader |  |
| `Cmd + Opt + Shift + V` / `Ctrl + Alt + Shift + V` | Paste as Single Bullet | Bullet-Level Editing |  |
| `Cmd + Opt + Shift + Y` / `Ctrl + Alt + Shift + Y` | Open AI Tutor Full Screen | Global |  |
| `Cmd + Opt + Shift + 0` / `Ctrl + Alt + Shift + 0` | Clear Text Color | Text Color (Bullet-Level & Text-Level) |  |
| `Cmd + Opt + Shift + 3` / `Ctrl + Alt + Shift + 3` | Text Color Gray | Text Color (Bullet-Level & Text-Level) |  |
| `Cmd + Opt + Shift + 4` / `Ctrl + Alt + Shift + 4` | Text Color Red | Text Color (Bullet-Level & Text-Level) |  |
| `Cmd + Opt + Shift + 5` / `Ctrl + Alt + Shift + 5` | Text Color Orange | Text Color (Bullet-Level & Text-Level) |  |
| `Cmd + Opt + Shift + 6` / `Ctrl + Alt + Shift + 6` | Text Color Yellow | Text Color (Bullet-Level & Text-Level) |  |
| `Cmd + Opt + Shift + 7` / `Ctrl + Alt + Shift + 7` | Text Color Green | Text Color (Bullet-Level & Text-Level) |  |
| `Cmd + Opt + Shift + 8` / `Ctrl + Alt + Shift + 8` | Text Color Blue | Text Color (Bullet-Level & Text-Level) |  |
| `Cmd + Opt + Shift + 9` / `Ctrl + Alt + Shift + 9` | Text Color Purple | Text Color (Bullet-Level & Text-Level) |  |
| `` Cmd + Opt + Shift + ` `` / `` Ctrl + Alt + Shift + ` `` | Operating System: Quick Add | Global | desktop global |
| `Cmd + Opt + Shift + ↑` / `Ctrl + Alt + Shift + ↑` | Collapse Children to 1st Level | Editor Scope Showing / Hiding |  |
| `Cmd + Opt + Shift + Backspace` / `Ctrl + Alt + Shift + Backspace` | Delete Bullet | Bullet-Level Editing |  |
