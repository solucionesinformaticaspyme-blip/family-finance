const CACHE_NAME = "finanzas-v2-cache-v15";
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./favicon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

// Instalación del Service Worker: Pre-cachear recursos estáticos
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log("[Service Worker] Caching static assets");
      // v1.5: "reload" evita que el navegador use una copia vieja de su propia caché HTTP
      return cache.addAll(STATIC_ASSETS.map((url) => new Request(url, { cache: "reload" })));
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

  // v1.5 - Archivos propios de la app: PRIMERO LA RED (siempre la versión más nueva si hay conexión).
  // Si no hay conexión o la red tarda más de 4 s, se usa la copia guardada (la app abre igual sin señal).
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    try {
      const network = fetch(req, { cache: "no-cache" }).then((res) => {
        if (res && res.status === 200 && res.type === "basic") {
          cache.put(req, res.clone());
        }
        return res;
      });
      if (!cached) return await network;
      const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 4000));
      const winner = await Promise.race([network.catch(() => null), timeout]);
      return winner || cached;
    } catch (e) {
      if (cached) return cached;
      throw e;
    }
  })());
});
