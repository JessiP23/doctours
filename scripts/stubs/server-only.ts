/**
 * `server-only` exists to blow up if a module is pulled into a client bundle.
 * Scripts under `scripts/` are already server-side — they run under tsx with the
 * service-role key — so the marker has nothing to protect there, and its throw
 * only stops us from reusing `lib/db/repo` and `lib/agent/*` from the CLI.
 * `tsconfig.scripts.json` maps the package to this empty module for that runtime
 * only; the app and the tests still resolve the real one.
 */
export {};
