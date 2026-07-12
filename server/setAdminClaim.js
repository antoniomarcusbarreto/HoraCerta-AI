// Grants (or revokes) the Firebase custom claim `admin: true` — the sole source
// of truth for isAdmin() in firestore.rules and for the Admin Portal login in
// src/App.tsx. There is intentionally no way to become an admin from the client;
// this script (run by a trusted operator with Admin SDK credentials) is it.
//
// Setup:
//   1. Generate a service account key in Firebase Console > Project Settings >
//      Service Accounts > Generate new private key.
//   2. Point GOOGLE_APPLICATION_CREDENTIALS at that JSON file.
//
// Usage:
//   GOOGLE_APPLICATION_CREDENTIALS=./service-account.json node server/setAdminClaim.js user@example.com
//   GOOGLE_APPLICATION_CREDENTIALS=./service-account.json node server/setAdminClaim.js user@example.com --revoke

import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const [, , email, flag] = process.argv;

if (!email) {
  console.error("Uso: node server/setAdminClaim.js <email> [--revoke]");
  process.exit(1);
}

initializeApp({
  credential: applicationDefault(),
});

async function run() {
  const auth = getAuth();
  const user = await auth.getUserByEmail(email);
  const grant = flag !== "--revoke";

  await auth.setCustomUserClaims(user.uid, { admin: grant });

  console.log(
    grant
      ? `Claim 'admin: true' concedida para ${email} (uid: ${user.uid}).`
      : `Claim 'admin' revogada para ${email} (uid: ${user.uid}).`
  );
  console.log(
    "O usuário precisa sair e entrar novamente (ou forçar refresh do ID token) para a claim entrar em vigor."
  );
}

run().catch((err) => {
  console.error("Falha ao definir a custom claim:", err.message);
  process.exit(1);
});
