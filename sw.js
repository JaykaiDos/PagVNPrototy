/**
 * @file sw.js
 * @description Service Worker para VN-Hub.
 *
 *
 * @version 2.0
 */

'use strict';


const CACHE_VERSION = 'v2';
const SHELL_CACHE   = `vnh-shell-${CACHE_VERSION}`;
const IMAGES_CACHE  = `vnh-images-${CACHE_VERSION}`;
const API_CACHE     = `vnh-api-${CACHE_VERSION}`;


// ─────────────────────────────────────────────
// CONFIGURACIÓN
// ─────────────────────────────────────────────

/** Máximo de imágenes en caché antes de purgar el 10% más antiguo. */
const MAX_IMAGE_CACHE_ENTRIES = 150;

/** TTL para respuestas de la API VNDB (segundos). */
const API_CACHE_TTL_SECONDS = 300;


// ─────────────────────────────────────────────
// SHELL ASSETS — Lista exhaustiva
//
// REGLA: Todo archivo importado por app-init.js
// (directa o transitivamente) DEBE estar aquí.
// Si no está, el SW no puede servir la app offline.
// ─────────────────────────────────────────────

const SHELL_ASSETS = [
  // ── Páginas HTML ───────────────────────────
  './',
  './index.html',
  './novel-details.html',   // ← faltaba en v1

  // ── CSS ────────────────────────────────────
  './assets/css/vn-hub.css',
  './assets/css/vn-hub-components.css',
  './assets/css/vn-hub-explore.css',
  './assets/css/vn-hub-export.css',
  './assets/css/vn-hub-profile.css',
  './assets/css/vn-hub-mobile.css',
  './assets/css/vn-hub-details.css',   // ← faltaba en v1

  // ── JS: núcleo ─────────────────────────────
  './js/app-init.js',
  './js/constants.js',
  './js/utils.js',                     // ← faltaba en v1
  './js/render-engine.js',
  './js/ui-controller.js',

  // ── JS: servicios ──────────────────────────
  './js/vndb-service.js',              // ← faltaba en v1
  './js/firebase-service.js',          // ← faltaba en v1
  './js/library-store.js',             // ← faltaba en v1
  './js/score-engine.js',              // ← faltaba en v1

  // ── JS: controladores ──────────────────────
  './js/auth-controller.js',           // ← faltaba en v1
  './js/feed-controller.js',
  './js/profile-controller.js',
  './js/explore-controller.js',
  './js/mobile-gestures.js',
  './js/novel-details.js',             // ← faltaba en v1

  // ── JS: traducciones ───────────────────────
  './js/translation-service.js',       // ← faltaba en v1
  './js/translation-tags.js',          // ← faltaba en v1 (164 KB — crítico offline)

  // ── JS: modales ────────────────────────────
  './js/modal-review.js',              // ← faltaba en v1
  './js/modal-log.js',                 // ← faltaba en v1
  './js/modal-comment.js',             // ← faltaba en v1
  './js/modal-delete.js',              // ← faltaba en v1
  './js/modal-export.js',              // ← faltaba en v1

  // ── JS: extensiones ────────────────────────
  './js/firebase-profile-ext.js',      // ← faltaba en v1

  // ── PWA ────────────────────────────────────
  './manifest.json',
];


// ─────────────────────────────────────────────
// FALLBACK SVG para imágenes que fallan offline
// ─────────────────────────────────────────────

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
  console.info('[SW] Instalando v2…');

  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => {
        console.info('[SW] Shell precacheado ✓');


        return self.skipWaiting();
      })
      .catch(err => {
        console.error('[SW] Error al precachear shell:', err);
        throw err;
      })
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
            console.info(`[SW] Eliminando caché obsoleto: ${key}`);
            return caches.delete(key);
          })
      ))
      .then(() => self.clients.claim())
      .then(() => console.info('[SW] Activado y controlando clientes ✓'))
  );
});


// ═══════════════════════════════════════════════════════════════
// FETCH HANDLER
// ═══════════════════════════════════════════════════════════════

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Solo interceptamos GET
  if (request.method !== 'GET') return;

  // ── API VNDB → Network-First con TTL ──────────────────────
  if (url.hostname === 'api.vndb.org') {
    event.respondWith(_networkFirst(request, API_CACHE, API_CACHE_TTL_SECONDS));
    return;
  }

  // ── Imágenes VNDB → Network-First + fallback SVG ──────────
  if (url.hostname.includes('s2.vndb.org') || url.hostname.includes('t.vndb.org')) {
    event.respondWith(_networkFirstImages(request, IMAGES_CACHE));
    return;
  }

  // ── Google Fonts → Cache-First ────────────────────────────
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(_cacheFirst(request, SHELL_CACHE));
    return;
  }

  // ── Assets propios (mismo origen) → Cache-First ───────────
  if (url.origin === self.location.origin) {
    event.respondWith(_cacheFirst(request, SHELL_CACHE));
    return;
  }
});


// ═══════════════════════════════════════════════════════════════
// ESTRATEGIAS DE CACHÉ
// ═══════════════════════════════════════════════════════════════

/**
 *
 * @param {Request} request
 * @param {string}  cacheName
 * @returns {Promise<Response>}
 */
async function _cacheFirst(request, cacheName) {
  // 1. Intentar desde caché
  const cached = await caches.match(request);
  if (cached) return cached;

  // 2. Si no hay caché, ir a la red
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      // Guardamos un clon; el original se devuelve al navegador
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // 3. Sin red y sin caché → respuesta de error controlada
    console.warn('[SW] Sin red y sin caché para:', request.url);
    return new Response('Recurso no disponible offline.', {
      status:  503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

/**
 * Network-First para imágenes VNDB.
 * Con red: descarga, guarda en caché y devuelve la imagen real.
 * Sin red: sirve desde caché o fallback SVG.
 *
 * CORRECCIÓN BUG-05 (LRU):
 * En v1 se borraban las primeras entradas del array de claves,
 * que es el orden de inserción en el caché — no el de antigüedad real.
 * El caché de la API Cache no garantiza orden cronológico en keys().
 * Solución: guardar timestamp en el nombre de la entrada es complejo
 * en Cache API; la solución pragmática para GitHub Pages es mantener
 * el límite por conteo y aceptar que el orden es aproximado.
 * Para LRU real se necesitaría IndexedDB (fuera de scope aquí).
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

      // Purgar si el caché supera el límite
      const keys = await cache.keys();
      if (keys.length >= MAX_IMAGE_CACHE_ENTRIES) {
        const countToDelete = Math.ceil(MAX_IMAGE_CACHE_ENTRIES * 0.1);
        await Promise.all(
          keys.slice(0, countToDelete).map(k => cache.delete(k))
        );
        console.info(`[SW] Purgadas ${countToDelete} imágenes del caché.`);
      }

      cache.put(request, response.clone());
    }

    return response;

  } catch {
    // Sin red: intentar desde caché
    const cached = await caches.match(request);
    if (cached) return cached;

    // Sin caché: devolver placeholder SVG
    return new Response(FALLBACK_IMAGE_SVG, {
      status:  200,
      headers: {
        'Content-Type':  'image/svg+xml',
        'Cache-Control': 'no-store',
      },
    });
  }
}

/**
 * Network-First con TTL para la API VNDB.
 * Con red: descarga, guarda con timestamp y devuelve la respuesta.
 * Sin red: sirve desde caché si no expiró; si expiró o no hay, 503.
 *
 * @param {Request} request
 * @param {string}  cacheName
 * @param {number}  ttlSeconds - Tiempo de vida en segundos.
 * @returns {Promise<Response>}
 */
async function _networkFirst(request, cacheName, ttlSeconds) {
  const cache = await caches.open(cacheName);

  try {
    const response = await fetch(request.clone());

    if (response.ok) {
      // Inyectar timestamp para verificar TTL cuando estemos offline
      const headers = new Headers(response.headers);
      headers.set('X-Cached-At', String(Date.now()));

      const cachedResponse = new Response(await response.clone().blob(), {
        status:     response.status,
        statusText: response.statusText,
        headers,
      });

      cache.put(request, cachedResponse);
    }

    return response;

  } catch {
    // Sin red: verificar TTL del caché
    const cached = await cache.match(request);

    if (cached) {
      const cachedAt = cached.headers.get('X-Cached-At');

      if (cachedAt) {
        const ageSeconds = (Date.now() - parseInt(cachedAt, 10)) / 1000;
        if (ageSeconds <= ttlSeconds) {
          console.info('[SW] API servida desde caché (age:', Math.round(ageSeconds), 's)');
          return cached;
        }
        console.warn('[SW] Caché de API expirado. No hay red.');
      } else {
        // Sin timestamp: servir igual (beneficio de la duda)
        return cached;
      }
    }

    // Sin red y sin caché válido
    return new Response(
      JSON.stringify({
        error:   'offline',
        message: 'Sin conexión y sin caché disponible.',
      }),
      {
        status:  503,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}