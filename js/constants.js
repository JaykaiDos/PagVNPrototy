/**
 * @file constants.js
 * @description Constantes globales e inmutables del proyecto VN-Hub.
 *              Centraliza todos los valores "mágicos" para facilitar
 *              mantenimiento y evitar duplicación (principio DRY).
 *
 * NOTA: Este archivo NO tiene dependencias. Debe ser cargado primero.
 */

'use strict';

// ─────────────────────────────────────────────
// 1. CLAVES DE ALMACENAMIENTO LOCAL
//    Prefijo "vnh_" para evitar colisiones con
//    otros proyectos en el mismo dominio.
// ─────────────────────────────────────────────

/** @type {string} Clave raíz de la biblioteca personal en localStorage */
const STORAGE_KEY_LIBRARY = 'vnh_library';

/** @type {string} Preferencia de tema (light | dark) */
const STORAGE_KEY_THEME = 'vnh_theme';


// ─────────────────────────────────────────────
// 2. ESTADOS DE NOVELA
//    Enumeración de los cuatro estados válidos.
//    Cada valor es la clave canónica usada en
//    localStorage y en la lógica de negocio.
// ─────────────────────────────────────────────

/**
 * @readonly
 * @enum {string}
 */
const VN_STATUS = Object.freeze({
  PENDING:   'pending',    // 📌 Pendiente  — backlog
  PLAYING:   'playing',    // 🎮 Jugando    — activa + bitácora
  FINISHED:  'finished',   // 🏆 Finalizado — review completa
  DROPPED:   'dropped',    // ❌ Abandonada — comentario breve
});

/**
 * Metadatos de UI para cada estado.
 * Mapea el valor canónico a su etiqueta, icono y clase CSS.
 *
 * @type {Record<string, {label: string, icon: string, cssClass: string}>}
 */
const VN_STATUS_META = Object.freeze({
  [VN_STATUS.PENDING]:  { label: 'Pendiente',  icon: '📌', cssClass: 'pending'  },
  [VN_STATUS.PLAYING]:  { label: 'Jugando',    icon: '🎮', cssClass: 'playing'  },
  [VN_STATUS.FINISHED]: { label: 'Finalizado', icon: '🏆', cssClass: 'finished' },
  [VN_STATUS.DROPPED]:  { label: 'Abandonada', icon: '❌', cssClass: 'dropped'  },
});


// ─────────────────────────────────────────────
// 3. SISTEMA DE PESOS (Scoring Engine)
//    Los pesos deben sumar 100 (excluyendo
//    "extra" que es una bonificación opcional).
//    Fuente: Mapa Maestro v1.
// ─────────────────────────────────────────────

/**
 * @typedef {Object} ScoreCategory
 * @property {string} key        - Identificador interno
 * @property {string} label      - Nombre visible al usuario
 * @property {number} weight     - Peso porcentual (0-100)
 * @property {boolean} [bonus]   - Si true, es bonificación (no forma parte de la base)
 * @property {boolean} [optional]- Si true, el campo puede omitirse (ej: contenido adulto)
 */

/** @type {ScoreCategory[]} */
const SCORE_CATEGORIES = Object.freeze([
  { key: 'story',        label: 'Historia / Guion',          weight: 30  },
  { key: 'characters',   label: 'Personajes',                weight: 15  },
  { key: 'art',          label: 'Diseño (Personajes/Fondos)',  weight: 6   },
  { key: 'cg',           label: 'Animaciones / CG',          weight: 10  },
  { key: 'adult',        label: 'Escenas H',                 weight: 15, optional: true },
  { key: 'audio',        label: 'Música, Voces y Sonidos',   weight: 10  },
  { key: 'ux',           label: 'Interfaz / UX',             weight: 4   },
  { key: 'replayability',label: 'Rejugabilidad / Extra',     weight: 10  },
  { key: 'extra',        label: 'Puntos Extra (impacto)',    weight: 15, bonus: true },
]);

/**
 * Peso base total (sin bonificación).
 * Útil para validar que los pesos base sumen exactamente 100.
 * @type {number}
 */
const SCORE_BASE_WEIGHT_TOTAL = SCORE_CATEGORIES
  .filter(c => !c.bonus)
  .reduce((sum, c) => sum + c.weight, 0); // Debe ser 100


// ─────────────────────────────────────────────
// 4. CONFIGURACIÓN DE LA API DE VNDB
// ─────────────────────────────────────────────

/**
 * Endpoint de la API VNDB (WebSocket JSON-API v2).
 * VNDB no expone REST directamente; se usa el endpoint
 * de la HTTPS query API disponible públicamente.
 *
 * @see https://api.vndb.org/kana
 */
const VNDB_API_BASE = 'https://api.vndb.org/kana';

/**
 * Campos solicitados al endpoint /vn de VNDB.
 * Limitamos los campos al mínimo necesario para reducir
 * el tamaño de la respuesta (rendimiento en GitHub Pages).
 *
 * @type {string[]}
 */
const VNDB_VN_FIELDS = Object.freeze([
  'id',
  'title',
  'titles.title',
  'titles.lang',
  'description',
  'image.url',
  'image.sexual',
  'released',
  'rating',
  'votecount',
  'length_minutes',
  'tags.name',
  'tags.rating',
  'developers.name',
]);
const VNDB_VN_FIELDS_STR = VNDB_VN_FIELDS.join(', ');

/**
 * Número máximo de resultados por página en la búsqueda.
 * VNDB permite un máximo de 100 por petición.
 * @type {number}
 */
const VNDB_PAGE_SIZE = 24;

/**
 * Tiempo máximo de espera (ms) para peticiones a VNDB
 * antes de abortar y mostrar error al usuario.
 * @type {number}
 */
const VNDB_REQUEST_TIMEOUT_MS = 10_000;


// ─────────────────────────────────────────────
// 5. CONFIGURACIÓN DE INTERFAZ
// ─────────────────────────────────────────────

/** @type {'light' | 'dark'} Tema por defecto */
const DEFAULT_THEME = 'light';

/**
 * Tiempo en ms que un toast de notificación permanece visible.
 * @type {number}
 */
const TOAST_DURATION_MS = 3_500;


// ─────────────────────────────────────────────
// EXPORTACIÓN (ES Modules para uso modular)
// ─────────────────────────────────────────────
export {
  // Storage
  STORAGE_KEY_LIBRARY,
  STORAGE_KEY_THEME,

  // Estado de novelas
  VN_STATUS,
  VN_STATUS_META,

  // Scoring
  SCORE_CATEGORIES,
  SCORE_BASE_WEIGHT_TOTAL,

  // VNDB API
  VNDB_API_BASE,
  VNDB_VN_FIELDS,
  VNDB_VN_FIELDS_STR,
  VNDB_PAGE_SIZE,
  VNDB_REQUEST_TIMEOUT_MS,

  // UI
  DEFAULT_THEME,
  TOAST_DURATION_MS,
};
