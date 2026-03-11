'use strict';

/**
 * @file js/feed-controller.js
 * @description Controlador del feed de comunidad.
 *              Carga y renderiza las reseñas públicas desde Firestore.
 *
 * CORRECCIONES v2:
 *  - [BUG #1] invalidateCache(): Permite que módulos externos (modal-review,
 *    FirebaseSync) fuercen una recarga en la próxima visita al feed.
 *    Reemplaza el anti-patrón de cooldown que bloqueaba actualizaciones
 *    inmediatas tras guardar una reseña.
 *  - [BUG #1] notifyReviewPublished(): API explícita post-publicación.
 *    Si el feed está visible al momento de guardar, lo recarga ahora mismo.
 *    Si no está visible, marca el cache como inválido para la próxima visita.
 *  - [DISEÑO] El cooldown de 60s se mantiene para cargas pasivas (navegación
 *    normal sin cambios recientes), pero se bypasea vía invalidateCache().
 *
 * RESPONSABILIDAD ÚNICA:
 *  - Escuchar el evento de navegación a la vista feed.
 *  - Cargar las entradas públicas con getPublicFeed().
 *  - Renderizar cada entrada como una .vh-feed-card en #feedList.
 *  - Gestionar estados de carga, vacío y error.
 */

import * as FirebaseService from './firebase-service.js';
import { escapeHtml }       from './utils.js';


// ─────────────────────────────────────────────
// CONSTANTES INTERNAS
// ─────────────────────────────────────────────

/** Cantidad de reseñas a cargar por defecto */
const FEED_PAGE_SIZE = 20;

/**
 * Tiempo mínimo entre recargas PASIVAS del feed (navegación normal).
 * Este cooldown NO aplica cuando invalidateCache() fue llamado.
 */
const FEED_RELOAD_COOLDOWN_MS = 60_000;


// ─────────────────────────────────────────────
// ESTADO INTERNO
// ─────────────────────────────────────────────

const _state = {
  loaded:        false,
  loading:       false,
  lastLoaded:    0,    // timestamp de la última carga exitosa
  cacheInvalid:  false, // [CORRECCIÓN] Flag: cache invalidado por cambio del usuario
};


// ─────────────────────────────────────────────
// REFERENCIAS DOM
// ─────────────────────────────────────────────

const _dom = {};

/**
 * Cachea las referencias DOM necesarias.
 * Se llama una sola vez en init().
 */
function _cacheDOM() {
  _dom.feedList = document.getElementById('feedList');
  _dom.viewFeed = document.getElementById('viewFeed');
  _dom.navFeed  = document.getElementById('navFeed');
}

/**
 * Comprueba si la vista del feed está actualmente visible en el DOM.
 * @returns {boolean}
 */
function _isFeedVisible() {
  return _dom.viewFeed != null && !_dom.viewFeed.hidden;
}


// ════════════════════════════════════════════════════════
// 1. GESTIÓN DE CACHÉ (API PÚBLICA)
// ════════════════════════════════════════════════════════

/**
 * [CORRECCIÓN BUG #1]
 * Invalida el caché del feed, forzando una recarga en la próxima visita.
 *
 * Este método debe llamarse SIEMPRE que el usuario publique o modifique
 * una reseña (desde modal-review.js o FirebaseSync en app-init.js).
 *
 * COMPORTAMIENTO:
 *  - Si el feed está visible AHORA → recarga inmediatamente (force=true).
 *  - Si el feed NO está visible    → marca el caché como inválido.
 *    La próxima vez que el usuario navegue a "Comunidad", verá los datos frescos.
 *
 * @returns {Promise<void>}
 */
async function invalidateCache() {
  _state.cacheInvalid = true;

  if (_isFeedVisible()) {
    // El usuario está mirando el feed justo ahora → recargar inmediatamente
    await loadFeed(true);
  }
  // Si no está visible, el flag cacheInvalid lo recargará al navegar
}

/**
 * [CORRECCIÓN BUG #1]
 * Atajo semántico para llamar desde modal-review y FirebaseSync
 * cuando una reseña acaba de ser publicada o actualizada.
 *
 * @returns {Promise<void>}
 */
async function notifyReviewPublished() {
  return invalidateCache();
}


// ════════════════════════════════════════════════════════
// 2. CARGA DE DATOS
// ════════════════════════════════════════════════════════

/**
 * Carga el feed público desde Firestore y re-renderiza.
 *
 * LÓGICA DE COOLDOWN (revisada):
 *  - Si force=true         → siempre carga (sin restricciones).
 *  - Si cacheInvalid=true  → siempre carga (el usuario tiene cambios recientes).
 *  - Si ya cargó hace <60s → no carga (evita lecturas innecesarias en Firestore).
 *
 * @param {boolean} [force=false] — Si true, ignora cooldown y cacheInvalid
 */
async function loadFeed(force = false) {
  if (_state.loading) return;

  const now          = Date.now();
  const withinCooldown = now - _state.lastLoaded < FEED_RELOAD_COOLDOWN_MS;

  // [CORRECCIÓN] cacheInvalid bypasea el cooldown pasivo
  const shouldSkip = !force && !_state.cacheInvalid && _state.loaded && withinCooldown;
  if (shouldSkip) return;

  _state.loading     = true;
  _state.cacheInvalid = false; // Consumimos el flag de invalidación
  _renderLoading();

  try {
    const entries = await FirebaseService.getPublicFeed(FEED_PAGE_SIZE);

    _state.loaded     = true;
    _state.lastLoaded = Date.now();

    if (entries.length === 0) {
      _renderEmpty();
    } else {
      _renderEntries(entries);
    }

  } catch (err) {
    console.error('[FeedController] Error al cargar feed:', err);
    _renderError(err.message);
    // En caso de error, dejamos cacheInvalid=false para no crear bucle de reintentos
  } finally {
    _state.loading = false;
  }
}


// ════════════════════════════════════════════════════════
// 3. RENDERIZADO
// ════════════════════════════════════════════════════════

/**
 * Limpia el contenedor y renderiza el skeleton de carga.
 */
function _renderLoading() {
  if (!_dom.feedList) return;
  _clear();

  const fragment = document.createDocumentFragment();

  for (let i = 0; i < 3; i++) {
    const skeleton = document.createElement('div');
    skeleton.className = 'vh-feed-card vh-feed-card--skeleton';
    skeleton.setAttribute('aria-hidden', 'true');
    skeleton.style.animationDelay = `${i * 120}ms`;

    const cover = document.createElement('div');
    cover.className = 'vh-feed-card__cover-placeholder vh-skeleton';

    const body = document.createElement('div');
    body.className = 'vh-feed-card__body';
    body.innerHTML = `
      <div class="vh-skeleton vh-skeleton--line" style="width:60%; height:0.75rem;"></div>
      <div class="vh-skeleton vh-skeleton--line" style="width:85%; height:1rem; margin-top:0.5rem;"></div>
      <div class="vh-skeleton vh-skeleton--line" style="width:40%; height:0.75rem; margin-top:0.5rem;"></div>
      <div class="vh-skeleton vh-skeleton--line" style="width:95%; height:0.7rem; margin-top:0.75rem;"></div>
      <div class="vh-skeleton vh-skeleton--line" style="width:80%; height:0.7rem; margin-top:0.35rem;"></div>
    `;

    skeleton.appendChild(cover);
    skeleton.appendChild(body);
    fragment.appendChild(skeleton);
  }

  _dom.feedList.appendChild(fragment);
}

/**
 * Renderiza el estado vacío cuando no hay reseñas públicas.
 */
function _renderEmpty() {
  if (!_dom.feedList) return;
  _clear();

  const empty = document.createElement('div');
  empty.className = 'vh-feed-empty';

  const icon = document.createElement('p');
  icon.className   = 'vh-feed-empty__icon';
  icon.textContent = '📭';
  icon.setAttribute('aria-hidden', 'true');

  const title = document.createElement('p');
  title.className   = 'vh-feed-empty__title';
  title.textContent = 'Aún no hay reseñas publicadas';

  const hint = document.createElement('p');
  hint.className   = 'vh-feed-empty__hint';
  hint.textContent = 'Finaliza una VN con tu perfil en modo público para aparecer aquí.';

  empty.appendChild(icon);
  empty.appendChild(title);
  empty.appendChild(hint);
  _dom.feedList.appendChild(empty);
}

/**
 * Renderiza un mensaje de error con opción de reintentar.
 * @param {string} [message]
 */
function _renderError(message) {
  if (!_dom.feedList) return;
  _clear();

  const errorEl = document.createElement('div');
  errorEl.className = 'vh-feed-error';
  errorEl.setAttribute('role', 'alert');

  const icon = document.createElement('p');
  icon.textContent = '⚠';
  icon.className   = 'vh-feed-error__icon';
  icon.setAttribute('aria-hidden', 'true');

  const text = document.createElement('p');
  text.className   = 'vh-feed-error__text';
  text.textContent = 'No se pudo cargar el feed.';

  const retryBtn = document.createElement('button');
  retryBtn.className   = 'vh-btn vh-btn--ghost';
  retryBtn.textContent = '↺ Reintentar';
  retryBtn.addEventListener('click', () => loadFeed(true));

  errorEl.appendChild(icon);
  errorEl.appendChild(text);
  errorEl.appendChild(retryBtn);
  _dom.feedList.appendChild(errorEl);
}

/**
 * Renderiza la lista de entradas del feed.
 * @param {object[]} entries — Documentos Firestore del feed
 */
function _renderEntries(entries) {
  if (!_dom.feedList) return;
  _clear();

  const fragment = document.createDocumentFragment();

  entries.forEach((entry, index) => {
    try {
      fragment.appendChild(_buildFeedCard(entry, index));
    } catch (err) {
      console.warn('[FeedController] Entrada inválida ignorada:', entry.id, err);
    }
  });

  _dom.feedList.appendChild(fragment);
}

/**
 * Construye una .vh-feed-card a partir de un documento del feed.
 * SEGURIDAD: todos los textos se escapan con escapeHtml() o textContent
 * para prevenir XSS sin excepción.
 *
 * @param {object} entry — Documento Firestore
 * @param {number} index — Para animación escalonada
 * @returns {HTMLElement}
 */
function _buildFeedCard(entry, index) {
  if (!entry || typeof entry !== 'object') throw new TypeError('Entrada inválida');

  const card = document.createElement('article');
  card.className = 'vh-feed-card';
  card.style.animationDelay = `${index * 60}ms`;

  card.appendChild(_buildCover(entry));

  const body = document.createElement('div');
  body.className = 'vh-feed-card__body';

  body.appendChild(_buildMeta(entry));

  const vnTitle = document.createElement('p');
  vnTitle.className   = 'vh-feed-card__vn-title';
  vnTitle.textContent = escapeHtml(String(entry.vnTitle ?? 'Sin título'));
  body.appendChild(vnTitle);

  if (typeof entry.finalScore === 'number') {
    body.appendChild(_buildScoreLine(entry));
  }

  if (entry.review && String(entry.review).trim().length > 0) {
    body.appendChild(_buildReviewText(entry));
  }

  card.appendChild(body);
  return card;
}

/**
 * Construye la imagen de portada o un placeholder.
 * @param {object} entry
 * @returns {HTMLElement}
 */
function _buildCover(entry) {
  const isValidUrl = typeof entry.vnImageUrl === 'string'
    && /^https:\/\//i.test(entry.vnImageUrl);

  if (isValidUrl) {
    const img = document.createElement('img');
    img.className = 'vh-feed-card__cover';
    img.setAttribute('src',     entry.vnImageUrl);
    img.setAttribute('alt',     escapeHtml(String(entry.vnTitle ?? '')));
    img.setAttribute('loading', 'lazy');
    img.setAttribute('decoding','async');
    return img;
  }

  const placeholder = document.createElement('div');
  placeholder.className   = 'vh-feed-card__cover-placeholder';
  placeholder.textContent = '📖';
  placeholder.setAttribute('aria-hidden', 'true');
  return placeholder;
}

/**
 * Construye la fila de metadatos: avatar, nombre de usuario y fecha.
 * @param {object} entry
 * @returns {HTMLElement}
 */
function _buildMeta(entry) {
  const meta = document.createElement('div');
  meta.className = 'vh-feed-card__meta';

  const isValidPhoto = typeof entry.photoURL === 'string'
    && /^https:\/\//i.test(entry.photoURL);

  if (isValidPhoto) {
    const avatar = document.createElement('img');
    avatar.className = 'vh-feed-card__avatar';
    avatar.setAttribute('src', entry.photoURL);
    avatar.setAttribute('alt', escapeHtml(String(entry.displayName ?? '')));
    avatar.setAttribute('loading', 'lazy');
    meta.appendChild(avatar);
  }

  const userName = document.createElement('span');
  userName.className   = 'vh-feed-card__user';
  userName.textContent = escapeHtml(String(entry.displayName ?? 'Usuario'));
  meta.appendChild(userName);

  const dateEl = document.createElement('span');
  dateEl.className   = 'vh-feed-card__date';
  // [DISEÑO] Preferimos updatedAt para reflejar ediciones recientes.
  // Si no existe updatedAt (publicación original sin editar), usamos publishedAt.
  dateEl.textContent = _formatDate(entry.updatedAt ?? entry.publishedAt);
  meta.appendChild(dateEl);

  return meta;
}

/**
 * Construye la línea de puntaje con valor numérico y etiqueta verbal.
 * @param {object} entry
 * @returns {HTMLElement}
 */
function _buildScoreLine(entry) {
  const line = document.createElement('div');
  line.className = 'vh-feed-card__score-line';

  const scoreVal = document.createElement('span');
  scoreVal.className   = 'vh-feed-card__score';
  scoreVal.textContent = Number(entry.finalScore).toFixed(2);

  const scoreLabel = document.createElement('span');
  scoreLabel.className   = 'vh-feed-card__score-label';
  scoreLabel.textContent = escapeHtml(String(entry.scoreLabel ?? ''));

  line.appendChild(scoreVal);
  line.appendChild(scoreLabel);
  return line;
}

/**
 * Construye el bloque de texto de reseña con soporte de spoiler.
 * SEGURIDAD: usa textContent, nunca innerHTML con datos del usuario.
 *
 * @param {object} entry
 * @returns {HTMLElement}
 */
function _buildReviewText(entry) {
  const review = document.createElement('p');
  review.className   = 'vh-feed-card__review';
  review.textContent = String(entry.review ?? '');

  if (entry.isSpoiler) {
    review.classList.add('vh-feed-card__review--spoiler');
    review.setAttribute('title', 'Click para revelar spoiler');
    review.addEventListener('click', () => {
      review.classList.add('revealed');
    }, { once: true });
  }

  return review;
}


// ════════════════════════════════════════════════════════
// 4. HELPERS
// ════════════════════════════════════════════════════════

/**
 * Limpia el contenedor del feed de forma eficiente.
 */
function _clear() {
  if (!_dom.feedList) return;
  while (_dom.feedList.firstChild) {
    _dom.feedList.removeChild(_dom.feedList.firstChild);
  }
}

/**
 * Formatea una fecha Firestore (Timestamp o ISO string) como texto relativo.
 * Ej: "hace 3 días", "hace 1 hora", "ahora".
 *
 * @param {object|string|null} timestamp — Firestore Timestamp o string ISO
 * @returns {string}
 */
function _formatDate(timestamp) {
  try {
    let date;

    if (timestamp && typeof timestamp.toDate === 'function') {
      date = timestamp.toDate();
    } else if (typeof timestamp === 'string') {
      date = new Date(timestamp);
    } else if (timestamp?.seconds) {
      date = new Date(timestamp.seconds * 1000);
    } else {
      return '';
    }

    if (isNaN(date.getTime())) return '';

    const diffMs  = Date.now() - date.getTime();
    const diffMin = Math.floor(diffMs / 60_000);
    const diffH   = Math.floor(diffMin / 60);
    const diffD   = Math.floor(diffH / 24);

    if (diffMin < 1)  return 'ahora';
    if (diffMin < 60) return `hace ${diffMin} min`;
    if (diffH < 24)   return `hace ${diffH}h`;
    if (diffD === 1)  return 'ayer';
    if (diffD < 7)    return `hace ${diffD} días`;
    if (diffD < 30)   return `hace ${Math.floor(diffD / 7)} sem`;
    if (diffD < 365)  return `hace ${Math.floor(diffD / 30)} meses`;
    return `hace ${Math.floor(diffD / 365)} años`;

  } catch {
    return '';
  }
}


// ════════════════════════════════════════════════════════
// 5. REGISTRO DE EVENTOS
// ════════════════════════════════════════════════════════

/**
 * Escucha el click en el botón de navegación "Comunidad".
 * Cuando se activa la vista feed, carga los datos si es necesario.
 *
 * [CORRECCIÓN BUG #1] Si cacheInvalid=true, siempre recarga al navegar.
 */
function _bindEvents() {
  const navFeed = document.getElementById('navFeed');
  if (!navFeed) return;

  navFeed.addEventListener('click', () => {
    // Esperamos un tick para que ui-controller haya cambiado la vista
    requestAnimationFrame(() => {
      // Si hay cambios pendientes del usuario, forzar recarga
      const shouldForce = _state.cacheInvalid;
      loadFeed(shouldForce);
    });
  });
}


// ════════════════════════════════════════════════════════
// 6. INICIALIZACIÓN
// ════════════════════════════════════════════════════════

/**
 * Inicializa el controlador del feed.
 * Llamado desde app-init.js.
 */
function init() {
  _cacheDOM();
  _bindEvents();
  console.info('[FeedController] Inicializado ✓');
}

export { init, loadFeed, invalidateCache, notifyReviewPublished };