// Shared API application factory. Builds an Express app with all `/api/*`
// routes, middleware and helpers, WITHOUT binding a port or serving the
// frontend — so the exact same code powers three targets:
//   - dev / Cloud Run (long-running):  ../server.ts wraps this + Vite/static + listen()
//   - Vercel (serverless):             ../api/index.ts exports createApiApp() directly
// Keep the frontend-serving and listen() concerns OUT of this file.

import express from "express";
import path from "path";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import cors from "cors";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { initializeApp, getApps, getApp, cert, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import webpush from "web-push";
import { MercadoPagoConfig, Payment, Preference } from "mercadopago";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { PLANS, getAccessState, TRIAL_DAYS, type PlanId } from "../src/subscription.js";
import { dueDoseMs } from "../src/utils/doseSchedule.js";

// dotenv.config() alone only reads ".env" — this project's docs/README tell
// users to put secrets in ".env.local" (Vite convention), so load that first.
// On serverless (Vercel) there is no dotenv file and these calls simply no-op;
// the platform injects the environment variables directly.
dotenv.config({ path: ".env.local" });
dotenv.config();

// Gemini model id + accepted image types, centralized so both scanner
// endpoints agree. `gemini-3.5-flash` (previously hardcoded) is not a published
// model id; default to a real current one and allow an override via env so ops
// can bump it without a code change if Google's catalog shifts.
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const ALLOWED_IMAGE_MIME = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];

// Lazily initialize Gemini to prevent crashes on startup if key is missing
let aiClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not defined in the environment secrets.");
    }
    aiClient = new GoogleGenAI({
      apiKey: apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return aiClient;
}

// Lazily initialize Firebase Admin. Credential resolution order:
//   1. FIREBASE_SERVICE_ACCOUNT — the full service-account JSON as an env var.
//      REQUIRED on serverless platforms (Vercel) where there is no Application
//      Default Credentials file and no GCP metadata server.
//   2. Application Default Credentials — used on Cloud Run/GCP (service account
//      attached) or locally via GOOGLE_APPLICATION_CREDENTIALS pointing at a file.
function getAdminApp(): App {
  if (getApps().length) return getApp();

  const svcJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (svcJson) {
    try {
      const parsed = JSON.parse(svcJson);
      return initializeApp({
        credential: cert(parsed),
        projectId: parsed.project_id,
      });
    } catch (err) {
      console.warn(
        "FIREBASE_SERVICE_ACCOUNT inválido (esperado JSON da conta de serviço); tentando Application Default Credentials.",
        err
      );
    }
  }

  // Cloud Run / local com GOOGLE_APPLICATION_CREDENTIALS.
  return initializeApp();
}

// ==========================================
// WEB PUSH (VAPID) SETUP
// ==========================================

// Configured lazily/guarded so the server still boots without keys — push is
// simply disabled until VAPID_PUBLIC_KEY/PRIVATE_KEY are present. The PUBLIC key
// is exposed to browsers so they can subscribe; the PRIVATE key is a server
// secret that signs push messages and must never reach the client.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:contato@horacerta.ai";
export let pushEnabled = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (pushEnabled) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  } catch (err) {
    // web-push validates key format synchronously and throws on malformed
    // keys. This runs at module load, before createApiApp() builds any route
    // — an uncaught throw here would crash the entire serverless function
    // (every /api/* route, not just push). Degrade to push-disabled instead.
    console.warn("VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY inválidas — push desativado.", err);
    pushEnabled = false;
  }
}

// The client talks to a NAMED Firestore database (see firebase-applet-config.json).
// The Admin SDK must target that same database, or the dispatcher would read an
// empty (default) one. Env wins; otherwise fall back to the committed config
// file (present on Node/Cloud Run, but NOT guaranteed on serverless — always set
// FIREBASE_DATABASE_ID in the Vercel environment).
function getDatabaseId(): string {
  if (process.env.FIREBASE_DATABASE_ID) return process.env.FIREBASE_DATABASE_ID;
  try {
    const cfg = JSON.parse(
      readFileSync(path.join(process.cwd(), "firebase-applet-config.json"), "utf-8")
    );
    return cfg.firestoreDatabaseId || "(default)";
  } catch {
    return "(default)";
  }
}

let firestoreDb: Firestore | null = null;
function getDb(): Firestore {
  if (!firestoreDb) {
    firestoreDb = getFirestore(getAdminApp(), getDatabaseId());
  }
  return firestoreDb;
}

// Deterministic, Firestore-safe doc id for a push subscription — endpoints are
// long URLs with characters not allowed in a doc id (or by isValidId in the
// security rules), so we key by the sha256 of the endpoint.
function subIdFromEndpoint(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}

// ==========================================
// MERCADO PAGO (assinaturas: PIX + Cartão)
// ==========================================

// Lazily initialize the Mercado Pago client so the server still boots without
// MP_ACCESS_TOKEN configured — payment endpoints simply fail with a clear error
// until it's set. The access token is a server secret and never reaches the client.
let mpConfig: MercadoPagoConfig | null = null;
function getMpConfig(): MercadoPagoConfig {
  if (!mpConfig) {
    const accessToken = process.env.MP_ACCESS_TOKEN;
    if (!accessToken) {
      throw new Error("MP_ACCESS_TOKEN não configurado no ambiente.");
    }
    mpConfig = new MercadoPagoConfig({ accessToken });
  }
  return mpConfig;
}

// Best-effort e-mail for the payer (required by MP for PIX). Prefer the auth
// record; the client never supplies it, so a spoofed body can't influence it.
async function getUserEmail(uid: string): Promise<string> {
  try {
    const rec = await getAuth(getAdminApp()).getUser(uid);
    if (rec.email) return rec.email;
  } catch { /* fall through */ }
  return `${uid}@horacerta.app`;
}

// The ONLY legitimate path that flips a user to "subscription active": called
// from the verified webhook after MP confirms an approved payment. Bypasses the
// security rules on purpose (Admin SDK) — the client is blocked from writing
// these fields. Idempotent per paymentId so a re-delivered notification can't
// extend the period twice. Renewals stack on top of any remaining time.
async function activateSubscription(uid: string, plan: PlanId, paymentId: string | number): Promise<boolean> {
  const db = getDb();
  const userRef = db.collection("users").doc(uid);
  const paymentRef = userRef.collection("payments").doc(String(paymentId));

  const existing = await paymentRef.get();
  if (existing.exists && existing.data()?.processed === true) {
    return false; // already applied — ignore duplicate webhook
  }

  const planDef = PLANS[plan];
  const nowMs = Date.now();
  const userSnap = await userRef.get();
  const currentEndIso = userSnap.exists ? (userSnap.data()?.subscriptionCurrentPeriodEnd as string | undefined) : undefined;
  const currentEndMs = currentEndIso ? new Date(currentEndIso).getTime() : 0;
  const baseMs = Math.max(nowMs, Number.isFinite(currentEndMs) ? currentEndMs : 0);
  const newEndIso = new Date(baseMs + planDef.days * 24 * 60 * 60 * 1000).toISOString();

  await userRef.set({
    subscriptionStatus: "active",
    subscriptionPlan: plan,
    subscriptionCurrentPeriodEnd: newEndIso,
  }, { merge: true });

  await paymentRef.set({
    paymentId: String(paymentId),
    plan,
    amount: planDef.amount,
    status: "approved",
    processed: true,
    periodEnd: newEndIso,
    createdAt: new Date().toISOString(),
  }, { merge: true });

  return true;
}

// Validates the `x-signature` HMAC that Mercado Pago attaches to every webhook.
// The signed manifest is `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`
// hashed with HMAC-SHA256 using MP_WEBHOOK_SECRET — NOT the request body, so no
// raw-body parser is needed. Rejects if the secret is unset (fail closed).
function validateMpSignature(req: express.Request): boolean {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return false;

  const signature = req.headers["x-signature"];
  const requestId = req.headers["x-request-id"];
  if (typeof signature !== "string") return false;

  const parts: Record<string, string> = {};
  for (const segment of signature.split(",")) {
    const [k, v] = segment.split("=");
    if (k && v) parts[k.trim()] = v.trim();
  }
  const ts = parts["ts"];
  const v1 = parts["v1"];
  if (!ts || !v1) return false;

  const dataIdRaw = (req.query["data.id"] ?? (req.body?.data?.id)) as string | undefined;
  // MP requires the id lowercased in the manifest when it is alphanumeric.
  const dataId = dataIdRaw != null ? String(dataIdRaw).toLowerCase() : "";
  const manifest = `id:${dataId};request-id:${requestId ?? ""};ts:${ts};`;

  const computed = createHmac("sha256", secret).update(manifest).digest("hex");
  const a = Buffer.from(computed);
  const b = Buffer.from(v1);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Defense-in-depth for the billed scanner endpoints: rejects with 403 when the
// user's access state is "blocked" (trial over + no active/grace subscription),
// so a technical user can't bypass the UI gate by calling the API directly.
// Fails OPEN on unexpected infra errors — this is a secondary guard behind the
// client gate, and we must not lock out paying users on a transient read error.
async function requireActiveSubscription(req: express.Request, res: express.Response, next: express.NextFunction) {
  try {
    const uid = (req as any).uid as string;
    const snap = await getDb().collection("users").doc(uid).get();
    const data = snap.exists ? snap.data() : null;
    const state = getAccessState({
      freeTrialUntil: data?.freeTrialUntil as string | undefined,
      subscriptionCurrentPeriodEnd: data?.subscriptionCurrentPeriodEnd as string | undefined,
    });
    if (state === "blocked") {
      res.status(403).json({
        error: "É necessária uma assinatura ativa para usar o scanner.",
        code: "SUBSCRIPTION_REQUIRED",
      });
      return;
    }
    next();
  } catch (err) {
    console.warn("Verificação de assinatura falhou (liberando por segurança de disponibilidade):", err);
    next();
  }
}

// Requires a valid Firebase ID token in the Authorization header. Rejects with
// 401 otherwise. This is the only trust boundary for the paid Gemini endpoints —
// never rely on client-supplied identity fields.
async function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers.authorization || "";
  const [scheme, token] = authHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    res.status(401).json({ error: "Token de autenticação ausente." });
    return;
  }

  try {
    const decoded = await getAuth(getAdminApp()).verifyIdToken(token);
    (req as any).uid = decoded.uid;
    next();
  } catch (err) {
    res.status(401).json({ error: "Token de autenticação inválido ou expirado." });
  }
}

// Same as requireAuth, but additionally rejects unless the token carries the
// `admin` custom claim (see server/setAdminClaim.js). Never trust a client-
// supplied role/uid for this — the claim is the only source of truth.
async function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers.authorization || "";
  const [scheme, token] = authHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    res.status(401).json({ error: "Token de autenticação ausente." });
    return;
  }

  try {
    const decoded = await getAuth(getAdminApp()).verifyIdToken(token);
    if (decoded.admin !== true) {
      res.status(403).json({ error: "Acesso negado: privilégio de administrador necessário." });
      return;
    }
    (req as any).uid = decoded.uid;
    next();
  } catch (err) {
    res.status(401).json({ error: "Token de autenticação inválido ou expirado." });
  }
}

// Shared key generator for the per-user rate limiters: prefer the authenticated
// uid; fall back to the (IPv6-safe) client IP for pre-auth traffic.
function userOrIpKey(req: express.Request): string {
  const uid = (req as any).uid;
  if (uid) return uid;
  return ipKeyGenerator(req.ip || "unknown");
}

// Real client IP for the login-log audit trail. On Vercel serverless,
// req.ip/req.socket.remoteAddress reflect the platform's internal proxy, not
// the browser — the real origin only shows up in these forwarding headers
// (no `trust proxy` is configured, so Express can't resolve this itself).
// req.ip is kept as the final fallback for the long-running dev/Cloud Run target.
function getClientIp(req: express.Request): string {
  const vercelForwarded = req.headers["x-vercel-forwarded-for"];
  if (typeof vercelForwarded === "string" && vercelForwarded) {
    return vercelForwarded.split(",")[0].trim();
  }
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || "unknown";
}

// Persists a server-side failure for the Admin Portal's "Logs" tab.
// Best-effort and swallows its own errors — a logging failure must never mask
// or replace the original error response already sent to the caller.
async function logServerError(action: string, error: unknown, uid?: string | null): Promise<void> {
  try {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error && error.stack ? error.stack.slice(0, 2000) : undefined;
    const errorLogId = `err_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const payload: Record<string, any> = {
      errorLogId,
      action,
      message: message.slice(0, 2000),
      createdAt: new Date().toISOString(),
    };
    if (stack) payload.stack = stack;
    if (uid) payload.userId = uid;
    await getDb().collection("errorLogs").doc(errorLogId).set(payload);
  } catch (loggingErr) {
    console.warn("Falha ao gravar errorLog:", loggingErr);
  }
}

// NOTE (serverless): express-rate-limit's default store is IN-MEMORY and does
// not survive between serverless invocations, so on Vercel these limits are
// effectively per-instance/best-effort. For a hard guarantee, back them with a
// shared store (Firestore/Redis). Kept here as a first line of defense; the real
// spend guard for Gemini is that every scan requires a verified ID token.
const geminiRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  message: { error: "Limite de leituras por Inteligência Artificial excedido. Tente novamente mais tarde." },
});

const adminActionRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  message: { error: "Limite de ações administrativas excedido. Tente novamente mais tarde." },
});

const pushWriteRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  message: { error: "Muitas atualizações de assinatura. Tente novamente mais tarde." },
});

const subscriptionRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  message: { error: "Muitas tentativas de pagamento. Tente novamente mais tarde." },
});

const logWriteRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  message: { error: "Limite de registros de log excedido. Tente novamente mais tarde." },
});

// ==========================================
// WEB PUSH DISPATCHER (per-user isolated)
// ==========================================

// Cross-invocation dedupe: a given dose slot for a given user is notified at
// most once. Persisted in Firestore (collectionGroup `pushDispatches`) so it
// survives serverless cold starts and multiple instances — an in-memory Map
// would let every Vercel invocation re-send the same reminder. OS-level `tag`
// collapsing is a second layer that de-dupes on-device.
const DISPATCH_TTL_MS = 15 * 60 * 1000;

// Which dose is due this minute is computed by the SHARED src/doseSchedule.ts
// (`dueDoseMs`), so the server dispatcher and the in-app poller agree exactly.

// One dispatch pass: find every active medicine whose reminder is due this
// minute and push a generic (no-PHI) reminder to THAT owner's devices only.
// Isolation holds because each subscription lives under its owner's uid tree
// and we send strictly to subscriptions grouped under the medicine's userId.
export async function dispatchDueReminders(): Promise<number> {
  if (!pushEnabled) return 0;
  const db = getDb();
  const nowMs = Date.now();

  // Only users who actually have a subscription are worth processing.
  const subsSnap = await db.collectionGroup("pushSubscriptions").get();
  if (subsSnap.empty) return 0;

  const subsByUser = new Map<string, any[]>();
  subsSnap.forEach((docSnap) => {
    const data = docSnap.data();
    const uid = data.userId || docSnap.ref.parent.parent?.id;
    if (!uid) return;
    if (!subsByUser.has(uid)) subsByUser.set(uid, []);
    subsByUser.get(uid)!.push({ ref: docSnap.ref, data });
  });

  const medsSnap = await db.collectionGroup("medicamentos").where("status", "==", "active").get();
  let sent = 0;

  for (const medDoc of medsSnap.docs) {
    const med = medDoc.data();
    const uid: string | undefined = med.userId;
    if (!uid || !subsByUser.has(uid)) continue;

    const doseMs = dueDoseMs(med, nowMs);
    if (doseMs == null) continue;

    const medId = med.medicamentoId || medDoc.id;

    // Cross-invocation dedupe via Firestore. A transaction-free create with a
    // deterministic id + `create()` fails if the marker already exists, so only
    // the first pass for this (uid, med, dose) proceeds to send.
    const dedupeId = subIdFromEndpoint(`${uid}_${medId}_${doseMs}`);
    const dispatchRef = db
      .collection("users").doc(uid)
      .collection("pushDispatches").doc(dedupeId);
    try {
      await dispatchRef.create({
        userId: uid,
        medicamentoId: medId,
        doseMs,
        expiresAt: new Date(nowMs + DISPATCH_TTL_MS).toISOString(),
        createdAt: new Date(nowMs).toISOString(),
      });
    } catch {
      // Already dispatched (doc exists) — skip this dose.
      continue;
    }

    const offsetMin = Number(med.reminderOffset) || 0;
    // Generic body — no patient name / medicine / dosage (PHI) on the lock screen.
    const body = offsetMin > 0
      ? `Sua próxima dose é em ${offsetMin} minutos. Abra o aplicativo para verificar os detalhes.`
      : "Você tem uma dose pendente. Abra o aplicativo para verificar os detalhes.";
    const payload = JSON.stringify({
      title: "Lembrete de Medicamento",
      body,
      tag: `dose_${medId}_${doseMs}`,
      data: { url: "/app" },
    });

    for (const sub of subsByUser.get(uid)!) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.data.endpoint, keys: sub.data.keys },
          payload
        );
        sent++;
      } catch (err: any) {
        // 404/410 => the subscription expired or was unsubscribed: clean it up.
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          try { await sub.ref.delete(); } catch { /* best-effort */ }
        } else {
          console.warn("Falha ao enviar push:", err?.statusCode || err?.message || err);
        }
      }
    }
  }
  return sent;
}

// ==========================================
// API APP FACTORY
// ==========================================

// Builds the Express app carrying every `/api/*` route. Does NOT call listen()
// and does NOT serve the frontend — those belong to the target-specific entry
// points (../server.ts for dev/Cloud Run, ../api/index.ts for Vercel).
export function createApiApp(): express.Express {
  const app = express();

  // Restrict cross-origin access to the app's own deployed/dev origins.
  // Scoped to /api only — the page and its static assets are same-origin
  // loads and must never be CORS-gated. Server-to-server callers (Mercado
  // Pago webhook, Vercel Cron) send no Origin header and are allowed through.
  const allowedOrigins = [
    process.env.APP_URL,
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ].filter((origin): origin is string => !!origin);
  app.use(
    "/api",
    cors({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          // Signal a rejected origin without throwing (which would surface as a
          // generic 500). The CORS headers are simply omitted, so the browser
          // blocks the response.
          callback(null, false);
        }
      },
    })
  );

  // Body parser with 10mb limit for base64 prescription images
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ limit: "10mb", extended: true }));

  // ==========================================
  // API ROUTES
  // ==========================================

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", time: new Date().toISOString() });
  });

  // AI Key Status Check
  app.get("/api/gemini/status", (req, res) => {
    res.json({ hasKey: !!process.env.GEMINI_API_KEY });
  });

  // ==========================================
  // AUDIT LOGS (Admin Portal "Logs" tab)
  // ==========================================

  // Records a successful login. Only the server can see the real client IP
  // (Vercel serverless rewrites req.ip; see getClientIp) — this can't be done
  // client-side like the rest of the app's CRUD, which writes straight to
  // Firestore. Called right after auth succeeds (AuthScreen.tsx / App.tsx's
  // handleAdminLogin) with the caller's own ID token.
  app.post("/api/logs/login", requireAuth, logWriteRateLimiter, async (req, res) => {
    try {
      const uid = (req as any).uid as string;
      const { userName, userEmail } = req.body || {};
      const logId = `login_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await getDb().collection("loginLogs").doc(logId).set({
        logId,
        userId: uid,
        userName: typeof userName === "string" ? userName.slice(0, 128) : "",
        userEmail: typeof userEmail === "string" ? userEmail.slice(0, 128) : "",
        ip: getClientIp(req),
        userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"].slice(0, 256) : null,
        createdAt: new Date().toISOString(),
      });
      res.json({ success: true });
    } catch (error: any) {
      console.error("Login log error:", error);
      await logServerError("POST /api/logs/login", error, (req as any).uid);
      res.status(500).json({ error: "Falha ao registrar login." });
    }
  });

  // Admin: change another user's real Firebase Auth password. The web/client
  // SDK has no way to do this for anyone but the currently signed-in user —
  // it requires the Admin SDK, hence this server-side, claim-gated endpoint.
  app.post("/api/admin/change-user-password", requireAdmin, adminActionRateLimiter, async (req, res) => {
    try {
      const { uid, newPassword } = req.body;

      if (!uid || typeof uid !== "string") {
        res.status(400).json({ error: "Parâmetro 'uid' ausente ou inválido." });
        return;
      }
      if (!newPassword || typeof newPassword !== "string" || newPassword.length < 6) {
        res.status(400).json({ error: "A nova senha deve ter pelo menos 6 caracteres." });
        return;
      }

      await getAuth(getAdminApp()).updateUser(uid, { password: newPassword });
      res.json({ success: true });
    } catch (error: any) {
      console.error("Admin change-user-password error:", error);
      await logServerError("POST /api/admin/change-user-password", error, (req as any).uid);
      res.status(500).json({
        error: "Falha ao alterar a senha do usuário.",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // AI Prescription Reading Endpoint
  app.post("/api/gemini/extract", requireAuth, requireActiveSubscription, geminiRateLimiter, async (req, res) => {
    try {
      const { imageBase64, mimeType } = req.body;

      if (!imageBase64 || typeof imageBase64 !== "string") {
        res.status(400).json({ error: "Missing imageBase64 parameter in request body." });
        return;
      }
      const resolvedMime = typeof mimeType === "string" ? mimeType : "image/jpeg";
      if (!ALLOWED_IMAGE_MIME.includes(resolvedMime)) {
        res.status(400).json({ error: "Formato de imagem não suportado." });
        return;
      }

      const client = getGeminiClient();

      const imagePart = {
        inlineData: {
          mimeType: resolvedMime,
          data: imageBase64,
        },
      };

      const promptPart = {
        text: `Você é um assistente médico especialista em leitura de receitas. Analise a receita médica enviada e extraia todos os medicamentos nela prescritos de forma estruturada.
Instruções:
- Identifique o nome do medicamento.
- Identifique a dosagem (ex: "1 comprimido", "5ml", "2 gotas", "800mg").
- Identifique o intervalo de tempo em horas (ex: de 8 em 8 horas => intervalHours = 8. Uma vez ao dia => intervalHours = 24. Se não estiver claro, estime de acordo com práticas médicas seguras).
- Identifique a duração em dias (ex: por 5 dias => durationDays = 5. Uso contínuo => utilize 30 dias por padrão).
- Extraia instruções adicionais úteis (ex: "tomar após as refeições", "diluir em água").
- Categorize o medicamento estritamente em um dos seguintes tipos: "pill" (comprimido, cápsula, drágea), "syrup" (xarope, suspensão líquida), "drop" (gotas, colírio), "cream" (pomada, creme, gel), "injection" (ampola, injetável), ou "other" (outros).
- Extraia também o nome do médico (doctorName) e a data da receita (date) se visíveis.`,
      };

      const response = await client.models.generateContent({
        model: GEMINI_MODEL,
        contents: { parts: [imagePart, promptPart] },
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              doctorName: { type: Type.STRING, description: "Nome do médico que assinou a receita." },
              date: { type: Type.STRING, description: "Data da receita médica." },
              medicines: {
                type: Type.ARRAY,
                description: "Lista de medicamentos extraídos.",
                items: {
                  type: Type.OBJECT,
                  properties: {
                    name: { type: Type.STRING, description: "Nome completo do medicamento." },
                    dosage: { type: Type.STRING, description: "Dosagem recomendada (ex: 1 comprimido, 5ml)." },
                    intervalHours: { type: Type.INTEGER, description: "Intervalo em horas (ex: de 8 em 8 horas => 8)." },
                    durationDays: { type: Type.INTEGER, description: "Duração do tratamento em dias." },
                    instructions: { type: Type.STRING, description: "Instruções adicionais de administração." },
                    category: {
                      type: Type.STRING,
                      description: "Categoria estrita do medicamento.",
                      enum: ["pill", "syrup", "drop", "cream", "injection", "other"]
                    }
                  },
                  required: ["name", "dosage", "intervalHours", "durationDays", "category"]
                }
              }
            },
            required: ["medicines"]
          }
        }
      });

      const extractedText = response.text;
      if (!extractedText) {
        res.status(500).json({ error: "No text returned from Gemini API." });
        return;
      }

      const parsedResult = JSON.parse(extractedText.trim());
      res.json(parsedResult);
    } catch (error: any) {
      console.error("Gemini Extraction Error:", error);
      await logServerError("POST /api/gemini/extract", error, (req as any).uid);
      res.status(500).json({
        error: "Falha ao processar receita com inteligência artificial.",
        details: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // AI Fiscal Receipt Reading Endpoint
  app.post("/api/gemini/extract-receipt", requireAuth, requireActiveSubscription, geminiRateLimiter, async (req, res) => {
    try {
      const { imageBase64, mimeType } = req.body;

      if (!imageBase64 || typeof imageBase64 !== "string") {
        res.status(400).json({ error: "Missing imageBase64 parameter in request body." });
        return;
      }
      const resolvedMime = typeof mimeType === "string" ? mimeType : "image/jpeg";
      if (!ALLOWED_IMAGE_MIME.includes(resolvedMime)) {
        res.status(400).json({ error: "Formato de imagem não suportado." });
        return;
      }

      const client = getGeminiClient();

      const imagePart = {
        inlineData: {
          mimeType: resolvedMime,
          data: imageBase64,
        },
      };

      const promptPart = {
        text: `Você é um assistente financeiro e farmacêutico especialista em leitura de comprovantes e cupons fiscais de medicamentos. Analise a imagem da nota fiscal ou cupom de compra enviado e extraia os dados estruturados.
Instruções:
- Identifique o nome do estabelecimento (farmácia, drogaria ou loja).
- Identifique a data de compra ou emissão no formato DD/MM/AAAA.
- Extraia cada item ou medicamento comprado com seu respectivo preço unitário ou total.
- Extraia o valor total da nota fiscal (totalPrice).
Preencha os valores nulos ou faltantes com estimativas seguras se baseadas no texto visível.`,
      };

      const response = await client.models.generateContent({
        model: GEMINI_MODEL,
        contents: { parts: [imagePart, promptPart] },
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              establishment: { type: Type.STRING, description: "Nome do estabelecimento ou farmácia." },
              date: { type: Type.STRING, description: "Data da compra no formato DD/MM/AAAA." },
              items: {
                type: Type.ARRAY,
                description: "Lista de itens ou medicamentos comprados.",
                items: {
                  type: Type.OBJECT,
                  properties: {
                    name: { type: Type.STRING, description: "Nome ou descrição do item comprado." },
                    price: { type: Type.NUMBER, description: "Preço do item em reais." }
                  },
                  required: ["name", "price"]
                }
              },
              totalPrice: { type: Type.NUMBER, description: "Preço total geral pago indicado no cupom." }
            },
            required: ["establishment", "date", "items", "totalPrice"]
          }
        }
      });

      const extractedText = response.text;
      if (!extractedText) {
        res.status(500).json({ error: "No text returned from Gemini API." });
        return;
      }

      const parsedResult = JSON.parse(extractedText.trim());
      res.json(parsedResult);
    } catch (error: any) {
      console.error("Gemini Receipt Extraction Error:", error);
      await logServerError("POST /api/gemini/extract-receipt", error, (req as any).uid);
      res.status(500).json({
        error: "Falha ao processar nota fiscal com inteligência artificial.",
        details: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // ==========================================
  // WEB PUSH (VAPID) ROUTES
  // ==========================================

  // Public VAPID key — safe to expose; the browser needs it to subscribe.
  app.get("/api/push/vapid-public-key", (req, res) => {
    res.json({ key: pushEnabled ? VAPID_PUBLIC_KEY : null });
  });

  // Register a browser push subscription. ISOLATION: the subscription is stored
  // under the tree of the AUTHENTICATED uid (from the verified ID token) — never
  // a client-supplied userId — so a user can only ever create a subscription in
  // their own space, and the dispatcher can only ever reach their own devices.
  app.post("/api/push/subscribe", requireAuth, pushWriteRateLimiter, async (req, res) => {
    try {
      const uid = (req as any).uid as string;
      const sub = req.body?.subscription || req.body;
      if (
        !sub || typeof sub.endpoint !== "string" || !sub.keys ||
        typeof sub.keys.p256dh !== "string" || typeof sub.keys.auth !== "string"
      ) {
        res.status(400).json({ error: "Assinatura de push inválida." });
        return;
      }
      if (sub.endpoint.length > 2000) {
        res.status(400).json({ error: "Endpoint de push excede o tamanho permitido." });
        return;
      }

      const subId = subIdFromEndpoint(sub.endpoint);
      await getDb()
        .collection("users").doc(uid)
        .collection("pushSubscriptions").doc(subId)
        .set({
          userId: uid,
          endpoint: sub.endpoint,
          keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
          expirationTime: sub.expirationTime ?? null,
          userAgent: typeof req.headers["user-agent"] === "string"
            ? req.headers["user-agent"].slice(0, 256)
            : null,
          updatedAt: new Date().toISOString(),
        }, { merge: true });

      res.json({ success: true });
    } catch (error: any) {
      console.error("Push subscribe error:", error);
      await logServerError("POST /api/push/subscribe", error, (req as any).uid);
      res.status(500).json({ error: "Falha ao registrar a assinatura de push." });
    }
  });

  // Remove a subscription (on logout or when the user disables reminders).
  app.post("/api/push/unsubscribe", requireAuth, pushWriteRateLimiter, async (req, res) => {
    try {
      const uid = (req as any).uid as string;
      const endpoint = req.body?.endpoint;
      if (typeof endpoint !== "string" || !endpoint) {
        res.status(400).json({ error: "Endpoint ausente." });
        return;
      }
      const subId = subIdFromEndpoint(endpoint);
      await getDb().collection("users").doc(uid).collection("pushSubscriptions").doc(subId).delete();
      res.json({ success: true });
    } catch (error: any) {
      console.error("Push unsubscribe error:", error);
      await logServerError("POST /api/push/unsubscribe", error, (req as any).uid);
      res.status(500).json({ error: "Falha ao remover a assinatura de push." });
    }
  });

  // Cron entry point for serverless deploys (Vercel Cron, etc.): runs a single
  // dispatch pass. Guarded by CRON_SECRET so only the scheduler can trigger it.
  // Accepts the secret either as a Bearer token (external cron) or via Vercel
  // Cron's own `x-vercel-cron` invocation.
  app.post("/api/push/dispatch", async (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (!secret) {
      res.status(503).json({ error: "CRON_SECRET não configurado." });
      return;
    }
    const authHeader = req.headers.authorization || "";
    const [scheme, token] = authHeader.split(" ");
    const provided = scheme === "Bearer" && token ? token : "";
    const providedBuf = Buffer.from(provided);
    const secretBuf = Buffer.from(secret);
    const ok = providedBuf.length === secretBuf.length &&
      timingSafeEqual(providedBuf, secretBuf);
    if (!ok) {
      res.status(401).json({ error: "Não autorizado." });
      return;
    }
    try {
      const sent = await dispatchDueReminders();
      res.json({ success: true, sent });
    } catch (error: any) {
      console.error("Push dispatch error:", error);
      await logServerError("POST /api/push/dispatch", error);
      res.status(500).json({ error: "Falha ao despachar lembretes." });
    }
  });

  // Also accept GET for platforms whose cron only issues GET requests.
  app.get("/api/push/dispatch", async (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (!secret) {
      res.status(503).json({ error: "CRON_SECRET não configurado." });
      return;
    }
    const authHeader = req.headers.authorization || "";
    const [scheme, token] = authHeader.split(" ");
    const provided = scheme === "Bearer" && token ? token : "";
    const providedBuf = Buffer.from(provided);
    const secretBuf = Buffer.from(secret);
    const ok = providedBuf.length === secretBuf.length &&
      timingSafeEqual(providedBuf, secretBuf);
    if (!ok) {
      res.status(401).json({ error: "Não autorizado." });
      return;
    }
    try {
      const sent = await dispatchDueReminders();
      res.json({ success: true, sent });
    } catch (error: any) {
      console.error("Push dispatch error:", error);
      await logServerError("GET /api/push/dispatch", error);
      res.status(500).json({ error: "Falha ao despachar lembretes." });
    }
  });

  // ==========================================
  // SUBSCRIPTION / MERCADO PAGO ROUTES
  // ==========================================

  // Reconciles the caller's subscription state and returns it. Two jobs:
  // (1) grants the 7-day free trial to legacy users who predate monetization
  //     (freeTrialUntil absent) — the client can't write this field itself
  //     (security rules), so it's done here with the Admin SDK;
  // (2) lazily normalizes subscriptionStatus once a paid period fully lapses.
  // Also used by the app as the PIX confirmation poll after showing the QR.
  app.post("/api/subscription/sync", requireAuth, async (req, res) => {
    try {
      const uid = (req as any).uid as string;
      const userRef = getDb().collection("users").doc(uid);
      const snap = await userRef.get();

      if (!snap.exists) {
        // Profile not created yet (client normally creates it at signup).
        res.json({ accessState: "blocked", subscriptionStatus: "inactive", subscriptionPlan: "none" });
        return;
      }

      const data = snap.data() as any;
      const patch: Record<string, any> = {};

      // (1) Legacy trial grant.
      if (!data.freeTrialUntil) {
        patch.freeTrialUntil = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();
        if (!data.subscriptionStatus) patch.subscriptionStatus = "inactive";
        if (!data.subscriptionPlan) patch.subscriptionPlan = "none";
      }

      const merged = { ...data, ...patch };
      const state = getAccessState({
        freeTrialUntil: merged.freeTrialUntil,
        subscriptionCurrentPeriodEnd: merged.subscriptionCurrentPeriodEnd,
      });

      // (2) Reflect a fully-lapsed paid period in the stored status (cosmetic —
      // access is date-derived, but keeps the profile card honest).
      if (state === "blocked" && merged.subscriptionStatus === "active") {
        patch.subscriptionStatus = "expired";
        merged.subscriptionStatus = "expired";
      }

      if (Object.keys(patch).length > 0) {
        await userRef.set(patch, { merge: true });
      }

      res.json({
        accessState: state,
        subscriptionStatus: merged.subscriptionStatus ?? "inactive",
        subscriptionPlan: merged.subscriptionPlan ?? "none",
        subscriptionCurrentPeriodEnd: merged.subscriptionCurrentPeriodEnd ?? null,
        freeTrialUntil: merged.freeTrialUntil ?? null,
      });
    } catch (error: any) {
      console.error("Subscription sync error:", error);
      await logServerError("POST /api/subscription/sync", error, (req as any).uid);
      res.status(500).json({ error: "Falha ao sincronizar assinatura." });
    }
  });

  // Creates an in-app PIX charge for the chosen plan and returns the QR code
  // (image + copy-paste string) so the client can render it without leaving the
  // app. The amount is taken from the server-side PLANS table — never the body.
  app.post("/api/subscription/pix", requireAuth, subscriptionRateLimiter, async (req, res) => {
    try {
      const uid = (req as any).uid as string;
      const plan = req.body?.plan as PlanId;
      if (plan !== "monthly" && plan !== "yearly") {
        res.status(400).json({ error: "Plano inválido." });
        return;
      }

      const planDef = PLANS[plan];
      const email = await getUserEmail(uid);
      const payment = new Payment(getMpConfig());

      const result = await payment.create({
        body: {
          transaction_amount: planDef.amount,
          description: `Hora Certa — Plano ${planDef.label}`,
          payment_method_id: "pix",
          payer: { email },
          external_reference: uid,
          metadata: { uid, plan },
        },
        requestOptions: { idempotencyKey: `${uid}-${plan}-${Date.now()}` },
      });

      const txData = result.point_of_interaction?.transaction_data;
      res.json({
        paymentId: result.id,
        qrCode: txData?.qr_code ?? null,
        qrCodeBase64: txData?.qr_code_base64 ?? null,
        ticketUrl: txData?.ticket_url ?? null,
        amount: planDef.amount,
      });
    } catch (error: any) {
      console.error("PIX create error:", error);
      await logServerError("POST /api/subscription/pix", error, (req as any).uid);
      res.status(500).json({ error: "Falha ao gerar cobrança PIX.", details: error?.message });
    }
  });

  // Creates a Checkout Pro preference (card path) and returns its init_point for
  // a redirect. MP hosts the card form — no card data ever touches this server.
  app.post("/api/subscription/checkout", requireAuth, subscriptionRateLimiter, async (req, res) => {
    try {
      const uid = (req as any).uid as string;
      const plan = req.body?.plan as PlanId;
      if (plan !== "monthly" && plan !== "yearly") {
        res.status(400).json({ error: "Plano inválido." });
        return;
      }

      const planDef = PLANS[plan];
      const email = await getUserEmail(uid);
      const preference = new Preference(getMpConfig());

      // auto_return needs valid absolute back_urls; APP_URL may be an unset
      // placeholder in dev, so only wire the return flow when it's a real URL.
      const appUrl = process.env.APP_URL || "";
      const hasValidAppUrl = /^https?:\/\//.test(appUrl) && !appUrl.includes("MY_APP_URL");
      const body: any = {
        items: [{
          id: `plan_${plan}`,
          title: `Hora Certa — Plano ${planDef.label}`,
          quantity: 1,
          unit_price: planDef.amount,
          currency_id: "BRL",
        }],
        payer: { email },
        external_reference: uid,
        metadata: { uid, plan },
      };
      if (hasValidAppUrl) {
        body.back_urls = {
          success: `${appUrl}/app?sub=success`,
          pending: `${appUrl}/app?sub=pending`,
          failure: `${appUrl}/app?sub=failure`,
        };
        body.auto_return = "approved";
      }

      const result = await preference.create({ body });
      res.json({ initPoint: result.init_point, preferenceId: result.id });
    } catch (error: any) {
      console.error("Checkout create error:", error);
      await logServerError("POST /api/subscription/checkout", error, (req as any).uid);
      res.status(500).json({ error: "Falha ao criar checkout de cartão.", details: error?.message });
    }
  });

  // Public webhook Mercado Pago calls when a payment changes state. Verified via
  // the x-signature HMAC (no ID token). On an approved payment we look it up,
  // read the uid (external_reference) + plan (metadata) and extend the period.
  app.post("/api/mercadopago/webhook", async (req, res) => {
    try {
      if (!validateMpSignature(req)) {
        res.status(401).json({ error: "Assinatura do webhook inválida." });
        return;
      }

      const dataId = (req.query["data.id"] ?? req.body?.data?.id) as string | undefined;
      const type = (req.query["type"] ?? req.body?.type) as string | undefined;

      // We only act on payment notifications; acknowledge the rest so MP stops.
      if (!dataId || (type && type !== "payment")) {
        res.status(200).json({ received: true, ignored: true });
        return;
      }

      const payment = new Payment(getMpConfig());
      const info = await payment.get({ id: String(dataId) });

      if (info.status === "approved") {
        const uid = (info.metadata?.uid as string | undefined) || (info.external_reference as string | undefined);
        let plan = info.metadata?.plan as PlanId | undefined;
        if (plan !== "monthly" && plan !== "yearly") {
          // Fallback: infer plan from the charged amount.
          const amt = Number(info.transaction_amount);
          plan = amt === PLANS.yearly.amount ? "yearly" : amt === PLANS.monthly.amount ? "monthly" : undefined;
        }
        if (uid && plan) {
          await activateSubscription(uid, plan, info.id ?? dataId);
        }
      }

      res.status(200).json({ received: true });
    } catch (error: any) {
      console.error("Mercado Pago webhook error:", error);
      await logServerError("POST /api/mercadopago/webhook", error);
      // 500 lets MP retry a genuinely failed processing attempt.
      res.status(500).json({ error: "Falha ao processar webhook." });
    }
  });

  // Safety net for anything a route's own try/catch didn't handle (e.g. a
  // synchronous throw, or middleware failing before a route body runs). Must
  // stay LAST — Express only treats a 4-arg handler as an error middleware,
  // and dispatch order matters.
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error("Unhandled Express error:", err);
    logServerError(`${req.method} ${req.path}`, err, (req as any).uid).catch(() => {});
    if (res.headersSent) {
      next(err);
      return;
    }
    res.status(500).json({ error: "Erro interno no servidor." });
  });

  return app;
}
