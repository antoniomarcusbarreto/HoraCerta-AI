// Generates a VAPID key pair for Web Push. Run this ONCE per deployment and
// store the output as environment secrets (never commit them):
//
//   node server/generateVapidKeys.js
//
// Then set in .env.local (dev) or the Vercel/Cloud Run secret panel (prod):
//   VAPID_PUBLIC_KEY=<publicKey>
//   VAPID_PRIVATE_KEY=<privateKey>
//   VAPID_SUBJECT=mailto:seu-email@dominio.com
//
// The PUBLIC key is safe to expose to browsers (the client fetches it to
// subscribe). The PRIVATE key is a server secret — it signs push messages and
// must never reach the client or the Git history.

import webpush from "web-push";

const keys = webpush.generateVAPIDKeys();

console.log("VAPID_PUBLIC_KEY=" + keys.publicKey);
console.log("VAPID_PRIVATE_KEY=" + keys.privateKey);
console.log("");
console.log("Copie as duas linhas acima para o seu .env.local (ou painel de");
console.log("secrets em produção) e defina também VAPID_SUBJECT=mailto:seu-email.");
