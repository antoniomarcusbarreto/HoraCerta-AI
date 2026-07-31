// Firestore Security Rules — automated "Dirty Dozen" regression tests.
//
// Runs against the Firestore emulator. It exercises the adversarial payloads
// documented in security_spec.md and asserts each one is REJECTED, plus a few
// positive cases that must SUCCEED, so a future edit to firestore.rules can't
// silently open a hole.
//
// HOW TO RUN (requires Java 11+ for the emulator):
//   npm install                      # installs @firebase/rules-unit-testing
//   npm run test:rules               # = firebase emulators:exec --only firestore "node --test tests/"
//
// Note on the named database: production uses a NAMED Firestore database, but
// firestore.rules matches `/databases/{database}/documents` (a wildcard), so the
// authorization logic is identical on the emulator's default database used here.

import { readFileSync } from "node:fs";
import assert from "node:assert";
import { test, before, after, beforeEach } from "node:test";
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from "@firebase/rules-unit-testing";
import {
  doc,
  setDoc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  serverTimestamp,
  Timestamp,
  setLogLevel,
} from "firebase/firestore";

let testEnv;

const OWNER = "owner_uid";
const ATTACKER = "attacker_uid";
// Compartilhamento: um cuidador que escreve e um que só acompanha.
const COADMIN = "coadmin_uid";
const VIEWER = "viewer_uid";
const SHARED_PATIENT = "pat_shared";
const SHARED_MED = "med_shared";
const SHARE_LISTS = { memberUids: [COADMIN, VIEWER], editorUids: [COADMIN] };

// A well-formed profile the rules consider "active" (needed by isUserActive()).
function validProfile(uid, extra = {}) {
  return {
    userId: uid,
    name: "Owner",
    email: `${uid}@example.com`,
    role: "user",
    status: "active",
    createdAt: serverTimestamp(),
    ...extra,
  };
}

function validMedicado(uid, medicadoId = "pat_1", extra = {}) {
  return {
    medicadoId,
    userId: uid,
    name: "Paciente",
    relationship: "self",
    createdAt: serverTimestamp(),
    ...extra,
  };
}

function validMedicamento(uid, medicadoId = "pat_1", medicamentoId = "med_1", extra = {}) {
  return {
    medicamentoId,
    receitaId: "rec_1",
    medicadoId,
    userId: uid,
    name: "Amoxicilina",
    dosage: "1 comprimido",
    intervalHours: 8,
    durationDays: 10,
    category: "pill",
    status: "active",
    createdAt: serverTimestamp(),
    ...extra,
  };
}

before(async () => {
  setLogLevel("error");
  testEnv = await initializeTestEnvironment({
    projectId: "demo-horacerta",
    firestore: {
      rules: readFileSync("firestore.rules", "utf8"),
      host: "127.0.0.1",
      port: 8080,
    },
  });
});

after(async () => {
  await testEnv?.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  // Seed an active owner profile + one patient, bypassing the rules.
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "users", OWNER), {
      userId: OWNER, name: "Owner", email: "owner@example.com",
      role: "user", status: "active", createdAt: Timestamp.now(),
    });
    await setDoc(doc(db, "users", OWNER, "medicados", "pat_1"), {
      medicadoId: "pat_1", userId: OWNER, name: "Paciente",
      relationship: "self", createdAt: Timestamp.now(),
    });
    // A suspended user, for the suspended-access-bypass test.
    await setDoc(doc(db, "users", "suspended_uid"), {
      userId: "suspended_uid", name: "Suspenso", email: "s@example.com",
      role: "user", status: "suspended", createdAt: Timestamp.now(),
    });

    // Um paciente do OWNER compartilhado com COADMIN (escreve) e VIEWER (só lê),
    // já com as listas propagadas na subárvore como o fan-out do aceite faria.
    await setDoc(doc(db, "users", OWNER, "medicados", SHARED_PATIENT), {
      medicadoId: SHARED_PATIENT, userId: OWNER, name: "Idoso",
      relationship: "pai", createdAt: Timestamp.now(), ...SHARE_LISTS,
    });
    await setDoc(doc(db, "users", OWNER, "medicados", SHARED_PATIENT, "medicamentos", SHARED_MED), {
      medicamentoId: SHARED_MED, receitaId: "rec_1", medicadoId: SHARED_PATIENT,
      userId: OWNER, name: "Losartana", dosage: "1", intervalHours: 12,
      durationDays: 30, category: "pill", status: "active",
      createdAt: Timestamp.now(), ...SHARE_LISTS,
    });
    // Convite correspondente, para o teste de escrita do cliente em `shares`.
    await setDoc(doc(db, "shares", "share_1"), {
      shareId: "share_1", ownerUid: OWNER, ownerName: "Owner",
      medicadoId: SHARED_PATIENT, medicadoName: "Idoso",
      granteeEmail: "coadmin@example.com", granteeUid: COADMIN,
      role: "coadministrador", status: "accepted", createdAt: new Date().toISOString(),
    });
  });
});

function validDoseLog(uid, extra = {}) {
  return {
    logId: "log_x",
    medicamentoId: SHARED_MED,
    medicadoId: SHARED_PATIENT,
    userId: OWNER, // titular da árvore, nunca quem escreve
    plannedTime: "2026-08-01T14:00:00.000Z",
    takenTime: "2026-08-01T14:05:00.000Z",
    status: "taken",
    registradoPor: uid,
    ...SHARE_LISTS,
    ...extra,
  };
}

function sharedDoseLogRef(db) {
  return doc(db, "users", OWNER, "medicados", SHARED_PATIENT, "medicamentos", SHARED_MED, "doseLogs", "log_x");
}

function authed(uid) {
  return testEnv.authenticatedContext(uid, { email_verified: true }).firestore();
}

// --- Positive baselines (must SUCCEED) ---

test("owner creates a valid patient", async () => {
  const db = authed(OWNER);
  await assertSucceeds(setDoc(doc(db, "users", OWNER, "medicados", "pat_2"), validMedicado(OWNER, "pat_2")));
});

test("owner reads their own profile", async () => {
  const db = authed(OWNER);
  await assertSucceeds(getDoc(doc(db, "users", OWNER)));
});

// --- Dirty Dozen (must all FAIL) ---

test("Payload 1: self-assigned admin role on create", async () => {
  const db = authed(ATTACKER);
  await assertFails(setDoc(doc(db, "users", ATTACKER), validProfile(ATTACKER, { role: "admin" })));
});

test("Payload 2: suspended user self-unban", async () => {
  const db = authed("suspended_uid");
  await assertFails(updateDoc(doc(db, "users", "suspended_uid"), { status: "active" }));
});

test("Payload 3: create patient under another user's path", async () => {
  const db = authed(ATTACKER);
  await assertFails(setDoc(doc(db, "users", OWNER, "medicados", "pat_x"), validMedicado(OWNER, "pat_x")));
});

test("Payload 4: read another user's profile", async () => {
  const db = authed(ATTACKER);
  await assertFails(getDoc(doc(db, "users", OWNER)));
});

test("Payload 4b: non-admin lists all users", async () => {
  const db = authed(ATTACKER);
  await assertFails(getDocs(collection(db, "users")));
});

test("Payload 6: negative intervalHours", async () => {
  const db = authed(OWNER);
  await assertFails(setDoc(
    doc(db, "users", OWNER, "medicados", "pat_1", "medicamentos", "med_bad"),
    validMedicamento(OWNER, "pat_1", "med_bad", { intervalHours: -8 })
  ));
});

test("Payload 7: oversized patient name (denial of wallet)", async () => {
  const db = authed(OWNER);
  await assertFails(setDoc(
    doc(db, "users", OWNER, "medicados", "pat_big"),
    validMedicado(OWNER, "pat_big", { name: "A".repeat(5000) })
  ));
});

test("Payload 8: prescription for a non-existent patient", async () => {
  const db = authed(OWNER);
  await assertFails(setDoc(
    doc(db, "users", OWNER, "medicados", "ghost_patient", "receitas", "rec_1"),
    { receitaId: "rec_1", medicadoId: "ghost_patient", userId: OWNER, date: "2026-07-09", extracted: false, createdAt: serverTimestamp() }
  ));
});

test("Payload 9: backdated createdAt", async () => {
  const db = authed(OWNER);
  await assertFails(setDoc(
    doc(db, "users", OWNER, "medicados", "pat_1", "medicamentos", "med_old"),
    validMedicamento(OWNER, "pat_1", "med_old", { createdAt: Timestamp.fromDate(new Date("2010-01-01T00:00:00Z")) })
  ));
});

test("Payload 10: suspended user writes new data", async () => {
  const db = authed("suspended_uid");
  await assertFails(setDoc(doc(db, "users", "suspended_uid", "medicados", "pat_s"), validMedicado("suspended_uid", "pat_s")));
});

test("Payload 11: ghost field injection on medicine", async () => {
  // First create a valid medicine (rules-disabled), then try a shadow-field update.
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(
      doc(ctx.firestore(), "users", OWNER, "medicados", "pat_1", "medicamentos", "med_1"),
      { medicamentoId: "med_1", receitaId: "rec_1", medicadoId: "pat_1", userId: OWNER, name: "Aspirina", dosage: "1", intervalHours: 8, durationDays: 5, category: "pill", status: "active", createdAt: Timestamp.now() }
    );
  });
  const db = authed(OWNER);
  await assertFails(updateDoc(
    doc(db, "users", OWNER, "medicados", "pat_1", "medicamentos", "med_1"),
    { name: "Aspirina", isVerifiedByAdmin: true }
  ));
});

test("Payload 12: cross-user push subscription write is blocked", async () => {
  // pushSubscriptions are server-only (create/update: if false) even for the owner.
  const db = authed(OWNER);
  await assertFails(setDoc(
    doc(db, "users", OWNER, "pushSubscriptions", "sub_1"),
    { userId: OWNER, endpoint: "https://x", keys: { p256dh: "a", auth: "b" } }
  ));
});

// ==========================================
// COMPARTILHAMENTO ENTRE CUIDADORES
// ==========================================
//
// O que precisa CONTINUAR funcionando (o acesso concedido é real) e o que
// precisa CONTINUAR falhando (o acesso não escala além do que foi concedido).

// --- Deve funcionar ---

test("compartilhado: coadministrador lê o paciente", async () => {
  const db = authed(COADMIN);
  await assertSucceeds(getDoc(doc(db, "users", OWNER, "medicados", SHARED_PATIENT)));
});

test("compartilhado: acompanhante lê o paciente", async () => {
  const db = authed(VIEWER);
  await assertSucceeds(getDoc(doc(db, "users", OWNER, "medicados", SHARED_PATIENT)));
});

test("compartilhado: convidado lista por array-contains (caminho real do sync)", async () => {
  const db = authed(VIEWER);
  await assertSucceeds(getDocs(query(
    collection(db, "users", OWNER, "medicados"),
    where("memberUids", "array-contains", VIEWER)
  )));
});

test("compartilhado: coadministrador registra dose em nome próprio", async () => {
  const db = authed(COADMIN);
  await assertSucceeds(setDoc(sharedDoseLogRef(db), validDoseLog(COADMIN)));
});

// --- Deve falhar ---

test("compartilhado: estranho não lê o paciente compartilhado", async () => {
  const db = authed(ATTACKER);
  await assertFails(getDoc(doc(db, "users", OWNER, "medicados", SHARED_PATIENT)));
});

test("compartilhado: convidado não enxerga OUTRO paciente do mesmo titular", async () => {
  // pat_1 existe e é do OWNER, mas não foi compartilhado — é a garantia de que
  // o escopo é por paciente e não por conta.
  const db = authed(COADMIN);
  await assertFails(getDoc(doc(db, "users", OWNER, "medicados", "pat_1")));
});

test("compartilhado: acompanhante NÃO registra dose", async () => {
  const db = authed(VIEWER);
  await assertFails(setDoc(sharedDoseLogRef(db), validDoseLog(VIEWER)));
});

test("compartilhado: coadministrador não forja registradoPor de outra pessoa", async () => {
  const db = authed(COADMIN);
  await assertFails(setDoc(sharedDoseLogRef(db), validDoseLog(COADMIN, { registradoPor: OWNER })));
});

test("compartilhado: coadministrador não se promove a editor de outro paciente", async () => {
  const db = authed(COADMIN);
  await assertFails(updateDoc(
    doc(db, "users", OWNER, "medicados", SHARED_PATIENT),
    { name: "Idoso", editorUids: [COADMIN, ATTACKER] }
  ));
});

test("compartilhado: nem o titular altera as listas de acesso pelo cliente", async () => {
  const db = authed(OWNER);
  await assertFails(updateDoc(
    doc(db, "users", OWNER, "medicados", SHARED_PATIENT),
    { name: "Idoso", memberUids: [COADMIN, VIEWER, ATTACKER] }
  ));
});

test("compartilhado: coadministrador não exclui o paciente", async () => {
  const db = authed(COADMIN);
  await assertFails(deleteDoc(doc(db, "users", OWNER, "medicados", SHARED_PATIENT)));
});

test("compartilhado: registro novo não pode nascer com listas diferentes do pai", async () => {
  const db = authed(COADMIN);
  await assertFails(setDoc(
    sharedDoseLogRef(db),
    validDoseLog(COADMIN, { memberUids: [COADMIN, VIEWER, ATTACKER] })
  ));
});

test("compartilhado: cliente não escreve na coleção shares", async () => {
  // Escrita é exclusiva do Admin SDK — deixar o cliente escrever aqui seria
  // permitir que alguém se autoconcedesse acesso.
  const db = authed(COADMIN);
  await assertFails(setDoc(doc(db, "shares", "share_forged"), {
    shareId: "share_forged", ownerUid: OWNER, ownerName: "Owner",
    medicadoId: "pat_1", medicadoName: "Paciente",
    granteeEmail: "coadmin@example.com", granteeUid: COADMIN,
    role: "coadministrador", status: "accepted", createdAt: new Date().toISOString(),
  }));
});

test("compartilhado: estranho não lê o convite de outra pessoa", async () => {
  const db = authed(ATTACKER);
  await assertFails(getDoc(doc(db, "shares", "share_1")));
});
