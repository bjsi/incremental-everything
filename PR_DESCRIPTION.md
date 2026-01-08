### Priority Widget Performance & UX Improvements

*   **Fixed Open Lag**: Changed default initialization to 'Light Mode' and implemented logic to totally skip expensive card checks (Tier 2/3) when in Light Mode.
*   **Optimistic UI Loading**: The Inheritance interface now renders immediately in Full Mode without blocking on descendant card calculations.
*   **Future Priority Support**: Enabled setting priority for descendant cards even if count is 0 (supports future cards), removing the "neither Incremental nor has flashcards" fallback state.
*   **Code Refactoring**: Simplified visibility logic for `showInheritanceSection` and `showAddCardPriorityButton` to remove redundant checks.
