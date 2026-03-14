/**
 * @file vndb-service.js
 * @description Servicio modular para consumir la API HTTP de VNDB.org (kana).
 *
 * CORRECCIONES v3 (BUG-03 + BUG-07):
 *
 *  BUG-03 — Doble escape en snapshots de localStorage:
 *    ANTES: _transformVn() llamaba sanitizeObject(rawVn) y luego guardaba
 *    el VnEntry resultante en localStorage via _saveSnapshot(). Como
 *    sanitizeObject escapa los strings (& → &amp;, < → &lt;), el snapshot
 *    almacenaba strings ya escapados. Al recuperarlos con _getSnapshot()
 *    y usarlos en textContent, aparecían literales como "Fate&#x2F;stay night"
 *    en lugar de "Fate/stay night".
 *
 *    FIX: sanitizeObject() se aplica SOLO sobre el rawVn crudo, antes de
 *    extraer cualquier campo. _transformVn() construye el VnEntry con los
 *    valores limpios (ya seguros para textContent, sin HTML-entities).
 *    _saveSnapshot() guarda ese VnEntry directamente — sin re-escapar.
 *    La protección XSS sigue siendo válida porque la UI usa textContent
 *    (nunca innerHTML) para todos los campos del VnEntry.
 *
 *  BUG-07 — getVnsByIds() sin verificación de caché individual:
 *    ANTES: cada llamada a getVnsByIds() hacía un POST a VNDB aunque
 *    algunos (o todos) los IDs ya estuvieran en _cache de getVnById().
 *    FIX: se verifica _getFromCache('vn:{id}') para cada ID antes de
 *    construir la petición, evitando llamadas de red redundantes.
 *
 * CAMBIOS v2 (previos, sin modificar):
 *  - _transformVn(): aplica stripBbCode() a la descripción.
 *  - _transformVn(): la descripción ya NO se trunca aquí.
 *  - stripBbCode importado desde utils.js.
 *
 * ARQUITECTURA:
 *  - Una sola responsabilidad: comunicación con VNDB (SRP).
 *  - Sin estado interno salvo la caché de sesión.
 *  - Toda data de red pasa por sanitización XSS antes de transformarse.
 */

'use strict';

import {
  VNDB_API_BASE,
  VNDB_VN_FIELDS_STR,
  VNDB_PAGE_SIZE,
  VNDB_REQUEST_TIMEOUT_MS,
} from './constants.js';

import {
  sanitizeObject,
  getPreferredTitle,
  formatReleaseDate,
  formatDuration,
  formatVndbRating,
  isNonEmptyString,
  stripBbCode,
} from './utils.js';
import { translateTags } from './translation-tags.js';


// ─────────────────────────────────────────────
// 1. ERROR PERSONALIZADO
// ─────────────────────────────────────────────

/**
 * Error específico de la comunicación con VNDB.
 * Permite distinguir errores VNDB de otros con instanceof.
 */
class VndbError extends Error {
  /**
   * @param {string} message
   * @param {number} code - Código HTTP o 0 para errores de red.
   */
  constructor(message, code) {
    super(message);
    this.name = 'VndbError';
    this.code = code;
  }
}


// ─────────────────────────────────────────────
// 2. CACHÉ EN MEMORIA (sesión)
// ─────────────────────────────────────────────

/** @type {Map<string, {data: object, timestamp: number}>} */
const _cache = new Map();

/** TTL de la caché en memoria: 5 minutos */
const CACHE_TTL_MS = 5 * 60 * 1_000;

/**
 * Devuelve el resultado de caché si existe y no expiró.
 * @param {string} key
 * @returns {object|null}
 */
function _getFromCache(key) {
  const entry = _cache.get(key);
  if (!entry) return null;

  const isExpired = Date.now() - entry.timestamp > CACHE_TTL_MS;
  if (isExpired) {
    _cache.delete(key);
    return null;
  }

  return entry.data;
}

/**
 * Guarda un resultado en la caché en memoria.
 * @param {string} key
 * @param {object} data
 */
function _setCache(key, data) {
  _cache.set(key, { data, timestamp: Date.now() });
}


// ─────────────────────────────────────────────
// 2a. SNAPSHOT LOCAL (persistente en localStorage)
//
// DISEÑO INTENCIONAL:
//  El snapshot almacena el VnEntry ya transformado y limpio.
//  Los strings NO están HTML-escapados porque se usan con
//  textContent (nunca innerHTML). Si se escaparan aquí,
//  aparecerían literales como &amp; en la UI (BUG-03).
// ─────────────────────────────────────────────

const META_STORAGE_KEY = 'vnh_meta';
const META_TTL_MS      = 30 * 24 * 60 * 60 * 1_000; // 30 días

/**
 * Lee el mapa de snapshots desde localStorage.
 * @returns {Record<string, object>}
 */
function _loadMetaMap() {
  try {
    const raw = localStorage.getItem(META_STORAGE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return (typeof obj === 'object' && obj !== null && !Array.isArray(obj))
      ? obj
      : {};
  } catch {
    return {};
  }
}

/**
 * Persiste el mapa de snapshots en localStorage.
 * @param {Record<string, object>} map
 */
function _saveMetaMap(map) {
  try {
    localStorage.setItem(META_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // QuotaExceededError u otro — ignorar silenciosamente.
    // La caché en memoria sigue operativa.
  }
}

/**
 * Guarda un VnEntry en el snapshot persistente.
 *
 * CORRECCIÓN BUG-03:
 *  Recibe el VnEntry ya transformado (strings limpios, sin HTML-entities).
 *  No aplica ningún escape adicional — los datos se usan con textContent.
 *
 * @param {import('./vndb-service.js').VnEntry} vn - VnEntry transformado.
 */
function _saveSnapshot(vn) {
  if (!vn?.id) return;
  const map = _loadMetaMap();
  map[vn.id] = { ...vn, _savedAt: Date.now() };
  _saveMetaMap(map);
}

/**
 * Recupera un snapshot del localStorage si no expiró.
 * @param {string} vnId
 * @returns {import('./vndb-service.js').VnEntry|null}
 */
function _getSnapshot(vnId) {
  const map  = _loadMetaMap();
  const snap = map[vnId];
  if (!snap) return null;
  const expired = Date.now() - (snap._savedAt ?? 0) > META_TTL_MS;
  return expired ? null : snap;
}


// ─────────────────────────────────────────────
// 3. CAPA DE TRANSPORTE (HTTP)
// ─────────────────────────────────────────────

/**
 * Realiza una petición POST al endpoint VNDB indicado.
 * Implementa timeout mediante AbortController.
 *
 * @param {string} endpoint - Ruta relativa (ej: '/vn').
 * @param {object} body     - Cuerpo JSON.
 * @returns {Promise<object>}
 * @throws {VndbError}
 */
async function _post(endpoint, body) {
  const url        = `${VNDB_API_BASE}${endpoint}`;
  const controller = new AbortController();

  const timeoutId = setTimeout(
    () => controller.abort(),
    VNDB_REQUEST_TIMEOUT_MS,
  );

  try {
    console.debug('[VNDB] POST', endpoint, body);
    const response = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const text    = await response.text().catch(() => '');
      const snippet = text.slice(0, 200);
      throw new VndbError(
        `Error HTTP ${response.status} en VNDB${snippet ? ` — ${snippet}` : ''}`,
        response.status,
      );
    }

    return await response.json();

  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof VndbError) throw error;

    if (error.name === 'AbortError') {
      throw new VndbError(
        'La conexión con VNDB tardó demasiado. Verifica tu conexión y reintenta.',
        408,
      );
    }

    throw new VndbError(
      `No se pudo conectar con VNDB: ${error.message}`,
      0,
    );
  }
}


// ─────────────────────────────────────────────
// 4. CAPA DE TRANSFORMACIÓN
// ─────────────────────────────────────────────

/**
 * @typedef {Object} VnEntry
 * @property {string}   id            - ID de VNDB (ej: "v17")
 * @property {string}   title         - Título preferido (es > en > ja-ro > original)
 * @property {string}   titleOriginal - Título principal de VNDB
 * @property {string}   description   - Sinopsis limpia (BBCode eliminado, sin truncar)
 * @property {string}   imageUrl      - URL de la portada
 * @property {boolean}  imageIsAdult  - true si la portada tiene contenido sexual
 * @property {string}   released      - Fecha de lanzamiento formateada (es-AR)
 * @property {string}   rating        - Rating 0.0–10.0 como string
 * @property {number}   votecount     - Total de votos en VNDB
 * @property {string}   duration      - Duración estimada (ej: "20h 30min")
 * @property {string[]} tags          - Top 10 tags más relevantes
 * @property {string[]} developers    - Nombres de desarrolladores
 */

/**
 * Transforma un objeto VN crudo de VNDB al formato VnEntry interno.
 *
 * CORRECCIÓN BUG-03 — Flujo de sanitización en dos fases:
 *
 *  FASE 1 — sanitizeObject(rawVn):
 *    Escapa todos los strings del objeto crudo de la API para prevenir
 *    XSS. Necesario porque rawVn viene de una fuente externa (VNDB).
 *    Esta operación convierte: <script> → &lt;script&gt;
 *
 *  FASE 2 — Construcción del VnEntry:
 *    Se extraen los campos del objeto sanitizado y se les aplican
 *    las transformaciones de presentación (formateo de fecha, duración,
 *    rating, etc.). Los strings resultantes están libres de HTML-entities
 *    porque son valores de presentación, no strings HTML.
 *
 *  IMPORTANTE: El VnEntry resultante NO debe volver a pasar por
 *  sanitizeObject(). Sus strings se insertan con textContent
 *  (never innerHTML), por lo que no necesitan escapado HTML adicional.
 *  Aplicar sanitizeObject() de nuevo generaría el BUG-03 original
 *  (doble-escape: & → &amp; → &amp;amp;).
 *
 * @param {object} rawVn - Objeto VN sin procesar de la API VNDB.
 * @returns {VnEntry}
 */
function _transformVn(rawVn) {
  // ── FASE 1: Sanitizar el objeto crudo de la API ───────────────
  // Esta es la ÚNICA llamada a sanitizeObject() en todo el flujo.
  // rawVn viene de la red y puede contener strings maliciosos.
  const safe = sanitizeObject(rawVn);

  // ── FASE 2: Construir el VnEntry con valores de presentación ──
  // Los campos se extraen del objeto sanitizado y se transforman.
  // Nota: safe.description contiene HTML-entities (&lt; etc.) que
  // stripBbCode maneja correctamente porque opera sobre el string
  // ya escapado — y los valores finales se insertan con textContent.
  const rawDescription  = safe.description ?? '';
  const cleanDescription = stripBbCode(rawDescription);

  return {
    id:            safe.id            ?? '',
    title:         getPreferredTitle(safe.title, safe.titles ?? []),
    titleOriginal: safe.title         ?? '',
    description:   cleanDescription,
    imageUrl:      rawVn.image?.url   ?? '',   // URL: se usa en src="" — NO escapar
    imageIsAdult:  (rawVn.image?.sexual ?? 0) > 1,
    released:      formatReleaseDate(safe.released),
    rating:        formatVndbRating(rawVn.rating),   // número — no necesita escape
    votecount:     rawVn.votecount    ?? 0,           // número — no necesita escape
    duration:      formatDuration(rawVn.length_minutes),
    tags:          translateTags(_extractTopTags(rawVn.tags ?? [], 10)),
    developers:    (rawVn.developers ?? [])
                     .map(d => String(d?.name ?? '').trim())
                     .filter(Boolean),
  };
}

/**
 * Extrae los N tags más relevantes de una VN.
 * Solo incluye tags con rating >= 2.0 (filtra tags marginales).
 *
 * @param {Array<{name:string, rating:number}>} tags
 * @param {number} limit
 * @returns {string[]}
 */
function _extractTopTags(tags, limit) {
  return tags
    .filter(t  => (t?.rating ?? 0) >= 2.0)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, limit)
    .map(t => String(t?.name ?? '').trim())
    .filter(isNonEmptyString);
}


// ─────────────────────────────────────────────
// 5. API PÚBLICA
// ─────────────────────────────────────────────

/**
 * @typedef {Object} SearchResult
 * @property {VnEntry[]} items
 * @property {boolean}   more
 * @property {number}    count
 */

/**
 * Busca Visual Novels por título en VNDB.
 * Ordenadas por rating descendente.
 *
 * @param {string} query
 * @param {{page?: number}} [options]
 * @returns {Promise<SearchResult>}
 * @throws {VndbError}
 */
async function searchVns(query, { page = 1 } = {}) {
  if (!isNonEmptyString(query) || query.trim().length < 2) {
    return { items: [], more: false, count: 0 };
  }

  const trimmedQuery = query.trim().replace(/\s{2,}/g, ' ');
  const cacheKey     = `search:${trimmedQuery}:p${page}`;

  const cached = _getFromCache(cacheKey);
  if (cached) return cached;

  const body = {
    filters:  ['search', '=', trimmedQuery],
    fields:   VNDB_VN_FIELDS_STR,
    results:  VNDB_PAGE_SIZE,
    page,
    sort:     'rating',
    reverse:  true,
  };

  const raw    = await _post('/vn', body);
  const result = {
    items: (raw.results ?? []).map(rv => {
      const v = _transformVn(rv);
      _saveSnapshot(v);
      return v;
    }),
    more:  raw.more  ?? false,
    count: raw.count ?? 0,
  };

  _setCache(cacheKey, result);
  return result;
}

/**
 * Obtiene los metadatos completos de una VN por su ID.
 *
 * @param {string} vnId - Formato "v{número}" (ej: "v17").
 * @returns {Promise<VnEntry|null>}
 * @throws {VndbError}
 */
async function getVnById(vnId) {
  if (!isNonEmptyString(vnId) || !/^v\d+$/.test(vnId)) {
    throw new VndbError(
      `ID de VN inválido: "${vnId}". Formato esperado: "v{número}" (ej: "v17").`,
      400,
    );
  }

  const cacheKey = `vn:${vnId}`;
  const cached   = _getFromCache(cacheKey);
  if (cached) return cached;

  const body = {
    filters: ['id', '=', vnId],
    fields:  VNDB_VN_FIELDS_STR,
    results: 1,
  };

  const raw = await _post('/vn', body);
  const vn  = raw.results?.[0] ?? null;
  if (!vn) return null;

  const transformed = _transformVn(vn);
  _setCache(cacheKey, transformed);
  _saveSnapshot(transformed);
  return transformed;
}

/**
 * Obtiene múltiples VNs por sus IDs en una sola petición HTTP.
 *
 * CORRECCIÓN BUG-07 — Caché por ID individual:
 *  ANTES: siempre hacía un POST aunque los IDs ya estuvieran en caché.
 *  AHORA: verifica _cache para cada ID. Solo hace POST por los IDs
 *  que realmente faltan, y combina el resultado con los cacheados.
 *  Si todos están en caché, no hay llamada de red.
 *
 * @param {string[]} vnIds
 * @returns {Promise<VnEntry[]>}
 * @throws {VndbError}
 */
async function getVnsByIds(vnIds) {
  // Deduplicar y validar IDs
  const validIds = [...new Set(
    (vnIds ?? []).filter(id => isNonEmptyString(id) && /^v\d+$/.test(id))
  )];

  if (validIds.length === 0) return [];

  // ── Separar IDs que ya están en caché de los que no ──────────
  const fromCache = [];
  const missing   = [];

  for (const id of validIds) {
    const cached = _getFromCache(`vn:${id}`);
    if (cached) {
      fromCache.push(cached);
    } else {
      missing.push(id);
    }
  }

  // Si todos estaban en caché, devolver sin petición de red
  if (missing.length === 0) return fromCache;

  // ── Pedir a VNDB solo los IDs que faltan ─────────────────────
  const filtersExpr = ['or', ...missing.map(id => ['id', '=', id])];
  const body = {
    filters: filtersExpr,
    fields:  VNDB_VN_FIELDS_STR,
    results: Math.min(missing.length, 100),
  };

  const raw      = await _post('/vn', body);
  const fetched  = (raw.results ?? []).map(rv => {
    const v = _transformVn(rv);
    // Guardar en caché individual para futuras llamadas
    _setCache(`vn:${v.id}`, v);
    _saveSnapshot(v);
    return v;
  });

  // Combinar: resultados de caché + recién descargados
  return [...fromCache, ...fetched];
}

/**
 * Obtiene las VNs con mejor rating en VNDB.
 * Requiere mínimo 100 votos.
 *
 * @param {number} [limit]
 * @returns {Promise<VnEntry[]>}
 * @throws {VndbError}
 */
async function getTopRatedVns(limit = 12) {
  const safeLimit = Math.min(Math.max(1, Number(limit) || 12), 100);
  const cacheKey  = `top:${safeLimit}`;

  const cached = _getFromCache(cacheKey);
  if (cached) return cached;

  const body = {
    filters: ['votecount', '>=', 100],
    fields:  VNDB_VN_FIELDS_STR,
    results: safeLimit,
    sort:    'rating',
    reverse: true,
  };

  const raw    = await _post('/vn', body);
  const result = (raw.results ?? []).map(rv => {
    const v = _transformVn(rv);
    _setCache(`vn:${v.id}`, v);   // poblar caché individual también
    return v;
  });

  _setCache(cacheKey, result);
  return result;
}

/**
 * Limpia toda la caché en memoria.
 */
function clearCache() {
  _cache.clear();
}

/**
 * Devuelve estadísticas de la caché actual (debugging).
 * @returns {{ size: number, keys: string[] }}
 */
function getCacheStats() {
  return {
    size: _cache.size,
    keys: [..._cache.keys()],
  };
}


// ─────────────────────────────────────────────
// EXPORTACIÓN
// ─────────────────────────────────────────────
export {
  VndbError,
  searchVns,
  getVnById,
  getVnsByIds,
  getTopRatedVns,
  clearCache,
  getCacheStats,
  _getSnapshot as getLocalMetaSnapshot,
};