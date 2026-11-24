const VERSION = "4.9";
const CACHE_NAME = `labcontrol-v2-${VERSION}`;
const API_CACHE = `labcontrol-api-v2-${VERSION}`;
const CAMPOS_LAB = ["id", "nombre", "sala", "ubicacion", "equipos", "estado", "horario", "foto", "imagenes", "posicion"];
const CAMPOS_EQUIPO = ["id", "labId", "nombre", "tipo", "fabricante", "modelo", "estado"];

async function guardarInventario(cache, request, response, campos) {
  const datos = await response.json();
  const visible = (fila) => Object.fromEntries(campos
    .filter((campo) => Object.hasOwn(fila, campo))
    .map((campo) => [campo, fila[campo]]));
  let copia;
  if (Array.isArray(datos)) copia = datos.map(visible);
  else if (Array.isArray(datos.data)) {
    const { total, pagina, totalPaginas, limite } = datos;
    copia = { data: datos.data.map(visible), total, pagina, totalPaginas, limite };
  } else copia = visible(datos);
  await cache.put(request, Response.json(copia));
}
const PRECACHE_URLS = [
  "./",
  "index",
  "login",
  "laboratorios",
  "equipos",
  "disponibilidad",
  "usuarios",
  "reportes",
  "configuracion",
  "css/style.css?v=4.9",
  "js/theme.js?v=4.9",
  "js/app.js?v=4.9",
  "js/data.js?v=4.9",
  "js/index.js?v=4.9",
  "js/login.js?v=4.9",
  "js/laboratorios.js?v=4.9",
  "css/operaciones.css?v=3",
  "js/equipos.js?v=4.9",
  "js/disponibilidad.js?v=4.9",
  "js/reportes.js?v=4.9",
  "js/usuarios.js?v=4.9",
  "js/configuracion.js?v=4.9",
  "js/app.js",
  "js/data.js",
  "js/datos-demo.js",
  "js/index.js",
  "js/login.js",
  "js/laboratorios.js",
  "js/equipos.js",
  "js/disponibilidad.js",
  "js/reportes.js",
  "js/usuarios.js",
  "js/configuracion.js",
  "js/vendor/lucide.min.js?v=4.9",
  "manifest.webmanifest",
  "img/profile-default.svg",
  "img/labcontrol-icon.png",
  "img/bg-tech.svg",
  "img/bg-tech-light.svg",
  "img/labs/Trasera_lab1.jpg",
  "img/labs/Frontal_lab1.jpg",
  "img/labs/Trasero Derecho_lab2.png",
  "img/labs/Frontal Derecho_lab2.png",
  "img/labs/Trasera_lab3.jpg",
  "img/labs/Frontal_lab3.jpg",
  "img/labs/Trasera_lab4.jpg",
  "img/labs/Frontal_lab4.jpg",
  "img/labs/Trasera_lab5.jpg",
  "img/labs/Frontal_lab5.jpg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) =>
        cache.addAll(PRECACHE_URLS.map((url) => new Request(url, { cache: "reload" })))
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k.startsWith("labcontrol-") && k !== CACHE_NAME && k !== API_CACHE).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "limpiar-cache-api") {
    event.waitUntil(caches.delete(API_CACHE));
  }
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  const base = new URL(self.registration.scope).pathname.replace(/\/+$/, "");
  const ruta = (base && url.pathname.startsWith(`${base}/`)
    ? url.pathname.slice(base.length)
    : url.pathname).replace(/^\/+/, "");

  const campos = /^api\/laboratorios(?:\/[^/]+)?$/.test(ruta) ? CAMPOS_LAB
    : ruta === "api/equipos" ? CAMPOS_EQUIPO : null;
  if (campos) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response?.status === 401) {
            event.waitUntil(caches.delete(API_CACHE));
            return response;
          }
          if (response && response.status === 200 && response.type === "basic") {
            const clone = response.clone();
            event.waitUntil(caches.open(API_CACHE).then((c) => guardarInventario(c, request, clone, campos)));
          }
          return response;
        })
        .catch(() =>
          caches.match(request, { cacheName: API_CACHE }).then((r) =>
            r || new Response(
              JSON.stringify({ error: "Sin conexión. Se muestran los últimos datos guardados." }),
              { status: 503, headers: { "Content-Type": "application/json" } }
            )
          )
        )
    );
    return;
  }

  if (ruta === "api" || ruta.startsWith("api/")) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(async () => {
      const cache = await caches.open(CACHE_NAME);
      return await cache.match(url.pathname) || await cache.match("index") || Response.error();
    }));
    return;
  }
  if (request.credentials === "include" || !PRECACHE_URLS.some((ruta) =>
    new URL(ruta, self.registration.scope).href === url.href)) return;

  event.respondWith(
    caches.match(request, { cacheName: CACHE_NAME }).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (!response || response.status !== 200 || response.type !== "basic") return response;
        const clone = response.clone();
        event.waitUntil(caches.open(CACHE_NAME).then((c) => c.put(request, clone)));
        return response;
      });
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const destino = new URL(
    event.notification?.data?.url || "./index",
    self.location.href
  ).href;

  event.waitUntil((async () => {
    const clientes = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const cliente of clientes) {
      if (!cliente.url.startsWith(self.location.origin + "/")) continue;
      await cliente.focus();
      try { if ("navigate" in cliente && !cliente.url.includes(destino)) await cliente.navigate(destino); } catch (e) {}
      return;
    }
    await self.clients.openWindow(destino);
  })());
});
