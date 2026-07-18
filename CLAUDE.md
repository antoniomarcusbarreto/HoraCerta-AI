# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Language

Always respond to the user in Brazilian Portuguese (português do Brasil).

## Commands

- `npm install` — install dependencies
- `npm run dev` — start the app (`tsx server.ts`: `createApiApp()` + Vite middleware) on `http://localhost:3000`
- `npm run lint` — type-check only (`tsc --noEmit`); there is no separate linter configured
- `npm run build` — Vite build of the frontend + esbuild bundle of `server.ts` into `dist/server.cjs`
- `npm run start` — run the production build (`node dist/server.cjs`)
- `npm run clean` — remove `dist/` and `server.js`

There is no test suite/framework in this repo (`security_spec.md` contains a *placeholder* Firestore rules test schema only — it is not wired to a runner).

Requires `GEMINI_API_KEY` in `.env.local` for the AI prescription/receipt scanning endpoints to work (see `.env.example`); the Gemini client in `server.ts` initializes lazily so the server still boots without it.

## Architecture

This is a Google AI Studio applet (see `metadata.json`, `firebase-applet-config.json`, `firebase-blueprint.json`). The backend API lives in **`server/app.ts`**, whose `createApiApp()` builds an Express app with every `/api/*` route (no `listen()`, no frontend serving). Two thin entry points reuse that same app:
- **`server.ts`** (dev / Cloud Run, `tsx server.ts` / `npm start`): calls `createApiApp()`, then adds Vite dev middleware (or static `dist/` in prod), binds `0.0.0.0:$PORT`, and runs the in-process push scheduler (`setInterval`).
- **`api/index.js`** (Vercel serverless): a plain-JS one-liner re-exporting `server-build/api.mjs`, which `npm run build:api` produces by esbuild-bundling `server/vercelEntry.ts` (→ `createApiApp()`). `vercel.json` rewrites `/api/(.*)` to it; the frontend is served by Vercel's static CDN from `dist/`. **Do not turn this back into a TypeScript file importing `../server/app`** — Vercel does not emit compiled JS for modules outside `api/`, so that form crashes every route at runtime with `ERR_MODULE_NOT_FOUND`. The pre-built bundle leaves no relative import to resolve.

Deployment target is **Vercel (serverless)**. Consequences to keep in mind: no long-running process, so the push scheduler is driven by **Vercel Cron** hitting `/api/push/dispatch` (see `crons` in `vercel.json`, guarded by `CRON_SECRET`); Firebase Admin is initialized from the **`FIREBASE_SERVICE_ACCOUNT`** env JSON (no ADC on Vercel — see `getAdminApp()` in `server/app.ts`); and the push dedupe is persisted in Firestore (`pushDispatches` subcollection) rather than an in-memory Map. In-memory `express-rate-limit` is best-effort only across serverless invocations.

### Two Vite entry points: landing page vs. app

Vite is configured with two HTML entry points (`vite.config.ts`): root `index.html` (a self-contained static marketing landing page — inline `<style>`, no React, no build-time data) and `app/index.html` (mounts `src/main.tsx`, the real React app). `server.ts` routes `/app` and `/app/*` to `app/index.html` and everything else (including `/`) to the root `index.html`, both in the Vite dev middleware branch and the production `express.static` branch — keep both branches in sync if you change routing. `vercel.json` mirrors the same `/app` rewrite for the Vercel deployment target. When asked to change "the landing page," edit root `index.html`, not anything under `src/`.

**No router, no global state library.** `src/App.tsx` is a single ~1500-line component holding all top-level state (active user, all seven data collections, active tab, PWA/notification state) and passing handlers down as props. Navigation between "screens" is a manual `activeTab` string switch plus a hand-rolled admin route detected by checking `window.location.pathname`/`hash` in a `useEffect` with `popstate`/`hashchange` listeners (`/admin` or `#/admin`) — not React Router.

### Offline-first data layer

- `src/dbLocalFallback.ts` (`dbLocal`) is the **source of truth for rendering**: every collection is read from/written to `localStorage` (keys prefixed `horacerta_`) synchronously, seeded with `SEED_*` fixtures (demo users `user_antonio`/`user_maria`/`user_joao`) the first time a key is missing.
- `src/firebase.ts` (`dbFirebase`) wraps Firestore CRUD. Every `dbLocal.add*`/`update*`/`delete*` method fire-and-forgets a matching `dbFirebase` call to push the change to Firestore (errors are only `console.warn`'d, never surfaced to the UI).
- `dbLocal.syncFromFirebase(userId)` pulls the full Firestore tree for a user back down into `localStorage` — called on login (`AuthScreen.tsx`) and again from `App.tsx`'s effect when `activeUser` changes, so the UI renders instantly from cache then silently reconciles with the cloud.
- Firestore layout: `users/{userId}/medicados/{medicadoId}/receitas|medicamentos/{id}/doseLogs/{id}`, plus flat `users/{userId}/consultas`, `farmacias`, `cupons`. Types for all entities live in `src/types.ts`.
- Deleting a `Receita` must cascade to its `Medicamento`s and their `DoseLog`s — see `dbLocalFallback.ts`'s `deleteReceita` for the pattern to replicate if adding similar cascades.

### Auth

`AuthScreen.tsx` handles both login and registration against Firebase Auth. On login, if `signInWithEmailAndPassword` fails, it falls back to checking the local `SEED_USERS` fixtures; if a match is found, it transparently calls `createUserWithEmailAndPassword` to register that seed account in Firebase Auth for the first time and migrates the profile's `userId` to the new Firebase UID (auto-migration flow — see `security_spec.md` §4 business rule). Registration requires password ≥6 chars with at least one letter and one number.

There's a fully separate admin portal (not just a role-gated tab) reachable at `/admin` or `#/admin`, with its own login state (`activeAdminUser`) independent of the main `activeUser` session, rendered as an early return in `App.tsx`.

The `isAdmin()` check in `firestore.rules` and the Admin Portal login gate are driven by a Firebase Auth custom claim (`admin: true`), not a Firestore field. There is no client-side way to grant it — `server/setAdminClaim.js` is a standalone Admin SDK script an operator runs manually (`GOOGLE_APPLICATION_CREDENTIALS=./service-account.json node server/setAdminClaim.js user@example.com [--revoke]`) to set or revoke it.

### Firestore security rules

`firestore.rules` is default-deny (`match /{document=**} { allow read, write: if false; }` at the top) with per-entity `isValid*(data, ...)` functions enforcing: exact key-set allowlists (blocks "ghost field" injection), `userId`/path ownership matching `request.auth.uid`, immutable identity fields, `createdAt == request.time`, string size caps, and an `isAdmin()` check driven by the `admin: true` custom claim (plus verified email). `security_spec.md` documents the "Dirty Dozen" adversarial payloads the rules are designed to reject — read it before modifying `firestore.rules` to understand what must keep failing.

### AI extraction endpoints

`server/app.ts` exposes `/api/gemini/extract` (prescription photo → structured medicines list) and `/api/gemini/extract-receipt` (fiscal receipt photo → establishment/items/total) using `@google/genai` against the model in `GEMINI_MODEL` (default `gemini-2.5-flash`; the old `gemini-3.5-flash` was not a valid id) with a `responseSchema` for structured JSON output. Both take `{ imageBase64, mimeType }` and are consumed by `PrescriptionScanner.tsx` / `ReceiptScanner.tsx`. The scanners only fall back to sample/mock data when the server reports **no** Gemini key (`hasApiKey === false`); on a real 401/403/5xx they surface the error instead of injecting fake medicines.

### PWA / notifications

Service worker registration, install-prompt handling (`beforeinstallprompt`), and a client-side dose-reminder poller (checks every 20s whether any active medicine's next dose time matches "now", using `localStorage` flags to dedupe) all live inline in `App.tsx` rather than in a separate module.

### Styling

Tailwind v4 via `@tailwindcss/vite` (no `tailwind.config.js` — v4 uses CSS-based config, check `src/index.css`). Custom brand tokens used throughout components: `brand-teal`, `brand-coral`, `brand-cream`, `brand-peach` (plus `-light`/`-dark`/`-darker` variants), `font-display` for headings and `font-sans` for body text.
