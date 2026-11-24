# Card Cluster: Extra Details show the wrong member's Extra Card Detail

**Reporter:** Hugo Marins, *Incremental RemNote* plugin (`incremental-everything`)
**Affected:** RemNote desktop for macOS 1.30.5-beta (the bundle in `app.asar`; no newer build in `build_overrides`). It has happened for a long time ("frequently"), so it is not new in this build.
**Queue mode:** Beautiful queue (screenshot). The code path below is shared with the Compact queue.
**Date:** 2026-11-24

---

## Summary

In a Card Cluster, the **Extra details** block under the answer often shows the Extra Card Detail (ECD) of a different member of the same cluster, not the ECD of the card being tested.

It shows the ECD of the member whose card the queue **loaded** (the one that entered the queue). The cluster renderer then tests the cluster's due members in cluster order, starting with the first due one. Whenever those two differ, the Extra details are wrong. They also stay the same while the cluster moves on to the next members, so in a cluster with several due members, at most one of them shows its own ECD.

## Example (screenshot attached)

A cluster "Classifique: Unrestricted · Restricted Channel · Canal" with one member per option, each with its own ECD child.

- The queue tests the member `ggIhglpfwEHmjc336` ("Restricted Channel" is highlighted as the answer).
- The Extra details show "Unrestricted channels ('U') are in relatively larger bodies of water…". That is the ECD of the sibling `j1AELPKxBqenQlLNh` ("Unrestricted"), not of `ggIhglpfwEHmjc336`.

## Steps to reproduce

1. Create a Rem with the Card Cluster powerup and three children with flashcards, A, B and C, in that order.
2. Give each child its own Extra Card Detail child: "ECD of A", "ECD of B", "ECD of C".
3. Make A and B due, or all three, and practise the parent document until the queue picks B's card first (the order is random, so it may take a few tries).
4. Reveal the answer.

**Expected:** the cluster opens on A and the Extra details show "ECD of A". After rating, B shows "ECD of B".
**Actual:** the cluster opens on A, but the Extra details show "ECD of B", the member the queue loaded. After rating A, B is tested and the Extra details still show "ECD of B". If C was the loaded card, A and B both show "ECD of C".

## Cause (from reading the 1.30.5-beta client bundle)

- `SpacedRepetitionCardCluster` overrides `currentRem()` and `remForCurrentActionItem()` so they follow `state.currentCompoundCardIdToTest`. `getCurrentActionItemOverride` does the same for the card.
- `initialize()` sets `currentCompoundCardIdToTest` to the first due member in cluster order (`i.find(...) ?? i[0]`), not to `this.props.quantum`.
- The base card class renders the Extra details with the **queue item's Rem**, not the cluster's current one:

  ```js
  t && this.shouldShowExtraCardDetail() ? <>
    <PluginWidgetSlot location={FlashcardExtraDetail}
        getWidgetContext={() => ({ remId: this.props.quantum?._id, cardId: this.getCurrentActionItem().cardId, revealed: !!t })}
        remContextToFilterPowerups={this.props.quantum} />
    <ExtraCardDetail rem={this.props.quantum} currentCard={this.getCurrentActionItem()} … />
  </> : null
  ```

  `SpacedRepetitionCardCluster` doesn't override this part, so `this.props.quantum` (the loaded member) decides which ECD is shown for every member of the cluster.

## Suggested fix

In the base card class, pass the Rem that is actually on screen:

- `ExtraCardDetail`: `rem={this.remForCurrentActionItem()}` (or `this.currentRem()`) instead of `this.props.quantum`. Outside clusters both return `this.props.quantum`, so ordinary cards don't change. The component's reactive query is keyed on the Rem id, so it refreshes when the cluster moves to the next member.
- The `FlashcardExtraDetail` plugin widget slot has the same problem. Its context `remId` and its `remContextToFilterPowerups` are both `this.props.quantum`, so plugin widgets at that location also show the loaded member's data on cluster cards, while the context's `cardId` correctly names the member being tested. Using the same current Rem there would make `remId` and `cardId` agree.

## What we checked

- The ECD is a direct child of each member, with the Extra Card Detail powerup, which is the usual placement. RemNote's ECD lookup only reads the children of the Rem it is given (and Rems included through portal children), so there is no other place to put a member's ECD that would show for that member.
- Inside a cluster, the plugin's widget context gives `cardId` = the card being tested and `remId` = the loaded member. That matches the code above.
