'use strict';

/**
 * @file js/novel-details.js
 * @description Controlador de la página de detalles de una Visual Novel.
 *              Orquesta: carga de datos de VNDB, render del hero,
 *              sinopsis, ficha técnica, tags, gestión de estado
 *              y carrusel de similares.
 *
 * FLUJO DE ARRANQUE:
 *  1. Leer ?id=vXX de la URL
 *  2. init() → LibraryStore + ThemeManager + AuthController
 *  3. Cargar VN desde VNDB (getVnById)
 *  4. Renderizar Hero, Sinopsis, Ficha, Tags
 *  5. Calcular similares por tags compartidos (searchVns con tag del top-1)
 *  6. Bindear eventos: status buttons, expand synopsis, carrusel
 *
 * CAMBIOS v2:
 *  - _renderHero(): el fondo (#heroBg) ahora empieza con opacity:0
 *    (definido en CSS) y recibe la clase .vnd-hero__bg--loaded después
 *    de asignar background-image, activando un fade-in suave de 0.6s.
 *    Elimina el cuadro negro vacío visible mientras carga la imagen.
 *
 * SRP: Este módulo solo gestiona la página de detalles.
 *      Delega scoring en score-engine, persistencia en library-store,
 *      y auth en auth-controller.
 *
 * SEGURIDAD: Todos los textos provenientes de la API se insertan
 *            con textContent (nunca innerHTML sin escapar).
 */

import * as VndbService     from './vndb-service.js';
import * as LibraryStore    from './library-store.js';
import * as AuthController  from './auth-controller.js';
import * as FirebaseService from './firebase-service.js';
import * as ModalReview     from './modal-review.js';
import * as ModalLog        from './modal-log.js';
import * as ModalComment    from './modal-comment.js';
import { ThemeManager }     from './app-init.js';
import {
  STORAGE_KEY_THEME,
  DEFAULT_THEME,
  TOAST_DURATION_MS,
  VN_STATUS,
  VN_STATUS_META,
} from './constants.js';
import { escapeHtml } from './utils.js';
import { translateSynopsis } from './translation-service.js';


// ─────────────────────────────────────────────
// 1. ESTADO DE LA PÁGINA
// ─────────────────────────────────────────────

/** @type {string|null} ID de la VN actual (ej: 'v17') */
let _vnId = null;

/** @type {import('./vndb-service.js').VnEntry|null} */
let _vnData = null;

/** @type {number} Posición actual del carrusel (índice) */
let _carouselIndex = 0;

/** @type {import('./vndb-service.js').VnEntry[]} */
let _similarVns = [];

/** @type {number} Timer del toast */
let _toastTimer = null;

/** @type {boolean} Estado de la sinopsis (expandida o no) */
let _synopsisExpanded = false;
let _synopsisEs = null;
let _showOriginal = true;

/** Cantidad de chars visibles antes de "Leer más" */
const SYNOPSIS_PREVIEW_LEN = 400;

/** Cantidad de cards visibles a la vez en el carrusel */
const CAROUSEL_VISIBLE = 3;


// ─────────────────────────────────────────────
// 2. REFERENCIAS DOM
// ─────────────────────────────────────────────

const _dom = {};

function _cacheDOM() {
  const ids = [
    'heroBg', 'heroCover', 'coverSkeleton', 'adultBadge',
    'heroTitle', 'heroMeta', 'heroSkeleton',
    'metaRating', 'metaYear', 'metaDuration',
    'breadcrumbTitle',
    'statusPanel', 'btnRemoveLib',
    'detailState', 'detailGrid',
    'synopsisText', 'btnExpandSynopsis', 'btnToggleLang',
    'fichaList',
    'tagsSection', 'tagsList',
    'similarSection', 'similarCarousel',
    'carouselPrev', 'carouselNext',
    'toast', 'themeToggle',
    'authContainer',
  ];

  ids.forEach(id => {
    _dom[id] = document.getElementById(id);
    if (!_dom[id]) console.warn(`[Details] #${id} no encontrado.`);
  });

  // Colección de botones de estado
  _dom.statusBtns = document.querySelectorAll('.vnd-status-btn');
}


// ─────────────────────────────────────────────
// 3. LECTURA DE PARÁMETROS DE URL
// ─────────────────────────────────────────────

/**
 * Lee el parámetro ?id=vXX de la URL actual.
 * Valida el formato antes de retornarlo.
 *
 * @returns {string|null} ID válido o null si inválido/ausente.
 */
function _readVnIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const id     = params.get('id') ?? '';
  return /^v\d+$/.test(id) ? id : null;
}


// ─────────────────────────────────────────────
// 4. RENDER DEL HERO
// ─────────────────────────────────────────────

/**
 * Renderiza la sección Hero con la imagen de fondo, portada y metadatos.
 *
 * FIX v2 — Fondo negro:
 *  El elemento #heroBg empieza con opacity:0 en CSS.
 *  Después de asignar background-image, se añade la clase
 *  .vnd-hero__bg--loaded (opacity:1 + transition:0.6s) usando
 *  requestAnimationFrame para garantizar que el browser ya registró
 *  el estilo antes de activar la transición.
 *  Si no hay imagen, el hero muestra el color de fallback definido en CSS:
 *    .vnd-hero { background-color: var(--vh-bg-surface); }
 *
 * @param {import('./vndb-service.js').VnEntry} vn
 */
function _renderHero(vn) {
  // ── Fondo blur con carga diferida + timeout ──
  if (_dom.heroBg) {
    const urlIsValid = typeof vn.imageUrl === 'string' && /^https:\/\//i.test(vn.imageUrl);
    if (urlIsValid) {
      const loader = new Image();
      let settled = false;
      const TIMEOUT_MS = 3000;
      const onDone = (ok) => {
        if (settled) return;
        settled = true;
        if (ok) {
          _dom.heroBg.style.backgroundImage = `url('${vn.imageUrl}')`;
          requestAnimationFrame(() => {
            _dom.heroBg.classList.add('vnd-hero__bg--loaded');
          });
        } else {
          _dom.heroBg.style.backgroundImage = '';
          _dom.heroBg.classList.add('vnd-hero__bg--loaded'); // revela fallback de CSS
        }
      };
      const timer = setTimeout(() => onDone(false), TIMEOUT_MS);
      loader.onload  = () => { clearTimeout(timer); onDone(true); };
      loader.onerror = () => { clearTimeout(timer); onDone(false); };
      loader.src     = vn.imageUrl;
    } else {
      _dom.heroBg.style.backgroundImage = '';
      _dom.heroBg.classList.add('vnd-hero__bg--loaded');
    }
  }

  // ── Portada principal ──
  if (vn.imageUrl && _dom.heroCover) {
    const COVER_TIMEOUT_MS = 2000;
    let coverSettled = false;
    const coverTimer = setTimeout(() => {
      if (coverSettled) return;
      coverSettled = true;
      if (_dom.coverSkeleton) {
        _dom.coverSkeleton.textContent = '📖';
        _dom.coverSkeleton.classList.add('vnd-hero__cover-placeholder');
      }
    }, COVER_TIMEOUT_MS);

    _dom.heroCover.setAttribute('src', vn.imageUrl);
    _dom.heroCover.setAttribute('alt', vn.title);

    _dom.heroCover.onload = () => {
      if (coverSettled) return;
      coverSettled = true;
      clearTimeout(coverTimer);
      if (_dom.coverSkeleton) _dom.coverSkeleton.hidden = true;
      _dom.heroCover.hidden = false;
    };

    _dom.heroCover.onerror = () => {
      if (coverSettled) return;
      coverSettled = true;
      clearTimeout(coverTimer);
      if (_dom.coverSkeleton) {
        _dom.coverSkeleton.textContent = '📖';
        _dom.coverSkeleton.classList.add('vnd-hero__cover-placeholder');
      }
    };
  } else {
    // Sin imagen: mostramos placeholder
    if (_dom.coverSkeleton) {
      _dom.coverSkeleton.textContent = '📖';
      _dom.coverSkeleton.classList.add('vnd-hero__cover-placeholder');
    }
  }

  // Badge adulto
  if (_dom.adultBadge) _dom.adultBadge.hidden = !vn.imageIsAdult;

  // ── Título y meta ──
  if (_dom.heroSkeleton) _dom.heroSkeleton.hidden = true;

  if (_dom.heroTitle) {
    _dom.heroTitle.textContent = vn.title;
    _dom.heroTitle.hidden = false;
  }

  if (_dom.breadcrumbTitle) _dom.breadcrumbTitle.textContent = vn.title;
  document.title = `${vn.title} — VN-Hub`;

  // Píldoras de metadatos
  if (_dom.metaRating && vn.rating && vn.rating !== 'N/A') {
    _dom.metaRating.textContent = `⭐ ${vn.rating}`;
    _dom.metaRating.hidden = false;
  }

  if (_dom.metaYear && vn.released && vn.released !== 'Fecha desconocida') {
    const year = vn.released.match(/\d{4}/)?.[0] ?? '';
    if (year) {
      _dom.metaYear.textContent = `📅 ${year}`;
    }
  }

  if (_dom.metaDuration && vn.duration && vn.duration !== 'Desconocida') {
    _dom.metaDuration.textContent = `⏱ ${vn.duration}`;
  }

  if (_dom.heroMeta) _dom.heroMeta.hidden = false;

  // Panel de estado
  if (_dom.statusPanel) {
    _dom.statusPanel.hidden = false;
    _updateStatusPanel();
  }
}


// ─────────────────────────────────────────────
// 5. RENDER SINOPSIS
// ─────────────────────────────────────────────

/**
 * Renderiza la sinopsis con soporte para "Leer más".
 * El texto se inserta con textContent (seguro contra XSS).
 * El BBCode ya viene limpiado desde vndb-service._transformVn().
 *
 * @param {string} description
 */
function _renderSynopsis(description) {
  if (!_dom.synopsisText) return;

  const baseText = description?.trim() ?? '';
  const esText   = _synopsisEs?.text?.trim?.() ?? '';
  const useEs    = esText && !_showOriginal;
  const text     = useEs ? esText : baseText;

  if (!text) {
    _dom.synopsisText.textContent = 'Sinopsis no disponible.';
    return;
  }

  const needsExpand = text.length > SYNOPSIS_PREVIEW_LEN;

  // Mostrar preview o texto completo
  _dom.synopsisText.textContent = needsExpand && !_synopsisExpanded
    ? `${text.slice(0, SYNOPSIS_PREVIEW_LEN)}…`
    : text;

  // Botón "Leer más"
  if (_dom.btnExpandSynopsis) {
    _dom.btnExpandSynopsis.hidden   = !needsExpand;
    _dom.btnExpandSynopsis.textContent = _synopsisExpanded ? 'Leer menos ↑' : 'Leer más ↓';
  }

  if (_dom.btnToggleLang) {
    _dom.btnToggleLang.hidden = !esText;
    _dom.btnToggleLang.textContent = _showOriginal ? 'Ver traducción' : 'Ver original';
  }
}


// ─────────────────────────────────────────────
// 6. RENDER FICHA TÉCNICA
// ─────────────────────────────────────────────

/**
 * Construye la ficha técnica usando un <dl> semántico.
 * Cada campo es un par dt/dd creado con textContent (sin XSS).
 *
 * @param {import('./vndb-service.js').VnEntry} vn
 */
function _renderFicha(vn) {
  const list = _dom.fichaList;
  if (!list) return;

  const fields = [
    { label: 'Desarrollador',        value: vn.developers?.join(', ') || 'Desconocido'                 },
    { label: 'Fecha de lanzamiento', value: vn.released  || 'Desconocida'                              },
    { label: 'Duración estimada',    value: vn.duration  || 'Desconocida'                              },
    { label: 'Votos en VNDB',        value: vn.votecount ? vn.votecount.toLocaleString('es-AR') : 'N/A' },
    { label: 'Rating VNDB',          value: vn.rating !== 'N/A' ? `${vn.rating} / 10` : 'Sin rating'  },
    { label: 'ID VNDB',              value: vn.id                                                       },
  ];

  const fragment = document.createDocumentFragment();

  fields.forEach(({ label, value }) => {
    if (!value) return;

    const dt = document.createElement('dt');
    dt.className   = 'vnd-ficha__term';
    dt.textContent = label;

    const dd = document.createElement('dd');
    dd.className   = 'vnd-ficha__def';
    dd.textContent = value;

    fragment.appendChild(dt);
    fragment.appendChild(dd);
  });

  list.appendChild(fragment);
}


// ─────────────────────────────────────────────
// 7. RENDER TAGS
// ─────────────────────────────────────────────

/**
 * Renderiza las etiquetas como pills interactivos.
 * Al hacer click en un tag, navega a la búsqueda con ese término.
 *
 * @param {string[]} tags
 */
function _renderTags(tags) {
  if (!tags?.length || !_dom.tagsList || !_dom.tagsSection) return;

  _dom.tagsSection.hidden = false;

  const fragment = document.createDocumentFragment();

  tags.forEach(tag => {
    const pill = document.createElement('button');
    pill.className = 'vnd-tag-pill';
    pill.setAttribute('role',  'listitem');
    pill.setAttribute('title', `Buscar "${tag}"`);
    pill.textContent = tag; // textContent: seguro contra XSS

    pill.addEventListener('click', () => {
      window.location.href = `index.html?search=${encodeURIComponent(tag)}`;
    });

    fragment.appendChild(pill);
  });

  _dom.tagsList.appendChild(fragment);
}


// ─────────────────────────────────────────────
// 8. RENDER PANEL DE ESTADO
// ─────────────────────────────────────────────

/**
 * Actualiza el panel de estado según la entrada actual en la biblioteca.
 * Marca el botón activo con aria-pressed y aplica clase visual.
 */
function _updateStatusPanel() {
  const entry = LibraryStore.getEntry(_vnId);

  _dom.statusBtns.forEach(btn => {
    const isActive = entry?.status === btn.dataset.status;
    btn.setAttribute('aria-pressed', String(isActive));
    btn.classList.toggle('vnd-status-btn--active', isActive);
  });

  if (_dom.btnRemoveLib) {
    _dom.btnRemoveLib.hidden = !entry;
  }
}


// ─────────────────────────────────────────────
// 9. CARRUSEL DE SIMILARES
// ─────────────────────────────────────────────

/**
 * Carga VNs similares a la actual buscando por el tag principal.
 * Filtra la VN actual de los resultados.
 *
 * @param {import('./vndb-service.js').VnEntry} vn
 */
async function _loadSimilarVns(vn) {
  const tags = (vn.tags ?? []).slice(0, 3);
  if (tags.length === 0 || !_dom.similarSection || !_dom.similarCarousel) return;
  try {
    const queries = await Promise.all(
      tags.map(t => VndbService.searchVns(t, { page: 1 }).catch(() => ({ items: [] })))
    );
    const merged = [];
    const seen = new Set();
    queries.forEach(q => {
      (q.items ?? []).forEach(item => {
        if (item.id === vn.id) return;
        if (seen.has(item.id)) return;
        seen.add(item.id);
        merged.push(item);
      });
    });
    merged.sort((a, b) => {
      const matchA = tags.filter(t => (a.tags ?? []).includes(t)).length;
      const matchB = tags.filter(t => (b.tags ?? []).includes(t)).length;
      const ratingA = a.rating === 'N/A' ? 0 : parseFloat(a.rating);
      const ratingB = b.rating === 'N/A' ? 0 : parseFloat(b.rating);
      if (matchB !== matchA) return matchB - matchA;
      return ratingB - ratingA;
    });
    _similarVns = merged.slice(0, 12);
    if (_similarVns.length === 0) return;
    _dom.similarSection.hidden = false;
    _carouselIndex = 0;
    _renderCarousel();
  } catch (err) {
    console.warn('[Details] No se pudieron cargar similares:', err);
  }
}

/**
 * Renderiza las cards del carrusel a partir de _carouselIndex.
 * Muestra CAROUSEL_VISIBLE cards a la vez.
 */
function _renderCarousel() {
  const carousel = _dom.similarCarousel;
  if (!carousel) return;

  while (carousel.firstChild) carousel.removeChild(carousel.firstChild);

  const visible  = _similarVns.slice(_carouselIndex, _carouselIndex + CAROUSEL_VISIBLE);
  const fragment = document.createDocumentFragment();

  visible.forEach(vn => {
    fragment.appendChild(_buildCarouselCard(vn));
  });

  carousel.appendChild(fragment);

  // Habilitar/deshabilitar botones de navegación
  if (_dom.carouselPrev) _dom.carouselPrev.disabled = _carouselIndex === 0;
  if (_dom.carouselNext) _dom.carouselNext.disabled = _carouselIndex + CAROUSEL_VISIBLE >= _similarVns.length;
}

/**
 * Construye una mini-card para el carrusel de similares.
 * El título es un link a la página de detalles de esa VN.
 *
 * @param {import('./vndb-service.js').VnEntry} vn
 * @returns {HTMLElement}
 */
function _buildCarouselCard(vn) {
  const card = document.createElement('article');
  card.className = 'vnd-carousel-card';
  card.setAttribute('role', 'listitem');

  const link = document.createElement('a');
  link.href      = `novel-details.html?id=${encodeURIComponent(vn.id)}`;
  link.className = 'vnd-carousel-card__link';
  link.setAttribute('aria-label', `Ver detalles de ${vn.title}`);

  // Portada
  if (vn.imageUrl && /^https:\/\//i.test(vn.imageUrl)) {
    const img = document.createElement('img');
    img.className = 'vnd-carousel-card__cover';
    img.setAttribute('src',      vn.imageUrl);
    img.setAttribute('alt',      vn.title);
    img.setAttribute('loading',  'lazy');
    img.setAttribute('decoding', 'async');

    if (vn.imageIsAdult) img.classList.add('vnd-carousel-card__cover--adult');
    link.appendChild(img);
  } else {
    const placeholder = document.createElement('div');
    placeholder.className   = 'vnd-carousel-card__placeholder';
    placeholder.textContent = '📖';
    placeholder.setAttribute('aria-hidden', 'true');
    link.appendChild(placeholder);
  }

  // Info
  const info = document.createElement('div');
  info.className = 'vnd-carousel-card__info';

  const title = document.createElement('p');
  title.className   = 'vnd-carousel-card__title';
  title.textContent = vn.title; // textContent: seguro

  info.appendChild(title);

  if (vn.rating && vn.rating !== 'N/A') {
    const rating = document.createElement('p');
    rating.className   = 'vnd-carousel-card__rating';
    rating.textContent = `⭐ ${vn.rating}`;
    info.appendChild(rating);
  }

  link.appendChild(info);
  card.appendChild(link);
  return card;
}


// ─────────────────────────────────────────────
// 10. ESTADOS DE LA UI (carga / error)
// ─────────────────────────────────────────────

/**
 * Muestra el estado de carga en el área principal.
 */
function _showLoading() {
  const el = _dom.detailState;
  if (!el) return;

  el.innerHTML = '';
  const skeleton = document.createElement('div');
  skeleton.className = 'vnd-loading';

  for (let i = 0; i < 4; i++) {
    const line = document.createElement('div');
    line.className     = 'vh-skeleton vh-skeleton--line';
    line.style.cssText = `width:${[80, 60, 90, 50][i]}%;height:1rem;margin-bottom:.75rem;`;
    skeleton.appendChild(line);
  }

  el.appendChild(skeleton);
}

/**
 * Muestra un estado de error con botón de reintento.
 * @param {string} message
 */
function _showError(message) {
  const el = _dom.detailState;
  if (!el) return;

  el.innerHTML = '';

  const wrapper = document.createElement('div');
  wrapper.className = 'vnd-error';
  wrapper.setAttribute('role', 'alert');

  const icon = document.createElement('p');
  icon.className   = 'vnd-error__icon';
  icon.textContent = '⚠';
  icon.setAttribute('aria-hidden', 'true');

  const msg = document.createElement('p');
  msg.className   = 'vnd-error__msg';
  msg.textContent = message;

  const retryBtn = document.createElement('button');
  retryBtn.className   = 'vh-btn vh-btn--primary';
  retryBtn.textContent = '↺ Reintentar';
  retryBtn.addEventListener('click', _loadVn);

  const backBtn = document.createElement('a');
  backBtn.href        = 'index.html';
  backBtn.className   = 'vh-btn vh-btn--ghost';
  backBtn.textContent = '← Volver al inicio';

  wrapper.appendChild(icon);
  wrapper.appendChild(msg);
  wrapper.appendChild(retryBtn);
  wrapper.appendChild(backBtn);
  el.appendChild(wrapper);
}

/**
 * Limpia el área de estados.
 */
function _clearState() {
  if (_dom.detailState) _dom.detailState.innerHTML = '';
}


// ─────────────────────────────────────────────
// 11. TOAST
// ─────────────────────────────────────────────

/**
 * Muestra una notificación temporal tipo toast.
 * @param {string} message
 * @param {'success'|'error'|'info'} type
 */
function _showToast(message, type = 'info') {
  const toast = _dom.toast;
  if (!toast) return;

  const iconEl = toast.querySelector('.vh-toast__icon');
  const msgEl  = toast.querySelector('.vh-toast__message');

  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  if (iconEl) iconEl.textContent = icons[type] ?? 'ℹ';
  if (msgEl)  msgEl.textContent  = String(message);

  toast.className = `vh-toast vh-toast--${type}`;
  toast.hidden    = false;

  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    if (_dom.toast) _dom.toast.hidden = true;
  }, TOAST_DURATION_MS);
}


// ─────────────────────────────────────────────
// 12. CARGA PRINCIPAL DE DATOS
// ─────────────────────────────────────────────

/**
 * Carga los datos de la VN desde VNDB y orquesta todos los renders.
 * Ciclo completo: loading → datos → render → similares.
 */
async function _loadVn() {
  if (!_vnId) {
    _showError('ID de Visual Novel no válido. Verifica la URL.');
    return;
  }

  _showLoading();

  try {
    const vn = await VndbService.getVnById(_vnId);

    if (!vn) {
      _showError(`No se encontró la Visual Novel con ID "${_vnId}" en VNDB.`);
      return;
    }

    _vnData = vn;
    _clearState();

    // Renderizar secciones en orden
    _renderHero(vn);
    // Traducir sinopsis al español via Cloudflare Worker (degradación graceful)
    try {
      const translated = await translateSynopsis(_vnId, vn.description);
      _synopsisEs = translated ? { text: translated } : null;
    } catch {
      _synopsisEs = null;
    }
    _renderSynopsis(vn.description);
    _renderFicha(vn);
    _renderTags(vn.tags);

    // Mostrar el grid principal
    if (_dom.detailGrid) _dom.detailGrid.hidden = false;

    // Cargar similares en paralelo (no bloquea el render principal)
    _loadSimilarVns(vn);

  } catch (err) {
    console.error('[Details] Error al cargar VN:', err);
    _showError('No se pudo conectar con VNDB. Verifica tu conexión e inténtalo de nuevo.');
  }
}


// ─────────────────────────────────────────────
// 13. MANEJADORES DE EVENTOS
// ─────────────────────────────────────────────

/**
 * Maneja el click en los botones de estado del panel de gestión.
 * Aplica el estado y abre el modal correspondiente si aplica.
 *
 * @param {string} newStatus
 */
function _handleStatusClick(newStatus) {
  if (!_vnId || !_vnData) return;

  const existingEntry = LibraryStore.getEntry(_vnId);
  const meta          = VN_STATUS_META[newStatus];

  if (!existingEntry) {
    LibraryStore.addVn(_vnId, newStatus);
    _showToast(`${meta.icon} Añadida como "${meta.label}"`, 'success');
  } else if (existingEntry.status !== newStatus) {
    const oldMeta = VN_STATUS_META[existingEntry.status];
    LibraryStore.updateStatus(_vnId, newStatus);
    _showToast(`${meta.icon} Movida de "${oldMeta.label}" → "${meta.label}"`, 'info');
  }

  _updateStatusPanel();
  _openModalForStatus(newStatus);
}

/**
 * Abre el modal correspondiente al estado seleccionado.
 * @param {string} status
 */
function _openModalForStatus(status) {
  if (!_vnId || !_vnData) return;

  switch (status) {
    case VN_STATUS.FINISHED:
      ModalReview.open(_vnId, _vnData.title, _vnData.imageUrl ?? '');
      break;
    case VN_STATUS.PLAYING:
      ModalLog.open(_vnId, _vnData.title);
      break;
    case VN_STATUS.DROPPED:
      ModalComment.open(_vnId, _vnData.title);
      break;
    default:
      break;
  }
}

/**
 * Maneja la eliminación de la VN de la biblioteca.
 */
function _handleRemoveLib() {
  if (!_vnId || !_vnData) return;

  const confirmed = window.confirm(
    `¿Eliminar "${_vnData.title}" de tu biblioteca?\nEsta acción no se puede deshacer.`
  );
  if (!confirmed) return;

  LibraryStore.removeVn(_vnId);
  _showToast(`"${_vnData.title}" eliminada de la biblioteca`, 'success');
  _updateStatusPanel();
}

/**
 * Maneja la expansión/colapso de la sinopsis.
 */
function _handleExpandSynopsis() {
  _synopsisExpanded = !_synopsisExpanded;
  if (_vnData) _renderSynopsis(_vnData.description);
}

/**
 * Registra todos los event listeners de la página.
 */
function _bindEvents() {
  // Toggle tema
  _dom.themeToggle?.addEventListener('click', () => ThemeManager.toggle());

  // Botones de estado en el panel hero
  _dom.statusBtns.forEach(btn => {
    btn.addEventListener('click', () => _handleStatusClick(btn.dataset.status));
  });

  // Quitar de biblioteca
  _dom.btnRemoveLib?.addEventListener('click', _handleRemoveLib);

  // Expandir sinopsis
  _dom.btnExpandSynopsis?.addEventListener('click', _handleExpandSynopsis);
  _dom.btnToggleLang?.addEventListener('click', () => {
    _showOriginal = !_showOriginal;
    if (_vnData) _renderSynopsis(_vnData.description);
  });

  // Carrusel: navegar hacia atrás
  _dom.carouselPrev?.addEventListener('click', () => {
    _carouselIndex = Math.max(0, _carouselIndex - CAROUSEL_VISIBLE);
    _renderCarousel();
  });

  // Carrusel: navegar hacia adelante
  _dom.carouselNext?.addEventListener('click', () => {
    _carouselIndex = Math.min(
      _similarVns.length - CAROUSEL_VISIBLE,
      _carouselIndex + CAROUSEL_VISIBLE
    );
    _renderCarousel();
  });

  // Escuchar cambios del store para actualizar el panel de estado
  LibraryStore.subscribe((event) => {
    if (event === 'add' || event === 'update' || event === 'remove') {
      _updateStatusPanel();
    }
  });
}


// ─────────────────────────────────────────────
// 14. BOOTSTRAP (ThemeManager local)
// ─────────────────────────────────────────────

/**
 * Inicializa el tema visual para esta página de forma independiente.
 * novel-details.html no carga app-init.js completo para evitar
 * inicializar módulos innecesarios (FeedController, etc.).
 */
function _initTheme() {
  const saved = localStorage.getItem(STORAGE_KEY_THEME);
  const theme = (saved === 'light' || saved === 'dark') ? saved : DEFAULT_THEME;
  document.documentElement.dataset.theme = theme;
}


// ─────────────────────────────────────────────
// 15. INICIALIZACIÓN
// ─────────────────────────────────────────────

/**
 * Punto de entrada de la página de detalles.
 * Se ejecuta cuando el DOM está listo.
 */
async function _init() {
  // 1. Tema visual (inmediato, antes de cualquier render)
  _initTheme();

  // 2. ID desde la URL
  _vnId = _readVnIdFromUrl();

  // 3. Cachear referencias DOM
  _cacheDOM();

  // 4. ThemeManager toggle
  _dom.themeToggle?.addEventListener('click', () => {
    const current = document.documentElement.dataset.theme ?? DEFAULT_THEME;
    const next    = current === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    localStorage.setItem(STORAGE_KEY_THEME, next);
  });

  // 5. LibraryStore
  try {
    LibraryStore.init();
  } catch (err) {
    console.error('[Details] Error al inicializar LibraryStore:', err);
  }

  // 6. Auth (para mostrar menú de usuario en el header)
  try {
    AuthController.init();
  } catch (err) {
    console.error('[Details] Error al inicializar AuthController:', err);
  }

  // 7. FirebaseSync liviano (solo escucha auth, no sincroniza feed)
  try {
    FirebaseService.onAuthChange(async (user) => {
      if (user) {
        const cloudEntries = await FirebaseService.loadLibraryFromCloud().catch(() => []);
        cloudEntries.forEach(entry => {
          if (!LibraryStore.hasVn(entry.vnId)) {
            LibraryStore.addVn(entry.vnId, entry.status);
          }
        });
        _updateStatusPanel();
      }
    });
  } catch (err) {
    console.error('[Details] Error al inicializar FirebaseSync:', err);
  }

  // 8. Bindear eventos
  _bindEvents();

  // 9. Cargar datos de la VN
  await _loadVn();

  console.info('[Details] Página inicializada ✓');
}


// ── Esperar al DOM antes de inicializar ──────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _init);
} else {
  _init();
}