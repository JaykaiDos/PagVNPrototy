/**
 * @file translation-service.js
 * @description Servicio de traducción de sinopsis para VN-Hub.
 *              Conecta con el Cloudflare Worker vn-hub-translator
 *              para traducir descripciones de inglés a español.
 *
 * ARQUITECTURA:
 *  - SRP: única responsabilidad — traducir texto vía Worker.
 *  - Caché en memoria (sessionStorage) para evitar llamadas
 *    repetidas dentro de la misma sesión del navegador.
 *  - Degradación graceful: si el Worker falla, devuelve null
 *    sin romper el resto de la página.
 *
 * FLUJO:
 *  1. Verificar caché local (sessionStorage)
 *  2. Si no hay caché → llamar al Worker
 *  3. Worker consulta KV → traduce con MyMemory si es necesario
 *  4. Guardar resultado en sessionStorage
 *  5. Devolver texto traducido
 *
 * USO:
 *  import { translateSynopsis } from './translation-service.js';
 *  const translated = await translateSynopsis('v17', 'Clannad is...');
 */

'use strict';

// ─────────────────────────────────────────────
// CONFIGURACIÓN
// ─────────────────────────────────────────────

/**
 * URL base del Cloudflare Worker de traducción.
 * Actualizar si cambia el nombre del Worker o la cuenta.
 * @type {string}
 */
const WORKER_URL = 'https://vn-hub-translator.cesarycesar93losmejores.workers.dev';

/** Timeout máximo para llamadas al Worker (ms) */
const REQUEST_TIMEOUT_MS = 10_000;

/** Prefijo de claves en sessionStorage */
const SESSION_PREFIX = 'vnh_trans:';


// ─────────────────────────────────────────────
// CACHÉ DE SESIÓN
// ─────────────────────────────────────────────

/**
 * Guarda una traducción en sessionStorage.
 * sessionStorage se limpia al cerrar la pestaña — no persiste
 * entre sesiones (eso lo gestiona el KV del Worker).
 *
 * @param {string} vnId
 * @param {string} translated
 */
function _saveToSession(vnId, translated) {
  try {
    sessionStorage.setItem(`${SESSION_PREFIX}${vnId}`, translated);
  } catch {
    // sessionStorage puede estar bloqueado en modo privado — ignorar
  }
}

/**
 * Recupera una traducción del sessionStorage.
 *
 * @param {string} vnId
 * @returns {string|null}
 */
function _getFromSession(vnId) {
  try {
    return sessionStorage.getItem(`${SESSION_PREFIX}${vnId}`);
  } catch {
    return null;
  }
}


// ─────────────────────────────────────────────
// VALIDADORES
// ─────────────────────────────────────────────

/**
 * Valida formato de ID VNDB: "v{número}".
 * @param {*} value
 * @returns {boolean}
 */
function _isValidVnId(value) {
  return typeof value === 'string' && /^v\d+$/.test(value);
}

/**
 * Valida que un valor sea string no vacío.
 * @param {*} value
 * @returns {boolean}
 */
function _isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}


// ─────────────────────────────────────────────
// API PÚBLICA
// ─────────────────────────────────────────────

/**
 * Traduce la sinopsis de una VN al español llamando al Worker.
 *
 * Prioridad de resolución:
 *  1. sessionStorage (caché de la pestaña actual)
 *  2. Worker → KV (caché persistente en Cloudflare)
 *  3. Worker → MyMemory (traducción nueva)
 *  4. null (si todo falla — la UI muestra el original)
 *
 * @param {string} vnId   - ID de la VN en formato "v{número}".
 * @param {string} text   - Texto en inglés a traducir.
 * @returns {Promise<string|null>} Texto traducido o null si falla.
 */
async function translateSynopsis(vnId, text) {
  // Validar inputs antes de cualquier operación
  if (!_isValidVnId(vnId)) {
    console.warn(`[TranslationService] vnId inválido: "${vnId}"`);
    return null;
  }

  if (!_isNonEmptyString(text)) {
    return null;
  }

  // 1. Verificar caché de sesión primero (0 latencia)
  const cached = _getFromSession(vnId);
  if (cached) {
    console.info(`[TranslationService] Caché hit para ${vnId}`);
    return cached;
  }

  // 2. Llamar al Worker
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${WORKER_URL}/translate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ vnId, text }),
      signal:  controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.warn(`[TranslationService] Worker respondió ${response.status}:`, err.error);
      return null;
    }

    const data = await response.json();
    const translated = data?.translated;

    if (!_isNonEmptyString(translated)) {
      console.warn('[TranslationService] Worker devolvió traducción vacía');
      return null;
    }

    // 3. Guardar en sessionStorage para esta pestaña
    _saveToSession(vnId, translated);

    console.info(
      `[TranslationService] Traducido ${vnId} — fromCache: ${data.fromCache ?? false}`
    );

    return translated;

  } catch (error) {
    clearTimeout(timeoutId);

    if (error.name === 'AbortError') {
      console.warn('[TranslationService] Timeout — el Worker tardó demasiado');
    } else {
      console.warn('[TranslationService] Error de red:', error.message);
    }

    // Degradación graceful: la UI mostrará el texto original
    return null;
  }
}

/**
 * Verifica que el Worker esté activo (útil para debugging).
 * @returns {Promise<boolean>}
 */
async function checkWorkerHealth() {
  try {
    const response = await fetch(`${WORKER_URL}/health`, { method: 'GET' });
    const data     = await response.json();
    return data?.status === 'ok';
  } catch {
    return false;
  }
}


// ─────────────────────────────────────────────
// EXPORTACIÓN
// ─────────────────────────────────────────────
export { translateSynopsis, checkWorkerHealth };
