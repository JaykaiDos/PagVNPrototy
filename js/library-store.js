/**
 * @file library-store.js
 * @description Gestión de estado de la biblioteca personal del usuario.
 *              Persiste en localStorage. Actúa como el Modelo (M) del patrón MVC.
 *
 * DISEÑO:
 *  - Toda escritura/lectura de localStorage pasa por este módulo (encapsulamiento).
 *  - Patrón Observer liviano para desacoplar el store de la UI.
 *  - Valida integridad del dato antes de persistir (evita corrupción silenciosa).
 *  - Campo "version" en cada entrada para soporte de migración de schema.
 *  - Funciones de lógica de negocio separadas del almacenamiento (SRP).
 *
 * SCHEMA DE LibraryEntry (v1):
 * {
 *   vnId:      string,         // ID de VNDB ("v17")
 *   status:    VN_STATUS,      // Estado actual de la VN
 *   addedAt:   string,         // ISO 8601 — cuándo se agregó
 *   updatedAt: string,         // ISO 8601 — última modificación
 *   log:       string,         // Bitácora de progreso (solo PLAYING)
 *   comment:   string,         // Comentario de abandono (solo DROPPED)
 *   score:     ScoreData|null, // Puntuación calculada (solo FINISHED)
 *   favRoute:  string,         // Ruta favorita (solo FINISHED)
 *   review:    string,         // Reseña libre (solo FINISHED)
 *   isSpoiler: boolean,        // Si la reseña contiene spoilers
 *   version:   number,         // Schema version (migración futura)
 * }
 *
 * INTEGRACIÓN CSS:
 *  Los objetos LibraryEntry tienen un campo "status" que mapea directamente
 *  a las clases CSS definidas en VN_STATUS_META:
 *    pending  → .status-pending  (color azul/celeste en light, dorado en dark)
 *    playing  → .status-playing  (color verde/rosa en light, rojo en dark)
 *    finished → .status-finished (color dorado en ambos modos)
 *    dropped  → .status-dropped  (color gris en ambos modos)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TESTS DE CONSOLA — Copiar y ejecutar en DevTools del navegador:
 *
 * // ── SETUP (ejecutar una vez) ──────────────────────────────────────────
 * import { init, addVn, updateStatus, updateLog, updateComment,
 *          updateReview, removeVn, getEntry, getEntriesByStatus,
 *          getRankedFinished, getStats, subscribe } from './library-store.js';
 * import { VN_STATUS } from './constants.js';
 * init(); // ¡Siempre primero!
 *
 * // 1. Agregar VNs con distintos estados
 * addVn('v17',   VN_STATUS.PENDING);   // Clannad → Pendiente
 * addVn('v4',    VN_STATUS.PLAYING);   // Kanon → Jugando
 * addVn('v11',   VN_STATUS.FINISHED);  // Little Busters → Finalizado
 * addVn('v2002', VN_STATUS.DROPPED);   // ... → Abandonada
 * console.log('Stats:', getStats());
 * // Esperado: { total: 4, byStatus: { pending:1, playing:1, finished:1, dropped:1 } }
 *
 * // 2. Actualizar estado
 * updateStatus('v17', VN_STATUS.PLAYING);
 * console.log(getEntry('v17').status); // 'playing'
 *
 * // 3. Bitácora (solo PLAYING)
 * updateLog('v4', 'Completé la ruta de Ayu. ¡El final me emocionó!');
 * console.log(getEntry('v4').log);
 *
 * // 4. Comentario (solo DROPPED)
 * updateComment('v2002', 'El ritmo era muy lento, lo retomo más adelante.');
 * console.log(getEntry('v2002').comment);
 *
 * // 5. Reseña completa (solo FINISHED)
 * import { calculateScore } from './score-engine.js';
 * const scoreData = calculateScore({
 *   story: 9, characters: 8, art: 7, cg: 8,
 *   adult: 7, audio: 9, ux: 7, replayability: 8,
 *   extra: 5, hasAdultContent: true
 * });
 * updateReview('v11', scoreData, { favRoute: 'Rin', review: 'Obra maestra.', isSpoiler: false });
 * console.log(getEntry('v11').score.finalScore); // ~8.xx
 *
 * // 6. Filtrar por estado
 * console.log('Jugando:', getEntriesByStatus(VN_STATUS.PLAYING).length); // 2
 *
 * // 7. Ranking de finalizadas
 * console.table(getRankedFinished().map(e => ({ id: e.vnId, score: e.score?.finalScore })));
 *
 * // 8. Observer
 * const unsub = subscribe((event, payload) => console.log('EVENTO:', event, payload?.vnId));
 * addVn('v40', VN_STATUS.PENDING); // Dispara: EVENTO: add v40
 * unsub(); // Desuscribirse
 *
 * // 9. Eliminar
 * removeVn('v40');
 * console.log(getEntry('v40')); // null
 *
 * // 10. Persistencia (verificar tras recargar)
 * console.log(localStorage.getItem('vnh_library')); // JSON con tus VNs
 * ─────────────────────────────────────────────────────────────────────────
 */

'use strict';

import { STORAGE_KEY_LIBRARY, VN_STATUS } from './constants.js';
import { nowIso, isNonEmptyString }        from './utils.js';


// ─────────────────────────────────────────────
// 1. VERSIÓN DEL SCHEMA
//    Incrementar cuando cambie la estructura
//    de LibraryEntry para activar migración.
// ─────────────────────────────────────────────
const SCHEMA_VERSION = 1;


// ─────────────────────────────────────────────
// 2. ESTADO INTERNO DEL MÓDULO
//    _library es el "store" en memoria.
//    Se inicializa desde localStorage al llamar init().
// ─────────────────────────────────────────────

/** @type {Map<string, LibraryEntry>} Clave: vnId */
let _library     = new Map();

/** @type {boolean} Previene uso accidental antes de init() */
let _initialized = false;

/** @type {Set<Function>} Suscriptores del patrón Observer */
const _listeners  = new Set();

function clearAll() {
  _library = new Map();
  _saveToStorage();
  _notify('update', null);
}

// ─────────────────────────────────────────────
// 3. PERSISTENCIA (localStorage)
//    Toda interacción con localStorage pasa
//    por estas dos funciones. Nunca acceder
//    a localStorage directamente desde el resto.
// ─────────────────────────────────────────────

/**
 * Lee y deserializa la biblioteca desde localStorage.
 * Maneja JSON malformado de forma silenciosa (no rompe la app).
 * Filtra entradas inválidas y migra el schema automáticamente.
 *
 * @returns {Map<string, LibraryEntry>} Biblioteca deserializada.
 */
function _loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_LIBRARY);
    if (!raw) return new Map();

    const parsed = JSON.parse(raw);

    // Validación de formato: debe ser un array (así se serializa el Map)
    if (!Array.isArray(parsed)) {
      console.warn('[LibraryStore] Formato inesperado en localStorage. Reiniciando.');
      return new Map();
    }

    return new Map(
      parsed
        .filter(_isValidEntry)
        .map(entry => [entry.vnId, _migrateEntry(entry)])
    );
  } catch (error) {
    console.error('[LibraryStore] Error al cargar desde localStorage:', error);
    return new Map();
  }
}

/**
 * Serializa y guarda la biblioteca en localStorage.
 * Convierte el Map a Array para compatibilidad con JSON.stringify.
 * Maneja QuotaExceededError (almacenamiento lleno) de forma explícita.
 */
function _saveToStorage() {
  try {
    const serialized = JSON.stringify([..._library.values()]);
    localStorage.setItem(STORAGE_KEY_LIBRARY, serialized);
  } catch (error) {
    if (error.name === 'QuotaExceededError') {
      console.error('[LibraryStore] localStorage lleno. No se pudo guardar la biblioteca.');
      _notify('error', 'El almacenamiento local está lleno. Elimina entradas para continuar.');
    } else {
      console.error('[LibraryStore] Error inesperado al guardar:', error);
    }
  }
}


// ─────────────────────────────────────────────
// 4. VALIDACIÓN Y MIGRACIÓN DE SCHEMA
//    Protege contra datos corruptos y facilita
//    actualizaciones futuras sin pérdida de datos.
// ─────────────────────────────────────────────

/**
 * Valida que un objeto tenga los campos mínimos de una LibraryEntry válida.
 * Filtra datos corruptos, de otros proyectos o de schemas muy antiguos.
 *
 * @param {unknown} entry - Objeto a validar.
 * @returns {boolean}     - true si es una entrada válida.
 */
function _isValidEntry(entry) {
  return (
    entry !== null                                    &&
    typeof entry === 'object'                          &&
    isNonEmptyString(entry.vnId)                       &&
    /^v\d+$/.test(entry.vnId)                          &&  // Formato ID válido
    Object.values(VN_STATUS).includes(entry.status)       // Estado conocido
  );
}

/**
 * Migra una entrada de schema antiguo al schema actual.
 * Añade campos faltantes con valores por defecto seguros.
 * No elimina campos extra (compatibilidad hacia adelante).
 *
 * @param {object} entry - Entrada posiblemente desactualizada.
 * @returns {LibraryEntry} Entrada con schema completo y actualizado.
 */
function _migrateEntry(entry) {
  const base = _createDefaultEntry(entry.vnId, entry.status);

  // Los datos existentes tienen precedencia sobre los defaults
  return {
    ...base,
    ...entry,
    version: SCHEMA_VERSION, // Siempre actualizamos al schema actual
  };
}

/**
 * Crea una LibraryEntry con todos los campos en sus valores por defecto.
 * Es la "plantilla" canónica del schema actual.
 *
 * @param {string}    vnId   - ID de VNDB.
 * @param {VN_STATUS} status - Estado inicial.
 * @returns {LibraryEntry}
 */
function _createDefaultEntry(vnId, status) {
  const now = nowIso();
  return {
    vnId,
    status,
    addedAt:   now,
    updatedAt: now,
    log:       '',    // Bitácora de progreso (habilitada en PLAYING)
    comment:   '',    // Comentario de abandono (habilitado en DROPPED)
    score:     null,  // ScoreData del motor de cálculo (solo en FINISHED)
    favRoute:  '',    // Ruta favorita (solo en FINISHED)
    review:    '',    // Reseña libre (solo en FINISHED)
    isSpoiler: false, // Indica si la reseña contiene spoilers
    version:   SCHEMA_VERSION,
  };
}


// ─────────────────────────────────────────────
// 5. PATRÓN OBSERVER
//    Desacopla el store de los componentes UI.
//    La UI se suscribe y reacciona a eventos,
//    sin que el store conozca a la UI.
// ─────────────────────────────────────────────

/**
 * @typedef {'add'|'update'|'remove'|'error'} StoreEvent
 */

/**
 * Notifica a todos los suscriptores activos sobre un cambio en el store.
 * Los errores en listeners se capturan para no romper el flujo principal.
 *
 * @param {StoreEvent} event   - Tipo de evento.
 * @param {*}          payload - Datos contextuales (LibraryEntry, vnId, mensaje...).
 */
function _notify(event, payload) {
  _listeners.forEach(listener => {
    try {
      listener(event, payload);
    } catch (err) {
      // Un listener roto no debe silenciar los demás
      console.error('[LibraryStore] Error en listener del Observer:', err);
    }
  });
}

/**
 * Suscribe una función a todos los cambios del store.
 * Devuelve una función de desuscripción (cleanup pattern, evita memory leaks).
 *
 * @param {function(StoreEvent, *): void} listener - Callback a invocar.
 * @returns {function(): void} Llama a esta función para cancelar la suscripción.
 *
 * @example
 *   const unsub = subscribe((event, payload) => {
 *     if (event === 'add')    renderNewCard(payload);
 *     if (event === 'update') refreshCard(payload.vnId);
 *     if (event === 'remove') removeCard(payload);
 *     if (event === 'error')  showToast(payload, 'error');
 *   });
 *   // En cleanup del componente:
 *   unsub();
 */
function subscribe(listener) {
  if (typeof listener !== 'function') {
    throw new TypeError('[LibraryStore] subscribe() requiere una función como argumento.');
  }
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}


// ─────────────────────────────────────────────
// 6. INICIALIZACIÓN
// ─────────────────────────────────────────────

/**
 * Inicializa el store cargando datos desde localStorage.
 * DEBE llamarse UNA VEZ antes de cualquier otra operación.
 * Es idempotente: llamadas posteriores son seguras (no re-inicializa).
 *
 * @example
 *   // En el punto de entrada de la app:
 *   import * as store from './library-store.js';
 *   store.init();
 */
function init() {
  if (_initialized) return;
  _library     = _loadFromStorage();
  _initialized = true;
  console.info(`[LibraryStore] Inicializado con ${_library.size} entradas.`);
}


// ─────────────────────────────────────────────
// 7. OPERACIONES DE ESCRITURA (CRUD)
// ─────────────────────────────────────────────

/**
 * Agrega una nueva VN a la biblioteca con el estado especificado.
 * Si la VN ya existe, actualiza solo el estado (sin duplicar).
 *
 * @param {string}    vnId   - ID de VNDB (ej: "v17").
 * @param {VN_STATUS} status - Estado inicial (usar VN_STATUS enum).
 * @returns {LibraryEntry} La entrada creada o la actualizada.
 * @throws {TypeError} Si vnId o status tienen formato inválido.
 */
function addVn(vnId, status) {
  _assertInitialized();
  _validateVnId(vnId);
  _validateStatus(status);

  // Idempotencia: si ya existe, actualizamos el estado en lugar de duplicar
  if (_library.has(vnId)) {
    return updateStatus(vnId, status);
  }

  const entry = _createDefaultEntry(vnId, status);
  _library.set(vnId, entry);
  _saveToStorage();
  _notify('add', entry);

  return entry;
}

/**
 * Actualiza el estado de una VN existente.
 *
 * REGLAS DE TRANSICIÓN:
 *  → PLAYING:  habilita el campo `log` (bitácora de progreso).
 *  → FINISHED: habilita `score`, `favRoute`, `review`, `isSpoiler`.
 *              Debe completarse con updateReview() para el score final.
 *  → DROPPED:  habilita el campo `comment` (razón de abandono).
 *  → PENDING:  limpia campos de estados activos (log se conserva como historial).
 *
 * Al salir de FINISHED: se limpian score, favRoute, review e isSpoiler.
 * El log (bitácora) NUNCA se borra al cambiar de estado (valor histórico).
 *
 * @param {string}    vnId      - ID de VNDB.
 * @param {VN_STATUS} newStatus - Nuevo estado destino.
 * @returns {LibraryEntry}      - Entrada con el estado actualizado.
 * @throws {Error} Si la VN no existe en la biblioteca.
 *
 * @example
 *   updateStatus('v17', VN_STATUS.PLAYING);
 *   // → entry.status = 'playing', log habilitada para updateLog()
 */
function updateStatus(vnId, newStatus) {
  _assertInitialized();
  _validateVnId(vnId);
  _validateStatus(newStatus);

  const existing  = _getOrThrow(vnId);
  const oldStatus = existing.status;

  // Optimización: si el estado no cambia, no persistimos ni notificamos
  if (oldStatus === newStatus) return existing;

  const updated = {
    ...existing,
    status:    newStatus,
    updatedAt: nowIso(),
    // Limpieza selectiva de campos según la transición de estado
    ..._getFieldResetForStatusChange(oldStatus, newStatus),
  };

  _library.set(vnId, updated);
  _saveToStorage();
  _notify('update', updated);

  return updated;
}

/**
 * Actualiza la bitácora de progreso de una VN.
 * SOLO disponible cuando la VN está en estado PLAYING.
 * Limite de 2000 caracteres para proteger el localStorage.
 *
 * @param {string} vnId - ID de VNDB.
 * @param {string} log  - Texto de la bitácora (se trunca a 2000 chars).
 * @returns {LibraryEntry}
 * @throws {Error} Si la VN no está en estado PLAYING.
 *
 * @example
 *   updateLog('v4', 'Terminé la ruta de Ayu ⭐. Ruta Makoto pendiente.');
 *   // → entry.log actualizado y persistido en localStorage
 */
function updateLog(vnId, log) {
  _assertInitialized();
  const entry = _getOrThrow(vnId);

  if (entry.status !== VN_STATUS.PLAYING) {
    throw new Error(
      `[LibraryStore] La bitácora solo está disponible en estado "Jugando". ` +
      `Estado actual de "${vnId}": "${entry.status}".`,
    );
  }

  const updated = {
    ...entry,
    log:       String(log ?? '').slice(0, 2_000), // Límite de seguridad
    updatedAt: nowIso(),
  };

  _library.set(vnId, updated);
  _saveToStorage();
  _notify('update', updated);

  return updated;
}

/**
 * Actualiza el comentario de abandono de una VN.
 * SOLO disponible cuando la VN está en estado DROPPED.
 * Limite de 1000 caracteres.
 *
 * @param {string} vnId    - ID de VNDB.
 * @param {string} comment - Comentario breve (se trunca a 1000 chars).
 * @returns {LibraryEntry}
 * @throws {Error} Si la VN no está en estado DROPPED.
 *
 * @example
 *   updateComment('v2002', 'El ritmo era muy lento. Retomo en otro momento.');
 */
function updateComment(vnId, comment) {
  _assertInitialized();
  const entry = _getOrThrow(vnId);

  if (entry.status !== VN_STATUS.DROPPED) {
    throw new Error(
      `[LibraryStore] El comentario de abandono solo está disponible en estado "Abandonada". ` +
      `Estado actual de "${vnId}": "${entry.status}".`,
    );
  }

  const updated = {
    ...entry,
    comment:   String(comment ?? '').slice(0, 1_000),
    updatedAt: nowIso(),
  };

  _library.set(vnId, updated);
  _saveToStorage();
  _notify('update', updated);

  return updated;
}

/**
 * Guarda la puntuación y reseña completa de una VN finalizada.
 * SOLO disponible cuando la VN está en estado FINISHED.
 *
 * El objeto `score` debe provenir de calculateScore() en score-engine.js.
 * Esto garantiza que la lógica de cálculo y la persistencia estén separadas (SRP).
 *
 * @param {string}    vnId          - ID de VNDB.
 * @param {ScoreData} score         - Resultado de calculateScore() del score-engine.
 * @param {object}    [meta]        - Metadata adicional de la reseña.
 * @param {string}    [meta.favRoute='']     - Nombre de la ruta favorita (máx. 200 chars).
 * @param {string}    [meta.review='']       - Reseña libre (máx. 5000 chars).
 * @param {boolean}   [meta.isSpoiler=false] - true si la reseña contiene spoilers.
 * @returns {LibraryEntry}
 * @throws {Error} Si la VN no está en estado FINISHED.
 *
 * @example
 *   import { calculateScore } from './score-engine.js';
 *   const scoreData = calculateScore({
 *     story: 9, characters: 8, art: 7, cg: 8,
 *     adult: 7, audio: 9, ux: 7, replayability: 8,
 *     extra: 5, hasAdultContent: true
 *   });
 *   updateReview('v11', scoreData, {
 *     favRoute: 'Rin',
 *     review: 'El final me rompió el corazón. Obra maestra.',
 *     isSpoiler: true,
 *   });
 */
function updateReview(vnId, score, { favRoute = '', review = '', isSpoiler = false } = {}) {
  _assertInitialized();
  const entry = _getOrThrow(vnId);

  if (entry.status !== VN_STATUS.FINISHED) {
    throw new Error(
      `[LibraryStore] La reseña completa solo está disponible en estado "Finalizado". ` +
      `Estado actual de "${vnId}": "${entry.status}".`,
    );
  }

  const updated = {
    ...entry,
    score,
    favRoute:  String(favRoute  ?? '').slice(0, 200),
    review:    String(review    ?? '').slice(0, 5_000),
    isSpoiler: Boolean(isSpoiler),
    updatedAt: nowIso(),
  };

  _library.set(vnId, updated);
  _saveToStorage();
  _notify('update', updated);

  return updated;
}

/**
 * Elimina una VN de la biblioteca permanentemente.
 * Esta operación NO se puede deshacer.
 *
 * @param {string} vnId - ID de VNDB.
 * @returns {boolean} true si se eliminó, false si no existía.
 *
 * @example
 *   const deleted = removeVn('v17');
 *   console.log(deleted ? 'Eliminada ✓' : 'No existía'); // Eliminada ✓
 *   console.log(getEntry('v17')); // null
 *
 * NOTA DE DISEÑO:
 *   El payload del evento 'remove' es { vnId } (objeto), NO el string
 *   directamente. Esto mantiene consistencia con los eventos 'add' y
 *   'update', y permite que FirebaseSync acceda a payload?.vnId
 *   de forma uniforme en todos los casos.
 */
function removeVn(vnId) {
  _assertInitialized();
  _validateVnId(vnId);

  if (!_library.has(vnId)) return false;

  _library.delete(vnId);
  _saveToStorage();

  // Payload como objeto { vnId } para consistencia con 'add'/'update'.
  // FirebaseSync (app-init.js) consume payload.vnId en todos los eventos.
  _notify('remove', { vnId });

  return true;
}


// ─────────────────────────────────────────────
// 8. CONSULTAS (READ)
// ─────────────────────────────────────────────

/**
 * Obtiene la entrada de una VN por su ID.
 *
 * @param {string} vnId - ID de VNDB.
 * @returns {LibraryEntry|null} La entrada o null si no existe.
 */
function getEntry(vnId) {
  _assertInitialized();
  return _library.get(vnId) ?? null;
}

/**
 * Verifica si una VN está en la biblioteca (cualquier estado).
 *
 * @param {string} vnId - ID de VNDB.
 * @returns {boolean}
 */
function hasVn(vnId) {
  _assertInitialized();
  return _library.has(vnId);
}

/**
 * Devuelve todas las entradas filtradas por estado, ordenadas por última
 * modificación (más reciente primero).
 *
 * @param {VN_STATUS|null} [status=null] - Estado a filtrar. null = todas las entradas.
 * @returns {LibraryEntry[]} Array ordenado por updatedAt descendente.
 *
 * @example
 *   const jugando = getEntriesByStatus(VN_STATUS.PLAYING);
 *   console.log(`${jugando.length} VNs en progreso`);
 */
function getEntriesByStatus(status = null) {
  _assertInitialized();

  let entries = [..._library.values()];

  if (status !== null) {
    _validateStatus(status);
    entries = entries.filter(e => e.status === status);
  }

  return entries.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

/**
 * Devuelve todas las VNs finalizadas ordenadas por puntaje final (ranking).
 * Solo incluye entradas con score calculado (no las sin puntaje aún).
 *
 * @returns {LibraryEntry[]} Array ordenado de mayor a menor finalScore.
 *
 * @example
 *   const ranking = getRankedFinished();
 *   ranking.forEach((e, i) => console.log(`#${i+1} ${e.vnId} — ${e.score.finalScore}`));
 */
function getRankedFinished() {
  _assertInitialized();

  return [..._library.values()]
    .filter(e => e.status === VN_STATUS.FINISHED && e.score !== null)
    .sort((a, b) => (b.score?.finalScore ?? 0) - (a.score?.finalScore ?? 0));
}

/**
 * Devuelve estadísticas de la biblioteca.
 * Útil para renderizar el dashboard/resumen del usuario.
 *
 * @returns {{ total: number, byStatus: Record<VN_STATUS, number> }}
 *
 * @example
 *   const stats = getStats();
 *   console.log(`Total: ${stats.total}`);
 *   console.log(`Jugando: ${stats.byStatus.playing}`);
 */
function getStats() {
  _assertInitialized();

  // Inicializa todos los estados en 0
  const byStatus = Object.values(VN_STATUS).reduce((acc, s) => {
    acc[s] = 0;
    return acc;
  }, {});

  _library.forEach(entry => {
    byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;
  });

  return {
    total: _library.size,
    byStatus,
  };
}

/**
 * Exporta toda la biblioteca como JSON legible (para backup del usuario).
 * El usuario puede guardar este JSON y restaurarlo más tarde con importLibrary().
 *
 * @returns {string} JSON formateado (indentado para legibilidad).
 *
 * @example
 *   const json = exportLibrary();
 *   // Crear un archivo descargable:
 *   const blob = new Blob([json], { type: 'application/json' });
 *   const url = URL.createObjectURL(blob);
 *   // ... montar un <a download> con la URL
 */
function exportLibrary() {
  _assertInitialized();
  return JSON.stringify([..._library.values()], null, 2);
}

/**
 * Importa una biblioteca desde un JSON previamente exportado.
 * ⚠️ SOBRESCRIBE la biblioteca actual. Usar con confirmación del usuario.
 *
 * @param {string} jsonStr - JSON exportado con exportLibrary().
 * @throws {Error} Si el JSON es inválido o tiene formato incorrecto.
 *
 * @example
 *   // En el handler del input[type=file]:
 *   const text = await file.text();
 *   importLibrary(text);
 *   console.log('Biblioteca restaurada:', getStats());
 */
function importLibrary(jsonStr) {
  _assertInitialized();

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error('[LibraryStore] El archivo de importación no es un JSON válido.');
  }

  if (!Array.isArray(parsed)) {
    throw new Error('[LibraryStore] El formato del archivo no es el esperado (debe ser un array de entradas).');
  }

  const validEntries = parsed.filter(_isValidEntry).map(_migrateEntry);

  if (validEntries.length === 0) {
    throw new Error('[LibraryStore] El archivo no contiene entradas válidas para importar.');
  }

  _library = new Map(validEntries.map(e => [e.vnId, e]));
  _saveToStorage();
  _notify('update', null); // null como payload indica recarga total

  console.info(`[LibraryStore] Importación exitosa: ${_library.size} entradas cargadas.`);
}


// ─────────────────────────────────────────────
// 9. HELPERS INTERNOS (privados al módulo)
// ─────────────────────────────────────────────

/**
 * Lanza un Error descriptivo si el store no fue inicializado.
 * Previene uso accidental antes de llamar a init().
 * @throws {Error}
 */
function _assertInitialized() {
  if (!_initialized) {
    throw new Error(
      '[LibraryStore] El store no fue inicializado. Llama a init() antes de cualquier otra operación.',
    );
  }
}

/**
 * Obtiene una entrada del store o lanza Error si no existe.
 * Centraliza el mensaje de "no encontrado" para consistencia.
 *
 * @param {string} vnId
 * @returns {LibraryEntry}
 * @throws {Error}
 */
function _getOrThrow(vnId) {
  const entry = _library.get(vnId);
  if (!entry) {
    throw new Error(
      `[LibraryStore] La VN "${vnId}" no existe en la biblioteca. ` +
      `Usa addVn() para agregarla primero.`,
    );
  }
  return entry;
}

/**
 * Valida el formato de un ID de VNDB.
 *
 * @param {string} vnId
 * @throws {TypeError} Si el formato es inválido.
 */
function _validateVnId(vnId) {
  if (!isNonEmptyString(vnId) || !/^v\d+$/.test(vnId)) {
    throw new TypeError(
      `[LibraryStore] ID de VN inválido: "${vnId}". Formato esperado: "v{número}" (ej: "v17").`,
    );
  }
}

/**
 * Valida que un estado sea miembro del enum VN_STATUS.
 *
 * @param {string} status
 * @throws {TypeError} Si el estado no es reconocido.
 */
function _validateStatus(status) {
  if (!Object.values(VN_STATUS).includes(status)) {
    throw new TypeError(
      `[LibraryStore] Estado desconocido: "${status}". ` +
      `Valores válidos: ${Object.values(VN_STATUS).join(', ')}.`,
    );
  }
}

/**
 * Determina qué campos resetear al cambiar de estado.
 * Principio: cada estado tiene campos exclusivos que no deben contaminar
 * estados posteriores, EXCEPTO el log (tiene valor histórico).
 *
 * REGLA DE RESET:
 *  - Al SALIR de FINISHED: limpiar score, favRoute, review, isSpoiler.
 *  - Al SALIR de DROPPED: no limpiar comment (valor histórico, como el log).
 *  - Log (PLAYING): NUNCA se borra (el historial de progreso es valioso).
 *
 * @param {VN_STATUS} oldStatus - Estado del que se sale.
 * @param {VN_STATUS} newStatus - Estado al que se entra.
 * @returns {Partial<LibraryEntry>} Campos a sobrescribir con sus valores default.
 */
function _getFieldResetForStatusChange(oldStatus, newStatus) {
  const resets = {};

  // Al salir de FINISHED, limpiamos la reseña completa
  // (si vuelve a FINISHED en el futuro, debe re-completarla)
  if (oldStatus === VN_STATUS.FINISHED && newStatus !== VN_STATUS.FINISHED) {
    resets.score     = null;
    resets.favRoute  = '';
    resets.review    = '';
    resets.isSpoiler = false;
  }

  return resets;
}


// ─────────────────────────────────────────────
// EXPORTACIÓN (API pública del módulo)
// ─────────────────────────────────────────────
export {
  // Ciclo de vida
  init,
  subscribe,
  clearAll,

  // Escritura
  addVn,
  updateStatus,
  updateLog,
  updateComment,
  updateReview,
  removeVn,

  // Lectura
  getEntry,
  hasVn,
  getEntriesByStatus,
  getRankedFinished,
  getStats,

  // Import / Export (backup)
  exportLibrary,
  importLibrary,
};