// Vercel serverless entry point for every `/api/*` route.
//
// Deliberately plain JavaScript with a single import: the real Express app is
// bundled ahead of time by esbuild into ../server-build/api.mjs (built from
// server/vercelEntry.ts -> server/app.ts). Vercel therefore has no TypeScript
// to compile and no cross-directory module graph to resolve here — the
// previous api/index.ts importing ../server/app failed with
// ERR_MODULE_NOT_FOUND at runtime because Vercel never emitted server/app.js.
//
// `vercel.json` rewrites /api/(.*) to this function; Express matches the
// original /api/... paths. The frontend (dist/) is served by Vercel's CDN.

export { default } from "../server-build/api.mjs";
