const CACHE_NAME = "finanzas-v2-cache-v1";
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

// Instalación del Service Worker: Pre-cachear recursos estáticos
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log("[Service Worker] Caching static assets");
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// Activación del Service Worker: Limpiar cachés antiguos
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            console.log("[Service Worker] Removing old cache:", cache);
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Estrategia de Fetch: Network First para API / Cache First para recursos estáticos
self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Ignorar peticiones que no sean GET (como las llamadas POST a la API de Apps Script)
  if (req.method !== "GET") {
    return;
  }

  // Peticiones de Google Fonts o CDN: Cache First con fallback a red
  if (req.url.includes("fonts.googleapis.com") || req.url.includes("fonts.gstatic.com") || req.url.includes("cdn.jsdelivr.net")) {
    event.respondWith(
      caches.match(req).then((cachedResponse) => {
        if (cachedResponse) return cachedResponse;
        return fetch(req).then((networkResponse) => {
          return caches.open(CACHE_NAME).then((cache) => {
            cache.put(req, networkResponse.clone());
            return networkResponse;
          });
        });
      })
    );
    return;
  }

  // Peticiones estáticas locales: Stale-While-Revalidate
  event.respondWith(
    caches.match(req).then((cachedResponse) => {
      const fetchPromise = fetch(req).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(req, networkResponse.clone());
          });
        }
        return networkResponse;
      }).catch(() => {
        // Si no hay red, retornar la respuesta en caché si existe
        return cachedResponse;
      });

      return cachedResponse || fetchPromise;
    })
  );
});
