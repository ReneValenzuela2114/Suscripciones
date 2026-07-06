// Service worker de la PWA "Mis Suscripciones".
// Regla clave: RED PRIMERO para el HTML (nunca te quedas en una versión vieja),
// caché solo para estáticos, y la API/datos NUNCA se cachean.
const VERSION = "sub-v1";
const STATIC = ["/icon.png", "/manifest.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(STATIC)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // La API y cualquier dato jamás se cachean (siempre a la red).
  if (url.pathname.startsWith("/api/")) return;

  // Navegación / HTML: red primero; si no hay red, cae a la cáscara guardada.
  if (req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html")) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put("/", copy));
          return res;
        })
        .catch(() => caches.match("/"))
    );
    return;
  }

  // Estáticos del mismo origen: caché primero, actualizando en segundo plano.
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(req).then((cached) => {
        const net = fetch(req)
          .then((res) => {
            if (res && res.status === 200) {
              const copy = res.clone();
              caches.open(VERSION).then((c) => c.put(req, copy));
            }
            return res;
          })
          .catch(() => cached);
        return cached || net;
      })
    );
  }
});
