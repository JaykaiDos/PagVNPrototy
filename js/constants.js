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
// ─────────────────────────────────────────────

/** @type {string} Clave raíz de la biblioteca personal en localStorage */
const STORAGE_KEY_LIBRARY = 'vnh_library';

/** @type {string} Preferencia de tema (light | dark) */
const STORAGE_KEY_THEME = 'vnh_theme';


// ─────────────────────────────────────────────
// 2. ESTADOS DE NOVELA
// ─────────────────────────────────────────────

/**
 * @readonly
 * @enum {string}
 */
const VN_STATUS = Object.freeze({
  PENDING:   'pending',
  PLAYING:   'playing',
  FINISHED:  'finished',
  DROPPED:   'dropped',
});

/**
 * Metadatos de UI para cada estado.
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
//
// REGLA INVARIANTE:
//  Los pesos de las categorías BASE (aquellas sin bonus:true)
//  DEBEN sumar exactamente 100. Si no suman 100, el motor de
//  scoring produce resultados proporcionales incorrectos.
//
//  La suma se verifica automáticamente en tiempo de módulo
//  (ver aserción _assertWeightIntegrity más abajo).
//  Si la suma es incorrecta, la app lanza un error inmediatamente
//  al arrancar — nunca llega a producción silenciosa.
// ─────────────────────────────────────────────

/**
 * @typedef {Object} ScoreCategory
 * @property {string}  key       - Identificador interno
 * @property {string}  label     - Nombre visible al usuario
 * @property {number}  weight    - Peso porcentual (0-100)
 * @property {boolean} [bonus]   - Si true, es bonificación (no forma parte de la base)
 * @property {boolean} [optional]- Si true, el campo puede omitirse (ej: contenido adulto)
 */

/** @type {ScoreCategory[]} */
const SCORE_CATEGORIES = Object.freeze([
  { key: 'story',         label: 'Historia / Guion',           weight: 30              },
  { key: 'characters',    label: 'Personajes',                 weight: 15              },
  { key: 'art',           label: 'Diseño (Personajes/Fondos)', weight: 6               },
  { key: 'cg',            label: 'Animaciones / CG',           weight: 10              },
  { key: 'adult',         label: 'Escenas H',                  weight: 15, optional: true },
  { key: 'audio',         label: 'Música, Voces y Sonidos',    weight: 10              },
  { key: 'ux',            label: 'Interfaz / UX',              weight: 4               },
  { key: 'replayability', label: 'Rejugabilidad / Extra',      weight: 10              },
  { key: 'extra',         label: 'Puntos Extra (impacto)',      weight: 15, bonus: true },
  //
  // ── Si modificás estos pesos, la suma de los no-bonus DEBE ser 100. ──
  // La aserción _assertWeightIntegrity() lo verificará al cargar la app.
  //
  // Suma actual (sin bonus):
  //   story(30) + characters(15) + art(6) + cg(10) + adult(15)
  //   + audio(10) + ux(4) + replayability(10) = 100 ✓
]);

/**
 * Suma de pesos base (sin bonificación).
 * Debe ser exactamente 100. La aserción debajo lo garantiza.
 * @type {number}
 */
const SCORE_BASE_WEIGHT_TOTAL = SCORE_CATEGORIES
  .filter(c => !c.bonus)
  .reduce((sum, c) => sum + c.weight, 0);


// ─────────────────────────────────────────────
// CORRECCIÓN BUG-08 — Aserción de integridad de pesos
//
// DISEÑO:
//  Esta función se ejecuta UNA SOLA VEZ al cargar el módulo.
//  No tiene impacto en rendimiento en producción.
//
//  Por qué lanzar un Error y no solo console.warn:
//  - Un warn puede ignorarse. Un Error detiene la app inmediatamente.
//  - En GitHub Pages (producción estática) no hay logs de servidor.
//    El único momento seguro para detectar esto es al arrancar.
//  - El mensaje incluye el valor incorrecto para acelerar el debug.
//
//  Cuándo se activa:
//  - Durante desarrollo al modificar pesos sin recalcular la suma.
//  - En QA si se copia un constants.js con pesos mal editados.
//  - NUNCA en producción si los pesos son correctos (función no-op).
// ─────────────────────────────────────────────

/**
 * Verifica que los pesos base de SCORE_CATEGORIES sumen exactamente 100.
 * Lanza un Error descriptivo si la suma es incorrecta.
 *
 * @throws {Error} Si SCORE_BASE_WEIGHT_TOTAL !== 100.
 */
function _assertWeightIntegrity() {
  if (SCORE_BASE_WEIGHT_TOTAL === 100) return; // caso feliz — no-op

  // Construir detalle de cada categoría para facilitar el debug
  const detail = SCORE_CATEGORIES
    .filter(c => !c.bonus)
    .map(c => `  ${c.key}: ${c.weight}`)
    .join('\n');

  throw new Error(
    `[constants.js] Los pesos base de SCORE_CATEGORIES deben sumar 100.\n` +
    `Suma actual: ${SCORE_BASE_WEIGHT_TOTAL}\n` +
    `Desglose:\n${detail}\n` +
    `Ajustá los pesos para que la suma sea exactamente 100.`
  );
}

// Ejecutar la aserción en tiempo de módulo
_assertWeightIntegrity();


// ─────────────────────────────────────────────
// 4. CONFIGURACIÓN DE LA API DE VNDB
// ─────────────────────────────────────────────

/**
 * Endpoint de la API VNDB (HTTPS query API v2).
 * @see https://api.vndb.org/kana
 */
const VNDB_API_BASE = 'https://api.vndb.org/kana';

/**
 * Campos solicitados al endpoint /vn de VNDB.
 * Limitamos al mínimo necesario para reducir el tamaño de respuesta.
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
 * Número máximo de resultados por página.
 * VNDB permite un máximo de 100 por petición.
 * @type {number}
 */
const VNDB_PAGE_SIZE = 24;

/**
 * Tiempo máximo de espera (ms) para peticiones a VNDB.
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
// EXPORTACIÓN
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