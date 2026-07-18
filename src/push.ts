// Client-side Web Push helpers. These register the browser's push subscription
// with the backend (POST /api/push/subscribe) so the server can deliver dose
// reminders via VAPID even when the app is fully closed.
//
// Isolation note: the subscription is always stored server-side under the
// AUTHENTICATED uid derived from the ID token we send here — the client never
// names a target user. See /api/push/subscribe in server.ts.

// Decode a base64url VAPID public key into the Uint8Array subscribe() expects.
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window
  );
}

type GetIdToken = () => Promise<string | undefined>;

// Subscribe this browser to push and register it with the backend. Safe to call
// repeatedly (idempotent) — reuses the existing browser subscription if present.
// Silently no-ops when unsupported, permission not granted, or push disabled on
// the server (no VAPID key). Returns true only when a subscription was registered.
export async function subscribeToPush(getIdToken: GetIdToken): Promise<boolean> {
  try {
    if (!pushSupported() || Notification.permission !== "granted") return false;

    const keyRes = await fetch("/api/push/vapid-public-key");
    if (!keyRes.ok) return false;
    const { key } = await keyRes.json();
    if (!key) return false; // server has push disabled

    const reg = await navigator.serviceWorker.ready;

    let subscription = await reg.pushManager.getSubscription();
    if (!subscription) {
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
    }

    const idToken = await getIdToken();
    if (!idToken) return false;

    const res = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    });
    return res.ok;
  } catch (err) {
    console.warn("Falha ao registrar push:", err);
    return false;
  }
}

// Tear down this browser's subscription and remove it from the current user's
// server-side tree. Call BEFORE signing the user out so the reminders of the
// account that is leaving never reach a device that a different account may use
// next (isolation on shared devices).
export async function unsubscribeFromPush(getIdToken: GetIdToken): Promise<void> {
  try {
    if (!pushSupported()) return;
    const reg = await navigator.serviceWorker.ready;
    const subscription = await reg.pushManager.getSubscription();
    if (!subscription) return;

    const endpoint = subscription.endpoint;
    const idToken = await getIdToken();
    if (idToken) {
      await fetch("/api/push/unsubscribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ endpoint }),
      }).catch(() => {});
    }
    await subscription.unsubscribe().catch(() => {});
  } catch (err) {
    console.warn("Falha ao remover push:", err);
  }
}
