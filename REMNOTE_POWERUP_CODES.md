# RemNote built-in powerups vs the Plugin SDK

RemNote's own table of built-in powerup codes and slot codes, compared with what the Plugin SDK declares.

- **RemNote:** desktop app **1.28.19**, read from `app.asar` — the powerup-code enum (the one containing `CardCluster="cc"`) and the slot-code map that follows it.
- **SDK:** `@remnote/plugin-sdk` **0.0.46** — `BuiltInPowerupCodes` in `dist/interfaces.d.ts` (lines 185–232), and the slot codes of `PowerupSlotCodeMap` from `dist/index.js` (the `.d.ts` types the slots as plain `string`).
- Extracted 2026-09-16. Extract again after a RemNote or SDK update rather than trusting this page.

## Summary

- RemNote declares **83** built-in powerups; the SDK declares **46**.
- **37** are missing from the SDK (❌). A plugin can still pass the code string to `hasPowerup`, `getPowerupProperty` or `setPowerupProperty`; it only lacks a named constant and slot codes.
- **6** are in both but disagree (⚠️): a different code or name, or slots that one side lacks or codes differently.
- **40** match exactly (✅).
- SDK entries RemNote no longer declares: **none**.

> **Card Cluster is `cc`**, missing from the SDK. Incremental RemNote guessed other codes plus a tag name, and stopped recognising clusters once RemNote moved them from a tag to the `cc` powerup (July 2026). `src/lib/priority_review_document/cluster.ts` now tries `cc` first.

Legend: ✅ same in both · ⚠️ in both, but disagreeing · ❌ not in the SDK

## Full table

| | Powerup (RemNote name) | Code | Slots in RemNote (name `code`) | Difference from the SDK |
|---|---|---|---|---|
| ✅ | Aliases | `l` | Aliases `a` |  |
| ❌ | AIGeneratedFlashcardSection | `aigfs` | — | not in the SDK |
| ❌ | AIGeneratedNotesSection | `aigns` | — | not in the SDK |
| ❌ | Notification | `v` | TargetId `t`, UserId `i` | not in the SDK |
| ❌ | Lecture | `lecture` | Date `d`, HasLearned `hl`, NoPDFs `np`, DoneSteps `ds` | not in the SDK |
| ❌ | Exam | `exam` | — | not in the SDK |
| ✅ | AutoSort | `a` | SortDirection `d` |  |
| ❌ | Class | `class` | ClassInformation `ci` | not in the SDK |
| ❌ | Columns | `cl` | — | not in the SDK |
| ❌ | SingleColumn | `sc` | Width `w` | not in the SDK |
| ✅ | AppliedTemplates | `at` | Templates `t` |  |
| ✅ | AutoTemplate | `m` | — |  |
| ✅ | CustomCSS | `c` | — |  |
| ✅ | DailyDocument | `d` | Timestamp `s`, Date `d` |  |
| ❌ | HandwrittenDocument | `dp` | State `s`, Pages `np`, InfiniteCanvas `ic`, LastZoomWorkspacePoint `z`, Theme `t`, EnableLearnThisUI `lt` | not in the SDK |
| ❌ | DrawingItems | `dr` | — | not in the SDK |
| ❌ | LearnPDFContent | `lpc` | — | not in the SDK |
| ✅ | DisableCards | `u` | — |  |
| ✅ | Divider | `dv` | — |  |
| ⚠️ | Document | `o` | Status `s`, IsFolder `f`, DeprecatedSource `o`, FolderClassId `fcid`, FolderClassName `fcn`, EnableLearnWithAITutorUI `at` | slots not in the SDK: IsFolder `f`, FolderClassId `fcid`, FolderClassName `fcn`, EnableLearnWithAITutorUI `at` |
| ✅ | DocumentSidebar | `s` | — |  |
| ✅ | EditLater | `e` | Message `m` |  |
| ✅ | Emoji | `j` | — |  |
| ✅ | ExtraCardDetail | `x` | — |  |
| ❌ | FloatingDiscussion | `fd` | — | not in the SDK |
| ✅ | Header | `r` | Size `s` |  |
| ✅ | Highlight | `h` | Color `c` |  |
| ❌ | InProgress | `ip` | — | not in the SDK |
| ⚠️ | Link | `b` | URL `u`, ShouldOpenInTextReader `s`, Title `t`, ReadPercent `r`, LastReadDate `d`, FileURL `f`, HasAIComputedTitle `ait`, Theme `h`, FontFamily `ff`, FontSize `fs`, LineHeight `lh` | slots not in the SDK: ShouldOpenInTextReader `s`, HasAIComputedTitle `ait`, Theme `h`, FontFamily `ff`, FontSize `fs`, LineHeight `lh` |
| ✅ | List | `i` | — |  |
| ✅ | MultipleChoice | `mc` | — |  |
| ✅ | MultiLineCard | `w` | — |  |
| ✅ | PDFPageNumber | `pn` | — |  |
| ✅ | PDFHighlight | `n` | Data `d`, PdfId `p` |  |
| ❌ | PDFHighlightSection | `phs` | — | not in the SDK |
| ✅ | QuickAdd | `q` | — |  |
| ❌ | Quiz | `qz` | — | not in the SDK |
| ✅ | Quote | `qt` | — |  |
| ✅ | RestoredFromTrash | `rt` | Date `d` |  |
| ❌ | SavedSharedArticleStudy | `ssa` | ArticleId `i`, ArticleTitle `t` | not in the SDK |
| ❌ | SavedSharedLearningOutline | `sslo` | OutlineId `i`, OutlineTitle `t` | not in the SDK |
| ❌ | SavedStudyDeck | `ssd` | StudyDeckId `i`, StudyDeckTitle `t` | not in the SDK |
| ✅ | Slot | `y` | SelectTag `t`, ExtraSlotsOnFrontOfCard `f`, ExtraSlotsOnBackOfCard `b` |  |
| ✅ | Sources | `os` | Sources `os` |  |
| ✅ | SuperPrivate | `k` | — |  |
| ✅ | TableOfContent | `toc` | — |  |
| ✅ | TextToSpeech | `tts` | — |  |
| ✅ | EmbedWebsite | `ew` | URL `u`, WIDTH `w`, HEIGHT `h` |  |
| ⚠️ | UsedAsTag | `g` | AutoActivate `a`, Pinned `p`, CollapseConfigure `c`, PrimaryColumnName `n`, IsSimpleTableTag `gt` | slots not in the SDK: IsSimpleTableTag `gt` |
| ❌ | User | `us` | UserId `i`, Notifications `n` | not in the SDK |
| ✅ | Todo | `t` | Status `s` |  |
| ⚠️ | UploadedFile | `f` | Type `t`, URL `u`, Name `n`, Authors `a`, Keywords `k`, Title `i`, ViewerData `v`, ReadPercent `r`, LastReadDate `d`, OCRRequestStatus `ocrs`, DidOCR `do`, HasNoTextLayer `tl`, URLBeforeOCR `ou`, Theme `h`, HasAIComputedTitle `ait`, TitleGenerationState `tgs`, DisableKeyPoints `dkp`, OfflinePath `op`, ViewInHTMLMode `vhm`, ExpandedMargin `em`, LinkedAudioRecordingId `lar` | slots not in the SDK: OCRRequestStatus `ocrs`, DidOCR `do`, URLBeforeOCR `ou`, HasAIComputedTitle `ait`, TitleGenerationState `tgs`, DisableKeyPoints `dkp`, OfflinePath `op`, ViewInHTMLMode `vhm`, ExpandedMargin `em`, LinkedAudioRecordingId `lar` |
| ✅ | WebHighlight | `p` | Data `d`, Url `w` |  |
| ✅ | Website | `z` | Hostname `u` |  |
| ✅ | Code | `cd` | Language `l`, DontWrap `w`, DontBoundHeight `b` |  |
| ✅ | TypeInAnswer | `ty` | — |  |
| ⚠️ | Deck | `de` | Topics `t`, Status `s`, ExamSchedulerDate `e`, RetrievabilityPeriodStartDate `r`, ExamConfig `ec`, ExamSchedulerCollection `emcd` | slots only in the SDK: MaxNewCardsPerDay `m`, MaxTotalCardsPerDay `c`, ConsolidationPeriodStartDate `pmd`, ConsolidationPeriodReIntroSectionLength `pml`, SavedExamInfo `ei`, ExamSchedulerDesiredStability `eds`, ExamSchedulerMaxNewCardsPerDay `emnc`, ExamSchedulerMaxTotalCardsPerDay `emtc` |
| ❌ | Discussion | `di` | — | not in the SDK |
| ⚠️ | SearchPortal | `sp` | Query `q`, Filter `f`, AutomaticBacklinkSearchPortalFor `b`, DontIncludeNestedDescendants `s`, HiddenColumns `h` | slots not in the SDK: HiddenColumns `h` |
| ✅ | Collection | `ct` | Template `t` |  |
| ✅ | HTMLHighlight | `hh` | Data `d`, HTMLId `h` |  |
| ❌ | AudioHighlight | `ah` | Data `d`, AudioId `a` | not in the SDK |
| ✅ | HideQueueAncestors | `ha` | — |  |
| ✅ | ImportedDocument | `id` | — |  |
| ✅ | Image | `im` | Image `i` |  |
| ✅ | SavedDocuments | `sd` | — |  |
| ✅ | Callout | `clo` | BulletIcon `b` |  |
| ❌ | Video | `vi` | URL `u`, TranscriptURL `tu`, Name `n`, Title `t` | not in the SDK |
| ❌ | VideoHighlight | `vh` | Data `d`, RemVideoId `p` | not in the SDK |
| ❌ | CardCluster | `cc` | — | not in the SDK |
| ❌ | Comment | `co` | UserId `i` | not in the SDK |
| ❌ | MCAT | `mcat` | — | not in the SDK |
| ❌ | MCAT1 | `mcat1` | — | not in the SDK |
| ❌ | MCAT2 | `mcat2` | — | not in the SDK |
| ❌ | MCAT3 | `mcat3` | — | not in the SDK |
| ❌ | SavedPrompts | `asp` | — | not in the SDK |
| ❌ | QueueEditStatus | `qe` | Dismissed `d` | not in the SDK |
| ❌ | AudioRecording | `au` | AudioFileNames `a`, AudioFileStartTimes `ast`, HasAIComputedTitle `ait`, HasTranscript `ht`, TranscriptionLanguageCode `tlc`, Theme `h`, FontFamily `ff`, FontSize `fs`, LineHeight `lh`, PDFPageAlignment `pdfpa` | not in the SDK |
| ❌ | QuizExplanation | `qx` | — | not in the SDK |
| ❌ | AIPracticeExam | `aipx` | LatestPracticeExamId `eid` | not in the SDK |
| ❌ | AIGeneratedSource | `aigsrc` | — | not in the SDK |
| ❌ | Template | `te` | — | not in the SDK |
| ❌ | TagTemplate | `tt` | — | not in the SDK |

## Missing from the SDK

| Powerup | Code | Slots (name `code`) |
|---|---|---|
| AIGeneratedFlashcardSection | `aigfs` | — |
| AIGeneratedNotesSection | `aigns` | — |
| Notification | `v` | TargetId `t`, UserId `i` |
| Lecture | `lecture` | Date `d`, HasLearned `hl`, NoPDFs `np`, DoneSteps `ds` |
| Exam | `exam` | — |
| Class | `class` | ClassInformation `ci` |
| Columns | `cl` | — |
| SingleColumn | `sc` | Width `w` |
| HandwrittenDocument | `dp` | State `s`, Pages `np`, InfiniteCanvas `ic`, LastZoomWorkspacePoint `z`, Theme `t`, EnableLearnThisUI `lt` |
| DrawingItems | `dr` | — |
| LearnPDFContent | `lpc` | — |
| FloatingDiscussion | `fd` | — |
| InProgress | `ip` | — |
| PDFHighlightSection | `phs` | — |
| Quiz | `qz` | — |
| SavedSharedArticleStudy | `ssa` | ArticleId `i`, ArticleTitle `t` |
| SavedSharedLearningOutline | `sslo` | OutlineId `i`, OutlineTitle `t` |
| SavedStudyDeck | `ssd` | StudyDeckId `i`, StudyDeckTitle `t` |
| User | `us` | UserId `i`, Notifications `n` |
| Discussion | `di` | — |
| AudioHighlight | `ah` | Data `d`, AudioId `a` |
| Video | `vi` | URL `u`, TranscriptURL `tu`, Name `n`, Title `t` |
| VideoHighlight | `vh` | Data `d`, RemVideoId `p` |
| CardCluster | `cc` | — |
| Comment | `co` | UserId `i` |
| MCAT | `mcat` | — |
| MCAT1 | `mcat1` | — |
| MCAT2 | `mcat2` | — |
| MCAT3 | `mcat3` | — |
| SavedPrompts | `asp` | — |
| QueueEditStatus | `qe` | Dismissed `d` |
| AudioRecording | `au` | AudioFileNames `a`, AudioFileStartTimes `ast`, HasAIComputedTitle `ait`, HasTranscript `ht`, TranscriptionLanguageCode `tlc`, Theme `h`, FontFamily `ff`, FontSize `fs`, LineHeight `lh`, PDFPageAlignment `pdfpa` |
| QuizExplanation | `qx` | — |
| AIPracticeExam | `aipx` | LatestPracticeExamId `eid` |
| AIGeneratedSource | `aigsrc` | — |
| Template | `te` | — |
| TagTemplate | `tt` | — |

## In both, but disagreeing

| Powerup | Code | Difference |
|---|---|---|
| Document | `o` | slots not in the SDK: IsFolder `f`, FolderClassId `fcid`, FolderClassName `fcn`, EnableLearnWithAITutorUI `at` |
| Link | `b` | slots not in the SDK: ShouldOpenInTextReader `s`, HasAIComputedTitle `ait`, Theme `h`, FontFamily `ff`, FontSize `fs`, LineHeight `lh` |
| UsedAsTag | `g` | slots not in the SDK: IsSimpleTableTag `gt` |
| UploadedFile | `f` | slots not in the SDK: OCRRequestStatus `ocrs`, DidOCR `do`, URLBeforeOCR `ou`, HasAIComputedTitle `ait`, TitleGenerationState `tgs`, DisableKeyPoints `dkp`, OfflinePath `op`, ViewInHTMLMode `vhm`, ExpandedMargin `em`, LinkedAudioRecordingId `lar` |
| Deck | `de` | slots only in the SDK: MaxNewCardsPerDay `m`, MaxTotalCardsPerDay `c`, ConsolidationPeriodStartDate `pmd`, ConsolidationPeriodReIntroSectionLength `pml`, SavedExamInfo `ei`, ExamSchedulerDesiredStability `eds`, ExamSchedulerMaxNewCardsPerDay `emnc`, ExamSchedulerMaxTotalCardsPerDay `emtc` |
| SearchPortal | `sp` | slots not in the SDK: HiddenColumns `h` |
