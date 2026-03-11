/**
 * @file sw.js
 * @description Service Worker para VN-Hub.
 *              Estrategia: Cache-First para assets estáticos,
 *              Network-First para la API de VNDB.
 *
 * CACHES:
 *  - vnh-shell-v1   : HTML, CSS, JS, fuentes (Shell de la app)
 *  - vnh-images-v1  : Portadas de VNs (cache con LRU manual)
 *  - vnh-api-v1     : Respuestas de la API VNDB (5 min TTL)
 *
 * ESTRATEGIAS:
 *  - Shell  → Cache-First con fallback a red (nunca devuelve 503 si la red funciona)
 *  - API    → Network-First con fallback a caché
 *  - Images → Network-First con cache posterior (evita servir imágenes rotas)
 *
 * FIXES v1.1:
 *  - [FIX #1] _cacheFirst: si no hay caché Y la red falla, devuelve null
 *    en lugar de una Response 503 falsa que el browser podría cachear.
 *  - [FIX #2] Imágenes de VNDB cambian de Cache-First a Network-First-Then-Cache:
 *    la primera carga siempre va a la red para garantizar la imagen real.
 *    Solo en offline usa caché o placeholder SVG.
 *  - [FIX #3] install: si cache.addAll falla, el SW lanza el error correctamente
 *    en lugar de silenciarlo, para que el browser reintente en la próxima visita.
 *
 * @version 1.1
 */

'use strict';

// ── Versión del cache (incrementar al desplegar cambios) ──
const CACHE_VERSION  = 'v1';
const SHELL_CACHE    = `vnh-shell-${CACHE_VERSION}`;
const IMAGES_CACHE   = `vnh-images-${CACHE_VERSION}`;
const API_CACHE      = `vnh-api-${CACHE_VERSION}`;

/** Máx. entradas en el cache de imágenes (LRU simple) */
const MAX_IMAGE_CACHE_ENTRIES = 150;

/** TTL en segundos para respuestas de API cacheadas */
const API_CACHE_TTL_SECONDS = 300; // 5 minutos

/**
 * Assets del shell que se precachean en install.
 * IMPORTANTE: todos estos archivos deben existir en el servidor.
 * Si alguno da 404, cache.addAll() falla y el SW no se instala.
 */
const SHELL_ASSETS = [
  './',
  './index.html',
  './assets/css/vn-hub.css',
  './assets/css/vn-hub-components.css',
  './assets/css/vn-hub-explore.css',
  './assets/css/vn-hub-export.css',
  './assets/css/vn-hub-profile.css',
  './assets/css/vn-hub-mobile.css',
  './js/app-init.js',
  './js/constants.js',
  './js/render-engine.js',
  './js/ui-controller.js',
  './js/feed-controller.js',
  './js/profile-controller.js',
  './js/explore-controller.js',
  './js/mobile-gestures.js',
];

/** Placeholder SVG para imágenes que fallan estando offline */
const FALLBACK_IMAGE_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300" viewBox="0 0 200 300">
  <rect width="200" height="300" fill="#f5f5f5"/>
  <text x="100" y="150" text-anchor="middle" dominant-baseline="middle"
        font-family="sans-serif" font-size="40" fill="#d8d8d8">✦</text>
  <text x="100" y="200" text-anchor="middle" dominant-baseline="middle"
        font-family="sans-serif" font-size="12" fill="#999">Sin imagen</text>
</svg>`.trim();


// ═══════════════════════════════════════════════════════════════
// LIFECYCLE: INSTALL
// ═══════════════════════════════════════════════════════════════

self.addEventListener('install', (event) => {
  console.info('[SW] Instalando…');

  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => {
        console.info('[SW] Shell precacheado.');
        return self.skipWaiting();
      })
    // [FIX #3] Sin .catch() aquí — si un asset del shell da 404,
    // el error se propaga y el SW NO se instala. Esto es correcto:
    // es mejor no tener SW que tener uno con caché incompleta.
    // Verificá que todos los archivos en SHELL_ASSETS existen.
  );
});


// ═══════════════════════════════════════════════════════════════
// LIFECYCLE: ACTIVATE
// ═══════════════════════════════════════════════════════════════

self.addEventListener('activate', (event) => {
  console.info('[SW] Activando…');

  const currentCaches = [SHELL_CACHE, IMAGES_CACHE, API_CACHE];

  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => !currentCaches.includes(key))
          .map(key => {
            console.info(`[SW] Eliminando cache obsoleto: ${key}`);
            return caches.delete(key);
          })
      ))
      .then(() => self.clients.claim())
      .then(() => console.info('[SW] Activado y controlando clientes.'))
  );
});


// ═══════════════════════════════════════════════════════════════
// FETCH HANDLER
// ═══════════════════════════════════════════════════════════════

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Solo interceptar GET
  if (request.method !== 'GET') return;

  // ── API de VNDB → Network-First con TTL ──
  if (url.hostname === 'api.vndb.org') {
    event.respondWith(_networkFirst(request, API_CACHE, API_CACHE_TTL_SECONDS));
    return;
  }

  // ── Imágenes de VNDB (CDN) → Network-First-Then-Cache ──
  // [FIX #2] Cambiado de Cache-First a Network-First-Then-Cache.
  // La primera carga siempre va a la red para garantizar la imagen real.
  // Solo en offline usa caché o devuelve el placeholder SVG.
  if (url.hostname.includes('s2.vndb.org') || url.hostname.includes('t.vndb.org')) {
    event.respondWith(_networkFirstImages(request, IMAGES_CACHE));
    return;
  }

  // ── Fuentes de Google → Cache-First ──
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(_cacheFirst(request, SHELL_CACHE));
    return;
  }

  // ── Shell de la app → Cache-First ──
  if (url.origin === self.location.origin) {
    event.respondWith(_cacheFirst(request, SHELL_CACHE));
    return;
  }
});


// ═══════════════════════════════════════════════════════════════
// ESTRATEGIAS DE CACHE
// ═══════════════════════════════════════════════════════════════

/**
 * Cache-First: devuelve desde caché si existe.
 * Si no está en caché, va a la red y cachea la respuesta.
 * [FIX #1] Si no hay caché Y la red falla, deja que el error
 * se propague al browser en lugar de devolver una respuesta 503
 * falsa que podría ser cacheada por el browser.
 *
 * @param {Request} request
 * @param {string}  cacheName
 * @returns {Promise<Response>}
 */
async function _cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  // Sin caché → ir a la red sin atrapar el error.
  // Si la red falla, el browser muestra su propio error offline,
  // que es más correcto que una respuesta 503 inventada.
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(cacheName);
    cache.put(request, response.clone());
  }
  return response;
}

/**
 * Network-First-Then-Cache para imágenes:
 * 1. Intenta la red primero → si responde OK, cachea y devuelve.
 * 2. Si la red falla (offline) → intenta caché.
 * 3. Si no hay caché → devuelve placeholder SVG.
 *
 * Esto garantiza que cuando hay red, SIEMPRE se sirve la imagen real.
 * El caché solo se usa como respaldo offline.
 *
 * @param {Request} request
 * @param {string}  cacheName
 * @returns {Promise<Response>}
 */
async function _networkFirstImages(request, cacheName) {
  try {
    const response = await fetch(request);

    if (response.ok) {
      const cache = await caches.open(cacheName);

      // Gestión de tamaño: borrar el 10% más antiguo si hay demasiadas entradas
      const keys = await cache.keys();
      if (keys.length >= MAX_IMAGE_CACHE_ENTRIES) {
        const toDelete = keys.slice(0, Math.ceil(MAX_IMAGE_CACHE_ENTRIES * 0.1));
        await Promise.all(toDelete.map(k => cache.delete(k)));
      }

      cache.put(request, response.clone());
    }

    return response;

  } catch {
    // Sin red → intentar caché
    const cached = await caches.match(request);
    if (cached) return cached;

    // Sin caché y sin red → placeholder SVG
    return new Response(FALLBACK_IMAGE_SVG, {
      status: 200,
      headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' },
    });
  }
}

/**
 * Network-First con TTL para la API de VNDB.
 * Añade un header X-Cached-At para controlar la expiración.
 *
 * @param {Request} request
 * @param {string}  cacheName
 * @param {number}  ttlSeconds
 * @returns {Promise<Response>}
 */
async function _networkFirst(request, cacheName, ttlSeconds) {
  const cache = await caches.open(cacheName);

  try {
    const response = await fetch(request.clone());
    if (response.ok) {
      const headers = new Headers(response.headers);
      headers.set('X-Cached-At', String(Date.now()));

      const cachedResponse = new Response(await response.clone().blob(), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });

      cache.put(request, cachedResponse);
    }
    return response;

  } catch {
    // Sin red → intentar caché con TTL
    const cached = await cache.match(request);
    if (cached) {
      const cachedAt = cached.headers.get('X-Cached-At');
      if (cachedAt) {
        const age = (Date.now() - parseInt(cachedAt, 10)) / 1000;
        if (age <= ttlSeconds) return cached;
      } else {
        return cached; // Sin timestamp → devolver igual (mejor que nada)
      }
    }

    return new Response(
      JSON.stringify({ error: 'offline', message: 'Sin conexión y sin caché disponible.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}