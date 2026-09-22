/**
 * Test-only shim. Import it FIRST in any `*.test.ts` whose module under test
 * reaches `@remnote/plugin-sdk`.
 *
 * The SDK ships a UMD bundle that touches `self` at load time and then wires
 * itself to a browser host, so requiring it under node either throws
 * `ReferenceError: self is not defined` or hangs the event loop — neither of
 * which a pure-maths test should have to care about. Rather than shim a browser,
 * this swaps the module out: `require('@remnote/plugin-sdk')` resolves to
 * `sdk_test_stub`, which carries the handful of runtime values the lib modules
 * read.
 *
 * Only `require` is affected. `npm run check-types` still type-checks against
 * the real SDK, so the stub cannot silently drift out of shape.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require('module') as {
    _resolveFilename: (request: string, ...rest: unknown[]) => string;
};

const originalResolve = Module._resolveFilename;

Module._resolveFilename = function (request: string, ...rest: unknown[]): string {
    if (request === '@remnote/plugin-sdk') {
        return originalResolve.call(this, require.resolve('./sdk_test_stub'), ...rest);
    }
    return originalResolve.call(this, request, ...rest);
};

export {};
