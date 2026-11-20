# Read Aloud

**Read aloud** turns a document, or any Rem and everything under it, into a spoken audio file and puts it into the document as a playable audio Rem stored in RemNote. Listen to your notes on a walk, in the car, or before a review session.

A second command, [**Add pronunciation**](#pronunciation), does the same for a single card: it reads it aloud at once and keeps the audio as its Extra Card Detail.

Read aloud reads the notes as they are (**Literal**), lightly reworked by AI so formulas and units can be heard (**Adapted**), or as a spoken **Summary** of the length you choose. The speech is made by a text-to-speech service with **your own API key**: Google's Gemini TTS, Microsoft Azure, or ElevenLabs. Nothing is paid for until you press **Generate**, and the popup shows the estimated cost first.

**Desktop app only.** It runs through the [Local Media Bridge](Local-Media-Bridge.md) helper, and the command appears only while that setting is on. **Languages:** Portuguese and English, including English terms inside Portuguese notes and the reverse.

## Using it { #use }

1. Put the cursor in the Rem or document to read (or select Rems), and run **Read aloud** (`ra`).
2. The popup shows the **script**, the text that will be spoken. Edit it freely.
3. Pick a **mode** (below), an **engine** and a **voice**. The line under them shows the estimate: words, duration, cost.
4. Press **Generate** (`⌘↵` / `Ctrl+Enter`). The popup closes and the audio is made **in the background**, so you can keep working in RemNote (a 5-minute audio takes about a minute).
5. When the audio is in, a notice appears at the top right, with the voice, duration and cost. **Open Rem** opens the read Rem, with the new audio at its top; **Dismiss** closes the notice. It never interrupts what you are doing: a popup you have open (another Read aloud, say) stays open, and the notice waits until you dismiss it. Drag it to move it if it is in the way.

The audio is added as the **first child** of the read Rem, captioned `🔊 Audio (<voice>)` (`🔊 Audio Summary (<voice>)` for a summary; `Áudio` / `Resumo em Áudio` in a Portuguese note). It is stored in RemNote like an uploaded file, so it plays offline and syncs. Set **Read Aloud: Tag for Audio Rems** to tag every audio Rem, for example `AI audio`.

An audio Rem and everything under it is never read again, so running Read aloud twice on a document does not read its previous audio or summary.

### Modes { #modes }

| Mode | What is spoken | AI |
|---|---|---|
| **Literal** | The notes as written, with the [reading rules](#reading-rules). Formulas are skipped (“formula omitted”). | None |
| **Adapted** | Everything in the notes, in the same order, made listenable: formulas and units said in words, abbreviations expanded, foreign terms marked. No content added or dropped. | Writes the script |
| **Summary** | A spoken summary of a [length you set](#summary-length), most important points first. Optional **additional instructions**, e.g. *focus on the definitions* or *end with three questions for me to answer*. | Writes the script |

In **Adapted** and **Summary**, press **Write the script with AI** (`⌘↵`), read the result, edit it if you like, then **Generate**. Formulas are read the way a teacher reads them: subscripts as “V sub A” in English and “V índice A” in Portuguese.

With **Also insert the summary text under the audio** (on by default), a Summary's text is also added under its audio Rem, headed *Summary of this document, written by AI*, with one Rem per line and the foreign terms in italics.

The AI step runs `claude -p` with your Claude subscription, at no per-call charge. When that fails (usage limit reached, the `claude` command not installed, any error) and an Anthropic API key is set, it runs on the API instead; the popup then shows the cost (a few cents for a note) and why `claude -p` failed. See [Setup](#setup).

### Summary length { #summary-length }

- **Length**: a slider with the share of the note to keep, from 20 % to 80 % of its word count (default **50 %**).
- **at most … min**: a cap, so a long chapter does not give a long summary.

The target is the smaller of the two, and the popup shows it live (*≈ 351 words · about 2 min 27 s*, or *capped* when the maximum wins). Questions you ask for count within it. Models tend to overshoot a word limit: an answer more than 25 % over the target is sent back once to be shortened. The popup then shows *356 words for a target of 351*.

### Drafts are kept { #drafts }

Closing the popup loses nothing. Reopening it on the same Rem brings back the AI-written scripts and your edits to them, the summary options and the mode you used. A hand edit of the Literal script comes back only while the note is unchanged. When the note changed after an AI script was written, the popup says so: press **Rewrite with AI** to include the changes. Drafts are kept on this computer (the plugin's local storage, not synced), for the 30 Rems used most recently.

## Add pronunciation { #pronunciation }

**Add pronunciation (Extra Card Detail)** (`pron`) gives a flashcard its spoken version, with no popup:

1. In the editor, put the cursor in the Rem or select several. **In the queue, it acts on the card on screen** (or on the Rem selected in the previewer).
2. Run **Add pronunciation**. It reads only the Rem itself, front then back, **not its children**, with the same [reading rules](#reading-rules): a cloze is read whole, a reference by the text it shows, pins are skipped. A **descriptor** is read [with its concept](#pronunciation-descriptors).
3. A few seconds later the audio **plays**, and it is added as the Rem's first child, captioned 🔊, with the **Extra Card Detail** powerup. It shows when the answer is revealed and makes no card of its own. **In the queue it does not play from the command**: the queue plays a card's Extra Card Detail audio itself, and both would overlap.

Pronunciations are kept apart from Read aloud's audios: they get the plugin's **Pronunciation** powerup (not the tag of *Read Aloud: Tag for Audio Rems*), whose pill shows a speaking-head icon instead of its name, and their bullet becomes that icon, in the editor and in the queue's *Extra details* (when a card has a single Extra Card Detail, which RemNote shows without a bullet, the icon takes the bullet's place; the 🔊 caption is written in brown text, which does not show on the emoji, so the queue can recognise it). The helper keeps their copies in a folder of their own, `pronunciations` inside the audio folder.

The engine is the one the popup would suggest (Gemini TTS when its key is set; Azure for English text with 3 or more marked Portuguese terms), with a random voice. A card costs a fraction of a cent. With several Rems selected, each gets its audio, and none plays.

### Descriptors are read with their concept { #pronunciation-descriptors }

A descriptor alone says little (*refere-se a que camada?*), so its pronunciation starts with the Rem it describes: the first parent that is **not** a descriptor (its concept, whether or not it is marked as one), then any descriptors in between, front only, then the card itself, front and back. For the descriptor *refere-se a que camada?* under the concept **Brake holding capacity**, the audio says “Brake holding capacity. Refere-se a que camada? Refers to the first layer on the drum.”

**The language of a short card.** A single word gives no clue, so an undecided side takes the language of the other side, then of the Rem's parents (for a concept or descriptor read before the card, the language of the Rems above it). A side that is all in *italics* in a note of the other language is read in that other language: *fairway* on the front of a card in Portuguese notes is pronounced in English, and *hidrovia* on its back in Portuguese.

**Playback.** The audio plays inside RemNote. If the app refuses to start it on its own, the helper plays it on the computer instead (with `ffplay`, which comes with ffmpeg, or `afplay` on macOS). The stored audio Rem plays like any other.

## Engines and costs { #engines }

The popup lists every engine with its own estimate, and greys out those whose key is not set (“no key”). It preselects a suggestion; any available engine can be picked instead.

| Engine | Key(s) in the helper's `.env` | Notes |
|---|---|---|
| **Gemini TTS (Google Cloud)** | `GOOGLE_CLOUD_API_KEY` (optional `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`) | Gemini 3.8 Flash TTS through Vertex AI, billed to a Google Cloud billing account (and its credits). Suggested first when set. Each call gets its locale (`pt-BR` or `en-US`), as through the Gemini API. |
| **Gemini TTS** | `GEMINI_API_KEY` | The same model through the Gemini API ([Google AI Studio](https://aistudio.google.com/apikey) key). |
| **Azure multilingual** | `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION` | Voice `en-US-AndrewMultilingualNeural`. The only engine that switches language **inside a sentence**, so it is suggested for scripts with 3 or more Portuguese terms marked inside English lines. English terms in Portuguese lines do not count: Gemini reads them well, while Portuguese words in an English sentence come out Spanish or English. |
| **ElevenLabs** | `ELEVENLABS_API_KEY` | Your account's voices, by first name. Suggested only when no other engine has a key. |

Gemini and ElevenLabs speak one language per call: a marked foreign term is read in its line's language, and the popup says so when the script has any.

Prices checked in November 2026 (the helper's `tts.py` holds them; check your provider's current prices):

| Engine | Billing | A 5-minute Portuguese note |
|---|---|---|
| Gemini TTS (either way) | US$9 per million audio tokens, 25 per second of speech, until 31 Dec 2026; US$18 from 2027. Pauses are free. | ~US$0.07 (0.14 in 2027) |
| Azure | US$15 per million characters, **including the SSML markup** (the helper keeps it short) | ~US$0.09 |
| ElevenLabs | Credits from your monthly plan; the estimate assumes ~US$0.20 per 1,000 characters | ~US$0.80 |

Durations are estimated from the word count at each engine's measured speaking rate (Gemini about 143 words a minute).

### Gemini's audio is checked { #checked }

Gemini TTS is a generative model, and now and then it does not just read: it goes on past the end of the text with sentences of its own, loops on a phrase, or skips a clause. Long calls and repeated passages make this likelier. So the helper:

- sends Gemini **short calls** (about 600 characters), and never two copies of the same passage in one call;
- **transcribes each call** on your Mac with a local [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (`brew install whisper-cpp`, and the speech model that [Incremental Video](Incremental-Video.md#setup) transcripts use, in `~/.incremental-remnote/ai-ocr/whisper/`), and compares it with the script, numbers (written in digits or in words, in English or Portuguese) and British or American spellings counted as the same;
- **makes the call again**, up to 3 times, when 5 or more words in a row are added or missing, or about 15 % of the words in all, and keeps the best take. What still does not match is reported.

Without whisper, only the length of each call is checked. A redone call is paid again, so a summary may cost a little more than estimated. Azure and ElevenLabs read the text as written and are not checked.

## Reading rules { #reading-rules }

| In the notes | Read aloud as |
|---|---|
| The tree | In order, depth first, collapsed children included. A Rem with a back is read *front: back*. |
| Rem references | The text the reference shows (the alias, when it points at one). |
| Pins (📌 references to highlights), tags, property Rems (*Next Rep Date*, *Priority*…), powerup slots | Skipped. |
| Images, audio, video, drawings, embeds, code | Skipped silently (the popup counts what was skipped). |
| Notices that an audio was made by AI (*Audio gerado por IA, apenas para introduzir a matéria.*, *AI-generated audio…*) | Skipped, when the notice ends its line and starts the Rem or follows a dash or colon. A Rem whose notice sits right above an audio is left out whole, title included (*PP 8A Como ventos e ondas fecham portos — Audio gerado por IA…*). A sentence that only talks about AI audio is still read. |
| Tables | “Table omitted.” |
| Formulas | Literal: “formula omitted”. Adapted and Summary: said in words. |
| Portals | Their Rems, once. |
| A descriptor you start on | Its concept first (front only), then any descriptors in between, then the Rem and its children, as [Add pronunciation](#pronunciation-descriptors) reads one. The audio is still named after the Rem. |
| Bold, italic, links, page numbers, emoji, arrows | Formatting dropped; `p. 12` is read “page 12”, `kN` “kilonewtons” (and the Portuguese equivalents). |
| Italic words in the other language | Marked as foreign terms (for example `<en>fairway</en>` in a Portuguese line), so Azure pronounces them in their own language. Acronyms are never marked. |

### The script format { #script-format }

The script in the popup is plain text, one idea per line:

| Mark | Meaning |
|---|---|
| `[pt]` at the start of a line | The line is in Portuguese (a line without it is English). |
| `<en>term</en>` / `<pt>termo</pt>` | A foreign term inside a line. |
| `[pause]` alone on a line | Time to answer: the question on the line before, the answer on the line after. The pause lasts 5 s or more, longer for longer answers; `[pause 8]` sets 8 s. |

Anything an engine would read out wrongly (markdown, LaTeX, links, page numbers, other brackets) is listed in red under the script, and **Generate** stays off until it is fixed.

## Setup { #setup }

1. The [Local Media Bridge](Local-Media-Bridge.md#setup) setting on and its helper running, **version 12 or later** (`python3 media_bridge.py status`). After updating the plugin, restart the helper; the command says so when it is too old.
2. **ffmpeg** on the computer (`brew install ffmpeg` on macOS): the helper uses it to join the parts into one mp3.
3. At least one engine's key, in a `.env` file the helper reads (one `NAME=value` per line). Either put it at `~/.remnote-media-bridge/.env`, or point the helper at an existing file with `~/.remnote-media-bridge/tts.json`:

    ```json
    {"envFile": "~/path/to/.env", "audioHome": "~/path/to/audios"}
    ```

    The helper reads the keys on every request, so a new key works without a restart. Keys never go into the plugin's settings, which RemNote syncs in plain text.

4. For **Adapted** and **Summary**:
    - the [Claude Code](https://claude.com/claude-code) command `claude`, signed in with your Claude subscription; and/or
    - `ANTHROPIC_API_KEY` in the same `.env`, with the `anthropic` package installed in the Python that runs the helper (`python3 -m pip install anthropic`).

**Google Cloud key:** in the Google Cloud console, pick the project whose billing account you want charged, enable the **Vertex AI API** (APIs & Services → Library), then create an API key under APIs & Services → Credentials. If it offers to authenticate through a service account, accept and give that account the *Vertex AI User* role. Restrict the key to the Vertex AI API.

### Options in `tts.json` { #options }

| Key | Default | What it sets |
|---|---|---|
| `envFile` | — | The `.env` file with the keys. |
| `audioHome` | `~/.remnote-media-bridge/audio` | Where a copy of every script and mp3 is kept, as `<subject>_<remId>.txt` / `.mp3`. |
| `pronunciationHome` | `<audioHome>/pronunciations` | Where the copies of [pronunciations](#pronunciation) go. |
| `geminiVoices` | 14 voices | The Gemini voices offered (and drawn from, when the voice is left on *Random*). |
| `geminiModel`, `vertexModel` | `gemini-3.8-flash-tts` | The Gemini TTS model. |
| `azureVoices` | `["en-US-AndrewMultilingualNeural"]` | The Azure voices offered. |
| `elevenModel` | `eleven_multilingual_v2` | The ElevenLabs model. |
| `llmModel` | `claude-opus-5-5` | The Claude model for Adapted and Summary (CLI and API). |
| `geminiUsdPerMTokens`, `elevenUsdPerMChars` | list prices | Your own prices, for the estimates. |
| `verifySpeech` | `true` | `false` turns off the [check of Gemini's audio](#checked). |
| `whisperCli`, `whisperModel`, `whisperVadModel` | `whisper-cli` on the PATH, the AI helper's models | The transcriber used for the check. |

To change what the AI is asked to do, put your own instructions in `~/.remnote-media-bridge/read-aloud-summary.md` or `read-aloud-adapted.md`. They replace that mode's task; the rules of the script format are always added.

### From a terminal { #cli }

The engine is `scripts/media_bridge/tts.py`, which also works on its own with a script file:

```bash
python3 tts.py script.txt --plan                       # engines, estimate; no cost
python3 tts.py script.txt --engine azure --out note.mp3
python3 spoken_script.py outline.md --mode summary --lang pt --words 350
```

## Troubleshooting { #troubleshooting }

- **The command is not in the omnibar:** turn on **Local Media Bridge**. Turning the setting off hides the command from the next reload.
- **“The media-bridge helper … is version N”:** restart the helper (`curl -X POST localhost:3460/shutdown`, then `launchctl kickstart -k gui/$(id -u)/com.incrementalremnote.media-bridge` when it runs at login).
- **Every engine shows “no key”:** the helper did not find the `.env`. Check `envFile` in `tts.json`, and the variable names above.
- **Portuguese spoken with a Spanish or English accent:** the line is missing its `[pt]` mark, or the engine read a marked term in the line's language (choose Azure for an English text with many Portuguese terms).
- **The notice never came:** the audio is made in the window where you pressed Generate, and reloading RemNote while it runs drops the job. The helper still keeps its copy of the mp3 in `audioHome` (see [Options](#options)), so you can add that file by hand instead of paying for it again.
- **A summary is cut off or too long:** lower the slider or the maximum, or press **Rewrite with AI**.
- **The audio says things the notes do not, repeats itself or skips a sentence:** that is Gemini improvising (see [Gemini's audio is checked](#checked)). Without whisper on this Mac the helper cannot catch it: install it, or generate again.
