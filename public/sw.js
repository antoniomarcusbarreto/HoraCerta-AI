const CACHE_NAME = "horacerta-cache-v2";
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

// Fetch Event
self.addEventListener("fetch", (e) => {
  const url = e.request.url;
  // Ignore API requests, hot reloads, and other dev socket requests
  if (url.includes("/api/") || url.includes("node_modules") || url.includes("@") || url.includes("hot-update")) {
    return;
  }
  e.respondWith(
    caches.match(e.request).then((cachedResponse) => {
      return cachedResponse || fetch(e.request);
    }).catch(() => fetch(e.request))
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
