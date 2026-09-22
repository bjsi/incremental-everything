/**
 * Test-only stand-in for `@remnote/plugin-sdk` (see `sdk_test_env.ts`).
 *
 * Mirrors the runtime values the pure lib modules actually read from the SDK.
 * Keep in step with `QueueInteractionScore` in the SDK's `interfaces.d.ts`;
 * `npm run check-types` still checks the real enum, because the resolver hook
 * below only affects `require` at test time, never the compiler.
 */
export enum QueueInteractionScore {
    TOO_EARLY = 0.01,
    AGAIN = 0,
    HARD = 0.5,
    GOOD = 1,
    EASY = 1.5,
    VIEWED_AS_LEECH = 2,
    RESET = 3,
    MANUAL_DATE = 4,
    MANUAL_EASE = 5,
}
