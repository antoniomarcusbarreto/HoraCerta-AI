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
  collection,
  serverTimestamp,
  Timestamp,
  setLogLevel,
} from "firebase/firestore";

let testEnv;

const OWNER = "owner_uid";
const ATTACKER = "attacker_uid";

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
  });
});

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
