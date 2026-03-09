'use strict';

/**
 * @file js/feed-controller.js
 * @description Controlador del feed de comunidad.
 *              Carga y renderiza las reseñas públicas desde Firestore.
 *              Se activa automáticamente cuando el usuario navega
 *              a la vista "feed".
 *
 * RESPONSABILIDAD ÚNICA:
 *  - Escuchar el evento de navegación a la vista feed.
 *  - Cargar las entradas públicas con getPublicFeed().
 *  - Renderizar cada entrada como una .vh-feed-card en #feedList.
 *  - Gestionar estados de carga, vacío y error.
 *
 * NO hace: lógica de puntuación, auth, library store.
 *
 * INTEGRACIÓN:
 *  app-init.js → FeedController.init()
 *  ui-controller.js → navFeed click → FeedController carga el feed
 */

import * as FirebaseService from './firebase-service.js';
import { escapeHtml }       from './utils.js';


// ─────────────────────────────────────────────
// CONSTANTES INTERNAS
// ─────────────────────────────────────────────

/** Cantidad de reseñas a cargar por defecto */
const FEED_PAGE_SIZE = 20;

/** Tiempo mínimo entre recargas del feed (ms) para no saturar Firestore */
const FEED_RELOAD_COOLDOWN_MS = 60_000;


// ─────────────────────────────────────────────
// ESTADO INTERNO
// ─────────────────────────────────────────────

const _state = {
  loaded:     false,
  loading:    false,
  lastLoaded: 0,   // timestamp de la última carga exitosa
};


// ─────────────────────────────────────────────
// REFERENCIAS DOM
// ─────────────────────────────────────────────

const _dom = {};

function _cacheDOM() {
  _dom.feedList  = document.getElementById('feedList');
  _dom.viewFeed  = document.getElementById('viewFeed');
  _dom.navFeed   = document.getElementById('navFeed');
}


// ════════════════════════════════════════════════════════
// 1. CARGA DE DATOS
// ════════════════════════════════════════════════════════

/**
 * Carga el feed público desde Firestore y re-renderiza.
 * Respeta el cooldown para evitar lecturas innecesarias.
 *
 * @param {boolean} [force=false] — Si true, ignora el cooldown
 */
async function loadFeed(force = false) {
  if (_state.loading) return;

  const now      = Date.now();
  const cooldown = now - _state.lastLoaded < FEED_RELOAD_COOLDOWN_MS;
  if (!force && _state.loaded && cooldown) return;

  _state.loading = true;
  _renderLoading();

  try {
    const entries = await FirebaseService.getPublicFeed(FEED_PAGE_SIZE);

    _state.loaded    = true;
    _state.lastLoaded = Date.now();

    if (entries.length === 0) {
      _renderEmpty();
    } else {
      _renderEntries(entries);
    }

  } catch (err) {
    console.error('[FeedController] Error al cargar feed:', err);
    _renderError(err.message);
  } finally {
    _state.loading = false;
  }
}


// ════════════════════════════════════════════════════════
// 2. RENDERIZADO
// ════════════════════════════════════════════════════════

/**
 * Limpia el contenedor y renderiza el skeleton de carga.
 */
function _renderLoading() {
  if (!_dom.feedList) return;
  _clear();

  const fragment = document.createDocumentFragment();

  // 3 skeletons animados para indicar carga
  for (let i = 0; i < 3; i++) {
    const skeleton = document.createElement('div');
    skeleton.className   = 'vh-feed-card vh-feed-card--skeleton';
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
      // Una entrada malformada no bloquea el resto
      console.warn('[FeedController] Entrada inválida ignorada:', entry.id, err);
    }
  });

  _dom.feedList.appendChild(fragment);
}

/**
 * Construye una .vh-feed-card a partir de un documento del feed.
 * SEGURIDAD: todos los textos se escapan con escapeHtml() antes
 * de insertarse en el DOM para prevenir XSS.
 *
 * @param {object} entry — Documento Firestore
 * @param {number} index — Para animación escalonada
 * @returns {HTMLElement}
 */
function _buildFeedCard(entry, index) {
  // ── Validación básica del documento ──────────────────────────────
  if (!entry || typeof entry !== 'object') throw new TypeError('Entrada inválida');

  const card = document.createElement('article');
  card.className = 'vh-feed-card';
  card.style.animationDelay = `${index * 60}ms`;

  // ── Portada ──────────────────────────────────────────────────────
  card.appendChild(_buildCover(entry));

  // ── Cuerpo ───────────────────────────────────────────────────────
  const body = document.createElement('div');
  body.className = 'vh-feed-card__body';

  // Meta: avatar + nombre + fecha
  body.appendChild(_buildMeta(entry));

  // Título de la VN
  const vnTitle = document.createElement('p');
  vnTitle.className   = 'vh-feed-card__vn-title';
  vnTitle.textContent = escapeHtml(String(entry.vnTitle ?? 'Sin título'));
  body.appendChild(vnTitle);

  // Línea de puntaje
  if (typeof entry.finalScore === 'number') {
    body.appendChild(_buildScoreLine(entry));
  }

  // Reseña (con soporte spoiler)
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

  // Avatar
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

  // Nombre de usuario
  const userName = document.createElement('span');
  userName.className   = 'vh-feed-card__user';
  userName.textContent = escapeHtml(String(entry.displayName ?? 'Usuario'));
  meta.appendChild(userName);

  // Fecha relativa
  const dateEl = document.createElement('span');
  dateEl.className   = 'vh-feed-card__date';
  dateEl.textContent = _formatDate(entry.publishedAt);
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
 * Construye el bloque de texto de reseña.
 * Si isSpoiler=true, aplica el filtro blur y el listener de click.
 * SEGURIDAD: usa textContent, nunca innerHTML con datos de usuario.
 *
 * @param {object} entry
 * @returns {HTMLElement}
 */
function _buildReviewText(entry) {
  const review = document.createElement('p');
  review.className   = 'vh-feed-card__review';
  // textContent escapa automáticamente: seguro contra XSS
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
// 3. HELPERS
// ════════════════════════════════════════════════════════

/**
 * Limpia el contenedor del feed.
 */
function _clear() {
  if (!_dom.feedList) return;
  while (_dom.feedList.firstChild) {
    _dom.feedList.removeChild(_dom.feedList.firstChild);
  }
}

/**
 * Formatea una fecha Firestore (Timestamp o ISO string) como texto relativo.
 * Ej: "hace 3 días", "hace 1 hora", "hoy".
 *
 * @param {object|string|null} timestamp — Firestore Timestamp o string ISO
 * @returns {string}
 */
function _formatDate(timestamp) {
  try {
    let date;

    // Firestore Timestamp tiene .toDate()
    if (timestamp && typeof timestamp.toDate === 'function') {
      date = timestamp.toDate();
    } else if (typeof timestamp === 'string') {
      date = new Date(timestamp);
    } else if (timestamp?.seconds) {
      // Firestore Timestamp serializado como { seconds, nanoseconds }
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
// 4. REGISTRO DE EVENTOS
// ════════════════════════════════════════════════════════

/**
 * Escucha el click en el botón de navegación "Comunidad".
 * Cuando se activa la vista feed, carga los datos si es necesario.
 */
function _bindEvents() {
  const navFeed = document.getElementById('navFeed');
  if (!navFeed) return;

  navFeed.addEventListener('click', () => {
    // Esperamos un tick para que ui-controller haya
    // cambiado la vista antes de cargar el feed.
    requestAnimationFrame(() => loadFeed());
  });
}


// ════════════════════════════════════════════════════════
// 5. INICIALIZACIÓN
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

export { init, loadFeed };