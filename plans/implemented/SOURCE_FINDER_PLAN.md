# Find Sources — plan and status

**Implemented** in v1.0.245 (all four phases, 2026-11-18).

Maintainer notes, not published (the docs site is built from `docs/` only). Last updated 2026-11-18.

**Goal:** from a note (a summary, course material, a translation, a statement to judge), find *where the canonical sources say it*, by meaning when the words differ, and pin those passages. Where the Pin Source Quote of today needs text copied from the open source, this works from text that only means the same thing.

**The friction it removes:** studying from a summary or course material (often in another language) of a subject the bibliography covers, and wanting to check it against the original: the wording, the context, whether it is even right. Today that means opening the book, finding the passage and pinning it by hand, or running `/explain-with-quotes`, `/paralelos` or `/quote-exercises` from Claude Code. This is a faster, one-Rem version of those skills, run from inside the plugin.

**Why it can work with the existing pin code:** the semantic index (the corpus provider) returns **index chunks whose text was taken from the PDF**. A paraphrase or translation is *found* by meaning; the verbatim snippet it points to is then *pinned* by the existing literal `/locate` + `ensureSourcePins`. Nothing in the pinning code has to change.

## How it works today (2026-11-18)

- **Pin Source Quote** (`psq`) pins a literal passage from the open source (`pinSourcesOfRems`, `src/lib/pdf_source_pins/index.ts`).
- **Source finder** (`find-source`, docs/Corpus-Provider.md) names the book a quote comes from. Its clues are all literal: an attribution in the text (*“…” (BPG 5.2.1)*), the Rem sitting in a book's notes, and 8-word runs found word for word in the index (FTS). It uses no embeddings and no API, and answers in about a second.
- **Before phase 1** the finder ran only when **no** source was open. A miss in the open source showed *Passage not found* and stopped.
- **The PSCPP provider** (`~/Busca-Semantica-PSCPP/busca_provedor.py`) also has a semantic search (`busca_consultar.consultar`), so far used only by the skills. It works in three steps:
  1. **Retrieval:** Gemini embedding (by meaning) and FTS (by word), fused with RRF.
  2. **Reranking:** Gemini scores each candidate. `conceito` mode gives `nota`, `motivo` and `diverge`; `decidir` mode says which items a passage settles.
  3. **Per result:** the book, the page range, the chunk text, the section's Rem in the notes, and `edital`.

  A query takes about 15 s.

## Decisions

- **Placement of the pins** (user, 2026-11-18): at the **end** of the Rem, on the back when it has one (`appendPins`, which matches the AI Study Tools rule *pin on the back*). **Inline**, right after the sentence a pin supports, only when the Rem mixes what more than one source or passage says **and** each part can be matched to its passage with confidence. Otherwise everything goes at the end.
- **Check Statement is a separate command** (user, 2026-11-18). It also pins the supporting quotes when they are not pinned yet.
- **Always review** before writing (as AI Study Tools decided). A shortcut that accepts the high-scoring rows (score 9 or more) is part of the review popup, not a way to skip it.
- **Quote Rems are optional** (user, 2026-11-18): the review popup asks, remembering the choice per device:
  - **Pins only:** the pins go on the Rem.
  - **Pins + quotes:** the pins go on the Rem, plus child Rems with the quotes (layout below).
- **Background, not modal:** the search runs as a tracker job, like Upscale image. A notice with **Review** opens the review popup when it is done, and a failure is a notice with `tone: error`.
- **The AI never types a quote.** The reranker may pick a *substring* of a chunk. The provider checks that it really is one, and otherwise falls back to the chunk's anchor sentence. The plugin then locates it in the RemNote PDF before offering it.
- **Same output layout as the skills,** so the skills and the plugin write one convention. See *Write layout*.
- **The contract stays generic:** the plugin only knows the operations in docs/Corpus-Provider.md. The Gemini key and the index stay in the user's provider, so other users can plug in their own library.

## Phases

### Phase 1: the open source misses, so ask the finder (shipped in v1.0.245)

- [x] **`pinQuotesInViews` / `pinQuoteInViews`:** when the open source does not hold the passage, the Rems that missed go to `pinFromSourceFinder`, gated on `hasCorpusCapability('find-source')`. This works in both paths, the single-view one and the Text Reader views popup.
- [x] **`pinFromSourceFinder(…, { searched })`:** skips the PDFs already searched with the Rem's own text, unless the book carries a literal `quote` (`quote-literal`: the Rem's text was corrected and only the literal text matches). They are listed as *“… (the open source)”* under *Not found in*.
- [x] **`finderPinDialog(run, fallback)`:** the dialog says the open source was searched first and how many Rems were pinned there. It keeps *Wrong PDF?…* for pins and the paraphrase/translation hint for misses.
- [x] **Without a finder** (no helper, or no provider), the dialogs are as before.
- [x] Test in RemNote:
  - the PIANC Rem (a translation, so still a miss, now listing the open PDF);
  - a quote from another book with a PDF open;
  - a multi-Rem selection mixing both.
- [x] Docs: the Source-Pins.md section became *Sources that are not open*; troubleshooting row; changelog v1.0.245.
- [x] Same release: pages and highlights RemNote has not loaded are read from remnote.db (helper `/source-highlights`), so no duplicate "Page NNN" (findings/PLUGIN_BRIDGE_AND_SDK.md).

### Phase 2: Find Sources (semantic search, background, review)

**Provider:** new operation `find-passages`, capability `semantic-search`, documented in docs/Corpus-Provider.md.

```json
{ "op": "find-passages",
  "items": [ { "remId": "…", "texts": ["front", "back"], "ancestors": ["…"],
               "openSourceRemId": "PdfRem or null", "mode": "support" } ] }
```

The answer has one list per Rem, best first:

```json
{ "items": [ { "remId": "…", "passages": [
  { "book": { "id": "pianc121", "title": "…", "cite": "PIANC 121", "pdfRemIds": ["…"] },
    "page": 29, "section": "1.4.3 Probability Aspects…",
    "quote": "Probabilistic design methods are widely used to determine the optimum dimensions (channel depth and width) of entrance channels and lead to significant savings compared to the deterministic design approach.",
    "covers": "Métodos de projeto probabilístico … abordagem de projeto determinístico.",
    "score": 10, "why": "mesma afirmação, traduzida", "role": "source",
    "diverges": false, "edital": "sim", "notesRemId": "…" } ] } ] }
```

- **`quote`:** verbatim, a substring of the chunk's raw `texto`. Never `texto_rico`, which carries LaTeX.
- **`covers`:** a substring of the Rem's text, the part this passage supports. Empty when the passage supports the whole Rem. This is what drives inline placement.
- **`role`:**
  - `source` when the passage says what the Rem says (score ≥ 8);
  - `related` when it is on the same point but says something else or more (score 6–7);
  - `diverges` when the reranker's `diverge` flag is set.
- **Scope:** the book of the open source, or of the Rem's notes, is searched first. A second, whole-collection query supplies `related` and `diverges`.

**Provider work** (`~/Busca-Semantica-PSCPP`; that repo commits itself):

- [x] `find_passages(pedido)` in `busca_provedor.py`: `consultar()` in `conceito` mode, the Rem's text as the question, the hinted book first, then the whole collection.
- [x] Reranker schema for this operation (mode `fonte`): add `trecho` (sentences copied from the passage) and `cobre` (the part of the query they support). Validate both as substrings after normalising spaces and quotes, with the anchor sentence or an empty `cobre` as the fallback.
- [x] `semantic-search` in `CAPACIDADES`; `pdfRemIds` through `bap._pdfs(sigla)`, as `find-source` does.

**Plugin work:**

- [x] **`FindSourcesJob`** in the tracker (pattern: `UpscaleJob`, `src/lib/upscale_image.ts`, `register/tracker.ts`).
  - At most 2 Rems in flight.
  - One `corpusRequest('find-passages')` per Rem, with a 90 s timeout.
  - Then a **dry-run** `ensureSourcePins` per passage on its RemNote PDF, to keep only pinnable ones and learn the real page.
  - Results stored per job until reviewed.
- [x] **Entry points:**
  - **Find Sources** command: the focused Rem or a multi-Rem selection, with or without a source open. Hidden without the helper, like Read aloud.
  - **🔎 Search by meaning** button in the *Passage not found* dialog (`MessageDialog` gains an action button that runs a command or opens a popup). Shown only with `semantic-search`, with the cost: *about 20 s per Rem, runs in the background, uses Gemini*.
- [x] **Notice** when done: *🔎 3 sources · 2 related · 1 diverges*, with **Review** (notice `action`). Errors: `tone: error`.
- [x] **Review popup** (`find_sources_popup.tsx`), keyboard-driven (popups-must-be-keyboard-driven):
  - groups **Sources / Related / Diverges**, one row per passage: cite, page, quote in the source's language, `why`, score, and what it covers;
  - Space toggles a row, `A` accepts the rows scored 9 or more, Enter writes, Esc keeps the notice so the review can be reopened;
  - the **Pins only / Pins + quotes** choice;
  - a preview line of where each pin goes (end, or inline after *“…”*).
- [x] **Re-check on write:** if the Rem's text changed since the search, re-run the dry run and drop `covers` that no longer match, so those pins go to the end.
- [x] **Write** (`runFindSourcesWrite` in `src/lib/find_sources/index.ts`, placement in `placement.ts` + test): `ensureSourcePins` for real per accepted passage, pins per the placement rule, then the quote Rems if chosen.
- [x] **Books with no RemNote PDF:** offered with their citation as text and no pin, marked *no PDF in RemNote*.
- [ ] **Media bridge op `find-sources`,** so the skills can use the same path (optional).

**Inline placement rule:**

- **When:** at least two accepted passages have non-empty, non-overlapping `covers`, and each `covers` maps to whole sentences of the Rem.
- **How:** the pin goes right after its sentence, which takes splitting the rich text at a plain-text offset. That only works when the boundary falls between text elements or inside a plain text element.
- **Otherwise,** when formatting, a reference or LaTeX sits on the boundary, the pin goes at the end.

**Write layout** with **Pins + quotes** (the same convention as `/paralelos` and `/quote-exercises`):

```
• <the Rem's text> 📌 📌
    • Sources            ← Extra Card Detail ("Fontes" in a Portuguese note)
        • > “<verbatim quote>” (PIANC 121, PDF p. 29) 📌     ← Quote powerup
    • Related material   ← Extra Card Detail ("Material relacionado")
        • > “…” (Mesquita, PDF p. 212) 📌
```

- **Diverging passages** go under *Related material*, prefixed ⚠️, until Check Statement exists.
- **Re-running** reuses an existing *Sources* / *Related material* child rather than adding a second one, and skips quotes already pinned there.

### Phase 3: Check Statement (shipped in v1.0.245)

- [x] **Command:** (`cks`, Check Statement against Sources) the same search in `mode: "check"`, which asks the reranker for `diverge` on every candidate. Then one `claude -p` call on the **retrieved passages only**: the Rem's text, the passages with their citations, and the instruction to answer in the Rem's language.
  - **The answer:** a verdict (✅ consistent / ⚠️ partly / ❌ contradicts / ❔ not covered), 2–4 sentences on what is wrong or missing and which source diverges, and the ids of the passages it rests on.
- [x] **Written** under the Rem as an Extra Card Detail **Check** Rem (*Verificação*): the verdict and observation, with the passages it rests on as quote + pin children. The supporting quotes are also pinned on the Rem when they are not already (user decision).
- [x] **Where `claude -p` runs:** the AI helper's `/run` from AI Study Tools phase 2 (see overlaps). Check Statement can be its thin slice.

### Phase 4: a whole summary (shipped in v1.0.245)

- [x] **Find Sources in Tree:** (`fsqd`; and `cksd`, Check Statements in descendants) like Pin Source Quotes in Tree, over the text Rems of a course or summary document. One job per Rem, one notice for the batch, and a review popup grouped by Rem, with *accept all ≥ 9* per Rem and globally.

## Overlaps with AI Study Tools (../AI_STUDY_TOOLS_PLAN.md)

The two plans go in **opposite directions**: AI Study Tools goes **source → notes** (generate summaries or Q&A from pages, with pins), while this one goes **notes → sources** (justify or check what a note says). They stay separate plans, but they share parts, which should be built once:

| Shared part | AI Study Tools | Here | Build it as |
|---|---|---|---|
| Pinning verbatim text | `ensureSourcePins` (done) | same | unchanged |
| Review before insert: a checkbox per item, Insert selected / all | phase 3 (not built) | phase 2 review popup | one `src/components/ReviewList` used by both. Whichever ships first builds it |
| `claude -p` with a fixed JSON contract, validation, one retry | helper `/run` (phase 2, not built) | Check Statement (phase 3) | the AI helper's `/run`. Check Statement is a small first user of it |
| Quotes must be verbatim | the model copies them; located, with one corrective retry | quotes come from the index; the model only picks a substring, validated | the same "locate before offering" step (dry-run `ensureSourcePins`) |
| Long runs: progress and cancel | phase 3 *Progress and cancel* | tracker job + notice | the tracker-job + notice pattern (Upscale), not a modal progress bar |
| Which view to pin (open question there) | open | the PDF page view, as the finder does | answer it there the same way |
| Pin on the back of a card | decided | `appendPins` does it | — |

**Not shared:** recipes from *AI Tutor Commands* (a generation feature), page-range extraction, and vision mode.

## Status of phase 2 (2026-11-18, shipped in v1.0.245)

- Tested end to end in RemNote. Follow-ups from that test, all done: the corpus gate takes the operation's capability (`find-passages` is `semantic-search`); a third write option adds the passage notes as **AI Note** child Rems (plugin powerup, small/italic/muted CSS, 🤖 pill); quotes follow the skills' rules (excerpts joined with `[…]`, each pinned on its own; bold emphasis and a bold-italic key word; `(cite, §x.y, PDF p. N; fora do edital)`); notes say what a passage says, never what it leaves out (prompt rule plus a regex in the provider that cuts "…, mas não menciona X" tails).
- Docs: Source-Pins.md *Find Sources*, Corpus-Provider.md `find-passages`, commands reference, changelog v1.0.245.

## Status of phase 2 as first built

- Built: provider `find-passages` (~16 s per Rem through the helper), plugin job, notice, review popup, write, and Search by meaning in the not-found dialogs. Not yet run end to end in RemNote; docs (Corpus-Provider.md `find-passages`, Source-Pins.md or a Find Sources page, changelog) wait for approval.
- **Learned:** the helper runs the provider under launchd, which has no permission to read the Google Drive library: `open()` blocks instead of failing. `consultar()` gained `args.conferir=False` for the provider path (the plugin checks every quote in the RemNote PDF anyway). `mesma_copia` (suggest-parent) still opens the library and could hang the same way.

## Status of phase 3 (2026-11-18)

- Built on Find Sources' pipeline: the job carries `check`; after the passages are located, `src/lib/find_sources/check.ts` sends the statement and the trimmed quotes to the AI helper's new `/run` (one `claude -p` turn, tools off, JSON validated with one retry; model `opus`, as Read aloud's script writer). Verdict `consistent` / `partly` / `contradicts` / `not-covered`, a 2–4 sentence observation in the Rem's language citing book and page, and the passages it rests on (marked ◆ and preselected in the review).
- Written first among the Rem's children: a dated Extra Card Detail header (`Verificação: ⚠️ Em parte (18/11/2026)`; runs never overwrite each other), the observation under it and, with quotes on, the basis quotes under the observation; other accepted passages go to Fontes / Material relacionado as in Find Sources; source pins on the Rem.
- Tested through the helper: a deliberately wrong statement came back `contradicts` in 4.5 s (Opus 5.5) with the right correction and sources. `/run` is the AI Study Tools phase 2 route; its JSON mode is what that plan's `/run` needs.

## Status of phase 4 (2026-11-18)

- `fsqd` / `cksd` collect the statements under the focused or selected Rems (`statementsInTree`): at least 6 words, not a heading (`getFontSize`), a quote, a slot or an AI Note, and not inside our own Fontes / Material relacionado / Verificação headers; `fsqd` also leaves out Rems that already carry a pin. At most 120 per run.
- The job runs 3 Rems at a time; a progress notice ("12 of 50 Rems done") is replaced by the review notice (showNotice now replaces a notice with the same id).
- Review: the same popup; `A` all ≥ 9, `Shift+A` the current Rem only, `PageDown` / `PageUp` between Rems, the header counts Rems and passages.
- **Outline-aware statements** (`src/lib/find_sources/outline.ts` + test, built from the user's notes d8BsVi, tQeV99, s5ibbX, PTj8Nz): a lead-in (ends with ":" or a dangling "…composta por") whose children are all short fragments (≤ 30 words, no heading; a fragment may be a nested lead-in with its own list) is one statement, lead-in + items, joined with the author's own punctuation ("," / "e" run on, else ";"). Every command uses it: `fsq` / `cks` on a list item judge its whole group. A source passage whose `covers` falls inside exactly one item is pinned on that item (also related ones in Pins only), else on the lead-in; quotes and Check Rems go under the lead-in. Headings and media captions (a Rem whose children are all text-less media) are not statements. Provider test: the 6-factor Gross UKC list → PIANC p. 35 (whole list, lead-in) and p. 43 (Net UKC, onto that item).
- Open: `getDescendants` shares `getChildrenRem`'s lazy-graph gap (findings/PLUGIN_BRIDGE_AND_SDK.md); a summary document is normally open, so its rows are loaded, but a closed one could come back short.

## Risks and open questions

- **Paginations differ:** the index's page is a hint. `/locate` searches ±2 pages, then the whole document.
- **Chunk boundaries:** a passage that runs across two chunks comes back as two quotes. Acceptable: each gets its own pin.
- **Cost and time:** about 15 s and one Gemini embedding + rerank call per Rem, plus one Claude call per Check Statement. Phase 4 over a 50-Rem summary is about 6 min with 2 in flight; the notice keeps that out of the way.
- **Reranker substrings may drift:** spacing, quotes, ligatures. Validate after normalisation, and fall back to the anchor sentence rather than dropping the passage.
- **`covers` confidence:** inline placement needs the reranker's `cobre` to be reliable. Measure on real summaries before turning inline on by default; the end is always safe.
- **The Rem's own language vs the quote's:** quotes stay in the source's language; headers and the Check text follow the Rem's language (the stopword heuristic from Read aloud).
