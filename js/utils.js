/**
 * @file utils.js
 * @description Utilidades puras y reutilizables para VN-Hub.
 *              Incluye sanitización XSS, formateo de datos y helpers genéricos.
 *
 * CAMBIOS v2:
 *  - stripBbCode(): limpia el markup BBCode que VNDB incluye en las sinopsis
 *    (ej: [b]texto[/b], [i]texto[/i], [url=...]texto[/url]).
 *    Se llama en _transformVn() de vndb-service.js antes de almacenar description.
 *
 * NOTA SOBRE IDIOMA DE SINOPSIS:
 *  La API de VNDB solo expone UN campo "description" por VN, siempre en
 *  el idioma original del desarrollador (mayormente inglés o japonés).
 *  No existe un endpoint de descripción por idioma en la API pública.
 *  La traducción automática requeriría un proxy con backend, lo cual es
 *  incompatible con GitHub Pages. Tarea pendiente: Fase E (backend proxy).
 *
 * PRINCIPIOS:
 *  - Cada función tiene UNA sola responsabilidad (SRP).
 *  - Ninguna función modifica estado externo (funciones puras).
 *  - Sin dependencias externas: solo usa APIs del navegador.
 */

'use strict';

// ─────────────────────────────────────────────
// 1. SEGURIDAD — Anti-XSS
// ─────────────────────────────────────────────

/**
 * Escapa caracteres HTML especiales para prevenir inyección XSS.
 * Debe usarse SIEMPRE antes de insertar texto de la API en el DOM
 * mediante innerHTML.
 *
 * @param {unknown} value - Valor a escapar (puede ser cualquier tipo).
 * @returns {string} Cadena con caracteres HTML escapados.
 *
 * @example
 *   escapeHtml('<script>alert("xss")</script>')
 *   // → '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
 */
function escapeHtml(value) {
  const str = String(value ?? '');

  return str
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#x27;');
}

/**
 * Sanitiza un objeto plano recursivamente, escapando todos los valores string.
 * Útil para limpiar objetos de respuesta de la API antes de procesarlos.
 *
 * @param {Record<string, unknown>} obj - Objeto a sanitizar.
 * @returns {Record<string, unknown>} Nuevo objeto con strings sanitizados.
 */
function sanitizeObject(obj) {
  if (typeof obj !== 'object' || obj === null) {
    return typeof obj === 'string' ? escapeHtml(obj) : obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(sanitizeObject);
  }

  return Object.fromEntries(
    Object.entries(obj).map(([key, val]) => [key, sanitizeObject(val)])
  );
}

/**
 * Valida que una cadena no esté vacía después de limpiar espacios.
 *
 * @param {unknown} value - Valor a validar.
 * @returns {boolean} true si la cadena es válida y no está vacía.
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}


// ─────────────────────────────────────────────
// 2. LIMPIEZA DE BBCODE (VNDB)
// ─────────────────────────────────────────────

/**
 * Elimina el markup BBCode que VNDB incluye en sus sinopsis.
 * VNDB usa un subconjunto de BBCode: [b], [i], [u], [s], [url], [spoiler].
 *
 * REGLAS DE TRANSFORMACIÓN:
 *  [b]texto[/b]           → texto          (negrita → plano)
 *  [i]texto[/i]           → texto          (cursiva → plano)
 *  [u]texto[/u]           → texto          (subrayado → plano)
 *  [s]texto[/s]           → texto          (tachado → plano)
 *  [url=https://...]txt[/url] → txt        (link → solo el texto visible)
 *  [url]https://...[/url] → https://...    (link sin texto → la URL)
 *  [spoiler]texto[/spoiler] → texto        (spoiler → visible, ya que
 *                                            la sinopsis no debería ser spoiler)
 *  [from]texto[/from]     → texto          (atribución de traducción)
 *  Etiquetas desconocidas → eliminadas     (apertura y cierre)
 *
 * SEGURIDAD: Esta función opera sobre texto plano DESPUÉS de sanitizeObject,
 * por lo que no hay riesgo de inyección HTML.
 *
 * @param {string} text - Texto con markup BBCode de VNDB.
 * @returns {string}    - Texto limpio sin BBCode.
 *
 * @example
 *   stripBbCode('[b]Decide The Fate Of All Mankind[/b]')
 *   // → 'Decide The Fate Of All Mankind'
 *
 *   stripBbCode('[url=https://vndb.org]VNDB[/url]')
 *   // → 'VNDB'
 */
function stripBbCode(text) {
  if (!isNonEmptyString(text)) return '';

  return text
    // [url=http://...]texto visible[/url] → solo el texto visible
    .replace(/\[url=[^\]]*\]([\s\S]*?)\[\/url\]/gi, '$1')
    // [url]https://...[/url] → la URL (sin corchetes)
    .replace(/\[url\]([\s\S]*?)\[\/url\]/gi,        '$1')
    // Etiquetas con contenido: [tag]...[/tag] → solo el contenido
    .replace(/\[(?:b|i|u|s|spoiler|from|quote)\]([\s\S]*?)\[\/(?:b|i|u|s|spoiler|from|quote)\]/gi, '$1')
    // Etiquetas de apertura/cierre sueltas (sin match de par)
    .replace(/\[\/?\w+(?:=[^\]]*)?\]/g, '')
    // Normalizar múltiples líneas en blanco consecutivas a máximo dos
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}


// ─────────────────────────────────────────────
// 3. FORMATEO DE DATOS DE VNDB
// ─────────────────────────────────────────────

/**
 * Trunca un texto largo añadiendo puntos suspensivos.
 *
 * @param {string} text   - Texto original.
 * @param {number} maxLen - Longitud máxima permitida (default: 200).
 * @returns {string} Texto truncado si supera el límite.
 */
function truncateText(text, maxLen = 200) {
  if (!isNonEmptyString(text)) return '';
  return text.length > maxLen
    ? `${text.slice(0, maxLen).trimEnd()}…`
    : text;
}

/**
 * Formatea una fecha de lanzamiento de VNDB al formato local es-AR.
 * VNDB devuelve fechas en formato "YYYY-MM-DD" o solo "YYYY".
 *
 * @param {string|null|undefined} dateStr - Fecha cruda de VNDB.
 * @returns {string} Fecha formateada o "Fecha desconocida".
 */
function formatReleaseDate(dateStr) {
  if (!isNonEmptyString(dateStr)) return 'Fecha desconocida';

  if (/^\d{4}$/.test(dateStr)) return dateStr;

  try {
    const date = new Date(`${dateStr}T00:00:00`);
    return date.toLocaleDateString('es-AR', {
      day:   'numeric',
      month: 'long',
      year:  'numeric',
    });
  } catch {
    return dateStr;
  }
}

/**
 * Convierte minutos en formato legible (horas y minutos).
 *
 * @param {number|null|undefined} minutes - Duración en minutos.
 * @returns {string} Duración formateada o 'Desconocida'.
 */
function formatDuration(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'Desconocida';

  const h   = Math.floor(minutes / 60);
  const min = minutes % 60;

  if (h === 0)   return `${min}min`;
  if (min === 0) return `${h}h`;
  return `${h}h ${min}min`;
}

/**
 * Formatea el rating de VNDB (escala 10–100) a escala 0–10 con un decimal.
 *
 * @param {number|null|undefined} rating - Rating crudo de VNDB.
 * @returns {string} Rating formateado o 'N/A'.
 */
function formatVndbRating(rating) {
  if (!Number.isFinite(rating)) return 'N/A';
  return (rating / 100).toFixed(1);
}

/**
 * Obtiene el título preferido de una VN según idioma.
 * Prioridad: español → inglés → romanji → primero disponible.
 *
 * @param {string} mainTitle        - Título principal de VNDB.
 * @param {Array<{title:string, lang:string}>} titles - Array de títulos alternativos.
 * @returns {string} El título más adecuado.
 */
function getPreferredTitle(mainTitle, titles = []) {
  const find = (lang) => titles.find(t => t.lang === lang)?.title;
  return find('es') || find('en') || find('ja-ro') || mainTitle || 'Sin título';
}


// ─────────────────────────────────────────────
// 4. HELPERS DE FECHA/TIEMPO
// ─────────────────────────────────────────────

/**
 * Genera un timestamp ISO de la fecha actual.
 * @returns {string} Timestamp ISO 8601.
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * Formatea un timestamp ISO a fecha local legible.
 *
 * @param {string} isoStr - Timestamp ISO 8601.
 * @returns {string} Fecha formateada en español.
 */
function formatTimestamp(isoStr) {
  if (!isNonEmptyString(isoStr)) return '';
  try {
    return new Date(isoStr).toLocaleString('es-AR', {
      day:    '2-digit',
      month:  '2-digit',
      year:   'numeric',
      hour:   '2-digit',
      minute: '2-digit',
    });
  } catch {
    return isoStr;
  }
}


// ─────────────────────────────────────────────
// 5. HELPERS DE DOM (seguros, sin XSS)
// ─────────────────────────────────────────────

/**
 * Crea un elemento DOM y le asigna propiedades de forma segura.
 *
 * @param {string} tag
 * @param {object} [options]
 * @param {string} [options.className]
 * @param {string} [options.textContent]
 * @param {Record<string, string>} [options.dataset]
 * @param {Record<string, string>} [options.attrs]
 * @returns {HTMLElement}
 */
function createElement(tag, { className, textContent, dataset = {}, attrs = {} } = {}) {
  const el = document.createElement(tag);

  if (className)                 el.className   = className;
  if (textContent !== undefined) el.textContent = textContent;

  Object.entries(dataset).forEach(([k, v]) => { el.dataset[k] = v; });
  Object.entries(attrs).forEach(([k, v])   => { el.setAttribute(k, v); });

  return el;
}

/**
 * Selecciona un elemento del DOM de forma segura.
 * Lanza un error descriptivo si no existe.
 *
 * @param {string} selector
 * @param {Element} [context]
 * @returns {Element}
 * @throws {Error}
 */
function requireElement(selector, context = document) {
  const el = context.querySelector(selector);
  if (!el) throw new Error(`[VN-Hub] Elemento requerido no encontrado: "${selector}"`);
  return el;
}


// ─────────────────────────────────────────────
// EXPORTACIÓN
// ─────────────────────────────────────────────
export {
  // Seguridad
  escapeHtml,
  sanitizeObject,
  isNonEmptyString,

  // BBCode
  stripBbCode,

  // Formateo
  truncateText,
  formatReleaseDate,
  formatDuration,
  formatVndbRating,
  getPreferredTitle,

  // Tiempo
  nowIso,
  formatTimestamp,

  // DOM
  createElement,
  requireElement,
};