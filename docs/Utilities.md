# Utilities

Commands and powerups that support the incremental workflow without being part of the queue itself — reshaping text and outlines, finding Rems and sources, controlling what the queue displays, and clearing out Rems an import left behind.

## [Text & Lists](Utilities-Text-and-Lists.md)

Reshape the text inside a Rem — most useful right after a PDF highlight lands as one flattened block.

- [Text Case Converter](Utilities-Text-and-Lists.md#text-case-converter)
- [Bulletize Inline Selected Text](Utilities-Text-and-Lists.md#bulletize-inline-selected-text)
- [Inlinize & Break Lists (from PDF Highlights)](Utilities-Text-and-Lists.md#inlinize-break-lists-from-pdf-highlights)

## [Outline & Headings](Utilities-Outline-and-Headings.md)

Restructure or re-level a subtree by its H1–H6 headings.

- [Restructure Outline by Headings](Utilities-Outline-and-Headings.md#restructure-outline-by-headings)
- [Set Next Heading Level](Utilities-Outline-and-Headings.md#set-next-heading-level)
- [Apply Heading Levels by Hierarchy (Table of Contents)](Utilities-Outline-and-Headings.md#apply-heading-levels-by-hierarchy-table-of-contents)

## [Finding & Navigating](Utilities-Finding-and-Navigating.md)

Reach a Rem, a source or a figure that RemNote’s own search will not surface.

- [Find Rem — Reference or Open](Utilities-Finding-and-Navigating.md#find-rem-reference-or-open)
- [Open Source in Popup](Utilities-Finding-and-Navigating.md#open-source-in-popup)
- [Filter a Document by Images](Utilities-Finding-and-Navigating.md#filter-a-document-by-images)

## [Queue Display](Utilities-Queue-Display.md)

Control how parents, ancestors and card details show during queue review.

- [Activation](Utilities-Queue-Display.md#activation)
- [Hide in Queue (`hiq`)](Utilities-Queue-Display.md#hide-in-queue)
- [Remove from Queue (`rfq`)](Utilities-Queue-Display.md#remove-from-queue-rfq)
- [No Hierarchy (`nh`)](Utilities-Queue-Display.md#no-hierarchy-nh)
- [Hide Parent (`hp`)](Utilities-Queue-Display.md#hide-parent-hp)
- [Hide Grandparent (`hgp`)](Utilities-Queue-Display.md#hide-grandparent-hgp)
- [Remove Parent (`rp`) — New](Utilities-Queue-Display.md#remove-parent-rp-new)
- [Remove Grandparent (`rgp`) — New](Utilities-Queue-Display.md#remove-grandparent-rgp-new)
- [Hide Front Extras (`hfe`) — New](Utilities-Queue-Display.md#hide-front-extras)
- [Queue Support](Utilities-Queue-Display.md#queue-support)

## [Cleaning Up](Utilities-Cleaning-Up.md)

Clear out Rems an import left behind, and audit disabled cards.

- [Delete Empty Extra Card Detail Rems](Utilities-Cleaning-Up.md#delete-empty-extra-card-detail-rems)
- [Card Enablement Audit](Utilities-Cleaning-Up.md#card-enablement-audit)

## [Under the Hood](Utilities-Under-the-Hood.md)

Infrastructure several commands depend on.

- [Omnibar Selection Recovery](Utilities-Under-the-Hood.md#omnibar-selection-recovery)

<script>
// Old links pointed at sections of this page (…/Utilities/#hide-in-queue); each
// category is now a page of its own, so forward the anchor there.
(function () {
  var pages = {"text-lists":"Utilities-Text-and-Lists","text-case-converter":"Utilities-Text-and-Lists","how-it-works":"Utilities-Text-and-Lists","english-title-case-rules":"Utilities-Text-and-Lists","examples":"Utilities-Text-and-Lists","acronyms-and-initialisms":"Utilities-Text-and-Lists","examples_1":"Utilities-Text-and-Lists","when-a-roman-numeral-counts-as-a-numeral":"Utilities-Text-and-Lists","other-features":"Utilities-Text-and-Lists","bulletize-inline-selected-text":"Utilities-Text-and-Lists","how-to-invoke":"Utilities-Text-and-Lists","what-it-does":"Utilities-Text-and-Lists","selection-modes":"Utilities-Text-and-Lists","example":"Utilities-Text-and-Lists","__codelineno-0-1":"Utilities-Text-and-Lists","__codelineno-0-2":"Utilities-Text-and-Lists","__codelineno-0-3":"Utilities-Text-and-Lists","__codelineno-0-4":"Utilities-Text-and-Lists","__codelineno-0-5":"Utilities-Text-and-Lists","__codelineno-0-6":"Utilities-Text-and-Lists","__codelineno-0-7":"Utilities-Text-and-Lists","__codelineno-0-8":"Utilities-Text-and-Lists","__codelineno-0-9":"Utilities-Text-and-Lists","__codelineno-0-10":"Utilities-Text-and-Lists","notes":"Utilities-Text-and-Lists","inlinize-break-lists-from-pdf-highlights":"Utilities-Text-and-Lists","__codelineno-1-1":"Utilities-Text-and-Lists","__codelineno-1-2":"Utilities-Text-and-Lists","__codelineno-1-3":"Utilities-Text-and-Lists","the-workflow":"Utilities-Text-and-Lists","inlinize-detected-list-inl":"Utilities-Text-and-Lists","__codelineno-2-1":"Utilities-Text-and-Lists","__codelineno-2-2":"Utilities-Text-and-Lists","__codelineno-2-3":"Utilities-Text-and-Lists","__codelineno-2-4":"Utilities-Text-and-Lists","__codelineno-2-5":"Utilities-Text-and-Lists","break-inline-list-into-children-brl":"Utilities-Text-and-Lists","restore-list-rem-rlr":"Utilities-Text-and-Lists","how-detection-works":"Utilities-Text-and-Lists","known-limitations":"Utilities-Text-and-Lists","outline-headings":"Utilities-Outline-and-Headings","restructure-outline-by-headings":"Utilities-Outline-and-Headings","how-to-invoke_1":"Utilities-Outline-and-Headings","preview-popup":"Utilities-Outline-and-Headings","per-rem-preserve-flatten-toggle":"Utilities-Outline-and-Headings","apply-cancel":"Utilities-Outline-and-Headings","algorithm":"Utilities-Outline-and-Headings","heading-levels-supported":"Utilities-Outline-and-Headings","undo":"Utilities-Outline-and-Headings","edge-cases":"Utilities-Outline-and-Headings","set-next-heading-level":"Utilities-Outline-and-Headings","invocation":"Utilities-Outline-and-Headings","behavior":"Utilities-Outline-and-Headings","grandparent-fallback":"Utilities-Outline-and-Headings","multi-rem-selections":"Utilities-Outline-and-Headings","notes-edge-cases":"Utilities-Outline-and-Headings","apply-heading-levels-by-hierarchy-table-of-contents":"Utilities-Outline-and-Headings","invoking-the-toc-command":"Utilities-Outline-and-Headings","depth-level-mapping":"Utilities-Outline-and-Headings","promote-demote-shift-one-level":"Utilities-Outline-and-Headings","preview-apply":"Utilities-Outline-and-Headings","undo-heading-levels":"Utilities-Outline-and-Headings","notes-heading-levels":"Utilities-Outline-and-Headings","finding-navigating":"Utilities-Finding-and-Navigating","find-rem-reference-or-open":"Utilities-Finding-and-Navigating","how-to-invoke_2":"Utilities-Finding-and-Navigating","spotting-pdf-highlights":"Utilities-Finding-and-Navigating","spotting-figures":"Utilities-Finding-and-Navigating","why-it-finds-rems-the-normal-search-cant":"Utilities-Finding-and-Navigating","find-by-alias":"Utilities-Finding-and-Navigating","recommended-use-cases":"Utilities-Finding-and-Navigating","insert-as-a-pin":"Utilities-Finding-and-Navigating","insert-text-with-a-pin":"Utilities-Finding-and-Navigating","pin-a-source-at-the-end-of-a-rem":"Utilities-Finding-and-Navigating","cloze-aware-insertion":"Utilities-Finding-and-Navigating","accent-insensitive-selection-aware":"Utilities-Finding-and-Navigating","stays-on-screen-near-the-edges":"Utilities-Finding-and-Navigating","open-source-in-popup":"Utilities-Finding-and-Navigating","two-ways-to-open-it":"Utilities-Finding-and-Navigating","how-to-invoke_3":"Utilities-Finding-and-Navigating","what-it-opens":"Utilities-Finding-and-Navigating","scroll-to-highlight":"Utilities-Finding-and-Navigating","floating-window-interaction-closing":"Utilities-Finding-and-Navigating","recommended-use-cases_1":"Utilities-Finding-and-Navigating","filter-a-document-by-images":"Utilities-Finding-and-Navigating","how-to-use-it":"Utilities-Finding-and-Navigating","seeing-the-result":"Utilities-Finding-and-Navigating","what-counts-as-an-image":"Utilities-Finding-and-Navigating","re-running-it":"Utilities-Finding-and-Navigating","how-long-it-takes-the-first-whole-kb-run-is-slow":"Utilities-Finding-and-Navigating","clearing-the-tag":"Utilities-Finding-and-Navigating","the-tag-is-invisible-in-the-outline":"Utilities-Finding-and-Navigating","pins-that-lead-to-an-image-are-ringed":"Utilities-Finding-and-Navigating","queue-display-utilities":"Utilities-Queue-Display","activation":"Utilities-Queue-Display","hide-in-queue":"Utilities-Queue-Display","create-extract-source-rem-hiding-behavior":"Utilities-Queue-Display","remove-from-queue-rfq":"Utilities-Queue-Display","hide-in-queue-vs-remove-from-queue":"Utilities-Queue-Display","no-hierarchy-nh":"Utilities-Queue-Display","hide-parent-hp":"Utilities-Queue-Display","hide-grandparent-hgp":"Utilities-Queue-Display","remove-parent-rp-new":"Utilities-Queue-Display","remove-grandparent-rgp-new":"Utilities-Queue-Display","hide-front-extras":"Utilities-Queue-Display","where-front-extras-come-from":"Utilities-Queue-Display","the-problem-it-solves":"Utilities-Queue-Display","applying-it":"Utilities-Queue-Display","result":"Utilities-Queue-Display","queue-support":"Utilities-Queue-Display","cleaning-up":"Utilities-Cleaning-Up","delete-empty-extra-card-detail-rems":"Utilities-Cleaning-Up","why-they-exist":"Utilities-Cleaning-Up","why-the-normal-search-cannot-find-them":"Utilities-Cleaning-Up","how-to-use-it_1":"Utilities-Cleaning-Up","what-counts-as-empty":"Utilities-Cleaning-Up","confirming-before-the-delete":"Utilities-Cleaning-Up","if-you-need-something-back":"Utilities-Cleaning-Up","how-long-it-takes":"Utilities-Cleaning-Up","card-enablement-audit":"Utilities-Cleaning-Up","the-problem-it-solves_1":"Utilities-Cleaning-Up","choosing-what-to-audit":"Utilities-Cleaning-Up","reading-the-results":"Utilities-Cleaning-Up","fixing-them":"Utilities-Cleaning-Up","undoing":"Utilities-Cleaning-Up","under-the-hood":"Utilities-Under-the-Hood","omnibar-selection-recovery":"Utilities-Under-the-Hood"};
  var whole = ["cleaning-up", "finding-navigating", "outline-headings", "queue-display-utilities", "text-lists", "under-the-hood"];
  // Double-dash slugs from the old GitHub Wiki, still in published READMEs.
  var aliases = {"find-rem--reference-or-open":"find-rem-reference-or-open"};
  var anchor = decodeURIComponent(location.hash.slice(1));
  anchor = aliases[anchor] || anchor;
  if (!anchor || !pages[anchor]) return;
  var hash = whole.indexOf(anchor) >= 0 ? '' : '#' + anchor;
  location.replace(new URL('../' + pages[anchor] + '/' + hash, location.href).href);
})();
</script>
