# Audio Playlist

**Audio Playlist** plays the audios in your notes one after the other, as if they were a single recording, in a small floating player that stays on screen while you move between documents and the flashcard queue. It remembers where you stopped, so a playlist paused on the computer resumes on the phone.

RemNote's own inline player handles one audio at a time: nothing plays the next one, and it forgets its position as soon as you leave the Rem. This is the layer on top, for listening to a chapter's [Read Aloud](Read-Aloud.md) audios, a course's lesson recordings, or everything carrying a tag.

**Works on the phone too.** It needs no helper and no settings.

Try it: this is the plugin's own player, over an invented document with four short clips made for this page. Start a playlist, drag the bar from one audio into the next, close the player and open it again.

<iframe src="../demos/audio-playlist.html" title="Audio Playlist demo" loading="lazy" style="width:100%;height:560px;border:0;display:block"></iframe>

## Starting a playlist { #start }

A playlist is made from **a branch**, from **a tag**, or from both.

| What to play | Where |
|---|---|
| Every audio in a document | The document's **⋯** menu → **Incremental RemNote…** → **Audio Playlist (this document)**. On a phone, this is the way. |
| Every audio under a Rem | Put the cursor in the Rem (or select several) and run **Audio Playlist: Play This Branch** (`apb`). With nothing to play under the cursor, the whole document plays instead. |
| Every audio in the Rems carrying a tag, across the knowledge base | Open the tag's own page and choose **Audio Playlist (rems tagged with this)** in the same menu, or run **Audio Playlist: Play Rems Tagged With This Rem** (`apt`). |
| A branch, but only the audios with a tag | Start the branch, then pick the tag in the player's **All audios** selector. |
| The playlist you heard last | **Audio Playlist: Open Player** (`apo`). |

Audios play **in the order of the document**. A playlist made from a tag alone has no document to follow, so it plays the oldest Rems first. With a tag, a Rem counts when it carries the tag or sits under a Rem that does: tagging a section's title takes all the audios of that section.

The tag selector lists the tag set in **Read Aloud: Tag for Audio Rems** (for example `AI audio`) and the tags you have used for a playlist before.

## The player { #player }

- **One position bar for the whole playlist.** Drag it anywhere: the player switches to the right audio and the right moment in it. The clock shows the time into the playlist and its total length.
- **−15 / +15** move within the playlist, across audios when needed. **⏮** goes to the start of the current audio, then to the previous one; **⏭** to the next.
- **Speed** from 0.75× to 2×, remembered.
- **The list** shows every audio with its length; tap one to play it. Under each name is where it sits in your notes, nearest level first.
- **↗** opens the Rem the current audio belongs to.
- **⌄** shrinks the player to a bar; drag it by its header to move it. **✕** closes it and saves the position.

An audio is named after the Rem it sits under when its own text only labels the file (`🔊 Áudio (Kore)`, as Read Aloud writes it), and after its own text otherwise.

**Short clips are left out.** Audios under 5 seconds (pronunciations, mostly) are skipped; a line at the bottom of the list says how many, with a link to include them. A list made only of short clips plays as it is.

**What is remembered:** the position in each of the last 20 playlists, the speed, and each file's length (so a list is measured once). Positions are kept in RemNote's synced storage, per knowledge base. A playlist is rebuilt from your notes every time it opens, so audios added since then appear in it, and the position stays on the same audio.

## Good to know { #notes }

- **On a phone the first play may need a tap** on the player's play button.
- **Only audio stored in RemNote, or linked from a public address, can be played.** An audio that fails to load is marked *unavailable* and skipped.
- Audios shown through a **portal** are not part of the branch they are shown in.
- Audio kept as a **source** (an uploaded file or a RemNote audio recording) is not included yet.
