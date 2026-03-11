'use strict';

/**
 * @file js/explore-controller.js
 * @description Módulo de Exploración Rápida para VN-Hub (v6).
 *
 * RESPONSABILIDADES (SRP):
 *  1. Autocompletado inteligente: historial + sugerencias de VNDB en tiempo real.
 *  2. Filtros rápidos: Top Rated, Populares, Recientes, Clásicos.
 *  3. Filtro por rango de año: presets + inputs personalizados.
 *  4. Botonera de tags: selección múltiple con lógica AND/OR,
 *     contadores predictivos y transiciones suaves.
 *  5. Estado activo: barra de resumen de filtros + limpieza global.
 *
 * INTEGRACIÓN:
 *  - Este módulo es AUTÓNOMO. No modifica ui-controller.js.
 *  - Interactúa con VNDB API directamente (mismo patrón de vndb-service.js).
 *  - Escribe resultados en #searchResults y #searchState del DOM existente
 *    usando las mismas clases CSS que ui-controller (sin duplicar lógica).
 *  - Exporta `init()` llamado desde index.html vía <script type="module">.
 *
 * SEGURIDAD:
 *  - Todo texto de API se sanitiza antes de insertarse al DOM.
 *  - No se usa innerHTML con datos crudos de usuario/API.
 *
 * RENDIMIENTO:
 *  - Caché en memoria con TTL de 5 min (mismo patrón que vndb-service).
 *  - Debounce en autocompletado (300ms).
 *  - Contadores predictivos calculados con un request ligero (results:0, count:true).
 *
 * @module ExploreController
 */

import {
  VNDB_API_BASE,
  VNDB_VN_FIELDS_STR,
  VNDB_PAGE_SIZE,
  VNDB_REQUEST_TIMEOUT_MS,
} from './constants.js';

import * as RenderEngine  from './render-engine.js';
import * as LibraryStore  from './library-store.js';


// ─────────────────────────────────────────────
// 1. CONSTANTES DEL MÓDULO
// ─────────────────────────────────────────────

/** Tiempo de debounce para autocompletado (ms) */
const AUTOCOMPLETE_DEBOUNCE_MS = 300;

/** Máximo de sugerencias en el dropdown */
const AUTOCOMPLETE_MAX_ITEMS = 8;

/** Máximo de entradas en el historial de búsqueda */
const HISTORY_MAX_ITEMS = 6;

/** Clave en localStorage para historial */
const HISTORY_STORAGE_KEY = 'vnh_search_history';

/** TTL de la caché interna del módulo (5 minutos) */
const EXPLORE_CACHE_TTL_MS = 5 * 60 * 1_000;

/**
 * Tags predefinidos.
 *
 * NOTA SOBRE IDs:
 *  La API VNDB /vn requiere el vndbid del tag (formato "g{número}") para
 *  el filtro ['tag', '=', 'g{número}'], NO el nombre en texto plano.
 *  Los IDs se obtienen dinámicamente via /tag endpoint en _resolveTagIds().
 *  El campo `vndbId` se rellena en runtime y comienza como null.
 *
 *  Para referencia, los IDs verificados de los tags principales:
 *  Romance=g302, Mystery=g2143, Fantasy=g337, SciFi=g2461, Horror=g532,
 *  Comedy=g105, Drama=g248, Action=g32, SliceOfLife=g2607, KineticNovel=g698,
 *  Nakige=g2384, Utsuge=g2016, Supernatural=g1198, Historical=g549,
 *  Thriller=g2687, Tragedy=g2903
 *
 * @type {Array<{id:string, label:string, icon:string, vndbName:string, vndbId:string|null}>}
 */
const PREDEFINED_TAGS = [
  { id: 'romance',      label: 'Romance',        icon: '💕', vndbName: 'Romance',         vndbId: 'g302'  },
  { id: 'mystery',      label: 'Misterio',        icon: '🔍', vndbName: 'Mystery',         vndbId: 'g2143' },
  { id: 'fantasy',      label: 'Fantasía',        icon: '🧙', vndbName: 'Fantasy',         vndbId: 'g337'  },
  { id: 'scifi',        label: 'Ciencia Ficción', icon: '🚀', vndbName: 'Science Fiction', vndbId: 'g2461' },
  { id: 'horror',       label: 'Terror',          icon: '👻', vndbName: 'Horror',          vndbId: 'g532'  },
  { id: 'comedy',       label: 'Comedia',         icon: '😄', vndbName: 'Comedy',          vndbId: 'g105'  },
  { id: 'drama',        label: 'Drama',           icon: '🎭', vndbName: 'Drama',           vndbId: 'g248'  },
  { id: 'action',       label: 'Acción',          icon: '⚔️', vndbName: 'Action',          vndbId: 'g32'   },
  { id: 'slice',        label: 'Vida Cotidiana',  icon: '☕', vndbName: 'Slice of Life',   vndbId: 'g2607' },
  { id: 'kinetic',      label: 'Novela Cinética', icon: '📖', vndbName: 'Kinetic Novel',   vndbId: 'g698'  },
  { id: 'nakige',       label: 'Nakige',          icon: '😭', vndbName: 'Nakige',          vndbId: 'g2384' },
  { id: 'utsuge',       label: 'Utsuge',          icon: '🌧️', vndbName: 'Utsuge',          vndbId: 'g2016' },
  { id: 'supernatural', label: 'Sobrenatural',    icon: '✨', vndbName: 'Supernatural',    vndbId: 'g1198' },
  { id: 'historical',   label: 'Histórico',       icon: '🏛️', vndbName: 'Historical',      vndbId: 'g549'  },
  { id: 'thriller',     label: 'Suspenso',        icon: '😰', vndbName: 'Thriller',        vndbId: 'g2687' },
  { id: 'tragedy',      label: 'Tragedia',        icon: '💔', vndbName: 'Tragedy',         vndbId: 'g2903' },
];

/**
 * Resuelve y valida los vndbIds de los tags predefinidos contra la API /tag.
 * Si la API devuelve un ID diferente al hardcodeado, lo corrige en memoria.
 * Se ejecuta una sola vez al inicializar el módulo (fire-and-forget).
 *
 * ESTRATEGIA DE RESILIENCIA:
 *  1. Los IDs hardcodeados son los valores de producción verificados.
 *  2. Esta función los confirma/corrige consultando la API.
 *  3. Si la API falla, los IDs hardcodeados siguen funcionando.
 */
async function _resolveTagIds() {
  const STORAGE_KEY = 'vnh_tag_ids';
  const STORAGE_TTL = 7 * 24 * 60 * 60 * 1_000; // 7 días

  // Intentar usar IDs guardados en localStorage (evita re-consultar)
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (stored && Date.now() - stored.ts < STORAGE_TTL) {
      // Aplicar IDs guardados a PREDEFINED_TAGS
      PREDEFINED_TAGS.forEach(tag => {
        if (stored.ids[tag.id]) tag.vndbId = stored.ids[tag.id];
      });
      console.debug('[Explore] Tag IDs cargados desde localStorage.');
      return;
    }
  } catch { /* silencioso */ }

  // Consultar la API en paralelo para cada tag (batches de 4 para respetar rate limit)
  const idsMap = {};
  const batchSize = 4;

  for (let i = 0; i < PREDEFINED_TAGS.length; i += batchSize) {
    const batch = PREDEFINED_TAGS.slice(i, i + batchSize);

    await Promise.allSettled(batch.map(async (tag) => {
      try {
        const raw = await _apiPost('/tag', {
          filters: ['search', '=', tag.vndbName],
          fields:  'id, name',
          results: 5,
        });

        // Buscar coincidencia exacta (case-insensitive) entre los resultados
        const match = (raw.results ?? []).find(
          r => r.name?.toLowerCase() === tag.vndbName.toLowerCase()
        );

        if (match?.id) {
          tag.vndbId = match.id;
          idsMap[tag.id] = match.id;
          console.debug(`[Explore] Tag "${tag.vndbName}" → ${match.id}`);
        } else {
          // Mantener el ID hardcodeado como fallback
          idsMap[tag.id] = tag.vndbId;
          console.warn(`[Explore] Tag "${tag.vndbName}" no encontrado exacto, usando ${tag.vndbId}`);
        }
      } catch (err) {
        // Fallo de red: mantener ID hardcodeado
        idsMap[tag.id] = tag.vndbId;
        console.warn(`[Explore] Error resolviendo "${tag.vndbName}":`, err.message);
      }
    }));
  }

  // Persistir IDs resueltos en localStorage
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ts: Date.now(), ids: idsMap }));
  } catch { /* localStorage lleno — silencioso */ }
}


// ─────────────────────────────────────────────
// 2. ESTADO DEL MÓDULO
// ─────────────────────────────────────────────

/**
 * @typedef {Object} ExploreState
 * @property {'idle'|'top'|'popular'|'recent'|'classics'|'year'|'tags'} activeFilter
 * @property {string[]} selectedTags    - IDs de tags seleccionados
 * @property {'AND'|'OR'} tagLogic      - Modo de combinación de tags
 * @property {number|null} yearFrom     - Año inicio del filtro
 * @property {number|null} yearTo       - Año fin del filtro
 * @property {number} autocompleteIndex - Índice seleccionado en el dropdown
 */

/** @type {ExploreState} */
const _state = {
  activeFilter:       'idle',
  selectedTags:       [],
  tagLogic:           'AND',
  yearFrom:           null,
  yearTo:             null,
  autocompleteIndex:  -1,
};

/** Caché en memoria para resultados de exploración */
const _cache = new Map();

/** Timer de debounce para el autocompletado */
let _autocompleteTimer = null;


// ─────────────────────────────────────────────
// 3. REFERENCIAS AL DOM
// ─────────────────────────────────────────────

/** @type {Record<string, HTMLElement|null>} */
const _dom = {};

/**
 * Cachea las referencias a todos los elementos DOM del módulo.
 * Loggea advertencias si algún elemento no existe.
 */
function _cacheDOM() {
  const ids = [
    // Buscador existente (para autocompletado y escritura de resultados)
    'searchInput', 'searchResults', 'searchState', 'searchPagination',

    // Panel de exploración
    'vepPanel',

    // Quick filters
    // (se obtienen por querySelectorAll en _bindEvents)

    // Año
    'vepYearBlock', 'vepYearReset', 'vepYearFrom', 'vepYearTo', 'vepYearApply',

    // Tags
    'vepTagsBlock', 'vepTagsGrid', 'vepTagsCounter', 'vepTagsClear',

    // Lógica
    'vepLogicAnd', 'vepLogicOr',

    // Estado activo
    'vepStatusBar', 'vepStatusText', 'vepClearAll',

    // Autocompletado
    'vepAutocomplete', 'vepAutocompleteList',
  ];

  ids.forEach(id => {
    _dom[id] = document.getElementById(id);
    if (!_dom[id]) console.warn(`[Explore] Elemento #${id} no encontrado.`);
  });
}


// ─────────────────────────────────────────────
// 4. CACHÉ EN MEMORIA
// ─────────────────────────────────────────────

/**
 * Guarda datos en la caché interna con TTL.
 * @param {string} key
 * @param {any} data
 */
function _setCache(key, data) {
  _cache.set(key, { data, ts: Date.now() });
}

/**
 * Recupera datos de la caché si no están expirados.
 * @param {string} key
 * @returns {any|null}
 */
function _getCache(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > EXPLORE_CACHE_TTL_MS) {
    _cache.delete(key);
    return null;
  }
  return entry.data;
}


// ─────────────────────────────────────────────
// 5. HISTORIAL DE BÚSQUEDA
// ─────────────────────────────────────────────

/**
 * Devuelve el historial de búsquedas del usuario.
 * @returns {string[]}
 */
function _getHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    const parsed = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Añade un término al historial (sin duplicados, limitado a N entradas).
 * @param {string} term
 */
function _addToHistory(term) {
  if (!term || term.trim().length < 2) return;
  const clean = term.trim();
  try {
    const history = _getHistory().filter(h => h !== clean);
    history.unshift(clean);
    localStorage.setItem(
      HISTORY_STORAGE_KEY,
      JSON.stringify(history.slice(0, HISTORY_MAX_ITEMS)),
    );
  } catch { /* localStorage puede estar lleno — silencioso */ }
}


// ─────────────────────────────────────────────
// 6. CAPA HTTP (VNDB API)
// ─────────────────────────────────────────────

/**
 * POST genérico a la API VNDB con timeout.
 * Mismo patrón que vndb-service._post() — sin duplicar el import.
 *
 * @param {string} endpoint - Ruta relativa (ej: '/vn')
 * @param {object} body     - Cuerpo de la petición
 * @returns {Promise<object>}
 */
async function _apiPost(endpoint, body) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), VNDB_REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${VNDB_API_BASE}${endpoint}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  controller.signal,
    });
    clearTimeout(tid);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    clearTimeout(tid);
    throw err;
  }
}

/**
 * Sanitiza un string para inserción segura en el DOM (prevención XSS).
 * @param {string} str
 * @returns {string}
 */
function _sanitize(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}


// ─────────────────────────────────────────────
// 7. AUTOCOMPLETADO
// ─────────────────────────────────────────────

/**
 * Construye el filtro VNDB para búsqueda de sugerencias.
 * @param {string} query
 * @returns {object} Body listo para _apiPost
 */
function _buildAutocompleteBody(query) {
  return {
    filters:  ['search', '=', query],
    fields:   'id, title',
    results:  AUTOCOMPLETE_MAX_ITEMS,
    sort:     'rating',
    reverse:  true,
  };
}

/**
 * Obtiene sugerencias de VNDB para el query dado.
 * Mezcla historial local + resultados de la API.
 *
 * @param {string} query
 * @returns {Promise<Array<{type:'history'|'api', text:string, id?:string}>>}
 */
async function _fetchSuggestions(query) {
  const cacheKey = `autocomplete:${query.toLowerCase()}`;
  const cached   = _getCache(cacheKey);
  if (cached) return cached;

  const trimmed = query.trim();

  // Historial filtrado
  const history = _getHistory()
    .filter(h => h.toLowerCase().includes(trimmed.toLowerCase()))
    .slice(0, 3)
    .map(text => ({ type: 'history', text }));

  // Sugerencias de API (solo si >= 2 chars)
  let apiItems = [];
  if (trimmed.length >= 2) {
    try {
      const raw = await _apiPost('/vn', _buildAutocompleteBody(trimmed));
      apiItems = (raw.results ?? []).map(vn => ({
        type: 'api',
        text: vn.title ?? '',
        id:   vn.id   ?? '',
      }));
    } catch (err) {
      console.warn('[Explore] Autocompletado fallido:', err.message);
    }
  }

  // Deduplicar: eliminar de API los que ya están en historial
  const historyTexts = new Set(history.map(h => h.text.toLowerCase()));
  const uniqueApi    = apiItems.filter(
    a => !historyTexts.has(a.text.toLowerCase())
  );

  const result = [...history, ...uniqueApi];
  _setCache(cacheKey, result);
  return result;
}

/**
 * Renderiza el dropdown de autocompletado con las sugerencias.
 * Usa nodos DOM — sin innerHTML con datos externos (XSS-safe).
 *
 * @param {Array<{type:string, text:string, id?:string}>} suggestions
 * @param {string} query - Query original para resaltar coincidencias
 */
function _renderAutocomplete(suggestions, query) {
  const list      = _dom.vepAutocompleteList;
  const container = _dom.vepAutocomplete;
  if (!list || !container) return;

  // Limpiar lista anterior
  while (list.firstChild) list.removeChild(list.firstChild);

  if (suggestions.length === 0) {
    container.hidden = true;
    return;
  }

  let lastType = null;

  suggestions.forEach((item, idx) => {
    // Separador de grupo (historial / sugerencias)
    if (item.type !== lastType) {
      const groupLabel = document.createElement('li');
      groupLabel.className = 'vep-autocomplete__group-label';
      groupLabel.setAttribute('role', 'presentation');
      groupLabel.textContent = item.type === 'history' ? '🕐 Búsquedas recientes' : '💡 Sugerencias';
      list.appendChild(groupLabel);
      lastType = item.type;
    }

    // Ítem
    const li   = document.createElement('li');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', 'false');
    li.id = `vep-ac-item-${idx}`;

    const btn = document.createElement('button');
    btn.className = 'vep-autocomplete__item';
    btn.type      = 'button';
    btn.setAttribute('tabindex', '-1');
    btn.dataset.text = item.text;

    // Ícono
    const icon = document.createElement('span');
    icon.className   = 'vep-autocomplete__item-icon';
    icon.textContent = item.type === 'history' ? '🕐' : '🔍';
    icon.setAttribute('aria-hidden', 'true');

    // Texto con marca de coincidencia (XSS-safe via textContent + replaceChild)
    const textSpan = document.createElement('span');
    textSpan.className = 'vep-autocomplete__item-text';
    _highlightMatch(textSpan, item.text, query);

    btn.appendChild(icon);
    btn.appendChild(textSpan);
    li.appendChild(btn);

    // Click: ejecutar búsqueda
    btn.addEventListener('click', () => {
      _selectSuggestion(item.text);
    });

    list.appendChild(li);
  });

  _state.autocompleteIndex = -1;
  container.hidden = false;

  // Actualizar aria-expanded en el input
  if (_dom.searchInput) {
    _dom.searchInput.setAttribute('aria-expanded', 'true');
  }
}

/**
 * Inserta texto en un elemento span resaltando la coincidencia con el query.
 * NO usa innerHTML — construye nodos de texto y <mark> programáticamente.
 *
 * @param {HTMLElement} container
 * @param {string} text
 * @param {string} query
 */
function _highlightMatch(container, text, query) {
  const lower     = text.toLowerCase();
  const queryLow  = query.trim().toLowerCase();
  const matchIdx  = lower.indexOf(queryLow);

  if (!queryLow || matchIdx === -1) {
    container.textContent = text;
    return;
  }

  container.appendChild(document.createTextNode(text.slice(0, matchIdx)));

  const mark = document.createElement('mark');
  mark.textContent = text.slice(matchIdx, matchIdx + queryLow.length);
  container.appendChild(mark);

  container.appendChild(document.createTextNode(text.slice(matchIdx + queryLow.length)));
}

/**
 * Cierra el dropdown de autocompletado y resetea el índice.
 */
function _closeAutocomplete() {
  if (_dom.vepAutocomplete)  _dom.vepAutocomplete.hidden = true;
  if (_dom.searchInput)      _dom.searchInput.setAttribute('aria-expanded', 'false');
  _state.autocompleteIndex = -1;
}

/**
 * Selecciona un ítem del dropdown: rellena el input y ejecuta la búsqueda.
 * @param {string} text
 */
function _selectSuggestion(text) {
  if (!_dom.searchInput) return;

  _addToHistory(text);
  _dom.searchInput.value = text;
  _closeAutocomplete();

  // Disparar el evento input del controlador existente (ui-controller)
  // para que su sistema de búsqueda se active sin duplicar lógica.
  _dom.searchInput.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Navega por el dropdown usando teclado (↑/↓).
 * @param {'up'|'down'} direction
 */
function _navigateAutocomplete(direction) {
  const items = _dom.vepAutocompleteList
    ? _dom.vepAutocompleteList.querySelectorAll('.vep-autocomplete__item')
    : [];

  if (items.length === 0) return;

  // Deseleccionar anterior
  if (_state.autocompleteIndex >= 0 && items[_state.autocompleteIndex]) {
    items[_state.autocompleteIndex].parentElement?.setAttribute('aria-selected', 'false');
  }

  if (direction === 'down') {
    _state.autocompleteIndex = Math.min(
      _state.autocompleteIndex + 1,
      items.length - 1,
    );
  } else {
    _state.autocompleteIndex = Math.max(_state.autocompleteIndex - 1, -1);
  }

  if (_state.autocompleteIndex >= 0 && items[_state.autocompleteIndex]) {
    const item = items[_state.autocompleteIndex];
    item.parentElement?.setAttribute('aria-selected', 'true');
    item.scrollIntoView({ block: 'nearest' });

    // Previsualizar en el input (sin ejecutar búsqueda aún)
    if (_dom.searchInput) {
      _dom.searchInput.value = item.dataset.text ?? '';
    }
  }
}

/**
 * Handler principal del input de búsqueda para el autocompletado.
 * Debounceado para reducir peticiones a la API.
 * @param {Event} e
 */
function _onSearchInputForAutocomplete(e) {
  const query = e.target.value;

  clearTimeout(_autocompleteTimer);

  if (query.trim().length < 2) {
    _closeAutocomplete();
    return;
  }

  _autocompleteTimer = setTimeout(async () => {
    const suggestions = await _fetchSuggestions(query);
    _renderAutocomplete(suggestions, query);
  }, AUTOCOMPLETE_DEBOUNCE_MS);
}


// ─────────────────────────────────────────────
// 8. LÓGICA DE FILTROS DE EXPLORACIÓN
// ─────────────────────────────────────────────

/**
 * Construye el body para el endpoint /vn según el filtro activo.
 *
 * VNDB API v2 — Filtros soportados:
 *  - rating, votecount, released (operadores: =, !=, >, >=, <, <=)
 *  - tag: ['tag', '=', 'nombre_del_tag']
 *  - Combinación con ['and', ...] / ['or', ...]
 *
 * @param {ExploreState} state
 * @param {number} [page=1]
 * @returns {object|null} Body o null si no hay filtro activo
 */
function _buildFilterBody(state, page = 1) {
  const base = {
    fields:  VNDB_VN_FIELDS_STR,
    results: VNDB_PAGE_SIZE,
    page,
  };

  switch (state.activeFilter) {

    case 'top':
      return {
        ...base,
        filters: ['votecount', '>=', 100],
        sort:    'rating',
        reverse: true,
      };

    case 'popular':
      return {
        ...base,
        filters: ['votecount', '>=', 10],
        sort:    'votecount',
        reverse: true,
      };

    case 'recent':
      return {
        ...base,
        filters: ['and',
          ['released', '>=', '2024-01-01'],
          ['released', '<=', '2025-12-31'],
          ['votecount', '>=', 5],
        ],
        sort:    'released',
        reverse: true,
      };

    case 'classics':
      return {
        ...base,
        filters: ['and',
          ['released', '<', '2010-01-01'],
          ['votecount', '>=', 50],
        ],
        sort:    'rating',
        reverse: true,
      };

    case 'year': {
      if (!state.yearFrom && !state.yearTo) return null;

      const yearFilters = [];
      if (state.yearFrom) {
        yearFilters.push(['released', '>=', `${state.yearFrom}-01-01`]);
      }
      if (state.yearTo) {
        yearFilters.push(['released', '<=', `${state.yearTo}-12-31`]);
      }

      return {
        ...base,
        filters: yearFilters.length === 1
          ? yearFilters[0]
          : ['and', ...yearFilters],
        sort:    'rating',
        reverse: true,
      };
    }

    case 'tags': {
      if (state.selectedTags.length === 0) return null;

      // Mapear IDs de tags a nombres VNDB
      const tagFilters = state.selectedTags
        .map(id => PREDEFINED_TAGS.find(t => t.id === id))
        .filter(t => t?.vndbId)
        .map(t => ['tag', '=', t.vndbId]);

      if (tagFilters.length === 0) return null;

      const combineMode = state.tagLogic === 'AND' ? 'and' : 'or';

      return {
        ...base,
        filters: tagFilters.length === 1
          ? tagFilters[0]
          : [combineMode, ...tagFilters],
        sort:    'rating',
        reverse: true,
      };
    }

    default:
      return null;
  }
}

/**
 * Ejecuta la consulta a VNDB con el estado actual y renderiza los resultados.
 * Reutiliza el área de resultados de búsqueda existente (#searchResults).
 *
 * @param {number} [page=1]
 */
async function _executeExploreQuery(page = 1) {
  const body = _buildFilterBody(_state, page);
  if (!body) return;

  const cacheKey = `explore:${JSON.stringify(body)}`;

  // Mostrar estado de carga en el área existente
  _setSearchState('loading');
  _clearSearchResults();

  try {
    let raw = _getCache(cacheKey);

    if (!raw) {
      raw = await _apiPost('/vn', body);
      _setCache(cacheKey, raw);
    }

    const items = raw.results ?? [];

    if (items.length === 0) {
      _setSearchState('empty', 'No se encontraron resultados con estos filtros.');
      return;
    }

    _setSearchState('');
    _renderExploreResults(items);
    _updatePagination(page, raw.more ?? false);

  } catch (err) {
    console.error('[Explore] Error al consultar VNDB:', err);
    _setSearchState('error', 'No se pudo conectar con VNDB. Inténtalo de nuevo.');
  }
}

/**
 * Renderiza los resultados de exploración en el grid existente.
 * Delega en RenderEngine para mantener consistencia visual.
 *
 * @param {object[]} rawItems - Items crudos de VNDB (sin transformar)
 */
function _renderExploreResults(rawItems) {
  const grid = _dom.searchResults;
  if (!grid) return;

  while (grid.firstChild) grid.removeChild(grid.firstChild);

  const fragment = document.createDocumentFragment();

  rawItems.forEach((rawVn, index) => {
    // Transformación mínima para compatibilidad con RenderEngine
    const vnEntry = _transformRawVn(rawVn);

    const libEntry    = LibraryStore.getEntry(vnEntry.id);
    const isSaved     = libEntry !== null;
    const savedStatus = libEntry?.status ?? null;

    fragment.appendChild(
      RenderEngine.createVnCard(vnEntry, { isSaved, savedStatus, index }),
    );
  });

  grid.appendChild(fragment);
}

/**
 * Transforma un resultado crudo de VNDB al formato mínimo requerido
 * por RenderEngine.createVnCard(). No duplica _transformVn de vndb-service
 * porque opera sobre datos ya saneados por la API.
 *
 * @param {object} raw
 * @returns {import('./vndb-service.js').VnEntry}
 */
function _transformRawVn(raw) {
  return {
    id:            _sanitize(raw.id            ?? ''),
    title:         _sanitize(raw.title         ?? ''),
    titleOriginal: _sanitize(raw.title         ?? ''),
    description:   _sanitize(raw.description   ?? ''),
    imageUrl:      _sanitize(raw.image?.url    ?? ''),
    imageIsAdult:  (raw.image?.sexual ?? 0) > 1,
    released:      _sanitize(raw.released      ?? ''),
    rating:        raw.rating
      ? (raw.rating / 10).toFixed(2)
      : '—',
    votecount:     raw.votecount    ?? 0,
    duration:      '',
    tags:          (raw.tags ?? [])
      .filter(t => t.rating >= 2.0)
      .sort((a, b) => b.rating - a.rating)
      .slice(0, 6)
      .map(t => _sanitize(t.name ?? '')),
    developers:    (raw.developers ?? [])
      .map(d => _sanitize(d.name ?? ''))
      .filter(Boolean),
  };
}


// ─────────────────────────────────────────────
// 9. FILTROS RÁPIDOS
// ─────────────────────────────────────────────

/**
 * Activa un filtro rápido (top/popular/recent/classics).
 * Si se hace clic en el filtro ya activo, lo desactiva.
 * @param {string} filter
 */
function _activateQuickFilter(filter) {
  const isSameFilter = _state.activeFilter === filter;

  // Toggle: desactivar si ya está activo
  if (isSameFilter) {
    _state.activeFilter = 'idle';
    _updateQuickFilterUI(null);
    _updateStatusBar();
    _clearSearchResults();
    _setSearchState('idle');
    return;
  }

  _state.activeFilter = filter;
  _updateQuickFilterUI(filter);
  _updateStatusBar();
  _executeExploreQuery(1);
}

/**
 * Actualiza el estado visual (aria-pressed) de los botones de acceso rápido.
 * @param {string|null} activeFilter
 */
function _updateQuickFilterUI(activeFilter) {
  document.querySelectorAll('.vep-quick__btn').forEach(btn => {
    const isActive = btn.dataset.filter === activeFilter;
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}


// ─────────────────────────────────────────────
// 10. FILTRO DE AÑO
// ─────────────────────────────────────────────

/**
 * Aplica un preset de año (chip predefinido).
 * @param {number} from
 * @param {number} to
 */
function _applyYearPreset(from, to) {
  _state.yearFrom     = from;
  _state.yearTo       = to;
  _state.activeFilter = 'year';

  // Sincronizar inputs con los valores del preset
  if (_dom.vepYearFrom) _dom.vepYearFrom.value = String(from);
  if (_dom.vepYearTo)   _dom.vepYearTo.value   = String(to);

  _updateYearChipsUI(from, to);
  _updateQuickFilterUI(null);
  _showYearReset();
  _updateStatusBar();
  _executeExploreQuery(1);
}

/**
 * Aplica el rango de año de los inputs personalizados.
 */
function _applyCustomYearRange() {
  const from = parseInt(_dom.vepYearFrom?.value ?? '', 10);
  const to   = parseInt(_dom.vepYearTo?.value   ?? '', 10);

  const validFrom = !isNaN(from) && from >= 1980 && from <= 2025;
  const validTo   = !isNaN(to)   && to   >= 1980 && to   <= 2025;

  if (!validFrom && !validTo) return;

  _state.yearFrom     = validFrom ? from : null;
  _state.yearTo       = validTo   ? to   : null;
  _state.activeFilter = 'year';

  _updateYearChipsUI(null, null); // Deseleccionar presets
  _updateQuickFilterUI(null);
  _showYearReset();
  _updateStatusBar();
  _executeExploreQuery(1);
}

/**
 * Limpia el filtro de año.
 */
function _clearYearFilter() {
  _state.yearFrom = null;
  _state.yearTo   = null;

  if (_dom.vepYearFrom) _dom.vepYearFrom.value = '';
  if (_dom.vepYearTo)   _dom.vepYearTo.value   = '';

  _updateYearChipsUI(null, null);
  if (_dom.vepYearReset) _dom.vepYearReset.hidden = true;

  if (_state.activeFilter === 'year') {
    _state.activeFilter = 'idle';
    _updateStatusBar();
    _clearSearchResults();
    _setSearchState('idle');
  } else {
    _updateStatusBar();
  }
}

/**
 * Muestra el botón de limpiar año.
 */
function _showYearReset() {
  if (_dom.vepYearReset) _dom.vepYearReset.hidden = false;
}

/**
 * Actualiza el estado visual de los chips de año.
 * @param {number|null} from
 * @param {number|null} to
 */
function _updateYearChipsUI(from, to) {
  document.querySelectorAll('.vep-year__chip').forEach(chip => {
    const chipFrom = parseInt(chip.dataset.yfrom, 10);
    const chipTo   = parseInt(chip.dataset.yto,   10);
    const isActive = chipFrom === from && chipTo === to;
    chip.classList.toggle('vep-year__chip--active', isActive);
    chip.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}


// ─────────────────────────────────────────────
// 11. SISTEMA DE TAGS
// ─────────────────────────────────────────────

/**
 * Renderiza los botones de tags predefinidos en el grid.
 * Aplica animación escalonada (stagger) vía CSS custom property.
 */
function _renderTagButtons() {
  const grid = _dom.vepTagsGrid;
  if (!grid) return;

  const fragment = document.createDocumentFragment();

  PREDEFINED_TAGS.forEach((tag, index) => {
    const btn = document.createElement('button');
    btn.className           = 'vep-tag';
    btn.type                = 'button';
    btn.dataset.tagId       = tag.id;
    btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-label', `Filtrar por ${tag.label}`);

    // Stagger delay para la animación de entrada
    btn.style.animationDelay = `${index * 30}ms`;

    // Ícono
    const iconSpan = document.createElement('span');
    iconSpan.className   = 'vep-tag__icon';
    iconSpan.textContent = tag.icon;
    iconSpan.setAttribute('aria-hidden', 'true');

    // Texto
    const labelSpan = document.createElement('span');
    labelSpan.textContent = tag.label;

    // Contador (empieza vacío, se actualiza con _fetchTagCount)
    const countSpan = document.createElement('span');
    countSpan.className      = 'vep-tag__count';
    countSpan.id             = `vep-tag-count-${tag.id}`;
    countSpan.setAttribute('aria-hidden', 'true');
    countSpan.setAttribute('data-loading', 'true');
    countSpan.textContent    = '…';

    btn.appendChild(iconSpan);
    btn.appendChild(labelSpan);
    btn.appendChild(countSpan);

    btn.addEventListener('click', () => _toggleTag(tag.id));

    fragment.appendChild(btn);
  });

  grid.appendChild(fragment);

  // Cargar contadores en segundo plano (no bloquea el render)
  _loadTagCounts();
}

/**
 * Obtiene el count aproximado de VNs para cada tag predefinido.
 * Usa `results: 0, count: true` para minimizar el tamaño de la respuesta.
 * Las peticiones se hacen en paralelo con Promise.allSettled.
 */
async function _loadTagCounts() {
  const promises = PREDEFINED_TAGS.map(async (tag) => {
    const cacheKey = `tagcount:${tag.id}`;
    const cached   = _getCache(cacheKey);

    if (cached !== null) {
      _updateTagCountUI(tag.id, cached);
      return;
    }

    try {
      const raw = await _apiPost('/vn', {
        filters: ['tag', '=', tag.vndbId],
        fields:  'id',
        results: 0,
        count:   true,
      });

      const count = raw.count ?? 0;
      _setCache(cacheKey, count);
      _updateTagCountUI(tag.id, count);
    } catch {
      _updateTagCountUI(tag.id, '?');
    }
  });

  await Promise.allSettled(promises);
}

/**
 * Actualiza el contador visual de un tag.
 * @param {string} tagId
 * @param {number|string} count
 */
function _updateTagCountUI(tagId, count) {
  const el = document.getElementById(`vep-tag-count-${tagId}`);
  if (!el) return;

  const formatted = typeof count === 'number'
    ? (count >= 1000 ? `${Math.floor(count / 1000)}k` : String(count))
    : String(count);

  el.textContent = formatted;
  el.removeAttribute('data-loading');
}

/**
 * Activa o desactiva un tag de la selección.
 * @param {string} tagId
 */
function _toggleTag(tagId) {
  const idx = _state.selectedTags.indexOf(tagId);

  if (idx === -1) {
    _state.selectedTags.push(tagId);
  } else {
    _state.selectedTags.splice(idx, 1);
  }

  _updateTagUI(tagId, idx === -1);

  // Si hay tags seleccionados, activar modo tags
  if (_state.selectedTags.length > 0) {
    _state.activeFilter = 'tags';
    _updateQuickFilterUI(null);
    _showTagsClear();
    _updateTagsCounter();
    _updateStatusBar();
    _executeExploreQuery(1);
  } else {
    // Sin tags: volver a idle
    _state.activeFilter = 'idle';
    _hideTagsClear();
    _clearTagsCounter();
    _updateStatusBar();
    _clearSearchResults();
    _setSearchState('idle');
  }
}

/**
 * Actualiza el estado visual (aria-pressed) de un tag.
 * @param {string} tagId
 * @param {boolean} isActive
 */
function _updateTagUI(tagId, isActive) {
  const btn = _dom.vepTagsGrid?.querySelector(`[data-tag-id="${tagId}"]`);
  if (!btn) return;
  btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
}

/**
 * Deselecciona todos los tags y limpia el estado relacionado.
 */
function _clearAllTags() {
  _state.selectedTags.forEach(id => _updateTagUI(id, false));
  _state.selectedTags = [];
  _hideTagsClear();
  _clearTagsCounter();

  if (_state.activeFilter === 'tags') {
    _state.activeFilter = 'idle';
    _updateStatusBar();
    _clearSearchResults();
    _setSearchState('idle');
  } else {
    _updateStatusBar();
  }
}

/** Muestra el botón de limpiar etiquetas */
function _showTagsClear() {
  if (_dom.vepTagsClear) _dom.vepTagsClear.hidden = false;
}

/** Oculta el botón de limpiar etiquetas */
function _hideTagsClear() {
  if (_dom.vepTagsClear) _dom.vepTagsClear.hidden = true;
}

/**
 * Muestra un contador predictivo de resultados para los tags seleccionados.
 * Hace una petición con count:true y results:0 para ser ligero.
 */
async function _updateTagsCounter() {
  const counter = _dom.vepTagsCounter;
  if (!counter) return;

  if (_state.selectedTags.length === 0) {
    counter.hidden = true;
    return;
  }

  counter.hidden    = false;
  counter.textContent = '⌛ Calculando resultados…';

  const body = _buildFilterBody(_state, 1);
  if (!body) return;

  try {
    const raw   = await _apiPost('/vn', { ...body, results: 0, count: true });
    const count = raw.count ?? 0;
    const logic = _state.tagLogic;

    counter.textContent = `~${count.toLocaleString('es-AR')} VNs encontradas (modo ${logic})`;
  } catch {
    counter.textContent = 'No se pudo calcular el conteo.';
  }
}

/** Oculta y limpia el contador de tags */
function _clearTagsCounter() {
  if (_dom.vepTagsCounter) {
    _dom.vepTagsCounter.hidden      = true;
    _dom.vepTagsCounter.textContent = '';
  }
}


// ─────────────────────────────────────────────
// 12. LÓGICA AND / OR
// ─────────────────────────────────────────────

/**
 * Cambia el modo de combinación de tags (AND ↔ OR).
 * @param {'AND'|'OR'} logic
 */
function _setTagLogic(logic) {
  _state.tagLogic = logic;

  // Actualizar UI de botones
  if (_dom.vepLogicAnd) {
    const isAnd = logic === 'AND';
    _dom.vepLogicAnd.setAttribute('aria-pressed', isAnd  ? 'true' : 'false');
    _dom.vepLogicAnd.classList.toggle('vep-logic__btn--on', isAnd);
    _dom.vepLogicOr.setAttribute('aria-pressed',  !isAnd ? 'true' : 'false');
    _dom.vepLogicOr.classList.toggle('vep-logic__btn--on', !isAnd);
  }

  // Re-ejecutar query si hay tags activos
  if (_state.selectedTags.length > 0) {
    _updateTagsCounter();
    _executeExploreQuery(1);
  }
}


// ─────────────────────────────────────────────
// 13. BARRA DE ESTADO
// ─────────────────────────────────────────────

/**
 * Construye y muestra el texto de estado de los filtros activos.
 */
function _updateStatusBar() {
  const bar  = _dom.vepStatusBar;
  const text = _dom.vepStatusText;
  if (!bar || !text) return;

  const parts = [];

  // Describir el filtro activo
  switch (_state.activeFilter) {
    case 'top':
      parts.push('🏆 Top Rated');
      break;
    case 'popular':
      parts.push('🔥 Populares');
      break;
    case 'recent':
      parts.push('✨ Recientes (2024–2025)');
      break;
    case 'classics':
      parts.push('📜 Clásicos (pre-2010)');
      break;
    case 'year':
      if (_state.yearFrom && _state.yearTo) {
        parts.push(`📅 ${_state.yearFrom} – ${_state.yearTo}`);
      } else if (_state.yearFrom) {
        parts.push(`📅 Desde ${_state.yearFrom}`);
      } else if (_state.yearTo) {
        parts.push(`📅 Hasta ${_state.yearTo}`);
      }
      break;
    case 'tags': {
      const tagLabels = _state.selectedTags
        .map(id => PREDEFINED_TAGS.find(t => t.id === id)?.label ?? id)
        .join(` ${_state.tagLogic} `);
      parts.push(`🏷️ ${tagLabels}`);
      break;
    }
    default:
      break;
  }

  if (parts.length === 0) {
    bar.hidden = true;
    return;
  }

  text.textContent = `Filtrando por: ${parts.join(' · ')}`;
  bar.hidden       = false;
}

/**
 * Limpia TODOS los filtros activos y vuelve al estado inicial.
 */
function _clearAllFilters() {
  _state.activeFilter = 'idle';
  _state.selectedTags = [];
  _state.yearFrom     = null;
  _state.yearTo       = null;

  // Reset UI
  _updateQuickFilterUI(null);
  _updateYearChipsUI(null, null);
  _clearAllTags();
  _clearTagsCounter();

  if (_dom.vepYearFrom)  _dom.vepYearFrom.value  = '';
  if (_dom.vepYearTo)    _dom.vepYearTo.value    = '';
  if (_dom.vepYearReset) _dom.vepYearReset.hidden = true;
  if (_dom.vepStatusBar) _dom.vepStatusBar.hidden  = true;

  _clearSearchResults();
  _setSearchState('idle');
}


// ─────────────────────────────────────────────
// 14. HELPERS DE UI (reutiliza DOM de ui-controller)
// ─────────────────────────────────────────────

/**
 * Limpia el grid de resultados de búsqueda.
 * Compatible con el área existente manejada por ui-controller.
 */
function _clearSearchResults() {
  const grid = _dom.searchResults;
  if (!grid) return;
  while (grid.firstChild) grid.removeChild(grid.firstChild);
  if (_dom.searchPagination) _dom.searchPagination.hidden = true;
}

/**
 * Escribe el estado de la zona de búsqueda existente (#searchState).
 * Delega en RenderEngine igual que ui-controller para consistencia visual.
 *
 * @param {'idle'|'loading'|'empty'|'error'|''} state
 * @param {string} [extra]
 */
function _setSearchState(state, extra = '') {
  const container = _dom.searchState;
  if (!container) return;

  while (container.firstChild) container.removeChild(container.firstChild);

  switch (state) {
    case 'idle': {
      const div = document.createElement('div');
      div.className = 'vh-search-state__idle';
      const p = document.createElement('p');
      p.className   = 'vh-search-state__hint';
      p.textContent = 'Escribe al menos 2 caracteres para buscar';
      div.appendChild(p);
      container.appendChild(div);
      break;
    }
    case 'loading':
      container.appendChild(RenderEngine.createLoadingState());
      break;
    case 'empty':
      container.appendChild(RenderEngine.createEmptySearchState(extra));
      break;
    case 'error':
      container.appendChild(RenderEngine.createErrorState(extra));
      break;
    default:
      break;
  }
}

/**
 * Actualiza los controles de paginación según la página actual.
 * Compatible con el sistema de paginación existente de ui-controller.
 *
 * @param {number} page
 * @param {boolean} hasMore
 */
function _updatePagination(page, hasMore) {
  const pagination = _dom.searchPagination;
  if (!pagination) return;

  pagination.hidden = page <= 1 && !hasMore;

  const prevPage = document.getElementById('prevPage');
  const nextPage = document.getElementById('nextPage');
  const pageInfo = document.getElementById('pageInfo');

  if (prevPage) prevPage.disabled = page <= 1;
  if (nextPage) nextPage.disabled = !hasMore;
  if (pageInfo) pageInfo.textContent = `Página ${page}`;

  // Sobrescribir los handlers de paginación para que usen el módulo explore
  if (prevPage) {
    prevPage.onclick = () => {
      if (_state.activeFilter !== 'idle') {
        const currentPage = _getCurrentPage();
        if (currentPage > 1) _executeExploreQuery(currentPage - 1);
      }
    };
  }
  if (nextPage) {
    nextPage.onclick = () => {
      if (_state.activeFilter !== 'idle') {
        _executeExploreQuery(_getCurrentPage() + 1);
      }
    };
  }
}

/**
 * Extrae la página actual del elemento pageInfo.
 * @returns {number}
 */
function _getCurrentPage() {
  const info = document.getElementById('pageInfo');
  const match = info?.textContent?.match(/\d+/);
  return match ? parseInt(match[0], 10) : 1;
}


// ─────────────────────────────────────────────
// 15. BINDING DE EVENTOS
// ─────────────────────────────────────────────

/**
 * Registra todos los event listeners del módulo.
 * Sigue el principio de delegación de eventos donde es posible.
 */
function _bindEvents() {

  // ── Autocompletado en el input de búsqueda existente ──
  if (_dom.searchInput) {
    _dom.searchInput.addEventListener('input',   _onSearchInputForAutocomplete);

    _dom.searchInput.addEventListener('keydown', (e) => {
      const isOpen = !_dom.vepAutocomplete?.hidden;

      if (e.key === 'ArrowDown' && isOpen) {
        e.preventDefault();
        _navigateAutocomplete('down');
      } else if (e.key === 'ArrowUp' && isOpen) {
        e.preventDefault();
        _navigateAutocomplete('up');
      } else if (e.key === 'Enter' && isOpen && _state.autocompleteIndex >= 0) {
        e.preventDefault();
        _selectSuggestion(_dom.searchInput.value);
      } else if (e.key === 'Escape') {
        _closeAutocomplete();
      }
    });

    // Registrar búsqueda exitosa en el historial
    // Escucha el evento nativo del input para capturar búsquedas normales también
    _dom.searchInput.addEventListener('change', () => {
      const val = _dom.searchInput.value.trim();
      if (val.length >= 2) _addToHistory(val);
    });
  }

  // Cerrar dropdown al hacer clic fuera
  document.addEventListener('click', (e) => {
    if (!_dom.vepAutocomplete?.hidden) {
      const isInsideSearch = _dom.searchInput?.contains(e.target)
        || _dom.vepAutocomplete?.contains(e.target);
      if (!isInsideSearch) _closeAutocomplete();
    }
  });

  // ── Filtros rápidos (delegación en el panel) ──
  document.querySelectorAll('.vep-quick__btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const filter = btn.dataset.filter;
      if (filter) _activateQuickFilter(filter);
    });
  });

  // ── Filtro de año: chips ──
  document.querySelectorAll('.vep-year__chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const from = parseInt(chip.dataset.yfrom, 10);
      const to   = parseInt(chip.dataset.yto,   10);
      if (!isNaN(from) && !isNaN(to)) _applyYearPreset(from, to);
    });
  });

  // ── Filtro de año: rango personalizado ──
  if (_dom.vepYearApply) {
    _dom.vepYearApply.addEventListener('click', _applyCustomYearRange);
  }

  // Enter en los inputs de año
  [_dom.vepYearFrom, _dom.vepYearTo].forEach(input => {
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') _applyCustomYearRange();
      });
    }
  });

  // ── Limpiar año ──
  if (_dom.vepYearReset) {
    _dom.vepYearReset.addEventListener('click', _clearYearFilter);
  }

  // ── Lógica AND/OR ──
  if (_dom.vepLogicAnd) {
    _dom.vepLogicAnd.addEventListener('click', () => _setTagLogic('AND'));
  }
  if (_dom.vepLogicOr) {
    _dom.vepLogicOr.addEventListener('click', () => _setTagLogic('OR'));
  }

  // ── Limpiar etiquetas ──
  if (_dom.vepTagsClear) {
    _dom.vepTagsClear.addEventListener('click', _clearAllTags);
  }

  // ── Limpiar todos los filtros ──
  if (_dom.vepClearAll) {
    _dom.vepClearAll.addEventListener('click', _clearAllFilters);
  }
}


// ─────────────────────────────────────────────
// 16. PUNTO DE ENTRADA
// ─────────────────────────────────────────────

/**
 * Inicializa el módulo de exploración rápida.
 * Llamado al cargar el script desde index.html.
 */
function init() {
  try {
    _cacheDOM();
    _renderTagButtons();
    _bindEvents();
    // Resolver IDs de tags en background (fire-and-forget, no bloquea el arranque)
    _resolveTagIds().catch(err => console.warn('[Explore] _resolveTagIds falló:', err));
    console.info('[ExploreController] Módulo de exploración inicializado ✓');
  } catch (err) {
    console.error('[ExploreController] Error al inicializar:', err);
  }
}

// Auto-inicializar cuando el DOM esté listo
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}


// ─────────────────────────────────────────────
// EXPORTACIÓN (para pruebas unitarias o integración futura)
// ─────────────────────────────────────────────
export {
  init,
  _clearAllFilters as clearAllFilters,
};