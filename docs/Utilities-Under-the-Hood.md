# Under the Hood

Not a utility — infrastructure that several of the other utilities depend on.

## Omnibar Selection Recovery

Internally, the plugin runs a small editor-selection cache so that commands invoked via the `Cmd+/` Omnibar can still access the multi-rem selection you had before opening the palette. (Without this, RemNote blurs the editor when the Omnibar opens, and a plugin command's `getSelection()` call comes back empty — `Add Tag`-style internal commands sidestep this by capturing the selection synchronously when the palette opens, but plugins have no equivalent hook.)

Commands that benefit from this recovery:

- **Make Incremental (Extract)** / **Extract with Priority** — multi-rem `Make Incremental` works from `Cmd+/`.
- **Dismiss Incremental Rem** — multi-rem dismissal works from `Cmd+/`.
- **Paste Rem Sources** — pasting onto multiple target rems works from `Cmd+/`.
- **Text Case Converter** — multi-rem case cycling works from `Cmd+/`.
- **Restructure Outline by Headings** — multi-rem restructure works from `Cmd+/`.

The cache has a 30-second TTL and is only written on positive selection events, so opening the Omnibar (which fires a clear-selection event) doesn't wipe what you just selected.
