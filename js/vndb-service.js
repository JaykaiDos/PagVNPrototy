/**
 * @file vndb-service.js
 * @description Servicio modular para consumir la API HTTP de VNDB.org (kana).
 *
 * CAMBIOS v2:
 *  - _transformVn(): aplica stripBbCode() a la descripción antes de almacenarla.
 *    Elimina markup [b][i][url][spoiler] etc. que VNDB incluye en las sinopsis.
 *  - _transformVn(): la descripción ya NO se trunca a 300 chars aquí.
 *    El truncado ahora lo hace novel-details.js via la lógica de "Leer más"
 *    (SYNOPSIS_PREVIEW_LEN). Para las cards de búsqueda, render-engine.js
 *    ya no muestra la descripción, así que no hay impacto.
 *  - stripBbCode importado desde utils.js.
 *
 * NOTA SOBRE IDIOMA:
 *  VNDB solo expone un campo "description" por VN (siempre en inglés/japonés).
 *  No existe endpoint de descripción por idioma en la API pública de VNDB.
 *  La traducción automática requiere backend, incompatible con GitHub Pages.
 *
 * ─────────────────────────────────────────────────────────
 * ARQUITECTURA:
 *  - Una sola responsabilidad: comunicación con VNDB (SRP).
 *  - Sin estado interno salvo la caché de sesión.
 *  - Toda data pasa por sanitización XSS antes de salir del módulo.
 * ─────────────────────────────────────────────────────────
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
// 2. CACHÉ EN MEMORIA
// ─────────────────────────────────────────────

/** @type {Map<string, {data: object, timestamp: number}>} */
const _cache = new Map();

/** TTL de la caché: 5 minutos */
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
// 2.a SNAPSHOT LOCAL (persistente en localStorage)
// ─────────────────────────────────────────────

const META_STORAGE_KEY = 'vnh_meta';
const META_TTL_MS      = 30 * 24 * 60 * 60 * 1_000; // 30 días

function _loadMetaMap() {
  try {
    const raw = localStorage.getItem(META_STORAGE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return typeof obj === 'object' && obj ? obj : {};
  } catch { return {}; }
}

function _saveMetaMap(map) {
  try {
    localStorage.setItem(META_STORAGE_KEY, JSON.stringify(map));
  } catch {}
}

function _saveSnapshot(vn) {
  if (!vn?.id) return;
  const map = _loadMetaMap();
  map[vn.id] = {
    ...vn,
    _savedAt: Date.now(),
  };
  _saveMetaMap(map);
}

function _getSnapshot(vnId) {
  const map = _loadMetaMap();
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
      const text = await response.text().catch(() => '');
      const snippet = (text || '').slice(0, 200);
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
 * CAMBIOS v2:
 *  - description: se limpia con stripBbCode() para eliminar [b][i][url] etc.
 *  - description: ya NO se trunca (el truncado lo gestiona la UI).
 *
 * @param {object} rawVn - Objeto VN sin procesar de la API VNDB.
 * @returns {VnEntry}
 */
function _transformVn(rawVn) {
  // Sanitizamos el objeto completo recursivamente (protección XSS global)
  const vn = sanitizeObject(rawVn);

  // Limpiar BBCode de la descripción antes de almacenar
  const rawDescription = vn.description ?? '';
  const cleanDescription = stripBbCode(rawDescription);

  return {
    id:            vn.id            ?? '',
    title:         getPreferredTitle(vn.title, vn.titles ?? []),
    titleOriginal: vn.title         ?? '',
    // v2: BBCode eliminado, sin truncar (la UI decide cuánto mostrar)
    description:   cleanDescription,
    imageUrl:      vn.image?.url    ?? '',
    imageIsAdult:  (vn.image?.sexual ?? 0) > 1,
    released:      formatReleaseDate(vn.released),
    rating:        formatVndbRating(vn.rating),
    votecount:     vn.votecount     ?? 0,
    duration:      formatDuration(vn.length_minutes),
    tags:          _extractTopTags(vn.tags ?? [], 10),
    developers:    (vn.developers ?? []).map(d => d.name).filter(Boolean),
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
    .filter(t  => t.rating >= 2.0)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, limit)
    .map(t => t.name)
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

  const trimmedQuery = query.trim().replace(/\s{2,}/g, ' ').replace(/[^\S\r\n]+/g, ' ');
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
 * @param {string[]} vnIds
 * @returns {Promise<VnEntry[]>}
 * @throws {VndbError}
 */
async function getVnsByIds(vnIds) {
  const validIds = [...new Set(
    (vnIds ?? []).filter(id => isNonEmptyString(id) && /^v\d+$/.test(id))
  )];

  if (validIds.length === 0) return [];

  const filtersExpr = ['or', ...validIds.map(id => ['id', '=', id])];
  const body = {
    filters: filtersExpr,
    fields:  VNDB_VN_FIELDS_STR,
    results: Math.min(validIds.length, 100),
  };

  const raw = await _post('/vn', body);
  return (raw.results ?? []).map(rv => {
    const v = _transformVn(rv);
    _saveSnapshot(v);
    return v;
  });
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
  const result = (raw.results ?? []).map(_transformVn);

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
