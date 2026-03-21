/**
 * @file sw.js
 * @description Service Worker para VN-Hub.
 *
 * CAMBIOS v3 — Optimización de carga de imágenes:
 * ─────────────────────────────────────────────────────────────────
 *  PROBLEMA (v2):
 *   _networkFirstImages() siempre hacía una petición de red antes de
 *   consultar el caché. Esto significaba que cada imagen, aunque ya
 *   estuviera almacenada localmente, generaba latencia de red antes de
 *   mostrarse. En conexiones lentas (3G/4G variable) este era el
 *   cuello de botella principal de la lentitud de imágenes.
 *
 *  SOLUCIÓN:
 *   Las imágenes de VNDB ahora usan estrategia CACHE-FIRST:
 *    1. Buscar en caché local → si existe, devolver inmediatamente (0ms).
 *    2. Si no está en caché → ir a la red, guardar y devolver.
 *   Las imágenes de portada no cambian con el tiempo (son estáticas
 *   por diseño en VNDB), por lo que Cache-First es seguro y óptimo.
 *
 *  TTL DEL CACHÉ DE IMÁGENES:
 *   Se añade un header X-Cached-At para poder expirar imágenes después
 *   de IMAGE_CACHE_TTL_DAYS días. Esto previene que portadas
 *   actualizadas en VNDB queden obsoletas indefinidamente.
 *
 *  LÍMITE DE ENTRADAS:
 *   Se aumenta MAX_IMAGE_CACHE_ENTRIES de 150 a 300 para reducir
 *   la frecuencia de purgas (cada purga fuerza una petición de red).
 *
 * @version 3.0
 */

'use strict';


const CACHE_VERSION = 'v3';
const SHELL_CACHE   = `vnh-shell-${CACHE_VERSION}`;
const IMAGES_CACHE  = `vnh-images-${CACHE_VERSION}`;
const API_CACHE     = `vnh-api-${CACHE_VERSION}`;


// ─────────────────────────────────────────────
// CONFIGURACIÓN
// ─────────────────────────────────────────────

/**
 * Máximo de imágenes en caché antes de purgar el 10% más antiguo.
 * Aumentado de 150 → 300 para reducir purgas innecesarias.
 * Una portada promedio pesa ~40-80 KB → 300 entradas ≈ 12-24 MB.
 */
const MAX_IMAGE_CACHE_ENTRIES = 300;

/** TTL para respuestas de la API VNDB (segundos). */
const API_CACHE_TTL_SECONDS = 300;

/**
 * TTL para imágenes cacheadas (días).
 * Después de este tiempo, la siguiente visita refresca la imagen
 * desde la red aunque esté en caché. Valor: 30 días.
 */
const IMAGE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;


// ─────────────────────────────────────────────
// SHELL ASSETS — Lista exhaustiva
// ─────────────────────────────────────────────

const SHELL_ASSETS = [
  // ── Páginas HTML ───────────────────────────
  './',
  './index.html',
  './novel-details.html',

  // ── CSS ────────────────────────────────────
  './assets/css/vn-hub.css',
  './assets/css/vn-hub-components.css',
  './assets/css/vn-hub-explore.css',
  './assets/css/vn-hub-export.css',
  './assets/css/vn-hub-profile.css',
  './assets/css/vn-hub-mobile.css',
  './assets/css/vn-hub-details.css',
  './assets/css/vn-hub-auth.css',

  // ── JS: núcleo ─────────────────────────────
  './js/app-init.js',
  './js/constants.js',
  './js/utils.js',
  './js/render-engine.js',
  './js/ui-controller.js',

  // ── JS: servicios ──────────────────────────
  './js/vndb-service.js',
  './js/firebase-service.js',
  './js/library-store.js',
  './js/score-engine.js',

  // ── JS: controladores ──────────────────────
  './js/auth-controller.js',
  './js/feed-controller.js',
  './js/profile-controller.js',
  './js/explore-controller.js',
  './js/mobile-gestures.js',
  './js/novel-details.js',

  // ── JS: traducciones ───────────────────────
  './js/translation-service.js',
  './js/translation-tags.js',

  // ── JS: modales ────────────────────────────
  './js/modal-review.js',
  './js/modal-log.js',
  './js/modal-comment.js',
  './js/modal-delete.js',
  './js/modal-export.js',

  // ── JS: extensiones ────────────────────────
  './js/firebase-profile-ext.js',

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
  console.info('[SW] Instalando v3…');

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

  // ── Imágenes VNDB → Cache-First con TTL ───────────────────
  //
  // CAMBIO v3: Network-First → Cache-First
  // Razón: las portadas de VNDB son estáticas (no cambian).
  // Cache-First elimina la latencia de red en visitas posteriores.
  // El TTL de 30 días garantiza que imágenes actualizadas en VNDB
  // se refresquen eventualmente.
  if (url.hostname.includes('s2.vndb.org') || url.hostname.includes('t.vndb.org')) {
    event.respondWith(_cacheFirstImages(request, IMAGES_CACHE));
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
 * Cache-First genérico (shell assets, fuentes).
 * @param {Request} request
 * @param {string}  cacheName
 * @returns {Promise<Response>}
 */
async function _cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    console.warn('[SW] Sin red y sin caché para:', request.url);
    return new Response('Recurso no disponible offline.', {
      status:  503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

/**
 * Cache-First para imágenes VNDB con TTL y límite de entradas.
 *
 * FLUJO:
 *  1. Buscar en caché → si existe Y no expiró → devolver (0ms extra).
 *  2. Si expiró o no existe → fetch de red → guardar con timestamp.
 *  3. Sin red y sin caché → placeholder SVG.
 *
 * VENTAJA vs Network-First anterior:
 *  En la segunda visita a la misma página, las portadas aparecen
 *  instantáneamente desde caché local sin ninguna petición HTTP.
 *
 * @param {Request} request
 * @param {string}  cacheName
 * @returns {Promise<Response>}
 */
async function _cacheFirstImages(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);

  if (cached) {
    // Verificar TTL: si no expiró, devolver desde caché
    const cachedAt = cached.headers.get('X-Cached-At');
    if (cachedAt) {
      const ageMs = Date.now() - parseInt(cachedAt, 10);
      if (ageMs <= IMAGE_CACHE_TTL_MS) {
        // Imagen fresca en caché → respuesta instantánea
        return cached;
      }
      // Imagen expirada → refrescar en background (stale-while-revalidate)
      _refreshImageInBackground(request, cache);
      return cached; // devolver la versión expirada mientras se refresca
    }
    // Sin timestamp (entradas de versión anterior) → devolver igual
    return cached;
  }

  // No está en caché → fetch de red
  return _fetchAndCacheImage(request, cache);
}

/**
 * Descarga una imagen, la guarda en caché con timestamp y la devuelve.
 * Si la red falla y no hay caché, devuelve el placeholder SVG.
 *
 * @param {Request}   request
 * @param {Cache}     cache    - Instancia ya abierta del caché
 * @returns {Promise<Response>}
 */
async function _fetchAndCacheImage(request, cache) {
  try {
    const response = await fetch(request);

    if (response.ok) {
      // Inyectar timestamp para el TTL
      const headers = new Headers(response.headers);
      headers.set('X-Cached-At', String(Date.now()));

      const blob           = await response.blob();
      const cachedResponse = new Response(blob, {
        status:     response.status,
        statusText: response.statusText,
        headers,
      });

      // Purgar si el caché supera el límite antes de guardar
      await _pruneImageCache(cache);
      cache.put(request, cachedResponse.clone());

      // Devolver una Response fresca desde el mismo blob
      return new Response(blob, {
        status:     response.status,
        statusText: response.statusText,
        headers:    response.headers,
      });
    }

    return response;

  } catch {
    // Sin red y sin caché → placeholder SVG
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
 * Refresca una imagen en segundo plano (stale-while-revalidate).
 * No bloquea la respuesta al usuario — se ejecuta de forma asíncrona.
 *
 * @param {Request} request
 * @param {Cache}   cache
 */
function _refreshImageInBackground(request, cache) {
  // Fire-and-forget: no await intencional
  fetch(request)
    .then(async response => {
      if (!response.ok) return;
      const headers = new Headers(response.headers);
      headers.set('X-Cached-At', String(Date.now()));
      const cachedResponse = new Response(await response.blob(), {
        status: response.status, statusText: response.statusText, headers,
      });
      await cache.put(request, cachedResponse);
      console.debug('[SW] Imagen refrescada en background:', request.url);
    })
    .catch(() => {
      // Silencioso: si falla, la versión expirada sigue sirviendo
    });
}

/**
 * Purga las entradas más antiguas si el caché supera MAX_IMAGE_CACHE_ENTRIES.
 * Se llama ANTES de guardar una nueva entrada para mantener el límite.
 *
 * @param {Cache} cache - Instancia ya abierta del caché
 */
async function _pruneImageCache(cache) {
  const keys = await cache.keys();
  if (keys.length < MAX_IMAGE_CACHE_ENTRIES) return;

  // Ordenar por X-Cached-At si está disponible, sino FIFO
  const entries = await Promise.all(
    keys.map(async key => {
      const resp      = await cache.match(key);
      const cachedAt  = resp?.headers?.get('X-Cached-At');
      return { key, ts: cachedAt ? parseInt(cachedAt, 10) : 0 };
    })
  );

  // Ordenar de más antiguo a más nuevo
  entries.sort((a, b) => a.ts - b.ts);

  // Eliminar el 10% más antiguo
  const countToDelete = Math.ceil(MAX_IMAGE_CACHE_ENTRIES * 0.1);
  await Promise.all(
    entries.slice(0, countToDelete).map(e => cache.delete(e.key))
  );

  console.info(`[SW] Purgadas ${countToDelete} imágenes del caché (límite: ${MAX_IMAGE_CACHE_ENTRIES}).`);
}

/**
 * Network-First con TTL para la API VNDB.
 * Con red: descarga, guarda con timestamp y devuelve la respuesta.
 * Sin red: sirve desde caché si no expiró; si expiró o no hay, 503.
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
        status:     response.status,
        statusText: response.statusText,
        headers,
      });

      cache.put(request, cachedResponse);
    }

    return response;

  } catch {
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
        return cached;
      }
    }

    return new Response(
      JSON.stringify({ error: 'offline', message: 'Sin conexión y sin caché disponible.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}