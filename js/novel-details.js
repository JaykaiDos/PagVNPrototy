'use strict';

/**
 * @file js/novel-details.js
 * @description Controlador de la página de detalles de una Visual Novel.
 *
 * CAMBIOS v3 — Confirmación antes de perder datos de reseña:
 * ─────────────────────────────────────────────────────────────────
 *  _handleStatusClick() es ahora async.
 *  Antes de aplicar cualquier cambio de estado que implique borrar
 *  score/reseña/ruta favorita (salir de FINISHED), se llama a
 *  confirmStatusChange() del nuevo módulo modal-status-change.js.
 *  Si el usuario cancela, la función retorna sin modificar nada y
 *  el panel de estado no se actualiza.
 *
 * CAMBIOS v2 (previos, mantenidos):
 *  - _renderHero(): fondo con fade-in vía .vnd-hero__bg--loaded.
 */

import * as VndbService          from './vndb-service.js';
import * as LibraryStore         from './library-store.js';
import * as AuthController       from './auth-controller.js';
import * as FirebaseService      from './firebase-service.js';
import * as ModalReview          from './modal-review.js';
import * as ModalLog             from './modal-log.js';
import * as ModalComment         from './modal-comment.js';
import { confirmStatusChange }   from './modal-status-change.js';
import { ThemeManager }          from './app-init.js';
import {
  STORAGE_KEY_THEME,
  DEFAULT_THEME,
  TOAST_DURATION_MS,
  VN_STATUS,
  VN_STATUS_META,
} from './constants.js';
import { escapeHtml }            from './utils.js';
import { translateSynopsis }     from './translation-service.js';


// ─────────────────────────────────────────────
// 1. ESTADO DE LA PÁGINA
// ─────────────────────────────────────────────

let _vnId   = null;
let _vnData = null;

let _carouselIndex   = 0;
let _similarVns      = [];
let _toastTimer      = null;
let _synopsisExpanded = false;
let _synopsisEs      = null;
let _showOriginal    = true;

const SYNOPSIS_PREVIEW_LEN = 400;
const CAROUSEL_VISIBLE     = 3;


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

  _dom.statusBtns = document.querySelectorAll('.vnd-status-btn');
}


// ─────────────────────────────────────────────
// 3. LECTURA DE PARÁMETROS DE URL
// ─────────────────────────────────────────────

function _readVnIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const id     = params.get('id') ?? '';
  return /^v\d+$/.test(id) ? id : null;
}


// ─────────────────────────────────────────────
// 4. RENDER DEL HERO
// ─────────────────────────────────────────────

function _renderHero(vn) {
  if (_dom.heroBg) {
    const urlIsValid = typeof vn.imageUrl === 'string' && /^https:\/\//i.test(vn.imageUrl);
    if (urlIsValid) {
      const loader   = new Image();
      let settled    = false;
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
          _dom.heroBg.classList.add('vnd-hero__bg--loaded');
        }
      };
      const timer    = setTimeout(() => onDone(false), TIMEOUT_MS);
      loader.onload  = () => { clearTimeout(timer); onDone(true); };
      loader.onerror = () => { clearTimeout(timer); onDone(false); };
      loader.src     = vn.imageUrl;
    } else {
      _dom.heroBg.style.backgroundImage = '';
      _dom.heroBg.classList.add('vnd-hero__bg--loaded');
    }
  }

  if (vn.imageUrl && _dom.heroCover) {
    let coverSettled = false;
    const COVER_TIMEOUT_MS = 2000;

    const onCoverDone = (ok) => {
      if (coverSettled) return;
      coverSettled = true;
      clearTimeout(coverTimer);
      if (ok) {
        if (_dom.coverSkeleton) _dom.coverSkeleton.hidden = true;
        _dom.heroCover.hidden = false;
      } else {
        if (_dom.coverSkeleton) {
          _dom.coverSkeleton.textContent = '📖';
          _dom.coverSkeleton.classList.add('vnd-hero__cover-placeholder');
        }
      }
    };

    const coverTimer = setTimeout(() => onCoverDone(false), COVER_TIMEOUT_MS);

    _dom.heroCover.onload  = null;
    _dom.heroCover.onerror = null;
    _dom.heroCover.removeAttribute('src');

    _dom.heroCover.onload  = () => onCoverDone(true);
    _dom.heroCover.onerror = () => onCoverDone(false);

    _dom.heroCover.setAttribute('alt', vn.title);
    _dom.heroCover.setAttribute('src', vn.imageUrl);

    if (_dom.heroCover.complete && !coverSettled) {
      onCoverDone(_dom.heroCover.naturalWidth > 0);
    }
  } else {
    if (_dom.coverSkeleton) {
      _dom.coverSkeleton.textContent = '📖';
      _dom.coverSkeleton.classList.add('vnd-hero__cover-placeholder');
    }
  }

  if (_dom.adultBadge) _dom.adultBadge.hidden = !vn.imageIsAdult;

  if (_dom.heroSkeleton) _dom.heroSkeleton.hidden = true;

  if (_dom.heroTitle) {
    _dom.heroTitle.textContent = vn.title || 'Sin título';
    _dom.heroTitle.hidden      = false;
  }

  if (_dom.breadcrumbTitle) _dom.breadcrumbTitle.textContent = vn.title || 'Sin título';
  document.title = `${vn.title || 'VN'} — VN-Hub`;

  if (_dom.metaRating) {
    _dom.metaRating.textContent = (vn.rating && vn.rating !== 'N/A') ? `⭐ ${vn.rating}` : '⭐ —';
    _dom.metaRating.hidden = false;
  }
  if (_dom.metaYear) {
    const year = vn.released?.match(/\d{4}/)?.[0] ?? '';
    _dom.metaYear.textContent = year ? `📅 ${year}` : '📅 —';
    _dom.metaYear.hidden = false;
  }
  if (_dom.metaDuration) {
    _dom.metaDuration.textContent = (vn.duration && vn.duration !== 'Desconocida') ? `⏱ ${vn.duration}` : '⏱ —';
    _dom.metaDuration.hidden = false;
  }

  if (_dom.heroMeta) _dom.heroMeta.hidden = false;

  if (_dom.statusPanel) {
    _dom.statusPanel.hidden = false;
    _updateStatusPanel();
  }
}


// ─────────────────────────────────────────────
// 5. RENDER SINOPSIS
// ─────────────────────────────────────────────

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

  _dom.synopsisText.textContent = needsExpand && !_synopsisExpanded
    ? `${text.slice(0, SYNOPSIS_PREVIEW_LEN)}…`
    : text;

  if (_dom.btnExpandSynopsis) {
    _dom.btnExpandSynopsis.hidden     = !needsExpand;
    _dom.btnExpandSynopsis.textContent = _synopsisExpanded ? 'Leer menos ↑' : 'Leer más ↓';
  }

  if (_dom.btnToggleLang) {
    _dom.btnToggleLang.hidden     = !esText;
    _dom.btnToggleLang.textContent = _showOriginal ? 'Ver traducción' : 'Ver original';
  }
}


// ─────────────────────────────────────────────
// 6. RENDER FICHA TÉCNICA
// ─────────────────────────────────────────────

function _renderFicha(vn) {
  const list = _dom.fichaList;
  if (!list) return;

  const fields = [
    { label: 'Desarrollador',        value: vn.developers?.join(', ') || 'Desconocido'                  },
    { label: 'Fecha de lanzamiento', value: vn.released  || 'Desconocida'                               },
    { label: 'Duración estimada',    value: vn.duration  || 'Desconocida'                               },
    { label: 'Votos en VNDB',        value: vn.votecount ? vn.votecount.toLocaleString('es-AR') : 'N/A' },
    { label: 'Rating VNDB',          value: vn.rating !== 'N/A' ? `${vn.rating} / 10` : 'Sin rating'   },
    { label: 'ID VNDB',              value: vn.id                                                        },
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

function _renderTags(tags) {
  if (!tags?.length || !_dom.tagsList || !_dom.tagsSection) return;

  _dom.tagsSection.hidden = false;

  const fragment = document.createDocumentFragment();

  tags.forEach(tag => {
    const pill = document.createElement('button');
    pill.className = 'vnd-tag-pill';
    pill.setAttribute('role',  'listitem');
    pill.setAttribute('title', `Buscar "${tag}"`);
    pill.textContent = tag;
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

async function _loadSimilarVns(vn) {
  const tags = (vn.tags ?? []).slice(0, 3);
  if (tags.length === 0 || !_dom.similarSection || !_dom.similarCarousel) return;
  try {
    const queries = await Promise.all(
      tags.map(t => VndbService.searchVns(t, { page: 1 }).catch(() => ({ items: [] })))
    );
    const merged = [];
    const seen   = new Set();
    queries.forEach(q => {
      (q.items ?? []).forEach(item => {
        if (item.id === vn.id) return;
        if (seen.has(item.id)) return;
        seen.add(item.id);
        merged.push(item);
      });
    });
    merged.sort((a, b) => {
      const matchA  = tags.filter(t => (a.tags ?? []).includes(t)).length;
      const matchB  = tags.filter(t => (b.tags ?? []).includes(t)).length;
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

function _renderCarousel() {
  const carousel = _dom.similarCarousel;
  if (!carousel) return;

  while (carousel.firstChild) carousel.removeChild(carousel.firstChild);

  const visible  = _similarVns.slice(_carouselIndex, _carouselIndex + CAROUSEL_VISIBLE);
  const fragment = document.createDocumentFragment();

  visible.forEach(vn => { fragment.appendChild(_buildCarouselCard(vn)); });

  carousel.appendChild(fragment);

  if (_dom.carouselPrev) _dom.carouselPrev.disabled = _carouselIndex === 0;
  if (_dom.carouselNext) _dom.carouselNext.disabled = _carouselIndex + CAROUSEL_VISIBLE >= _similarVns.length;
}

function _buildCarouselCard(vn) {
  const card = document.createElement('article');
  card.className = 'vnd-carousel-card';
  card.setAttribute('role', 'listitem');

  const link = document.createElement('a');
  link.href      = `novel-details.html?id=${encodeURIComponent(vn.id)}`;
  link.className = 'vnd-carousel-card__link';
  link.setAttribute('aria-label', `Ver detalles de ${vn.title}`);

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

  const info = document.createElement('div');
  info.className = 'vnd-carousel-card__info';

  const title = document.createElement('p');
  title.className   = 'vnd-carousel-card__title';
  title.textContent = vn.title;
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
// 10. ESTADOS DE LA UI
// ─────────────────────────────────────────────

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

function _clearState() {
  if (_dom.detailState) _dom.detailState.innerHTML = '';
}


// ─────────────────────────────────────────────
// 11. TOAST
// ─────────────────────────────────────────────

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

    _renderHero(vn);
    _renderSynopsis(vn.description);
    _renderFicha(vn);
    _renderTags(vn.tags);

    if (_dom.detailGrid) _dom.detailGrid.hidden = false;

    _loadSimilarVns(vn);

    translateSynopsis(_vnId, vn.description)
      .then(translated => {
        _synopsisEs = translated ? { text: translated } : null;
        if (_synopsisEs) _renderSynopsis(vn.description);
      })
      .catch(() => { _synopsisEs = null; });

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
 *
 * CAMBIO v3 — async + confirmación:
 *  Si la entrada actual está en FINISHED con datos enriquecidos y el
 *  usuario elige un estado diferente, se pide confirmación antes de
 *  borrar score/reseña/ruta favorita.
 *  Si el usuario cancela → retorna sin aplicar ningún cambio.
 *
 * @param {string} newStatus
 */
async function _handleStatusClick(newStatus) {
  if (!_vnId || !_vnData) return;

  const existingEntry = LibraryStore.getEntry(_vnId);
  const meta          = VN_STATUS_META[newStatus];

  // ── NUEVO: pedir confirmación si hay datos que perder ─────────
  const confirmed = await confirmStatusChange(existingEntry, newStatus, _vnData.title);
  if (!confirmed) return;
  // ──────────────────────────────────────────────────────────────

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

function _handleExpandSynopsis() {
  _synopsisExpanded = !_synopsisExpanded;
  if (_vnData) _renderSynopsis(_vnData.description);
}

function _bindEvents() {
  _dom.themeToggle?.addEventListener('click', () => ThemeManager.toggle());

  _dom.statusBtns.forEach(btn => {
    btn.addEventListener('click', () => _handleStatusClick(btn.dataset.status));
  });

  _dom.btnRemoveLib?.addEventListener('click', _handleRemoveLib);
  _dom.btnExpandSynopsis?.addEventListener('click', _handleExpandSynopsis);

  _dom.btnToggleLang?.addEventListener('click', () => {
    _showOriginal = !_showOriginal;
    if (_vnData) _renderSynopsis(_vnData.description);
  });

  _dom.carouselPrev?.addEventListener('click', () => {
    _carouselIndex = Math.max(0, _carouselIndex - CAROUSEL_VISIBLE);
    _renderCarousel();
  });

  _dom.carouselNext?.addEventListener('click', () => {
    _carouselIndex = Math.min(
      _similarVns.length - CAROUSEL_VISIBLE,
      _carouselIndex + CAROUSEL_VISIBLE
    );
    _renderCarousel();
  });

  LibraryStore.subscribe((event) => {
    if (event === 'add' || event === 'update' || event === 'remove') {
      _updateStatusPanel();
    }
  });
}


// ─────────────────────────────────────────────
// 14. BOOTSTRAP
// ─────────────────────────────────────────────

function _initTheme() {
  const saved = localStorage.getItem(STORAGE_KEY_THEME);
  const theme = (saved === 'light' || saved === 'dark') ? saved : DEFAULT_THEME;
  document.documentElement.dataset.theme = theme;
}

async function _init() {
  _initTheme();
  _vnId = _readVnIdFromUrl();
  _cacheDOM();

  _dom.themeToggle?.addEventListener('click', () => {
    const current = document.documentElement.dataset.theme ?? DEFAULT_THEME;
    const next    = current === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    localStorage.setItem(STORAGE_KEY_THEME, next);
  });

  try { LibraryStore.init(); } catch (err) {
    console.error('[Details] Error al inicializar LibraryStore:', err);
  }

  try { AuthController.init(); } catch (err) {
    console.error('[Details] Error al inicializar AuthController:', err);
  }

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

  _bindEvents();
  await _loadVn();

  console.info('[Details] Página inicializada ✓');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _init);
} else {
  _init();
}