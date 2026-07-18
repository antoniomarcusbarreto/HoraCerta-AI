// Bundle source for the Vercel serverless function.
//
// esbuild bundles this file (see the `build` script) into a single
// self-contained `server-build/api.mjs`, which `api/index.js` re-exports.
// Everything the API needs is inlined there, so the deployed function has NO
// relative imports left to resolve at runtime.
//
// Why: Vercel's own TypeScript handling does not compile/emit the modules this
// app imports from outside `api/` (server/, src/), so `api/index.ts` importing
// `../server/app` crashed every route with ERR_MODULE_NOT_FOUND. Bundling ahead
// of time removes that dependency entirely.

import { createApiApp } from "./app.js";

export default createApiApp();
