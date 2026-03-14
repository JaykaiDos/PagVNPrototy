'use strict';

/**
 * @file js/render-engine.js
 * @description Motor de renderizado de componentes UI para VN-Hub.
 */

import { VN_STATUS, VN_STATUS_META, SCORE_CATEGORIES }      from './constants.js';
import { escapeHtml }                                        from './utils.js';
import { getScoreThreshold, formatFinalScore as _fmtScore } from './score-engine.js';


// ─────────────────────────────────────────────
// CONSTANTES INTERNAS
// ─────────────────────────────────────────────

/** Emoji placeholder cuando no hay imagen o la imagen falla. */
const NO_IMAGE_PLACEHOLDER = '📖';

/**
 * Dimensiones estándar de portadas en VNDB.
 * Declarar width/height evita layout shift (CLS) al reservar
 * el espacio antes de que la imagen termine de descargar.
 * El CSS controla las dimensiones visuales reales con object-fit.
 */
const COVER_WIDTH  = 200;
const COVER_HEIGHT = 300;

const STATUS_BADGE_CLASS = Object.freeze({
  [VN_STATUS.PENDING]:  'vh-badge--pending',
  [VN_STATUS.PLAYING]:  'vh-badge--playing',
  [VN_STATUS.FINISHED]: 'vh-badge--finished',
  [VN_STATUS.DROPPED]:  'vh-badge--dropped',
});


// ─────────────────────────────────────────────
// HELPERS DE CREACIÓN DE ELEMENTOS DOM
// ─────────────────────────────────────────────

function _el(tag, cls = '', attrs = {}) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  return el;
}

function _elText(tag, cls, text, attrs = {}) {
  const el = _el(tag, cls, attrs);
  el.textContent = String(text ?? '');
  return el;
}

/**
 * Convierte un elemento <img> roto en un placeholder div controlado.
 * Se llama desde el handler onerror de _safeImage().
 *
 * MOTIVO: cuando la URL de VNDB falla (404, red cortada, etc.), el
 * navegador muestra su ícono de imagen rota nativo. Este helper lo
 * reemplaza por un placeholder visual consistente con el diseño.
 *
 * @param {HTMLImageElement} img - La imagen que falló.
 */
function _applyImgPlaceholder(img) {
  // Preservar las clases CSS de la imagen para mantener el layout
  const cls = img.className;

  const placeholder = document.createElement('div');
  placeholder.className   = `${cls} vh-card__cover-placeholder vh-card__cover-placeholder--error`;
  placeholder.textContent = NO_IMAGE_PLACEHOLDER;
  placeholder.setAttribute('aria-label', 'Imagen no disponible');
  placeholder.setAttribute('role', 'img');

  // Reemplazar la imagen rota por el placeholder en el DOM
  img.parentNode?.replaceChild(placeholder, img);
}

/**
 * Crea un elemento de imagen seguro con fallback de error controlado.
 *
 * CORRECCIONES v4:
 *  - PERF-03: handler onerror → reemplaza imagen rota por placeholder div.
 *  - PERF-04: width/height declarados → reserva espacio, elimina CLS.
 *  - PERF-05: fetchpriority="high" en las primeras cards → mejora LCP.
 *
 * Si src no es una URL válida (http/https), devuelve directamente
 * el placeholder div sin intentar crear un <img>.
 *
 * @param {string}  src      - URL de la imagen.
 * @param {string}  alt      - Texto alternativo.
 * @param {string}  cls      - Clase CSS de la imagen.
 * @param {boolean} [priority=false] - Si true, añade fetchpriority="high".
 * @returns {HTMLElement} <img> o <div> placeholder.
 */
function _safeImage(src, alt, cls, priority = false) {
  const isValidSrc = typeof src === 'string' && /^https?:\/\//i.test(src);

  if (!isValidSrc) {
    const placeholder = _el('div', `${cls} vh-card__cover-placeholder`);
    placeholder.textContent = NO_IMAGE_PLACEHOLDER;
    placeholder.setAttribute('role', 'img');
    placeholder.setAttribute('aria-label', alt || 'Sin imagen');
    return placeholder;
  }

  const img = _el('img', cls);
  img.setAttribute('src',     src);
  img.setAttribute('alt',     alt);
  img.setAttribute('loading', priority ? 'eager' : 'lazy');
  img.setAttribute('decoding', 'async');

  // PERF-04: reservar espacio para evitar CLS
  img.setAttribute('width',  String(COVER_WIDTH));
  img.setAttribute('height', String(COVER_HEIGHT));

  // PERF-05: prioridad alta solo en primeras cards (above the fold)
  if (priority) {
    img.setAttribute('fetchpriority', 'high');
  }

  // PERF-03: fallback controlado si la imagen falla
  img.addEventListener('error', () => _applyImgPlaceholder(img), { once: true });

  return img;
}

/**
 * Construye un <a> con el título de la VN que enlaza a novel-details.html.
 *
 * SEGURIDAD: usa textContent (nunca innerHTML) para el texto del título.
 * El vnId ya viene validado del servicio VNDB (/^v\d+$/).
 *
 * @param {string} vnId
 * @param {string} title
 * @returns {HTMLAnchorElement}
 */
function _buildTitleLink(vnId, title) {
  const link = document.createElement('a');
  link.href        = `novel-details.html?id=${encodeURIComponent(vnId)}`;
  link.className   = 'vh-card__title-link';
  link.setAttribute('aria-label', `Ver detalles de ${title}`);
  link.textContent = title;
  return link;
}


// ─────────────────────────────────────────────
// 1. BADGE DE ESTADO
// ─────────────────────────────────────────────

function createStatusBadge(status) {
  const meta     = VN_STATUS_META[status];
  const badgeCls = STATUS_BADGE_CLASS[status];

  if (!meta || !badgeCls) return _elText('span', 'vh-badge', '—');

  const badge = _el('span', `vh-badge ${badgeCls}`, { 'aria-label': meta.label });
  badge.appendChild(_elText('span', '', meta.icon, { 'aria-hidden': 'true' }));
  badge.appendChild(_elText('span', '', meta.label));
  return badge;
}


// ─────────────────────────────────────────────
// 2. CARD DE BÚSQUEDA
// ─────────────────────────────────────────────

/**
 * Crea una card para el grid de resultados de búsqueda.
 *
 * CAMBIO v4: _buildCoverSection recibe el índice para
 * aplicar fetchpriority="high" a las primeras 3 cards.
 *
 * @param {import('./vndb-service.js').VnEntry} vnEntry
 * @param {{isSaved?: boolean, savedStatus?: string|null, index?: number}} options
 * @returns {HTMLElement}
 */
function createVnCard(vnEntry, { isSaved = false, savedStatus = null, index = 0 } = {}) {
  const card = _el('article', 'vh-card', {
    'role':       'listitem',
    'data-vn-id': vnEntry.id,
  });
  card.classList.add('vh-card--linkable');
  card.style.animationDelay = `${index * 40}ms`;

  // Pasar index para que las primeras 3 cards tengan fetchpriority="high"
  card.appendChild(_buildCoverSection(vnEntry, index));

  const body = _el('div', 'vh-card__body');

  const titleEl = _el('h3', 'vh-card__title');
  titleEl.appendChild(_buildTitleLink(vnEntry.id, vnEntry.title));
  body.appendChild(titleEl);

  body.appendChild(_buildMetaRow(vnEntry));
  body.appendChild(_buildTagsRow(vnEntry.tags));
  card.appendChild(body);

  const footer = _el('div', 'vh-card__footer');
  footer.appendChild(_buildAddButton(vnEntry, isSaved, savedStatus));
  card.appendChild(footer);

  card.addEventListener('click', (e) => {
    if (e.target.closest('[data-action]')) return;
    window.location.href = `novel-details.html?id=${encodeURIComponent(vnEntry.id)}`;
  });

  return card;
}

/**
 * Construye la sección de portada de una card.
 *
 * @param {object} vnEntry
 * @param {number} [cardIndex=0] - Índice de la card en el grid.
 *   Las primeras 3 (index < 3) reciben fetchpriority="high".
 * @returns {HTMLElement}
 */
function _buildCoverSection(vnEntry, cardIndex = 0) {
  const wrapper  = _el('div', 'vh-card__cover-wrapper');
  const imgCls   = `vh-card__cover${vnEntry.imageIsAdult ? ' vh-card__cover--adult' : ''}`;
  const priority = cardIndex < 3;

  wrapper.appendChild(_safeImage(vnEntry.imageUrl, vnEntry.title, imgCls, priority));

  if (vnEntry.imageIsAdult) {
    wrapper.appendChild(
      _elText('span', 'vh-card__adult-badge', '18+', { 'aria-label': 'Contenido adulto' })
    );
  }
  return wrapper;
}

function _buildMetaRow(vnEntry) {
  const meta = _el('div', 'vh-card__meta');

  if (vnEntry.rating && vnEntry.rating !== 'N/A') {
    meta.appendChild(_elText('span', 'vh-card__rating', vnEntry.rating));
  }

  if (vnEntry.released && vnEntry.released !== 'Fecha desconocida') {
    const year = vnEntry.released.match(/\d{4}/)?.[0] ?? '';
    if (year) meta.appendChild(_elText('span', 'vh-card__year', year));
  }

  return meta;
}

function _buildTagsRow(tags) {
  const row = _el('div', 'vh-card__tags');
  (tags ?? []).slice(0, 3).forEach(tag => {
    row.appendChild(_elText('span', 'vh-card__tag', tag));
  });
  return row;
}

function _buildAddButton(vnEntry, isSaved, savedStatus) {
  const btn = _el('button',
    isSaved ? 'vh-card__add-btn vh-card__add-btn--saved' : 'vh-card__add-btn',
    {
      'data-action': 'open-status-menu',
      'data-vn-id':  vnEntry.id,
      'aria-label':  isSaved
        ? `Cambiar estado de ${vnEntry.title}`
        : `Añadir ${vnEntry.title} a biblioteca`,
    }
  );

  if (isSaved && savedStatus) {
    const meta = VN_STATUS_META[savedStatus];
    btn.appendChild(_elText('span', '', meta?.icon ?? '✓', { 'aria-hidden': 'true' }));
    btn.appendChild(_elText('span', '', meta?.label ?? 'Guardada'));
  } else {
    btn.appendChild(_elText('span', '', '+', { 'aria-hidden': 'true' }));
    btn.appendChild(_elText('span', '', 'Añadir'));
  }

  return btn;
}


// ─────────────────────────────────────────────
// 3. CARD DE BIBLIOTECA
// ─────────────────────────────────────────────

/**
 * Crea una card para los paneles de la biblioteca personal.
 *
 * @param {import('./vndb-service.js').VnEntry} vnEntry
 * @param {import('./library-store.js').LibraryEntry} libraryEntry
 * @param {number} index - Para animación escalonada y fetchpriority.
 * @returns {HTMLElement}
 */
function createLibraryCard(vnEntry, libraryEntry, index = 0) {
  const card = _el('article', 'vh-card', {
    'role':        'listitem',
    'data-vn-id':  libraryEntry.vnId,
    'data-status': libraryEntry.status,
  });
  card.classList.add('vh-card--linkable');
  card.style.animationDelay = `${index * 35}ms`;

  // Imagen con badge de estado — index para fetchpriority
  const coverSection       = _buildCoverSection(vnEntry, index);
  const statusBadgeWrapper = _el('div', 'vh-card__status-badge');
  statusBadgeWrapper.appendChild(createStatusBadge(libraryEntry.status));
  coverSection.appendChild(statusBadgeWrapper);
  card.appendChild(coverSection);

  const body = _el('div', 'vh-card__body');

  const titleEl = _el('h3', 'vh-card__title');
  titleEl.appendChild(_buildTitleLink(vnEntry.id, vnEntry.title));
  body.appendChild(titleEl);

  body.appendChild(_buildMetaRow(vnEntry));

  // Preview de bitácora (PLAYING)
  if (libraryEntry.status === VN_STATUS.PLAYING && libraryEntry.log) {
    const logPreview = _el('p', 'vh-card__log-preview');
    const truncated  = libraryEntry.log.slice(0, 80) + (libraryEntry.log.length > 80 ? '…' : '');
    logPreview.textContent = truncated;
    body.appendChild(logPreview);
  }

  // Preview de comentario (DROPPED)
  if (libraryEntry.status === VN_STATUS.DROPPED && libraryEntry.comment) {
    const commentPreview = _el('p', 'vh-card__log-preview');
    const truncated      = libraryEntry.comment.slice(0, 80) + (libraryEntry.comment.length > 80 ? '…' : '');
    commentPreview.textContent = truncated;
    body.appendChild(commentPreview);
  }

  card.appendChild(body);

  if (libraryEntry.status === VN_STATUS.FINISHED && libraryEntry.score) {
    card.appendChild(_buildScoreSection(libraryEntry.score));
  }

  card.appendChild(_buildLibraryFooter(vnEntry, libraryEntry));

  card.addEventListener('click', (e) => {
    if (e.target.closest('[data-action]')) return;
    window.location.href = `novel-details.html?id=${encodeURIComponent(vnEntry.id)}`;
  });

  return card;
}

function _buildScoreSection(scoreData) {
  const threshold = getScoreThreshold(scoreData.finalScore);
  const section   = _el('div', 'vh-card__score');

  const value = _elText('span', 'vh-card__score-value', _fmtScore(scoreData.finalScore));
  if (threshold?.css) value.classList.add(threshold.css);

  const label = _elText('span', 'vh-card__score-label', scoreData.finalScoreLabel);

  section.appendChild(value);
  section.appendChild(label);
  return section;
}

function _buildLibraryFooter(vnEntry, libraryEntry) {
  const footer = _el('div', 'vh-card__footer');

  const editBtn = _buildEditButton(vnEntry, libraryEntry);
  if (editBtn) footer.appendChild(editBtn);

  const changeBtn = _el('button', 'vh-card__change-btn', {
    'data-action': 'open-status-menu',
    'data-vn-id':  libraryEntry.vnId,
    'aria-label':  `Cambiar estado de ${vnEntry.title}`,
  });
  changeBtn.appendChild(_elText('span', '', '⇄', { 'aria-hidden': 'true' }));
  changeBtn.appendChild(_elText('span', '', 'Mover'));
  footer.appendChild(changeBtn);

  const removeBtn = _el('button', 'vh-card__remove-btn', {
    'data-action': 'remove-vn',
    'data-vn-id':  libraryEntry.vnId,
    'aria-label':  `Eliminar ${vnEntry.title} de la biblioteca`,
    'title':       'Eliminar de biblioteca',
  });
  removeBtn.textContent = '🗑';
  footer.appendChild(removeBtn);

  return footer;
}

function _buildEditButton(vnEntry, libraryEntry) {
  const configs = {
    [VN_STATUS.PLAYING]: {
      action: 'edit-log',
      icon:   '📝',
      label:  libraryEntry.log ? 'Ver bitácora' : 'Escribir bitácora',
    },
    [VN_STATUS.FINISHED]: {
      action: 'edit-review',
      icon:   '⭐',
      label:  libraryEntry.score ? 'Editar reseña' : 'Clasificar',
    },
    [VN_STATUS.DROPPED]: {
      action: 'edit-comment',
      icon:   '💬',
      label:  libraryEntry.comment ? 'Editar comentario' : 'Añadir comentario',
    },
  };

  const config = configs[libraryEntry.status];
  if (!config) return null;

  const btn = _el('button', 'vh-card__edit-btn', {
    'data-action': config.action,
    'data-vn-id':  libraryEntry.vnId,
    'aria-label':  `${config.label} de ${vnEntry.title}`,
    'title':       config.label,
  });

  btn.appendChild(_elText('span', '', config.icon, { 'aria-hidden': 'true' }));
  btn.appendChild(_elText('span', '', config.label));
  return btn;
}


// ─────────────────────────────────────────────
// 4. ESTADOS DE UI
// ─────────────────────────────────────────────

function createLoadingState(message = 'Buscando en VNDB…') {
  const el = _el('div', 'vh-search-state__loading', { 'aria-label': message });
  el.textContent = message;
  return el;
}

function createEmptySearchState(query) {
  const el = _el('p', 'vh-search-state__empty');
  el.textContent = `No se encontraron resultados para "${query}"`;
  return el;
}

function createErrorState(message) {
  const el = _el('div', 'vh-search-state__error', { 'role': 'alert' });
  el.textContent = String(message ?? 'Ocurrió un error. Inténtalo de nuevo.');
  return el;
}


// ─────────────────────────────────────────────
// 5. CONTADORES Y ESTADÍSTICAS
// ─────────────────────────────────────────────

function updateTabCounts(stats) {
  const allEl = document.getElementById('count-all');
  if (allEl) allEl.textContent = String(stats.total);

  Object.values(VN_STATUS).forEach(status => {
    const el = document.getElementById(`count-${status}`);
    if (el) el.textContent = String(stats.byStatus[status] ?? 0);
  });
}

function updateLibraryStats(stats) {
  const container = document.getElementById('libraryStats');
  if (!container) return;

  while (container.firstChild) container.removeChild(container.firstChild);
  if (stats.total === 0) return;

  const totalPill = _el('span', 'vh-stat-pill');
  totalPill.textContent = `📚 ${stats.total} total`;
  container.appendChild(totalPill);

  Object.values(VN_STATUS).forEach(status => {
    const count = stats.byStatus[status] ?? 0;
    if (count === 0) return;
    const meta = VN_STATUS_META[status];
    const pill = _el('span', 'vh-stat-pill');
    pill.textContent = `${meta.icon} ${count}`;
    pill.title       = `${count} ${meta.label}`;
    container.appendChild(pill);
  });
}


// ─────────────────────────────────────────────
// EXPORTACIÓN
// ─────────────────────────────────────────────
export {
  createVnCard,
  createLibraryCard,
  createStatusBadge,
  createLoadingState,
  createEmptySearchState,
  createErrorState,
  updateTabCounts,
  updateLibraryStats,
};