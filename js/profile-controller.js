'use strict';

/**
 * @file js/profile-controller.js
 * @description Controlador del Módulo de Perfil de Usuario.
 *
 * CAMBIOS v2:
 *  - Botón ✏️ "Editar nombre" en el hero (solo perfil propio).
 *  - Modal inline _openEditNameModal() con validación y guardado en Firestore.
 *  - _saveDisplayName() centraliza la lógica de actualización y re-render.
 *
 * RESPONSABILIDADES:
 *  - Detectar si la URL tiene ?profile=UID (perfil ajeno) o no (perfil propio).
 *  - Renderizar el hero, estadísticas, tabs, grid de VNs y reseñas.
 *  - Comparador de afinidad cuando se visita un perfil ajeno.
 *  - Botón de compartir URL del perfil.
 *  - Respeta privacidad: si el perfil es privado/friends, muestra estado bloqueado.
 */

import * as FirebaseService from './firebase-service.js';
import * as VndbService     from './vndb-service.js';
import * as LibraryStore    from './library-store.js';
import { escapeHtml }       from './utils.js';
import { VN_STATUS_META, SCORE_CATEGORIES } from './constants.js';


// ─────────────────────────────────────────────────────────────
// CONSTANTES INTERNAS
// ─────────────────────────────────────────────────────────────

const MAX_VN_METADATA_BATCH = 50;
const RELOAD_COOLDOWN_MS    = 30_000;
const NAME_MIN_LEN          = 2;
const NAME_MAX_LEN          = 40;


// ─────────────────────────────────────────────────────────────
// ESTADO DEL MÓDULO
// ─────────────────────────────────────────────────────────────

const _state = {
  targetUid:      null,
  isOwnProfile:   false,
  profile:        null,
  libraryEntries: [],
  reviews:        [],
  vnMeta:         new Map(),
  activeTab:      'novels',
  activeFilter:   'all',
  lastLoaded:     0,
  loading:        false,
};


// ─────────────────────────────────────────────────────────────
// REFERENCIAS DOM
// ─────────────────────────────────────────────────────────────

const _dom = {};

function _cacheDOM() {
  ['viewProfile', 'navProfile', 'navProfileItem', 'profileContent'].forEach(id => {
    _dom[id] = document.getElementById(id);
    if (!_dom[id]) console.warn(`[ProfileController] #${id} no encontrado.`);
  });
}


// ═══════════════════════════════════════════════════════════════
// 1. PUNTO DE ENTRADA PÚBLICO
// ═══════════════════════════════════════════════════════════════

function init() {
  _cacheDOM();
  const urlUid = _getProfileUidFromUrl();
  if (urlUid) _navigateToProfile(urlUid);
  console.info('[ProfileController] Inicializado ✓');
}

async function openProfile(uid = null) {
  const currentUser = FirebaseService.getCurrentUser();
  if (!uid && !currentUser) { _renderNotLoggedIn(); return; }

  const targetUid = uid ?? currentUser.uid;
  const isOwn     = currentUser?.uid === targetUid;

  const sameProfile    = _state.targetUid === targetUid;
  const withinCooldown = Date.now() - _state.lastLoaded < RELOAD_COOLDOWN_MS;
  if (sameProfile && withinCooldown && !_state.loading) { _showView(); return; }

  _state.targetUid    = targetUid;
  _state.isOwnProfile = isOwn;
  _state.activeTab    = 'novels';
  _state.activeFilter = 'all';

  _showView();
  _renderLoading();
  await _loadProfileData(targetUid, isOwn, currentUser);
}

async function _navigateToProfile(uid) {
  document.dispatchEvent(new CustomEvent('vnh:navigate', { detail: { view: 'profile', uid } }));
}


// ═══════════════════════════════════════════════════════════════
// 2. CARGA DE DATOS
// ═══════════════════════════════════════════════════════════════

async function _loadProfileData(targetUid, isOwn, currentUser) {
  if (_state.loading) return;
  _state.loading = true;

  try {
    const profile = await FirebaseService.getPublicProfile(targetUid);
    if (!profile) { _renderNotFound(); return; }
    if (!isOwn && profile.privacy !== 'public') { _renderPrivate(profile); return; }

    _state.profile = profile;

    const entries = await FirebaseService.getPublicLibrary(targetUid, isOwn);
    _state.libraryEntries = entries;
    _state.reviews = entries.filter(e =>
      e.status === 'finished' && e.review && e.review.trim().length > 0
    );

    await _fetchVnMetadata(entries.map(e => e.vnId));
    _renderProfile(profile, isOwn, currentUser);
    _state.lastLoaded = Date.now();

  } catch (err) {
    console.error('[ProfileController] Error al cargar perfil:', err);
    _renderError(err.message);
  } finally {
    _state.loading = false;
  }
}

async function _fetchVnMetadata(vnIds) {
  const toFetch = vnIds.filter(id => !_state.vnMeta.has(id)).slice(0, MAX_VN_METADATA_BATCH);
  if (toFetch.length === 0) return;

  const results = await Promise.allSettled(toFetch.map(id => VndbService.getVnById(id)));
  results.forEach((result, i) => {
    if (result.status === 'fulfilled' && result.value) {
      _state.vnMeta.set(toFetch[i], result.value);
    }
  });
}


// ═══════════════════════════════════════════════════════════════
// 3. RENDERIZADO PRINCIPAL
// ═══════════════════════════════════════════════════════════════

function _renderProfile(profile, isOwn, currentUser) {
  if (!_dom.profileContent) return;

  const entries  = _state.libraryEntries;
  const stats    = _calcStats(entries);
  const fragment = document.createDocumentFragment();

  fragment.appendChild(_buildHero(profile, isOwn, currentUser));
  fragment.appendChild(_buildStatsStrip(stats));
  fragment.appendChild(_buildTabs(stats, isOwn));
  fragment.appendChild(_buildPanels(entries, isOwn, currentUser));

  _dom.profileContent.innerHTML = '';
  _dom.profileContent.appendChild(fragment);

  _activateTab(_state.activeTab);
  _activateFilter(_state.activeFilter);
  _bindTabEvents();
  _bindFilterEvents();
  _bindShareButton(profile);
  _bindSpoilerToggles();

  // Adjuntar evento del botón de editar nombre (solo perfil propio)
  if (isOwn) _bindEditNameButton();
}

function _calcStats(entries) {
  const byStatus = { pending: 0, playing: 0, finished: 0, dropped: 0 };
  let scoreSum = 0, scoreCount = 0;

  entries.forEach(e => {
    if (byStatus[e.status] !== undefined) byStatus[e.status]++;
    if (e.status === 'finished' && e.score?.finalScore) {
      scoreSum += e.score.finalScore;
      scoreCount++;
    }
  });

  return {
    total: entries.length,
    ...byStatus,
    avgScore: scoreCount > 0 ? (scoreSum / scoreCount).toFixed(2) : '—',
  };
}


// ═══════════════════════════════════════════════════════════════
// 4. CONSTRUCCIÓN DE COMPONENTES DOM
// ═══════════════════════════════════════════════════════════════

/**
 * Construye el hero del perfil.
 * Si es perfil propio, incluye el botón ✏️ junto al nombre.
 */
function _buildHero(profile, isOwn, currentUser) {
  const hero = _el('div', 'vhp-hero');
  hero.appendChild(_el('div', 'vhp-hero__banner'));

  const body       = _el('div', 'vhp-hero__body');
  const avatarWrap = _el('div', 'vhp-hero__avatar-wrap');
  avatarWrap.appendChild(_buildAvatar(profile));
  body.appendChild(avatarWrap);

  // Info central
  const info = _el('div', 'vhp-hero__info');

  // Fila de nombre + botón editar
  const nameRow = _el('div', 'vhp-hero__name-row');

  const nameEl = _el('h2', 'vhp-hero__name');
  nameEl.id          = 'vhpDisplayName';
  nameEl.textContent = profile.displayName ?? 'Usuario';
  nameRow.appendChild(nameEl);

  // Botón editar nombre — solo en perfil propio
  if (isOwn) {
    const editBtn = _el('button', 'vhp-edit-name-btn');
    editBtn.id          = 'vhpEditNameBtn';
    editBtn.type        = 'button';
    editBtn.title       = 'Editar nombre de usuario';
    editBtn.setAttribute('aria-label', 'Editar nombre de usuario');
    editBtn.textContent = '✏️';
    nameRow.appendChild(editBtn);
  }

  info.appendChild(nameRow);

  if (isOwn && profile.email) {
    const emailEl = _el('p', 'vhp-hero__email');
    emailEl.textContent = profile.email;
    info.appendChild(emailEl);
  }

  if (profile.createdAt) {
    const joinedEl = _el('p', 'vhp-hero__joined');
    joinedEl.innerHTML = `📅 Miembro desde ${escapeHtml(_formatDate(profile.createdAt))}`;
    info.appendChild(joinedEl);
  }

  if (isOwn) {
    const privLabel = { public: '🌐 Público', friends: '👥 Amigos', private: '🔒 Privado' };
    const badge = _el('span', `vhp-hero__privacy-badge vhp-hero__privacy-badge--${profile.privacy ?? 'public'}`);
    badge.textContent = privLabel[profile.privacy] ?? '🌐 Público';
    info.appendChild(badge);
  }

  body.appendChild(info);

  // Acciones
  const actions = _el('div', 'vhp-hero__actions');

  if (profile.privacy === 'public') {
    const shareBtn = _el('button', 'vhp-share-btn');
    shareBtn.id          = 'vhpShareBtn';
    shareBtn.textContent = '🔗 Compartir perfil';
    actions.appendChild(shareBtn);

    const shareToast = _el('span', 'vhp-share-toast');
    shareToast.id          = 'vhpShareToast';
    shareToast.textContent = '✓ URL copiada al portapapeles';
    actions.appendChild(shareToast);
  }

  if (!isOwn) {
    const badge = _el('span', 'vhp-visitor-badge');
    badge.textContent = `👁 Perfil de ${escapeHtml(profile.displayName ?? 'Usuario')}`;
    actions.appendChild(badge);
  }

  body.appendChild(actions);
  hero.appendChild(body);
  return hero;
}

function _buildAvatar(profile) {
  if (profile.photoURL && /^https:\/\//i.test(profile.photoURL)) {
    const img    = _el('img', 'vhp-hero__avatar');
    img.src      = profile.photoURL;
    img.alt      = escapeHtml(profile.displayName ?? 'Avatar');
    img.loading  = 'lazy';
    img.decoding = 'async';
    img.onerror  = () => {
      const initial = _el('div', 'vhp-hero__avatar-initial');
      initial.textContent = (profile.displayName ?? 'U').charAt(0).toUpperCase();
      img.replaceWith(initial);
    };
    return img;
  }
  const initial = _el('div', 'vhp-hero__avatar-initial');
  initial.textContent = (profile.displayName ?? 'U').charAt(0).toUpperCase();
  return initial;
}

function _buildStatsStrip(stats) {
  const strip = _el('div', 'vhp-stats');
  const items = [
    { icon: '📚', value: stats.total,    label: 'Total',      accent: false },
    { icon: '🏆', value: stats.finished, label: 'Finalizado', accent: false },
    { icon: '🎮', value: stats.playing,  label: 'Jugando',    accent: false },
    { icon: '📌', value: stats.pending,  label: 'Pendiente',  accent: false },
    { icon: '❌', value: stats.dropped,  label: 'Abandonado', accent: false },
    { icon: '⭐', value: stats.avgScore, label: 'Promedio',   accent: true  },
  ];
  items.forEach(({ icon, value, label, accent }) => {
    const card    = _el('div', `vhp-stat-card${accent ? ' vhp-stat-card--accent' : ''}`);
    const iconEl  = _el('span', 'vhp-stat-card__icon');  iconEl.textContent  = icon;
    const valueEl = _el('span', 'vhp-stat-card__value'); valueEl.textContent = String(value);
    const labelEl = _el('span', 'vhp-stat-card__label'); labelEl.textContent = label;
    card.appendChild(iconEl);
    card.appendChild(valueEl);
    card.appendChild(labelEl);
    strip.appendChild(card);
  });
  return strip;
}

function _buildTabs(stats, isOwn) {
  const nav = _el('nav', 'vhp-nav');
  nav.id = 'vhpNav';

  const tabs = [
    { id: 'novels',   icon: '📖', label: 'Novelas',  count: stats.total          },
    { id: 'reviews',  icon: '✍️',  label: 'Reseñas',  count: _state.reviews.length },
  ];

  if (!isOwn) {
    tabs.push({ id: 'affinity', icon: '💞', label: 'Afinidad', count: null });
  }

  tabs.forEach(({ id, icon, label, count }) => {
    const btn = _el('button', 'vhp-nav__btn');
    btn.dataset.tab = id;
    btn.type        = 'button';

    const iconEl  = _el('span'); iconEl.textContent  = icon;
    const labelEl = _el('span'); labelEl.textContent = ` ${label}`;
    btn.appendChild(iconEl);
    btn.appendChild(labelEl);

    if (count !== null) {
      const badge = _el('span', 'vhp-nav__badge');
      badge.textContent = String(count);
      btn.appendChild(badge);
    }

    nav.appendChild(btn);
  });

  return nav;
}

function _buildPanels(entries, isOwn, currentUser) {
  const container = _el('div', 'vhp-panels');

  container.appendChild(_buildNovelsPanel(entries));
  container.appendChild(_buildReviewsPanel());
  if (!isOwn) container.appendChild(_buildAffinityPanel(currentUser));

  return container;
}

function _buildNovelsPanel(entries) {
  const panel = _el('div', 'vhp-panel');
  panel.id = 'vhpPanel-novels';

  // Barra de filtros
  const filterBar = _el('div', 'vhp-filter-bar');
  filterBar.id = 'vhpFilterBar';

  const filters = [
    { key: 'all',      label: 'Todos'      },
    { key: 'finished', label: 'Finalizado' },
    { key: 'playing',  label: 'Jugando'    },
    { key: 'pending',  label: 'Pendiente'  },
    { key: 'dropped',  label: 'Abandonada' },
  ];

  filters.forEach(({ key, label }) => {
    const count = key === 'all'
      ? entries.length
      : entries.filter(e => e.status === key).length;

    const meta  = key !== 'all' ? VN_STATUS_META[key] : null;
    const btn   = _el('button', 'vhp-filter-btn');
    btn.dataset.filter = key;
    btn.type           = 'button';
    btn.innerHTML      = `${meta?.icon ?? '📋'} ${escapeHtml(label)} <span class="vhp-filter-count">(${count})</span>`;
    filterBar.appendChild(btn);
  });

  panel.appendChild(filterBar);

  const grid  = _el('div', 'vhp-vn-grid');
  grid.id     = 'vhpVnGrid';
  const empty = _el('div', 'vhp-vn-empty');
  empty.id    = 'vhpVnEmpty';
  empty.textContent = 'No hay novelas en esta categoría.';
  empty.hidden = true;

  panel.appendChild(grid);
  panel.appendChild(empty);
  return panel;
}

function _buildReviewsPanel() {
  const panel = _el('div', 'vhp-panel');
  panel.id = 'vhpPanel-reviews';

  if (_state.reviews.length === 0) {
    const empty = _el('p', 'vhp-reviews-empty');
    empty.textContent = 'Aún no hay reseñas publicadas.';
    panel.appendChild(empty);
    return panel;
  }

  _state.reviews.forEach(entry => {
    const meta    = _state.vnMeta.get(entry.vnId);
    const card    = _buildReviewCard(entry, meta);
    panel.appendChild(card);
  });

  return panel;
}

function _buildReviewCard(entry, meta) {
  const card = _el('article', 'vhp-review-card');

  // Portada
  if (meta?.imageUrl) {
    const img    = _el('img', 'vhp-review-card__cover');
    img.src      = meta.imageUrl;
    img.alt      = escapeHtml(meta.title ?? entry.vnId);
    img.loading  = 'lazy';
    card.appendChild(img);
  }

  const body    = _el('div', 'vhp-review-card__body');
  const titleEl = _el('h3', 'vhp-review-card__title');
  titleEl.textContent = meta?.title ?? entry.vnId;
  body.appendChild(titleEl);

  if (entry.score?.finalScore != null) {
    const scoreEl = _el('span', 'vhp-review-card__score');
    scoreEl.textContent = `⭐ ${entry.score.finalScore.toFixed(1)}`;
    body.appendChild(scoreEl);
  }

  const textEl = _el('p', 'vhp-review-card__text');
  if (entry.isSpoiler) {
    textEl.classList.add('vhp-spoiler');
    textEl.dataset.spoiler = '1';
    textEl.title = 'Clic para revelar spoiler';
  }
  textEl.textContent = entry.review;
  body.appendChild(textEl);

  card.appendChild(body);
  return card;
}

function _buildAffinityPanel(currentUser) {
  const panel = _el('div', 'vhp-panel');
  panel.id = 'vhpPanel-affinity';

  if (!currentUser) {
    const msg = _el('p');
    msg.textContent = 'Inicia sesión para ver tu afinidad con este usuario.';
    panel.appendChild(msg);
    return panel;
  }

  const myFinished  = LibraryStore.getEntriesByStatus('finished').map(e => e.vnId);
  const hisFinished = _state.libraryEntries
    .filter(e => e.status === 'finished')
    .map(e => e.vnId);

  const commonIds = myFinished.filter(id => hisFinished.includes(id));
  const total     = new Set([...myFinished, ...hisFinished]).size;
  const pct       = total > 0 ? Math.round((commonIds.length / total) * 100) : 0;

  const header = _el('div', 'vhp-affinity-header');
  const pctEl  = _el('span', 'vhp-affinity-pct');
  pctEl.textContent = `${pct}% de afinidad`;
  const subEl  = _el('span', 'vhp-affinity-sub');
  subEl.textContent = `${commonIds.length} VN${commonIds.length !== 1 ? 's' : ''} en común de ${total} únicas`;
  header.appendChild(pctEl);
  header.appendChild(subEl);
  panel.appendChild(header);

  const container = _el('div', 'vhp-affinity-grid');

  if (commonIds.length > 0) {
    commonIds.forEach(id => {
      const entry = _state.libraryEntries.find(e => e.vnId === id);
      if (entry) {
        const card = _buildVnCard(entry);
        container.appendChild(card);
      }
    });
    panel.appendChild(container);
  } else {
    const empty = _el('div', 'vhp-affinity-empty');
    const icon  = _el('span', 'vhp-affinity-empty__icon');
    icon.textContent = '🔭';
    const text  = _el('p');
    text.textContent = 'No tienen novelas en común todavía.';
    empty.appendChild(icon);
    empty.appendChild(text);
    panel.appendChild(empty);
  }

  return panel;
}

function _buildVnCard(entry) {
  const meta  = _state.vnMeta.get(entry.vnId);
  const card  = _el('article', 'vhp-vn-card');

  // Portada
  const imgWrap = _el('div', 'vhp-vn-card__cover-wrap');
  if (meta?.imageUrl) {
    const img    = _el('img', 'vhp-vn-card__cover');
    img.src      = meta.imageUrl;
    img.alt      = escapeHtml(meta.title ?? entry.vnId);
    img.loading  = 'lazy';
    img.decoding = 'async';
    imgWrap.appendChild(img);
  }

  // Score badge
  if (entry.score?.finalScore != null) {
    const badge = _el('span', 'vhp-vn-card__score');
    badge.textContent = entry.score.finalScore.toFixed(1);
    imgWrap.appendChild(badge);
  }

  // Status badge
  const statusMeta = VN_STATUS_META[entry.status];
  if (statusMeta) {
    const statusBadge = _el('span', `vhp-vn-card__status vhp-vn-card__status--${entry.status}`);
    statusBadge.textContent = statusMeta.icon;
    statusBadge.title       = statusMeta.label;
    imgWrap.appendChild(statusBadge);
  }

  card.appendChild(imgWrap);

  const title = _el('p', 'vhp-vn-card__title');
  title.textContent = meta?.title ?? entry.vnId;
  card.appendChild(title);

  return card;
}

function _renderVnGrid(entries, grid, empty) {
  while (grid.firstChild) grid.removeChild(grid.firstChild);

  if (entries.length === 0) {
    empty.hidden = false;
    return;
  }

  empty.hidden = true;
  const fragment = document.createDocumentFragment();
  entries.forEach(entry => fragment.appendChild(_buildVnCard(entry)));
  grid.appendChild(fragment);
}


// ═══════════════════════════════════════════════════════════════
// 5. EDICIÓN DE NOMBRE DE USUARIO
// ═══════════════════════════════════════════════════════════════

/**
 * Adjunta el evento de click al botón ✏️.
 * Separado del build por SRP: el botón se construye en _buildHero;
 * el evento se registra después del render para tener el DOM listo.
 */
function _bindEditNameButton() {
  const btn = document.getElementById('vhpEditNameBtn');
  if (!btn) return;
  btn.addEventListener('click', _openEditNameModal);
}

/**
 * Abre el modal inline de edición de nombre de usuario.
 * Crea el modal una sola vez y lo añade al body (reutilizable).
 * Si ya existe, simplemente lo muestra.
 */
function _openEditNameModal() {
  let overlay = document.getElementById('vhpEditNameOverlay');
  let modal   = document.getElementById('vhpEditNameModal');

  if (!overlay) {
    overlay = _buildEditNameOverlay();
    modal   = _buildEditNameModal(overlay);
    document.body.appendChild(overlay);
  }

  // Resetear estado del modal antes de mostrarlo
  const input   = document.getElementById('vhpEditNameInput');
  const errorEl = document.getElementById('vhpEditNameError');
  const counter = document.getElementById('vhpEditNameCounter');
  const saveBtn = document.getElementById('vhpEditNameSaveBtn');

  if (input) {
    input.value = _state.profile?.displayName ?? '';
    const len = input.value.length;
    if (counter) counter.textContent = `${len} / ${NAME_MAX_LEN}`;
  }
  if (errorEl) { errorEl.textContent = ''; errorEl.hidden = true; }
  if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Guardar'; }

  overlay.hidden = false;
  modal.hidden   = false;
  input?.focus();
}

/**
 * Construye el overlay de fondo del modal.
 * Al hacer clic fuera del modal, lo cierra.
 * @param {HTMLElement} [overlay] — referencia forward para el listener
 * @returns {HTMLElement}
 */
function _buildEditNameOverlay() {
  const overlay = _el('div', 'vhp-modal-overlay');
  overlay.id     = 'vhpEditNameOverlay';
  overlay.hidden = true;
  overlay.setAttribute('aria-hidden', 'true');
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.hidden = true;
      const m = document.getElementById('vhpEditNameModal');
      if (m) m.hidden = true;
    }
  });
  return overlay;
}

/**
 * Construye el modal de edición de nombre de usuario.
 * Incluye: input con validación live, contadorcaracteres, error, botones.
 *
 * @param {HTMLElement} overlay — para adjuntar el modal dentro
 * @returns {HTMLElement} El modal
 */
function _buildEditNameModal(overlay) {
  const modal = _el('div', 'vhp-modal');
  modal.id    = 'vhpEditNameModal';
  modal.setAttribute('role',          'dialog');
  modal.setAttribute('aria-modal',    'true');
  modal.setAttribute('aria-labelledby', 'vhpEditNameTitle');

  // Header
  const header  = _el('div', 'vhp-modal__header');
  const titleEl = _el('h2', 'vhp-modal__title');
  titleEl.id          = 'vhpEditNameTitle';
  titleEl.textContent = 'Editar nombre de usuario';
  const closeBtn = _el('button', 'vhp-modal__close');
  closeBtn.type        = 'button';
  closeBtn.textContent = '✕';
  closeBtn.setAttribute('aria-label', 'Cerrar');
  closeBtn.addEventListener('click', _closeEditNameModal);
  header.appendChild(titleEl);
  header.appendChild(closeBtn);

  // Body
  const body = _el('div', 'vhp-modal__body');

  const fieldLabel = _el('label', 'vhp-field__label');
  fieldLabel.setAttribute('for', 'vhpEditNameInput');
  fieldLabel.textContent = 'Nombre visible';
  body.appendChild(fieldLabel);

  const inputWrap = _el('div', 'vhp-field__input-wrap');

  const input = _el('input', 'vhp-field__input');
  input.id          = 'vhpEditNameInput';
  input.type        = 'text';
  input.maxLength   = NAME_MAX_LEN;
  input.minLength   = NAME_MIN_LEN;
  input.placeholder = 'Tu nombre en VN-Hub…';
  input.setAttribute('autocomplete', 'nickname');
  inputWrap.appendChild(input);

  // Contador de caracteres
  const counter = _el('span', 'vhp-field__counter');
  counter.id          = 'vhpEditNameCounter';
  counter.textContent = `0 / ${NAME_MAX_LEN}`;
  inputWrap.appendChild(counter);

  body.appendChild(inputWrap);

  // Mensaje de error
  const errorEl = _el('p', 'vhp-field__error');
  errorEl.id     = 'vhpEditNameError';
  errorEl.hidden = true;
  errorEl.setAttribute('role', 'alert');
  body.appendChild(errorEl);

  // Hint
  const hint = _el('p', 'vhp-field__hint');
  hint.textContent = `Entre ${NAME_MIN_LEN} y ${NAME_MAX_LEN} caracteres. Visible en tu perfil y reseñas.`;
  body.appendChild(hint);

  // Footer
  const footer    = _el('div', 'vhp-modal__footer');
  const cancelBtn = _el('button', 'vh-btn vh-btn--ghost');
  cancelBtn.type        = 'button';
  cancelBtn.textContent = 'Cancelar';
  cancelBtn.addEventListener('click', _closeEditNameModal);

  const saveBtn = _el('button', 'vh-btn vh-btn--primary');
  saveBtn.id          = 'vhpEditNameSaveBtn';
  saveBtn.type        = 'button';
  saveBtn.textContent = 'Guardar';
  saveBtn.addEventListener('click', _onSaveNameClick);

  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);

  modal.appendChild(header);
  modal.appendChild(body);
  modal.appendChild(footer);
  overlay.appendChild(modal);

  // Live: contador de caracteres
  input.addEventListener('input', () => {
    const len     = input.value.length;
    counter.textContent = `${len} / ${NAME_MAX_LEN}`;
    counter.classList.toggle('vhp-field__counter--warn', len > NAME_MAX_LEN - 5);
  });

  // Guardar con Enter
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); _onSaveNameClick(); }
    if (e.key === 'Escape') _closeEditNameModal();
  });

  return modal;
}

/**
 * Cierra el modal de edición ocultando el overlay y el modal.
 * Usa getElementById para ser resiliente al orden de creación del DOM.
 */
function _closeEditNameModal() {
  const overlay = document.getElementById('vhpEditNameOverlay');
  const modal   = document.getElementById('vhpEditNameModal');
  if (overlay) overlay.hidden = true;
  if (modal)   modal.hidden   = true;
}

/**
 * Handler del botón "Guardar". Valida el nombre antes de enviarlo.
 */
async function _onSaveNameClick() {
  const input   = document.getElementById('vhpEditNameInput');
  const errorEl = document.getElementById('vhpEditNameError');
  const saveBtn = document.getElementById('vhpEditNameSaveBtn');
  if (!input || !errorEl || !saveBtn) return;

  const name = input.value.trim();
  const validationError = _validateName(name);

  if (validationError) {
    errorEl.textContent = validationError;
    errorEl.hidden      = false;
    input.focus();
    return;
  }

  errorEl.hidden = true;
  await _saveDisplayName(name, saveBtn);
}

/**
 * Valida el nombre de usuario localmente antes de llamar a Firestore.
 * @param {string} name
 * @returns {string|null} Mensaje de error o null si es válido
 */
function _validateName(name) {
  if (name.length < NAME_MIN_LEN) return `El nombre debe tener al menos ${NAME_MIN_LEN} caracteres.`;
  if (name.length > NAME_MAX_LEN) return `El nombre no puede superar los ${NAME_MAX_LEN} caracteres.`;
  if (/<[^>]+>/.test(name))       return 'El nombre no puede contener HTML.';
  return null;
}

/**
 * Persiste el nuevo nombre en Firestore y actualiza el DOM localmente
 * sin recargar el perfil completo.
 *
 * FLUJO:
 *  1. Deshabilitar botón para evitar doble-submit.
 *  2. Llamar a FirebaseService.updateDisplayName().
 *  3. Actualizar _state.profile localmente.
 *  4. Actualizar el texto del nombre en el DOM (sin re-render total).
 *  5. Cerrar el modal.
 *
 * @param {string}      name    — Nombre validado
 * @param {HTMLElement} saveBtn — Botón para deshabilitar durante la operación
 */
async function _saveDisplayName(name, saveBtn) {
  saveBtn.disabled    = true;
  saveBtn.textContent = 'Guardando…';

  try {
    await FirebaseService.updateDisplayName(name);

    // Actualizar estado local
    if (_state.profile) _state.profile.displayName = name;

    // Actualizar el nombre en el DOM sin re-render completo
    const nameEl = document.getElementById('vhpDisplayName');
    if (nameEl) nameEl.textContent = name;

    // Actualizar el initial del avatar si aplica
    const initial = document.querySelector('.vhp-hero__avatar-initial');
    if (initial) initial.textContent = name.charAt(0).toUpperCase();

    // Forzar recarga del perfil en la próxima visita
    _state.lastLoaded = 0;

    _closeEditNameModal();

  } catch (err) {
    const errorEl = document.getElementById('vhpEditNameError');
    if (errorEl) {
      errorEl.textContent = err.message ?? 'Error al guardar. Intenta nuevamente.';
      errorEl.hidden      = false;
    }
    console.error('[ProfileController] Error al guardar nombre:', err);
    // Rehabilitar botón solo en caso de error para permitir reintento
    saveBtn.disabled    = false;
    saveBtn.textContent = 'Guardar';
  }
}


// ═══════════════════════════════════════════════════════════════
// 6. ESTADOS DE CARGA / ERROR / PRIVADO
// ═══════════════════════════════════════════════════════════════

function _renderLoading() {
  if (!_dom.profileContent) return;
  _dom.profileContent.innerHTML = '';
  const state   = _el('div', 'vhp-state');
  const spinner = _el('div', 'vhp-spinner');
  const text    = _el('p', 'vhp-state__desc');
  text.textContent = 'Cargando perfil…';
  state.appendChild(spinner);
  state.appendChild(text);
  _dom.profileContent.appendChild(state);
}

function _renderPrivate(profile) {
  _renderStateMessage('🔒', 'Perfil privado',
    `${escapeHtml(profile.displayName ?? 'Este usuario')} mantiene su perfil en privado.`);
}

function _renderNotFound() {
  _renderStateMessage('❓', 'Perfil no encontrado',
    'No existe ningún usuario con ese identificador.');
}

function _renderNotLoggedIn() {
  _renderStateMessage('🔑', 'Inicia sesión',
    'Necesitas iniciar sesión para ver tu perfil.');
}

function _renderError(msg) {
  _renderStateMessage('⚠️', 'Error al cargar el perfil',
    `Ocurrió un error inesperado. ${escapeHtml(msg ?? '')}`);
}

function _renderStateMessage(icon, title, desc) {
  if (!_dom.profileContent) return;
  _dom.profileContent.innerHTML = '';
  const state   = _el('div', 'vhp-state');
  const iconEl  = _el('span', 'vhp-state__icon');  iconEl.textContent  = icon;
  const titleEl = _el('h2',   'vhp-state__title'); titleEl.textContent = title;
  const descEl  = _el('p',    'vhp-state__desc');  descEl.textContent  = desc;
  state.appendChild(iconEl);
  state.appendChild(titleEl);
  state.appendChild(descEl);
  _dom.profileContent.appendChild(state);
}


// ═══════════════════════════════════════════════════════════════
// 7. EVENTOS
// ═══════════════════════════════════════════════════════════════

function _bindTabEvents() {
  const nav = document.getElementById('vhpNav');
  if (!nav) return;
  nav.querySelectorAll('.vhp-nav__btn').forEach(btn => {
    btn.addEventListener('click', () => _activateTab(btn.dataset.tab));
  });
}

function _activateTab(tabId) {
  _state.activeTab = tabId;
  document.querySelectorAll('.vhp-nav__btn').forEach(btn => {
    btn.classList.toggle('vhp-nav__btn--active', btn.dataset.tab === tabId);
  });
  document.querySelectorAll('.vhp-panel').forEach(panel => {
    panel.classList.toggle('vhp-panel--active', panel.id === `vhpPanel-${tabId}`);
  });
}

function _bindFilterEvents() {
  const bar = document.getElementById('vhpFilterBar');
  if (!bar) return;
  bar.querySelectorAll('.vhp-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => _activateFilter(btn.dataset.filter));
  });
}

function _activateFilter(filter) {
  _state.activeFilter = filter;
  document.querySelectorAll('.vhp-filter-btn').forEach(btn => {
    btn.classList.toggle('vhp-filter-btn--active', btn.dataset.filter === filter);
  });
  const entries = filter === 'all'
    ? _state.libraryEntries
    : _state.libraryEntries.filter(e => e.status === filter);
  const grid  = document.getElementById('vhpVnGrid');
  const empty = document.getElementById('vhpVnEmpty');
  if (grid && empty) _renderVnGrid(entries, grid, empty);
}

function _bindShareButton() {
  const btn = document.getElementById('vhpShareBtn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}?profile=${encodeURIComponent(_state.targetUid)}`;
    try {
      await navigator.clipboard.writeText(url);
      _showShareToast();
    } catch {
      prompt('Copia este enlace de tu perfil:', url);
    }
  });
}

function _showShareToast() {
  const toast = document.getElementById('vhpShareToast');
  if (!toast) return;
  toast.classList.add('vhp-share-toast--visible');
  setTimeout(() => toast.classList.remove('vhp-share-toast--visible'), 2500);
}

function _bindSpoilerToggles() {
  document.querySelectorAll('[data-spoiler="1"]').forEach(el => {
    el.addEventListener('click', () => el.classList.toggle('revealed'));
  });
}


// ═══════════════════════════════════════════════════════════════
// 8. VISIBILIDAD DE LA VISTA
// ═══════════════════════════════════════════════════════════════

function _showView() {
  if (_dom.viewProfile) {
    _dom.viewProfile.hidden = false;
    _dom.viewProfile.classList.remove('vh-view--hidden');
  }
}


// ═══════════════════════════════════════════════════════════════
// 9. UTILIDADES
// ═══════════════════════════════════════════════════════════════

function _getProfileUidFromUrl() {
  const params = new URLSearchParams(location.search);
  const uid    = params.get('profile');
  if (uid && /^[a-zA-Z0-9_-]{8,128}$/.test(uid)) return uid;
  return null;
}

function _formatDate(date) {
  try {
    let d;
    if (date && typeof date.toDate === 'function') d = date.toDate();
    else if (typeof date === 'string')             d = new Date(date);
    else if (date?.seconds)                        d = new Date(date.seconds * 1000);
    else return '';
    return d.toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' });
  } catch { return ''; }
}

function _el(tag, cls = '') {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  return el;
}


// ═══════════════════════════════════════════════════════════════
// EXPORTACIÓN
// ═══════════════════════════════════════════════════════════════

export { init, openProfile };