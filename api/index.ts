// Vercel serverless entry point for every `/api/*` route.
//
// It exports the SAME Express app built by createApiApp() that the dev/Cloud
// Run server (../server.ts) uses — so there is a single source of truth for the
// backend. `vercel.json` rewrites `/api/(.*)` to this function, and Express
// matches the original `/api/...` paths on the incoming request.
//
// No listen() here: Vercel invokes the exported handler per request. The
// frontend (dist/) is served by Vercel's static CDN, not by this function.

import { createApiApp } from "../server/app.js";

const app = createApiApp();

export default app;
