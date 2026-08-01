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
import { getFirestore, FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import webpush from "web-push";
import { MercadoPagoConfig, Payment, Preference } from "mercadopago";
import { createHash, createHmac, timingSafeEqual, randomInt, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PLANS, getAccessState, canPerformScan, TRIAL_DAYS, TRIAL_SCAN_LIMIT, type PlanId, type ScanType } from "../src/subscription.js";
import { dueDoseMs, doseSlotAtMs } from "../src/utils/doseSchedule.js";

// dotenv.config() alone only reads ".env" — this project's docs/README tell
// users to put secrets in ".env.local" (Vite convention), so load that first.
// On serverless (Vercel) there is no dotenv file and these calls simply no-op;
// the platform injects the environment variables directly.
dotenv.config({ path: ".env.local" });
dotenv.config();

// Gemini model id + accepted image types, centralized so both scanner
// endpoints agree. Overridable via GEMINI_MODEL so ops can bump the model
// without a code change. (`gemini-3.5-flash` — the value originally hardcoded
// here — was not a published id at the time; it since became available and was
// verified to honor the responseSchema below. Prefer a pinned id over
// `gemini-flash-latest`, which shifts under you without a deploy.)
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const ALLOWED_IMAGE_MIME = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];

// Single admin's inbox: destination for "esqueci minha senha" notifications.
// There is only one admin account in this project (see CLAUDE.md), so this is
// a constant rather than a configurable list.
const ADMIN_NOTIFICATION_EMAIL = "antonio.marcus.barreto@gmail.com";
// Resend's shared test sender — works without a verified domain but is more
// likely to be flagged as spam. Swap for a verified domain address in prod.
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev";

// Self-service password reset: once name+email are confirmed to match a real
// account, a one-time code is emailed to that account's own registered
// address (proof of inbox access) before any password change is allowed.
const PASSWORD_RESET_CODE_TTL_MS = 10 * 60 * 1000;
const PASSWORD_RESET_CODE_MAX_ATTEMPTS = 5;

// Compartilhamento de um medicado entre cuidadores. Um convite pendente expira
// sozinho: convite de acesso a dado de saúde não pode ficar aceitável para
// sempre numa caixa de e-mail antiga.
const SHARE_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Teto de cuidadores por paciente. Precisa ficar ABAIXO do limite de 20 que
// isValidShareLists() impõe em firestore.rules, senão o fan-out gera um
// documento que as próprias regras passam a rejeitar em qualquer edição.
const MAX_SHARES_PER_MEDICADO = 10;

// ==========================================
// RETENÇÃO DAS TRILHAS DE AUDITORIA (LGPD art. 15/16)
// ==========================================
// Cada coleção de log carrega um `expiresAt` (Timestamp) para que o TTL NATIVO
// do Firestore as expurgue sozinho — sem isso elas crescem para sempre, o que
// é retenção indefinida de dado pessoal (LGPD art. 15: os dados devem ser
// eliminados após o fim do tratamento).
//
// ATENÇÃO: gravar o campo não basta. A política de TTL precisa ser criada UMA
// VEZ por coleção no console (Firestore > TTL) ou via:
//   gcloud firestore fields ttls update expiresAt \
//     --collection-group=loginLogs --enable-ttl --database=<DATABASE_ID>
// Repita para errorLogs e actionLogs. Sem isso o campo é só um dado inerte.
const LOGIN_LOG_RETENTION_DAYS = 180;  // Marco Civil da Internet, art. 15 (6 meses).
const ERROR_LOG_RETENTION_DAYS = 90;   // Operacional: só precisa durar a investigação.
// Espelha ACTION_LOG_RETENTION_DAYS em src/firebase.ts: a mesma coleção é
// escrita pelo cliente (mutações no painel) e por aqui (compartilhamento), e
// duas retenções diferentes na mesma trilha seriam impossíveis de auditar.
const ACTION_LOG_RETENTION_DAYS = 365;

function expiresInDays(days: number): Timestamp {
  return Timestamp.fromDate(new Date(Date.now() + days * 24 * 60 * 60 * 1000));
}

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

// Defense-in-depth for the billed scanner endpoints, in a single Firestore read:
//   1. rejects with 403 when the user's access state is "blocked" (trial over +
//      no active/grace subscription), so a technical user can't bypass the UI
//      gate by calling the API directly;
//   2. rejects with 403 when a TRIAL user has already spent their free scans of
//      this type (protects the Gemini quota — see src/subscription.ts's
//      canPerformScan). Active subscribers, grace-period users and admin-exempt
//      users are never subject to this cap.
// Fails OPEN on unexpected infra errors — this is a secondary guard behind the
// client gate, and we must not lock out paying users on a transient read error.
// Stashes the resolved access state on the request so the route handler can
// decide whether to bump the trial scan counter without a second Firestore read.
function requireScanAccess(scanType: ScanType) {
  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try {
      const uid = (req as any).uid as string;
      const snap = await getDb().collection("users").doc(uid).get();
      const data = snap.exists ? snap.data() : null;
      const user = {
        freeTrialUntil: data?.freeTrialUntil as string | undefined,
        subscriptionCurrentPeriodEnd: data?.subscriptionCurrentPeriodEnd as string | undefined,
        scanLimitExempt: data?.scanLimitExempt as boolean | undefined,
        trialPrescriptionScansUsed: data?.trialPrescriptionScansUsed as number | undefined,
        trialReceiptScansUsed: data?.trialReceiptScansUsed as number | undefined,
      };
      const state = getAccessState(user);
      if (state === "blocked") {
        res.status(403).json({
          error: "É necessária uma assinatura ativa para usar o scanner.",
          code: "SUBSCRIPTION_REQUIRED",
        });
        return;
      }
      if (!canPerformScan(user, scanType)) {
        res.status(403).json({
          error: scanType === "prescription"
            ? `Você já utilizou seus ${TRIAL_SCAN_LIMIT} scans gratuitos de receita do período de testes. Assine um plano para continuar usando o leitor de receitas.`
            : `Você já utilizou seus ${TRIAL_SCAN_LIMIT} scans gratuitos de nota fiscal do período de testes. Assine um plano para continuar usando o leitor de notas.`,
          code: "TRIAL_SCAN_LIMIT_REACHED",
        });
        return;
      }
      (req as any).scanAccessState = state;
      next();
    } catch (err) {
      console.warn("Verificação de acesso ao scanner falhou (liberando por segurança de disponibilidade):", err);
      next();
    }
  };
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

// Aplica `apply` a todos os docs em lotes de 400 (o limite do Firestore é 500
// operações por batch).
async function commitInChunks(
  db: Firestore,
  docs: FirebaseFirestore.QueryDocumentSnapshot[],
  apply: (batch: FirebaseFirestore.WriteBatch, doc: FirebaseFirestore.QueryDocumentSnapshot) => void
): Promise<void> {
  const CHUNK = 400;
  for (let i = 0; i < docs.length; i += CHUNK) {
    const batch = db.batch();
    for (const doc of docs.slice(i, i + CHUNK)) apply(batch, doc);
    await batch.commit();
  }
}

// Fecha o buraco de LGPD do hard-delete: o `recursiveDelete` da conta só
// alcança `users/{uid}/**`, mas as três trilhas de auditoria são coleções
// TOP-LEVEL e sobreviveriam à exclusão, ainda vinculadas ao titular.
//
// O tratamento é DIFERENCIADO em vez de um delete uniforme porque a base legal
// de cada uma é diferente:
//
//   - actionLogs: consentimento (LGPD art. 11, I). O `entityLabel` descreve um
//     registro de saúde e pode nomear um TERCEIRO (o medicado — filho, idoso)
//     que nunca consentiu com nada => APAGA.
//   - loginLogs: obrigação legal. O Marco Civil da Internet (art. 15) manda o
//     provedor guardar registro de acesso por 6 meses, então o documento NÃO
//     pode simplesmente sumir; mas o art. 16, I proíbe reter dado pessoal
//     excessivo, e nome/e-mail não são exigidos => PSEUDONIMIZA, preservando
//     apenas IP + timestamp (o TTL o elimina ao fim dos 6 meses).
//   - errorLogs: legítimo interesse (operação/segurança). O stack trace tem
//     valor diagnóstico sem o titular => ANONIMIZA, removendo o vínculo.
async function purgeUserAuditTrail(uid: string): Promise<{
  actionLogsDeleted: number;
  loginLogsPseudonymized: number;
  errorLogsAnonymized: number;
}> {
  const db = getDb();
  const anonymizedAt = new Date().toISOString();

  const [actionSnap, loginSnap, errorSnap] = await Promise.all([
    db.collection("actionLogs").where("actorId", "==", uid).get(),
    db.collection("loginLogs").where("userId", "==", uid).get(),
    db.collection("errorLogs").where("userId", "==", uid).get(),
  ]);

  await commitInChunks(db, actionSnap.docs, (batch, doc) => batch.delete(doc.ref));

  await commitInChunks(db, loginSnap.docs, (batch, doc) =>
    batch.update(doc.ref, {
      // Rótulo explícito em vez de string vazia: a aba Logs continua legível e
      // deixa claro que a lacuna é uma exclusão atendida, não um bug.
      userName: "(conta excluída)",
      userEmail: "",
      anonymizedAt,
    })
  );

  await commitInChunks(db, errorSnap.docs, (batch, doc) =>
    batch.update(doc.ref, { userId: FieldValue.delete(), anonymizedAt })
  );

  return {
    actionLogsDeleted: actionSnap.size,
    loginLogsPseudonymized: loginSnap.size,
    errorLogsAnonymized: errorSnap.size,
  };
}

// Mesmo buraco do purgeUserAuditTrail, para a coleção `shares`: ela é
// top-level e o recursiveDelete de `users/{uid}/**` não a alcança.
//
// São duas pontas com consequências bem diferentes:
//
//   - Convites que o excluído CONCEDEU: a árvore dele acabou de ser apagada,
//     então só resta remover os documentos — que guardam o nome de um paciente
//     (terceiro) e o e-mail do convidado.
//   - Convites que o excluído RECEBEU: a árvore do OUTRO titular continua de
//     pé, com o uid do excluído gravado em `memberUids` de cada documento. Só
//     apagar o convite deixaria esse uid para trás; é preciso reprocessar as
//     listas de cada paciente afetado, e por isso o sync roda DEPOIS da
//     exclusão dos convites (ele recalcula a partir do que sobrou).
async function purgeUserShares(uid: string): Promise<{ sharesDeleted: number; medicadosResynced: number }> {
  const db = getDb();

  let email = "";
  try {
    const authUser = await getAuth(getAdminApp()).getUser(uid);
    email = normalizeEmail(authUser.email || "");
  } catch {
    // Registro do Auth já removido: seguimos pelos convites achados por uid.
  }

  const [ownedSnap, grantedSnap, pendingSnap] = await Promise.all([
    db.collection("shares").where("ownerUid", "==", uid).get(),
    db.collection("shares").where("granteeUid", "==", uid).get(),
    email ? db.collection("shares").where("granteeEmail", "==", email).get() : Promise.resolve(null),
  ]);

  // Pares (titular, paciente) cujas listas precisam ser recalculadas depois.
  const toResync = new Map<string, { ownerUid: string; medicadoId: string }>();
  for (const docSnap of [...grantedSnap.docs, ...(pendingSnap ? pendingSnap.docs : [])]) {
    const share = docSnap.data();
    if (share.ownerUid === uid) continue; // árvore própria já foi apagada
    toResync.set(`${share.ownerUid}/${share.medicadoId}`, {
      ownerUid: share.ownerUid,
      medicadoId: share.medicadoId,
    });
  }

  const allDocs = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
  for (const docSnap of [...ownedSnap.docs, ...grantedSnap.docs, ...(pendingSnap ? pendingSnap.docs : [])]) {
    allDocs.set(docSnap.id, docSnap);
  }
  await commitInChunks(db, [...allDocs.values()], (batch, doc) => batch.delete(doc.ref));

  for (const { ownerUid, medicadoId } of toResync.values()) {
    try {
      await syncMedicadoShareLists(ownerUid, medicadoId);
    } catch (err) {
      console.warn(`Falha ao reprocessar listas de ${ownerUid}/${medicadoId}:`, err);
    }
  }

  return { sharesDeleted: allDocs.size, medicadosResynced: toResync.size };
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
      expiresAt: expiresInDays(ERROR_LOG_RETENTION_DAYS),
    };
    if (stack) payload.stack = stack;
    if (uid) payload.userId = uid;
    await getDb().collection("errorLogs").doc(errorLogId).set(payload);
  } catch (loggingErr) {
    console.warn("Falha ao gravar errorLog:", loggingErr);
  }
}

// Firebase enforces exact-string email uniqueness for the password provider,
// so two accounts can only ever share a "visually identical" email if the
// strings aren't actually byte-identical — typically an invisible/zero-width
// Unicode character (mobile keyboard autocomplete, copy-paste) that plain
// .trim() doesn't strip since it isn't ASCII/Unicode whitespace. Stripping
// these before every Auth/Firestore lookup keeps such near-duplicates from
// silently resolving to different accounts.
const INVISIBLE_CHARS_RE = new RegExp(`[${[0x200B, 0x200C, 0x200D, 0x200E, 0x200F, 0x2060, 0xFEFF, 0x00AD, 0x00A0].map((c) => String.fromCodePoint(c)).join("")}]`, "g");
function normalizeEmail(email: string): string {
  return email.replace(INVISIBLE_CHARS_RE, "").trim().toLowerCase();
}

// One-time codes are short-lived and single-use, so a plain SHA-256 digest
// (no per-code salt) is sufficient — the value is never persisted anywhere
// an attacker could offline-brute-force it, only compared via timingSafeEqual.
function hashResetCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

// Sends a notification email via Resend's HTTP API (no SDK needed — a single
// fetch call, which plays nicer with serverless than holding an SMTP
// connection open). `html` is optional so callers that don't need branding
// (there are none left, but keeps the helper honest) can skip it; Resend
// falls back to rendering `text` when `html` is omitted. Throws on failure;
// callers decide whether that's fatal.
async function sendResendEmail(to: string, subject: string, text: string, html?: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("RESEND_API_KEY is not defined in the environment secrets.");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `Hora Certa AI <${RESEND_FROM_EMAIL}>`,
      to: [to],
      subject,
      text,
      ...(html ? { html } : {}),
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Resend respondeu ${response.status}: ${body.slice(0, 500)}`);
  }
}

// Values interpolated into the HTML email templates below can come from user
// input (e.g. the submitted email on the admin-notification path) — escape
// before interpolating so a crafted string can't inject markup into an email
// client that renders it.
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// Shared branded shell for outbound emails — mirrors AuthScreen.tsx's card
// (brand-cream background, brand-teal heading, rounded card) so the code
// email doesn't look like generic/unstyled transactional spam. Table-based
// layout with inline styles for compatibility with Outlook's rendering engine.
function renderBrandedEmailHtml(bodyHtml: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#EFECE1;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
  <tr>
    <td align="center">
      <table role="presentation" width="100%" style="max-width:480px;background-color:#FDFBF7;border-radius:24px;border:1px solid #EFECE1;">
        <tr>
          <td style="padding:32px 32px 8px 32px;text-align:center;">
            <div style="font-size:28px;line-height:1;">&#10084;&#65039;</div>
            <div style="font-size:20px;font-weight:700;color:#0D3E46;margin-top:8px;">Hora Certa</div>
            <div style="font-size:12px;color:#6b7280;margin-top:4px;">Gestão inteligente de medicamentos e receitas médicas</div>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 32px 32px 32px;">${bodyHtml}</td>
        </tr>
      </table>
      <div style="font-size:11px;color:#9ca3af;margin-top:16px;">Hora Certa AI</div>
    </td>
  </tr>
</table>`;
}

function renderResetCodeEmailHtml(code: string, ttlMinutes: number): string {
  return renderBrandedEmailHtml(`
    <p style="font-size:14px;color:#0D3E46;line-height:1.6;margin:0 0 20px 0;">Use o código abaixo para redefinir sua senha:</p>
    <div style="background-color:#FFF1E6;border-radius:16px;padding:20px;text-align:center;margin-bottom:20px;">
      <span style="font-size:32px;font-weight:700;letter-spacing:8px;color:#EAA15F;">${escapeHtml(code)}</span>
    </div>
    <p style="font-size:12px;color:#6b7280;line-height:1.6;margin:0;">Ele expira em ${ttlMinutes} minutos. Se você não solicitou a redefinição de senha, ignore este e-mail.</p>
  `);
}

function renderAdminNotificationEmailHtml(introHtml: string, rows: [string, string][]): string {
  const rowsHtml = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${escapeHtml(label)}</td><td style="padding:6px 0;text-align:right;font-size:13px;font-weight:600;color:#0D3E46;">${escapeHtml(value)}</td></tr>`,
    )
    .join("");
  return renderBrandedEmailHtml(`
    <p style="font-size:14px;color:#0D3E46;line-height:1.6;margin:0 0 16px 0;">${introHtml}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rowsHtml}</table>
  `);
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

// Separate from subscriptionRateLimiter (which gates PAYMENT CREATION) because
// this endpoint is meant to be polled/re-clicked while waiting for a webhook
// that may never arrive — sharing one budget would let a slow PIX confirmation
// exhaust the same limit needed to create a NEW payment attempt.
const paymentVerifyRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  message: { error: "Muitas verificações de pagamento. Tente novamente mais tarde." },
});

const logWriteRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  message: { error: "Limite de registros de log excedido. Tente novamente mais tarde." },
});

// Unauthenticated by nature (runs before the account exists), so IP/email is
// the only key available. Generous ceiling since a normal signup flow may
// retry this a couple of times (typo in the email, resubmission after a
// validation error) before actually registering.
const checkEmailRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  message: { error: "Muitas verificações de e-mail. Tente novamente mais tarde." },
});

// Unauthenticated by nature (it's for people who can't log in), so this is
// the only real defense against someone using it to spam the admin's inbox
// or trigger repeated OTP emails. A legitimate flow can hit this more than
// once (verify, then confirm/resend/force-send), hence the higher ceiling
// than the other admin-adjacent limiters.
const passwordResetRequestRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  message: { error: "Muitas solicitações de redefinição de senha. Tente novamente mais tarde." },
});

// Guards the OTP-verification step against brute-forcing the 6-digit code
// over HTTP, on top of the per-code attempt counter stored in Firestore.
const passwordResetConfirmRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  message: { error: "Muitas tentativas. Tente novamente mais tarde." },
});

// Convidar dispara e-mail para terceiro e um fan-out de escrita na subárvore
// do paciente — as duas coisas que não se quer em laço apertado.
const shareWriteRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  message: { error: "Muitas operações de compartilhamento. Tente novamente mais tarde." },
});

// ==========================================
// COMPARTILHAMENTO ENTRE CUIDADORES
// ==========================================

// A fonte da verdade de quem tem acesso a um medicado é a coleção `shares`.
// As listas `memberUids`/`editorUids` gravadas nos documentos são apenas um
// índice desnormalizado, existente para que firestore.rules decida sem precisar
// de um get() por documento lido.
//
// Esta função reconstrói as listas a partir dos convites ACEITOS e as replica
// pela subárvore inteira do paciente. É idempotente de propósito: recalcula
// tudo do zero em vez de aplicar deltas, então basta reexecutá-la para reparar
// um fan-out que tenha ficado pela metade.
//
// LIMITE CONHECIDO: em serverless isto roda dentro do timeout da invocação. Um
// paciente com histórico muito longo (milhares de doseLogs) pode não terminar
// numa tacada. Como a operação é idempotente, o conserto é reexecutar — mas se
// isso virar rotina, o caminho certo é mover o fan-out para um job de fundo.
async function syncMedicadoShareLists(ownerUid: string, medicadoId: string): Promise<{ memberUids: string[]; editorUids: string[]; docsWritten: number }> {
  const db = getDb();

  const acceptedSnap = await db
    .collection("shares")
    .where("ownerUid", "==", ownerUid)
    .where("medicadoId", "==", medicadoId)
    .where("status", "==", "accepted")
    .get();

  const memberUids: string[] = [];
  const editorUids: string[] = [];
  acceptedSnap.forEach((docSnap) => {
    const share = docSnap.data();
    const uid: string | undefined = share.granteeUid;
    if (!uid) return; // convite aceito sem uid resolvido não deveria existir
    if (!memberUids.includes(uid)) memberUids.push(uid);
    if (share.role === "coadministrador" && !editorUids.includes(uid)) editorUids.push(uid);
  });

  // Revogação grava listas VAZIAS em vez de apagar o campo: `isMember()` testa
  // a pertinência ao array, então [] nega acesso do mesmo jeito e o documento
  // continua com um formato único, mais fácil de inspecionar.
  const lists = { memberUids, editorUids };

  const userRef = db.collection("users").doc(ownerUid);
  const medicadoRef = userRef.collection("medicados").doc(medicadoId);

  // BulkWriter em vez de WriteBatch: batch estoura em 500 escritas e a
  // subárvore de doseLogs passa disso com facilidade.
  const writer = db.bulkWriter();
  let docsWritten = 0;
  const stamp = (ref: FirebaseFirestore.DocumentReference) => {
    writer.set(ref, lists, { merge: true });
    docsWritten++;
  };

  stamp(medicadoRef);

  const [receitasSnap, medicamentosSnap, consultasSnap] = await Promise.all([
    medicadoRef.collection("receitas").get(),
    medicadoRef.collection("medicamentos").get(),
    userRef.collection("consultas").where("medicadoId", "==", medicadoId).get(),
  ]);

  receitasSnap.forEach((d) => stamp(d.ref));
  consultasSnap.forEach((d) => stamp(d.ref));

  for (const medDoc of medicamentosSnap.docs) {
    stamp(medDoc.ref);
    const logsSnap = await medDoc.ref.collection("doseLogs").get();
    logsSnap.forEach((d) => stamp(d.ref));
  }

  await writer.close();
  return { memberUids, editorUids, docsWritten };
}

// Trilha de acesso a dado de saúde. Segue a mesma regra de privacidade dos
// actionLogs escritos pelo cliente: `entityLabel` NUNCA nomeia o paciente —
// só o id — porque a trilha é lida no painel admin por alguém que não tem
// (nem deve ter) acesso ao prontuário.
async function logShareAction(
  action: "update" | "delete",
  actor: { uid: string; name: string; email: string },
  medicadoId: string,
  detail: string,
): Promise<void> {
  try {
    const db = getDb();
    const logId = randomUUID();
    await db.collection("actionLogs").doc(logId).set({
      logId,
      actorId: actor.uid,
      actorName: actor.name,
      actorEmail: actor.email,
      action,
      entityType: "Share",
      entityId: medicadoId,
      entityLabel: detail,
      page: "compartilhamento",
      createdAt: Timestamp.now(),
      expiresAt: expiresInDays(ACTION_LOG_RETENTION_DAYS),
    });
  } catch (err) {
    // Trilha é best-effort: não pode derrubar a operação principal.
    console.warn("Falha ao registrar actionLog de compartilhamento:", err);
  }
}

function renderShareInviteEmailHtml(params: {
  ownerName: string;
  medicadoName: string;
  roleLabel: string;
  roleDescription: string;
  acceptUrl: string;
  ttlDays: number;
}): string {
  return renderBrandedEmailHtml(`
    <p style="font-size:14px;color:#0D3E46;line-height:1.6;margin:0 0 16px 0;">
      <strong>${escapeHtml(params.ownerName)}</strong> convidou você para acompanhar a medicação de
      <strong>${escapeHtml(params.medicadoName)}</strong> no Hora Certa AI.
    </p>
    <div style="background-color:#FFF1E6;border-radius:16px;padding:16px;margin-bottom:20px;">
      <div style="font-size:12px;color:#6b7280;margin-bottom:4px;">Seu acesso</div>
      <div style="font-size:16px;font-weight:700;color:#0D3E46;">${escapeHtml(params.roleLabel)}</div>
      <div style="font-size:12px;color:#6b7280;margin-top:6px;line-height:1.5;">${escapeHtml(params.roleDescription)}</div>
    </div>
    <p style="margin:0 0 20px 0;">
      <a href="${escapeHtml(params.acceptUrl)}" style="display:inline-block;background-color:#EAA15F;color:#FDFBF7;text-decoration:none;font-weight:700;font-size:14px;padding:14px 24px;border-radius:16px;">Revisar convite</a>
    </p>
    <p style="font-size:12px;color:#6b7280;line-height:1.6;margin:0;">
      O acesso só começa depois que você aceitar. O convite expira em ${params.ttlDays} dias, e
      quem convidou pode encerrá-lo a qualquer momento. Se você não esperava este convite, ignore este e-mail.
    </p>
  `);
}

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

// Quanto tempo depois do horário previsto uma dose sem registro vira alerta.
const MISSED_DOSE_GRACE_MS = 30 * 60 * 1000;

// Envia um push para cada destinatário que tenha dispositivo registrado,
// desduplicando por (destinatário, chave). A dedupe É POR DESTINATÁRIO de
// propósito: com uma chave única por dose, o primeiro envio criaria o marcador
// e todos os outros cuidadores seriam silenciosamente pulados.
async function pushToRecipients(
  db: Firestore,
  subsByUser: Map<string, any[]>,
  recipients: string[],
  dedupeKey: string,
  payload: string,
  nowMs: number,
): Promise<number> {
  let sent = 0;
  for (const recipientUid of recipients) {
    const subs = subsByUser.get(recipientUid);
    if (!subs || subs.length === 0) continue;

    const dispatchRef = db
      .collection("users").doc(recipientUid)
      .collection("pushDispatches").doc(subIdFromEndpoint(`${recipientUid}_${dedupeKey}`));
    try {
      await dispatchRef.create({
        userId: recipientUid,
        dedupeKey,
        expiresAt: new Date(nowMs + DISPATCH_TTL_MS).toISOString(),
        createdAt: new Date(nowMs).toISOString(),
      });
    } catch {
      continue; // já despachado para este destinatário
    }

    for (const sub of subs) {
      try {
        await webpush.sendNotification({ endpoint: sub.data.endpoint, keys: sub.data.keys }, payload);
        sent++;
      } catch (err: any) {
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

// Carrega as inscrições de push agrupadas por uid — extraído para os dois jobs
// não duplicarem a lógica de agrupamento. Cada job faz a sua própria varredura
// (são duas por minuto de cron); se isso pesar, o passo seguinte é receber o
// mapa por parâmetro em vez de recarregá-lo.
async function loadSubscriptionsByUser(db: Firestore): Promise<Map<string, any[]>> {
  const subsSnap = await db.collectionGroup("pushSubscriptions").get();
  const subsByUser = new Map<string, any[]>();
  subsSnap.forEach((docSnap) => {
    const data = docSnap.data();
    const uid = data.userId || docSnap.ref.parent.parent?.id;
    if (!uid) return;
    if (!subsByUser.has(uid)) subsByUser.set(uid, []);
    subsByUser.get(uid)!.push({ ref: docSnap.ref, data });
  });
  return subsByUser;
}

// Alerta de dose NÃO tomada: a dose venceu há MISSED_DOSE_GRACE_MS e ninguém
// registrou nada. É o que o acompanhante à distância realmente quer saber — o
// lembrete de "está na hora" é para quem ministra, não para quem observa —, e
// por isso aqui o destino é a lista INTEIRA de membros, incluindo quem só lê.
export async function dispatchMissedDoseAlerts(): Promise<number> {
  if (!pushEnabled) return 0;
  const db = getDb();
  const nowMs = Date.now();
  const targetMs = nowMs - MISSED_DOSE_GRACE_MS;

  const subsByUser = await loadSubscriptionsByUser(db);
  if (subsByUser.size === 0) return 0;

  const medsSnap = await db.collectionGroup("medicamentos").where("status", "==", "active").get();
  let sent = 0;

  for (const medDoc of medsSnap.docs) {
    const med = medDoc.data();
    const ownerUid: string | undefined = med.userId;
    if (!ownerUid) continue;

    // SÓ para paciente compartilhado. Disparar isto para todo mundo criaria um
    // segundo fluxo de notificação para cada usuário que já existe — gente que
    // nunca pediu por ele e que hoje só recebe o lembrete da dose. Quem tem um
    // paciente sozinho não passa a ser cobrado por não ter marcado a dose.
    const members: string[] = Array.isArray(med.memberUids) ? med.memberUids : [];
    if (members.length === 0) continue;

    // A dose que ESTAVA marcada para o minuto de `targetMs`.
    const doseMs = doseSlotAtMs(med, targetMs);
    if (doseMs == null) continue;

    const recipients = [ownerUid, ...members]
      .filter((uid, i, arr) => arr.indexOf(uid) === i && subsByUser.has(uid));
    if (recipients.length === 0) continue;

    // Só consulta os doseLogs dos poucos medicamentos com dose vencida neste
    // minuto — não de todos os ativos.
    const doseMinute = Math.floor(doseMs / 60_000);
    const logsSnap = await medDoc.ref.collection("doseLogs").get();
    const alreadyLogged = logsSnap.docs.some((logDoc) => {
      const t = new Date(logDoc.data().plannedTime).getTime();
      return Number.isFinite(t) && Math.floor(t / 60_000) === doseMinute;
    });
    if (alreadyLogged) continue;

    const medId = med.medicamentoId || medDoc.id;
    // Sem PHI no corpo, pela mesma política do lembrete comum: isto aparece na
    // tela de bloqueio de um cuidador que pode estar em público.
    const payload = JSON.stringify({
      title: "Dose sem registro",
      body: "Uma dose passou do horário e ainda não foi marcada como tomada. Abra o aplicativo para verificar.",
      tag: `missed_${medId}_${doseMs}`,
      data: { url: "/app" },
    });

    sent += await pushToRecipients(db, subsByUser, recipients, `missed_${medId}_${doseMs}`, payload, nowMs);
  }

  return sent;
}

// One dispatch pass: find every active medicine whose reminder is due this
// minute and push a generic (no-PHI) reminder to the people who ADMINISTER it —
// the owner plus any coadministrador (`editorUids`). Quem só acompanha
// (acompanhante) fica de fora daqui de propósito: receber um alerta a cada dose
// de outra pessoa é ruído, e o que essa pessoa quer é o alerta de dose perdida.
export async function dispatchDueReminders(): Promise<number> {
  if (!pushEnabled) return 0;
  const db = getDb();
  const nowMs = Date.now();

  // Only users who actually have a subscription are worth processing.
  const subsByUser = await loadSubscriptionsByUser(db);
  if (subsByUser.size === 0) return 0;

  const medsSnap = await db.collectionGroup("medicamentos").where("status", "==", "active").get();
  let sent = 0;

  for (const medDoc of medsSnap.docs) {
    const med = medDoc.data();
    const ownerUid: string | undefined = med.userId;
    if (!ownerUid) continue;

    const doseMs = dueDoseMs(med, nowMs);
    if (doseMs == null) continue;

    // Titular + coadministradores. O isolamento continua de pé: `editorUids` só
    // é gravado pelo aceite de um convite, do lado do servidor.
    const recipients = [ownerUid, ...(Array.isArray(med.editorUids) ? med.editorUids : [])]
      .filter((uid, i, arr) => arr.indexOf(uid) === i && subsByUser.has(uid));
    if (recipients.length === 0) continue;

    const medId = med.medicamentoId || medDoc.id;
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

    sent += await pushToRecipients(db, subsByUser, recipients, `dose_${medId}_${doseMs}`, payload, nowMs);
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

  // Health check. `build` is a hand-bumped marker: on serverless it is the only
  // reliable way to tell WHICH deployment is actually answering, since a stale
  // function can keep serving after a new deploy reports "Ready".
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", build: "scan-limit-1", time: new Date().toISOString() });
  });

  // AI Key Status Check. `model` is echoed back (not a secret) so an operator
  // can confirm from outside WHICH model a deployment resolved — GEMINI_MODEL
  // is an env override, and otherwise there is no way to tell without shell
  // access. The client only reads `hasKey`.
  app.get("/api/gemini/status", (req, res) => {
    res.json({ hasKey: !!process.env.GEMINI_API_KEY, model: GEMINI_MODEL });
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
        expiresAt: expiresInDays(LOGIN_LOG_RETENTION_DAYS),
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

  // Hard-deletes a user: the whole Firestore tree AND the Firebase Auth
  // account. This is the "apague meus dados" (LGPD) path — the client-side
  // delete only removed the profile doc, leaving the login working and every
  // subcollection (prontuário, receitas, doses) orphaned but intact.
  //
  // Only the Admin SDK can delete an Auth account, so this must live server-side.
  app.delete("/api/admin/users/:uid", requireAdmin, adminActionRateLimiter, async (req, res) => {
    const targetUid = req.params.uid;
    const actorUid = (req as any).uid as string;

    try {
      if (!targetUid || typeof targetUid !== "string") {
        res.status(400).json({ error: "Parâmetro 'uid' ausente ou inválido." });
        return;
      }
      // Deleting yourself would destroy the only admin account and lock the
      // portal out permanently — there is no UI to grant the claim back.
      if (targetUid === actorUid) {
        res.status(400).json({ error: "Não é possível excluir a própria conta de administrador." });
        return;
      }

      // Refuse to delete another admin: recovering one requires shell access to
      // setAdminClaim.js, so this must never be a one-click mistake.
      try {
        const target = await getAuth(getAdminApp()).getUser(targetUid);
        if (target.customClaims?.admin === true) {
          res.status(403).json({ error: "Não é possível excluir uma conta de administrador." });
          return;
        }
      } catch (err: any) {
        // Auth record already gone: still allow the Firestore cleanup below so
        // orphaned data can be purged.
        if (err?.code !== "auth/user-not-found") throw err;
      }

      // recursiveDelete walks every subcollection (medicados -> receitas /
      // medicamentos -> doseLogs, consultas, farmacias, cupons,
      // pushSubscriptions, payments, pushDispatches). A plain delete() on the
      // doc would leave all of it behind, invisible but stored.
      const db = getDb();
      await db.recursiveDelete(db.collection("users").doc(targetUid));

      // As trilhas de auditoria são top-level e NÃO são alcançadas acima —
      // sem isto a exclusão deixaria para trás nome de paciente (actionLogs),
      // IP + e-mail (loginLogs) e o vínculo do titular (errorLogs), quebrando
      // a promessa da própria Política de Privacidade (seção 9).
      // Best-effort e reportado: se falhar, a conta já foi removida e o
      // operador precisa saber que a trilha ficou pendente — daí o flag na
      // resposta em vez de um 500 que sugeriria que nada aconteceu.
      let auditTrail: Awaited<ReturnType<typeof purgeUserAuditTrail>> | null = null;
      let auditTrailPurged = false;
      try {
        auditTrail = await purgeUserAuditTrail(targetUid);
        auditTrailPurged = true;
      } catch (purgeErr) {
        console.error("Falha ao expurgar trilha de auditoria:", purgeErr);
        await logServerError("DELETE /api/admin/users/:uid (purga de logs)", purgeErr, actorUid);
      }

      // Também top-level, e com um efeito que o recursiveDelete não cobre: se o
      // excluído era CONVIDADO na conta de outra pessoa, o uid dele continuaria
      // gravado nas listas de acesso da árvore alheia. Roda antes do
      // deleteUser porque precisa ler o e-mail do registro do Auth.
      let shares: Awaited<ReturnType<typeof purgeUserShares>> | null = null;
      let sharesPurged = false;
      try {
        shares = await purgeUserShares(targetUid);
        sharesPurged = true;
      } catch (shareErr) {
        console.error("Falha ao expurgar compartilhamentos:", shareErr);
        await logServerError("DELETE /api/admin/users/:uid (purga de shares)", shareErr, actorUid);
      }

      let authDeleted = false;
      try {
        await getAuth(getAdminApp()).deleteUser(targetUid);
        authDeleted = true;
      } catch (err: any) {
        if (err?.code !== "auth/user-not-found") throw err;
      }

      res.json({ success: true, authDeleted, auditTrailPurged, auditTrail, sharesPurged, shares });
    } catch (error: any) {
      console.error("Admin delete-user error:", error);
      await logServerError("DELETE /api/admin/users/:uid", error, actorUid);
      res.status(500).json({
        error: "Falha ao excluir o usuário.",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Suspende / reativa uma conta DE VERDADE.
  //
  // Antes, "suspender" só gravava status:"suspended" no doc do Firestore. Isso
  // é apenas um rótulo: as regras de segurança consultam isUserActive() somente
  // nos `allow create/update`, nunca nos `allow get/list`, e o token do usuário
  // continuava válido — ou seja, quem já estava logado seguia lendo o próprio
  // prontuário e chamando os endpoints normalmente. Só o Admin SDK corta acesso
  // de fato, daí este endpoint.
  //
  // disabled:true impede novos logins; revokeRefreshTokens invalida a sessão já
  // existente, fazendo o getIdToken(true) do cliente falhar com
  // auth/user-disabled | auth/user-token-expired — dois códigos que
  // isDeadSessionError (src/firebase.ts) já reconhece, então o app derruba a
  // sessão sozinho no próximo foreground.
  app.post("/api/admin/users/:uid/status", requireAdmin, adminActionRateLimiter, async (req, res) => {
    const targetUid = req.params.uid;
    const actorUid = (req as any).uid as string;

    try {
      const { status } = req.body || {};
      if (status !== "active" && status !== "suspended") {
        res.status(400).json({ error: "Parâmetro 'status' deve ser 'active' ou 'suspended'." });
        return;
      }
      if (!targetUid || typeof targetUid !== "string") {
        res.status(400).json({ error: "Parâmetro 'uid' ausente ou inválido." });
        return;
      }
      // Mesma proteção do delete: suspender a si mesmo tranca o portal, e
      // reativar exigiria acesso a shell.
      if (targetUid === actorUid) {
        res.status(400).json({ error: "Não é possível suspender a própria conta de administrador." });
        return;
      }

      const adminAuth = getAuth(getAdminApp());
      const suspend = status === "suspended";

      try {
        const target = await adminAuth.getUser(targetUid);
        if (target.customClaims?.admin === true) {
          res.status(403).json({ error: "Não é possível suspender uma conta de administrador." });
          return;
        }
      } catch (err: any) {
        // Sem conta de Auth (perfil órfão): ainda vale refletir no Firestore.
        if (err?.code !== "auth/user-not-found") throw err;
      }

      let authUpdated = false;
      try {
        await adminAuth.updateUser(targetUid, { disabled: suspend });
        if (suspend) {
          // Sem isto o ID token já emitido continua aceito até expirar (~1h).
          await adminAuth.revokeRefreshTokens(targetUid);
        }
        authUpdated = true;
      } catch (err: any) {
        if (err?.code !== "auth/user-not-found") throw err;
      }

      // Espelha no perfil para o painel e as regras continuarem coerentes.
      await getDb().collection("users").doc(targetUid).set({ status }, { merge: true });

      res.json({ success: true, status, authUpdated });
    } catch (error: any) {
      console.error("Admin set-user-status error:", error);
      await logServerError("POST /api/admin/users/:uid/status", error, actorUid);
      res.status(500).json({ error: "Falha ao alterar o status do usuário." });
    }
  });

  // Pré-checagem de cadastro: o client chama isto ANTES de
  // createUserWithEmailAndPassword para evitar criar uma segunda conta
  // Firebase Auth para um e-mail já cadastrado — o SDK client-side rejeita
  // duplicidade na maioria dos casos (auth/email-already-in-use), mas isso
  // depende inteiramente da configuração do projeto no Firebase Console; esta
  // é uma trava própria da aplicação, via Admin SDK (getUserByEmail).
  // Best-effort: erros aqui não bloqueiam o cadastro (fail open), já que o
  // SDK do Firebase continua sendo a defesa autoritativa.
  app.post("/api/auth/check-email", checkEmailRateLimiter, async (req, res) => {
    try {
      const { email } = req.body || {};
      if (!email || typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        res.status(400).json({ error: "Informe um e-mail válido." });
        return;
      }

      const trimmedEmail = normalizeEmail(email);
      try {
        await getAuth(getAdminApp()).getUserByEmail(trimmedEmail);
        res.json({ available: false });
      } catch (err: any) {
        if (err?.code === "auth/user-not-found") {
          res.json({ available: true });
          return;
        }
        throw err;
      }
    } catch (error: any) {
      console.error("Check-email error:", error);
      await logServerError("POST /api/auth/check-email", error);
      res.status(500).json({ error: "Falha ao verificar o e-mail." });
    }
  });

  // "Esqueci minha senha": the project deliberately does not use Firebase's
  // sendPasswordResetEmail/sendEmailVerification (see CLAUDE.md). Instead:
  //   - If the submitted email matches a real account, a one-time code is
  //     emailed to that account's OWN registered address via Resend. Only
  //     someone with inbox access can ever complete the reset (see the
  //     confirm endpoint below), so that possession is the real verification
  //     factor — an earlier version of this endpoint also required the
  //     account's registered name to match before sending, but that only
  //     added friction (people forget the exact name/format they signed up
  //     with) without adding real security, since the OTP already gates the
  //     actual password change.
  //   - If the email doesn't match any account, nothing is sent on the first
  //     call. The caller may explicitly opt in via `forceSend` to notify the
  //     single admin anyway (e.g. the user isn't sure which email they used),
  //     who can investigate and reset manually via the existing
  //     /api/admin/change-user-password flow.
  app.post("/api/auth/request-password-reset", passwordResetRequestRateLimiter, async (req, res) => {
    try {
      const { email, forceSend } = req.body || {};

      if (!email || typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        res.status(400).json({ error: "Informe um e-mail válido." });
        return;
      }

      const trimmedEmail = normalizeEmail(email);

      let matchedUid: string | null = null;
      try {
        matchedUid = (await getAuth(getAdminApp()).getUserByEmail(trimmedEmail)).uid;
      } catch (err: any) {
        if (err?.code !== "auth/user-not-found") throw err;
      }

      if (matchedUid) {
        const code = String(randomInt(100000, 1000000));
        await getDb()
          .collection("passwordResetCodes")
          .doc(matchedUid)
          .set({
            codeHash: hashResetCode(code),
            expiresAt: new Date(Date.now() + PASSWORD_RESET_CODE_TTL_MS).toISOString(),
            attempts: 0,
            createdAt: new Date().toISOString(),
          });

        try {
          await sendResendEmail(
            trimmedEmail,
            "HoraCerta AI — código para redefinir sua senha",
            [
              `Seu código de verificação é: ${code}`,
              `Ele expira em ${PASSWORD_RESET_CODE_TTL_MS / 60000} minutos.`,
              "Se você não solicitou a redefinição de senha, ignore este e-mail.",
            ].join("\n"),
            renderResetCodeEmailHtml(code, PASSWORD_RESET_CODE_TTL_MS / 60000),
          );
        } catch (emailErr) {
          console.error("Falha ao enviar código de redefinição:", emailErr);
          await logServerError("POST /api/auth/request-password-reset (otp email)", emailErr, matchedUid);
          res.status(500).json({ error: "Não foi possível enviar o código de verificação. Tente novamente." });
          return;
        }

        res.json({
          matched: true,
          message: "Enviamos um código de verificação para o seu e-mail cadastrado. Informe-o para definir uma nova senha.",
        });
        return;
      }

      // No match: only notify the admin if the caller explicitly asked to,
      // after already being told the email wasn't found.
      if (forceSend === true) {
        try {
          await sendResendEmail(
            ADMIN_NOTIFICATION_EMAIL,
            "HoraCerta AI — solicitação de redefinição de senha (e-mail não encontrado)",
            [
              "O e-mail abaixo NÃO foi encontrado no cadastro automaticamente — confirme a identidade antes de agir.",
              `E-mail informado: ${trimmedEmail.slice(0, 200)}`,
              `Data/hora: ${new Date().toISOString()}`,
            ].join("\n"),
            renderAdminNotificationEmailHtml(
              "O e-mail abaixo <strong>NÃO</strong> foi encontrado no cadastro automaticamente — confirme a identidade antes de agir.",
              [
                ["E-mail informado", trimmedEmail.slice(0, 200)],
                ["Data/hora", new Date().toLocaleString("pt-BR")],
              ],
            ),
          );
        } catch (emailErr) {
          console.error("Falha ao enviar e-mail de solicitação de reset:", emailErr);
          await logServerError("POST /api/auth/request-password-reset (admin email)", emailErr);
        }
        res.json({ matched: false, message: "Solicitação enviada! Entraremos em contato em breve." });
        return;
      }

      res.json({
        matched: false,
        message: "Não encontramos esse e-mail no nosso cadastro. Você pode solicitar o envio mesmo assim para uma verificação manual.",
      });
    } catch (error: any) {
      console.error("Password reset request error:", error);
      await logServerError("POST /api/auth/request-password-reset", error);
      res.status(500).json({ error: "Falha ao processar a solicitação." });
    }
  });

  // Second step of the self-service flow above: exchanges a valid, unexpired
  // one-time code for an actual password change via the Admin SDK. Errors
  // are intentionally generic ("código inválido ou expirado") whether the
  // account doesn't exist, the code is wrong, or it expired — same reasoning
  // as the request endpoint, this must never confirm which emails exist.
  app.post("/api/auth/confirm-password-reset", passwordResetConfirmRateLimiter, async (req, res) => {
    const INVALID_CODE_RESPONSE = { error: "Código inválido ou expirado. Solicite um novo código." };

    try {
      const { email, code, newPassword } = req.body || {};

      if (!email || typeof email !== "string") {
        res.status(400).json({ error: "Informe o e-mail." });
        return;
      }
      if (!code || typeof code !== "string" || !/^\d{6}$/.test(code)) {
        res.status(400).json(INVALID_CODE_RESPONSE);
        return;
      }
      if (!newPassword || typeof newPassword !== "string" || !/^(?=.*[A-Za-z])(?=.*\d).{6,}$/.test(newPassword)) {
        res.status(400).json({ error: "A nova senha deve ter pelo menos 6 caracteres, com letra e número." });
        return;
      }

      let uid: string;
      try {
        uid = (await getAuth(getAdminApp()).getUserByEmail(normalizeEmail(email))).uid;
      } catch (err: any) {
        if (err?.code === "auth/user-not-found") {
          res.status(400).json(INVALID_CODE_RESPONSE);
          return;
        }
        throw err;
      }

      const codeRef = getDb().collection("passwordResetCodes").doc(uid);
      const codeSnap = await codeRef.get();

      if (!codeSnap.exists) {
        res.status(400).json(INVALID_CODE_RESPONSE);
        return;
      }

      const codeData = codeSnap.data()!;
      if (new Date(codeData.expiresAt).getTime() < Date.now()) {
        await codeRef.delete();
        res.status(400).json(INVALID_CODE_RESPONSE);
        return;
      }
      if ((codeData.attempts || 0) >= PASSWORD_RESET_CODE_MAX_ATTEMPTS) {
        await codeRef.delete();
        res.status(400).json({ error: "Muitas tentativas incorretas. Solicite um novo código." });
        return;
      }

      const providedHash = hashResetCode(code);
      const storedHashBuf = Buffer.from(codeData.codeHash, "hex");
      const providedHashBuf = Buffer.from(providedHash, "hex");
      const codeMatches =
        storedHashBuf.length === providedHashBuf.length && timingSafeEqual(storedHashBuf, providedHashBuf);

      if (!codeMatches) {
        await codeRef.update({ attempts: (codeData.attempts || 0) + 1 });
        res.status(400).json({ error: "Código incorreto. Tente novamente." });
        return;
      }

      await codeRef.delete();
      await getAuth(getAdminApp()).updateUser(uid, { password: newPassword });

      res.json({ success: true });
    } catch (error: any) {
      console.error("Password reset confirm error:", error);
      await logServerError("POST /api/auth/confirm-password-reset", error);
      res.status(500).json({ error: "Falha ao redefinir a senha." });
    }
  });

  // AI Prescription Reading Endpoint
  app.post("/api/gemini/extract", requireAuth, requireScanAccess("prescription"), geminiRateLimiter, async (req, res) => {
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

      // The scan succeeded — if this was a trial user (not exempt, not paid),
      // count it against their one free prescription scan. Never blocks the
      // response: a bookkeeping hiccup shouldn't cost the user a result they
      // already paid Gemini tokens to produce.
      if ((req as any).scanAccessState === "trial") {
        getDb().collection("users").doc((req as any).uid)
          .set({ trialPrescriptionScansUsed: FieldValue.increment(1) }, { merge: true })
          .catch((e) => console.warn("Falha ao incrementar trialPrescriptionScansUsed:", e));
      }

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
  app.post("/api/gemini/extract-receipt", requireAuth, requireScanAccess("receipt"), geminiRateLimiter, async (req, res) => {
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

      // Same trial-scan bookkeeping as /api/gemini/extract, for the receipt type.
      if ((req as any).scanAccessState === "trial") {
        getDb().collection("users").doc((req as any).uid)
          .set({ trialReceiptScansUsed: FieldValue.increment(1) }, { merge: true })
          .catch((e) => console.warn("Falha ao incrementar trialReceiptScansUsed:", e));
      }

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
      // Roda em try próprio: uma falha no alerta de dose perdida não pode
      // impedir o lembrete comum, que é a função principal do cron.
      let missed = 0;
      try {
        missed = await dispatchMissedDoseAlerts();
      } catch (missedErr) {
        console.error("Missed-dose dispatch error:", missedErr);
        await logServerError("POST /api/push/dispatch (dose perdida)", missedErr);
      }
      res.json({ success: true, sent, missed });
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
      let missed = 0;
      try {
        missed = await dispatchMissedDoseAlerts();
      } catch (missedErr) {
        console.error("Missed-dose dispatch error:", missedErr);
        await logServerError("GET /api/push/dispatch (dose perdida)", missedErr);
      }
      res.json({ success: true, sent, missed });
    } catch (error: any) {
      console.error("Push dispatch error:", error);
      await logServerError("GET /api/push/dispatch", error);
      res.status(500).json({ error: "Falha ao despachar lembretes." });
    }
  });

  // ==========================================
  // COMPARTILHAMENTO ENTRE CUIDADORES
  // ==========================================
  //
  // Todo o ciclo do convite passa por aqui, e não pelo cliente, por um motivo
  // só: aceitar um convite propaga listas de acesso por toda a subárvore do
  // paciente. firestore.rules dá escrita ZERO ao cliente em `shares` — se não
  // desse, qualquer um poderia se autoconceder acesso ao prontuário de outra
  // pessoa forjando um documento.

  const SHARE_ROLE_LABELS: Record<string, { label: string; description: string }> = {
    coadministrador: {
      label: "Coadministrador",
      description: "Pode registrar doses e cuidar dos medicamentos, receitas e consultas deste paciente.",
    },
    acompanhante: {
      label: "Acompanhante",
      description: "Pode acompanhar a adesão ao tratamento, sem alterar nada.",
    },
  };

  // Nome e e-mail do ator para a trilha de auditoria.
  async function loadActor(uid: string): Promise<{ uid: string; name: string; email: string }> {
    const snap = await getDb().collection("users").doc(uid).get();
    const data = snap.data() || {};
    return {
      uid,
      name: typeof data.name === "string" ? data.name : "(sem nome)",
      email: typeof data.email === "string" ? data.email : "(sem e-mail)",
    };
  }

  // Lista os compartilhamentos que dizem respeito ao chamador, nas duas pontas:
  // os que ele concedeu e os que recebeu. É por `asGrantee` que o cliente
  // descobre de quais árvores alheias ele precisa sincronizar dados.
  app.get("/api/shares", requireAuth, async (req, res) => {
    const uid = (req as any).uid as string;
    try {
      const db = getDb();
      // Sem orderBy de propósito: só filtros de igualdade dispensam índice
      // composto no Firestore. São poucos registros — a ordenação é do cliente.
      const [ownerSnap, granteeSnap] = await Promise.all([
        db.collection("shares").where("ownerUid", "==", uid).get(),
        db.collection("shares").where("granteeUid", "==", uid).where("status", "==", "accepted").get(),
      ]);

      // Convites ainda pendentes não têm granteeUid resolvido, então só podem
      // ser achados pelo e-mail — que vem do registro do Auth, nunca do corpo
      // da requisição.
      const authUser = await getAuth(getAdminApp()).getUser(uid);
      const myEmail = normalizeEmail(authUser.email || "");
      const pendingSnap = myEmail
        ? await db.collection("shares").where("granteeEmail", "==", myEmail).where("status", "==", "pending").get()
        : null;

      const asGrantee = [
        ...granteeSnap.docs.map((d) => d.data()),
        ...(pendingSnap ? pendingSnap.docs.map((d) => d.data()) : []),
      ];

      res.json({
        asOwner: ownerSnap.docs.map((d) => d.data()),
        asGrantee,
      });
    } catch (error: any) {
      console.error("List shares error:", error);
      await logServerError("GET /api/shares", error, uid);
      res.status(500).json({ error: "Falha ao carregar os compartilhamentos." });
    }
  });

  // Convida alguém para acompanhar UM paciente.
  app.post("/api/shares", requireAuth, shareWriteRateLimiter, async (req, res) => {
    const uid = (req as any).uid as string;
    try {
      const { medicadoId, granteeEmail, role } = req.body || {};

      if (typeof medicadoId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(medicadoId)) {
        res.status(400).json({ error: "Paciente inválido." });
        return;
      }
      if (role !== "coadministrador" && role !== "acompanhante") {
        res.status(400).json({ error: "Papel inválido." });
        return;
      }
      if (typeof granteeEmail !== "string" || !granteeEmail.includes("@") || granteeEmail.length > 128) {
        res.status(400).json({ error: "E-mail do convidado inválido." });
        return;
      }

      const db = getDb();
      const email = normalizeEmail(granteeEmail);

      const ownerAuth = await getAuth(getAdminApp()).getUser(uid);
      if (normalizeEmail(ownerAuth.email || "") === email) {
        res.status(400).json({ error: "Você já tem acesso a este paciente." });
        return;
      }

      // O convite só existe para um paciente que é mesmo do titular.
      const medicadoRef = db.collection("users").doc(uid).collection("medicados").doc(medicadoId);
      const medicadoSnap = await medicadoRef.get();
      if (!medicadoSnap.exists) {
        res.status(404).json({ error: "Paciente não encontrado." });
        return;
      }
      const medicadoName = String(medicadoSnap.data()?.name || "Paciente");

      const existingSnap = await db
        .collection("shares")
        .where("ownerUid", "==", uid)
        .where("medicadoId", "==", medicadoId)
        .get();
      const live = existingSnap.docs.map((d) => d.data()).filter((s) => s.status !== "revoked");

      if (live.some((s) => s.granteeEmail === email)) {
        res.status(409).json({ error: "Já existe um convite ativo para este e-mail." });
        return;
      }
      if (live.length >= MAX_SHARES_PER_MEDICADO) {
        res.status(409).json({ error: `Limite de ${MAX_SHARES_PER_MEDICADO} cuidadores por paciente atingido.` });
        return;
      }

      const owner = await loadActor(uid);
      const shareId = randomUUID();
      const now = new Date();
      const share = {
        shareId,
        ownerUid: uid,
        ownerName: owner.name,
        medicadoId,
        medicadoName,
        granteeEmail: email,
        role,
        status: "pending" as const,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + SHARE_INVITE_TTL_MS).toISOString(),
      };
      await db.collection("shares").doc(shareId).set(share);

      // O convite é gravado ANTES do e-mail e o resultado do envio é reportado
      // em vez de derrubar a operação: sem RESEND_API_KEY (dev) o fluxo segue
      // testável, e em produção o titular vê que precisa reenviar em vez de
      // achar que deu tudo certo.
      const appUrl = (process.env.APP_URL || "").replace(/\/+$/, "");
      const acceptUrl = `${appUrl}/app#/convite/${shareId}`;
      const roleInfo = SHARE_ROLE_LABELS[role];
      let emailSent = false;
      let emailError: string | undefined;
      try {
        await sendResendEmail(
          email,
          `${owner.name} convidou você para acompanhar ${medicadoName}`,
          `${owner.name} convidou você para acompanhar a medicação de ${medicadoName} no Hora Certa AI, como ${roleInfo.label}.\n\n${roleInfo.description}\n\nAcesse para revisar o convite: ${acceptUrl}\n\nO acesso só começa depois que você aceitar. O convite expira em 7 dias.`,
          renderShareInviteEmailHtml({
            ownerName: owner.name,
            medicadoName,
            roleLabel: roleInfo.label,
            roleDescription: roleInfo.description,
            acceptUrl,
            ttlDays: Math.round(SHARE_INVITE_TTL_MS / (24 * 60 * 60 * 1000)),
          }),
        );
        emailSent = true;
      } catch (err: any) {
        emailError = err instanceof Error ? err.message : String(err);
        console.warn("Falha ao enviar convite de compartilhamento:", emailError);
      }

      await logShareAction("update", owner, medicadoId, `convite ${role} enviado`);
      res.json({ success: true, share, emailSent, emailError });
    } catch (error: any) {
      console.error("Create share error:", error);
      await logServerError("POST /api/shares", error, uid);
      res.status(500).json({ error: "Falha ao criar o convite." });
    }
  });

  // Aceite do convidado — é aqui que o acesso passa a existir de fato.
  app.post("/api/shares/:shareId/accept", requireAuth, shareWriteRateLimiter, async (req, res) => {
    const uid = (req as any).uid as string;
    const shareId = req.params.shareId;
    try {
      const db = getDb();
      const shareRef = db.collection("shares").doc(shareId);
      const snap = await shareRef.get();
      if (!snap.exists) {
        res.status(404).json({ error: "Convite não encontrado." });
        return;
      }
      const share = snap.data()!;

      if (share.status === "accepted" && share.granteeUid === uid) {
        res.json({ success: true, alreadyAccepted: true });
        return;
      }
      if (share.status !== "pending") {
        res.status(409).json({ error: "Este convite não está mais disponível." });
        return;
      }

      // O e-mail vem do registro do Auth, não do token: um ID token em cache
      // pode carregar um e-mail já trocado desde então.
      const authUser = await getAuth(getAdminApp()).getUser(uid);
      if (normalizeEmail(authUser.email || "") !== share.granteeEmail) {
        res.status(403).json({ error: "Este convite foi enviado para outro e-mail." });
        return;
      }
      if (share.expiresAt && new Date(share.expiresAt).getTime() < Date.now()) {
        res.status(410).json({ error: "Este convite expirou. Peça um novo." });
        return;
      }

      const medicadoSnap = await db
        .collection("users").doc(share.ownerUid)
        .collection("medicados").doc(share.medicadoId)
        .get();
      if (!medicadoSnap.exists) {
        res.status(404).json({ error: "O paciente deste convite não existe mais." });
        return;
      }

      // expiresAt PRECISA sair no aceite. Se ficasse, o TTL nativo do Firestore
      // apagaria o documento do convite dias depois enquanto os memberUids
      // continuariam gravados na subárvore — acesso ativo sem registro que o
      // explique, e sem nada que o titular consiga revogar pela UI.
      await shareRef.update({
        granteeUid: uid,
        status: "accepted",
        acceptedAt: new Date().toISOString(),
        expiresAt: FieldValue.delete(),
      });

      const result = await syncMedicadoShareLists(share.ownerUid, share.medicadoId);
      const actor = await loadActor(uid);
      await logShareAction("update", actor, share.medicadoId, `convite ${share.role} aceito`);

      res.json({ success: true, docsWritten: result.docsWritten });
    } catch (error: any) {
      console.error("Accept share error:", error);
      await logServerError("POST /api/shares/:shareId/accept", error, uid);
      res.status(500).json({ error: "Falha ao aceitar o convite." });
    }
  });

  // Revogação pelo titular, ou saída/recusa pelo próprio convidado.
  app.delete("/api/shares/:shareId", requireAuth, shareWriteRateLimiter, async (req, res) => {
    const uid = (req as any).uid as string;
    const shareId = req.params.shareId;
    try {
      const db = getDb();
      const shareRef = db.collection("shares").doc(shareId);
      const snap = await shareRef.get();
      if (!snap.exists) {
        res.status(404).json({ error: "Convite não encontrado." });
        return;
      }
      const share = snap.data()!;

      const isOwner = share.ownerUid === uid;
      let isGrantee = share.granteeUid === uid;
      if (!isOwner && !isGrantee) {
        // Convite ainda pendente: o convidado só é identificável pelo e-mail.
        const authUser = await getAuth(getAdminApp()).getUser(uid);
        isGrantee = normalizeEmail(authUser.email || "") === share.granteeEmail;
      }
      if (!isOwner && !isGrantee) {
        res.status(403).json({ error: "Você não pode encerrar este compartilhamento." });
        return;
      }

      if (share.status !== "revoked") {
        await shareRef.update({
          status: "revoked",
          revokedAt: new Date().toISOString(),
          // Volta a ter expiresAt para o TTL limpar o registro depois. Aqui é
          // seguro: sem status "accepted" o fan-out abaixo já tirou o acesso.
          expiresAt: new Date(Date.now() + SHARE_INVITE_TTL_MS).toISOString(),
        });
      }

      // Roda sempre, mesmo se já estava revogado: é a rede de segurança para um
      // fan-out anterior que tenha falhado no meio.
      const result = await syncMedicadoShareLists(share.ownerUid, share.medicadoId);
      const actor = await loadActor(uid);
      await logShareAction("delete", actor, share.medicadoId, isOwner ? "acesso revogado pelo titular" : "acesso encerrado pelo convidado");

      res.json({ success: true, docsWritten: result.docsWritten });
    } catch (error: any) {
      console.error("Revoke share error:", error);
      await logServerError("DELETE /api/shares/:shareId", error, uid);
      res.status(500).json({ error: "Falha ao encerrar o compartilhamento." });
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
        scanLimitExempt: merged.scanLimitExempt ?? false,
        trialPrescriptionScansUsed: merged.trialPrescriptionScansUsed ?? 0,
        trialReceiptScansUsed: merged.trialReceiptScansUsed ?? 0,
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

  // PULL-based fallback for the webhook's PUSH: actively re-checks one payment
  // directly with Mercado Pago and reconciles it if approved. Exists because
  // the webhook can simply never arrive (delivery failure on Mercado Pago's
  // side, not something our own logs can ever see) — the client already holds
  // the paymentId (returned by /api/subscription/pix, or appended by MP to the
  // Checkout Pro back_url as payment_id/collection_id), so it can ask us to
  // check directly instead of only waiting on the webhook. Reuses
  // activateSubscription, which is idempotent, so calling this after the
  // webhook already succeeded is a harmless no-op.
  app.post("/api/subscription/verify-payment", requireAuth, paymentVerifyRateLimiter, async (req, res) => {
    try {
      const uid = (req as any).uid as string;
      const paymentId = req.body?.paymentId;
      if (paymentId == null || (typeof paymentId !== "string" && typeof paymentId !== "number")) {
        res.status(400).json({ error: "paymentId ausente ou inválido." });
        return;
      }

      const payment = new Payment(getMpConfig());
      const info = await payment.get({ id: String(paymentId) });

      // Ownership check: the payment must be tied to the CALLING user, never a
      // client-supplied uid — otherwise one user could pass another's payment
      // id and either snoop on it or, worse, trigger activation on their own
      // account off someone else's money.
      const infoUid = (info.metadata?.uid as string | undefined) || (info.external_reference as string | undefined);
      if (infoUid !== uid) {
        res.status(403).json({ error: "Este pagamento não pertence à sua conta." });
        return;
      }

      let subscriptionActive = false;
      if (info.status === "approved") {
        let plan = info.metadata?.plan as PlanId | undefined;
        if (plan !== "monthly" && plan !== "yearly") {
          const amt = Number(info.transaction_amount);
          plan = amt === PLANS.yearly.amount ? "yearly" : amt === PLANS.monthly.amount ? "monthly" : undefined;
        }
        if (plan) {
          await activateSubscription(uid, plan, info.id ?? paymentId);
          subscriptionActive = true;
        } else {
          await logServerError(
            "POST /api/subscription/verify-payment (aprovado sem plano)",
            new Error(`Pagamento ${info.id ?? paymentId} aprovado (R$ ${info.transaction_amount}) mas não foi possível determinar o plano.`),
            uid
          );
        }
      }

      res.json({ status: info.status, subscriptionActive });
    } catch (error: any) {
      console.error("Verify payment error:", error);
      await logServerError("POST /api/subscription/verify-payment", error, (req as any).uid);
      res.status(500).json({ error: "Falha ao verificar o pagamento." });
    }
  });

  // Public webhook Mercado Pago calls when a payment changes state. Verified via
  // the x-signature HMAC (no ID token). On an approved payment we look it up,
  // read the uid (external_reference) + plan (metadata) and extend the period.
  app.post("/api/mercadopago/webhook", async (req, res) => {
    try {
      if (!validateMpSignature(req)) {
        // This is a PUBLIC, unauthenticated endpoint — random bot/scanner
        // traffic hitting it with no real payload is expected noise and would
        // flood errorLogs if logged unconditionally. Only log when the request
        // actually looks like a genuine (or spoofed-to-look-genuine) Mercado
        // Pago call — has an x-signature header AND a payment id — since
        // THAT combination rejected is the signal that either MP_WEBHOOK_SECRET
        // is misconfigured (every real payment silently fails to activate) or
        // someone is probing the endpoint. Money can have already moved on
        // Mercado Pago's side by the time this fires, so this must never be silent.
        const dataIdRaw = (req.query["data.id"] ?? req.body?.data?.id) as string | undefined;
        const looksGenuine = typeof req.headers["x-signature"] === "string" && !!dataIdRaw;
        if (looksGenuine) {
          await logServerError(
            "POST /api/mercadopago/webhook (assinatura rejeitada)",
            new Error(
              `Webhook rejeitado para payment.id=${dataIdRaw}. ` +
              (process.env.MP_WEBHOOK_SECRET
                ? "MP_WEBHOOK_SECRET está configurado mas não bateu com a assinatura recebida — confira se é o valor ATUAL do painel do Mercado Pago (Webhooks)."
                : "MP_WEBHOOK_SECRET NÃO está configurado no ambiente — todo webhook real está sendo rejeitado agora. Configure-o na Vercel e faça um redeploy.")
            )
          );
        }
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
        } else {
          // Money already moved on Mercado Pago's side (status === "approved")
          // but we couldn't tell who to credit or which plan — must never fail
          // silently. Surfaces in Admin Portal → Logs → Erros so an operator
          // can reconcile manually via "Gerenciar Assinatura", cross-checking
          // this payment id against the Mercado Pago dashboard.
          await logServerError(
            "POST /api/mercadopago/webhook (pagamento aprovado sem uid/plano)",
            new Error(
              `Pagamento ${info.id ?? dataId} aprovado (R$ ${info.transaction_amount}) mas uid=${uid ?? "?"} plan=${plan ?? "?"} — ` +
              `não foi possível ativar a assinatura automaticamente. Verifique este pagamento no painel do Mercado Pago e ative manualmente pelo Painel Admin.`
            ),
            uid
          );
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
