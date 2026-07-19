const CACHE_NAME = "horacerta-cache-v4";
const ASSETS = [
  "/app",
  "/app/index.html",
  "/manifest.json"
];

// Install Event
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS).catch(() => {});
    })
  );
  self.skipWaiting();
});

// Activate Event
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch Event — network-first so a new deploy's fixed app shell/bundle
// actually reaches a device promptly, falling back to cache only when
// offline (the previous cache-first strategy could serve the same stale
// index.html/bundle forever, since this SW's only invalidation lever is
// bumping CACHE_NAME above).
self.addEventListener("fetch", (e) => {
  const url = e.request.url;
  // Ignore API requests, hot reloads, and other dev socket requests
  if (url.includes("/api/") || url.includes("node_modules") || url.includes("@") || url.includes("hot-update")) {
    return;
  }
  e.respondWith(
    fetch(e.request)
      .then((networkResponse) => {
        const copy = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, copy)).catch(() => {});
        return networkResponse;
      })
      .catch(() => caches.match(e.request))
  );
});

// Listen to message from Client (for immediate local background notifications)
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SHOW_NOTIFICATION") {
    const { title, body, icon, data } = event.data.payload;
    self.registration.showNotification(title, {
      body: body,
      icon: icon || "https://images.unsplash.com/photo-1584017911766-d451b3d0e843?w=192&h=192&fit=crop&auto=format",
      badge: "https://images.unsplash.com/photo-1584017911766-d451b3d0e843?w=192&h=192&fit=crop&auto=format",
      vibrate: [200, 100, 200],
      data: data || {},
    });
  }
});

// Web Push: fired by the OS/browser even when the app is fully closed. The
// server (VAPID) delivers a generic, no-PHI payload here; details are only
// visible after the user opens the app.
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = {};
  }

  const title = payload.title || "Lembrete de Medicamento";
  const options = {
    body: payload.body || "Você tem uma dose pendente. Abra o aplicativo para verificar os detalhes.",
    icon: payload.icon || "https://images.unsplash.com/photo-1584017911766-d451b3d0e843?w=192&h=192&fit=crop&auto=format",
    badge: "https://images.unsplash.com/photo-1584017911766-d451b3d0e843?w=192&h=192&fit=crop&auto=format",
    vibrate: [300, 100, 300],
    requireInteraction: true,
    // Same tag format the in-app poller uses, so the OS collapses duplicates
    // instead of stacking them when both paths fire on the same device.
    tag: payload.tag || "dose_reminder",
    data: payload.data || { url: "/app" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// If the browser rotates/expires the subscription, best-effort resubscribe with
// the same VAPID key so the device keeps receiving reminders. The client will
// also re-register on next app open, so this is a resilience layer.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    fetch("/api/push/vapid-public-key")
      .then((res) => res.json())
      .then((data) => {
        if (!data || !data.key) return;
        return self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(data.key),
        });
      })
      .catch(() => {})
  );
});

// Decode a base64url VAPID public key into the Uint8Array subscribe() expects.
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

// Listen to notification click
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      if (clientList.length > 0) {
        let client = clientList[0];
        for (let i = 0; i < clientList.length; i++) {
          if (clientList[i].focused) {
            client = clientList[i];
            break;
          }
        }
        return client.focus();
      }
      return clients.openWindow("/app");
    })
  );
});
