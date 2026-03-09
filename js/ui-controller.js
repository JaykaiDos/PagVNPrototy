'use strict';

/**
 * @file js/ui-controller.js
 * @description Controlador principal de la UI de VN-Hub.
 *              Versión 2: integra modales de review, log y comment
 *              al flujo de cambio de estado.
 *
 * CAMBIOS v2:
 *  - _applyStatusSelection() abre el modal correspondiente
 *    según el nuevo estado seleccionado.
 *  - Se importan los tres módulos de modales.
 *  - El resto de la lógica permanece igual.
 */

import * as VndbService   from './vndb-service.js';
import * as LibraryStore  from './library-store.js';
import * as RenderEngine  from './render-engine.js';
import * as ModalReview   from './modal-review.js';
import * as ModalLog      from './modal-log.js';
import * as ModalComment  from './modal-comment.js';
import { VN_STATUS, VN_STATUS_META, TOAST_DURATION_MS } from './constants.js';
import { ThemeManager }   from './app-init.js';
import * as FirebaseService from './firebase-service.js';


// ─────────────────────────────────────────────
// 1. ESTADO DEL CONTROLADOR
// ─────────────────────────────────────────────

const _state = {
  view:           'search',
  activeTab:      'all',
  menuTargetVnId: null,
  menuOpen:       false,
  searchPage:     1,
  searchQuery:    '',
  searchHasMore:  false,
  /** @type {Map<string, import('./vndb-service.js').VnEntry>} */
  vnCache:        new Map(),
};

let _searchDebounceTimer = null;
const DEBOUNCE_MS        = 420;


// ─────────────────────────────────────────────
// 2. REFERENCIAS AL DOM
// ─────────────────────────────────────────────

const _dom = {};

function _cacheDOM() {
  const ids = [
    'searchInput', 'searchClear', 'searchState', 'searchResults',
    'searchPagination', 'prevPage', 'nextPage', 'pageInfo',
    'viewSearch', 'viewLibrary', 'viewFeed',
    'navSearch', 'navLibrary', 'navFeed', 'navFeedItem',
    'statusMenu', 'menuOverlay',
    'toast', 'themeToggle', 'libraryStats',
  ];

  ids.forEach(id => {
    _dom[id] = document.getElementById(id);
    if (!_dom[id]) console.warn(`[UI] Elemento #${id} no encontrado.`);
  });

  _dom.panelGrids  = {};
  document.querySelectorAll('[data-panel-grid]').forEach(el => {
    _dom.panelGrids[el.dataset.panelGrid] = el;
  });

  _dom.emptyStates = {};
  document.querySelectorAll('[data-empty]').forEach(el => {
    _dom.emptyStates[el.dataset.empty] = el;
  });

  _dom.tabPanels = {};
  document.querySelectorAll('[role="tabpanel"]').forEach(el => {
    _dom.tabPanels[el.id.replace('tabpanel-', '')] = el;
  });

  _dom.tabs = {};
  document.querySelectorAll('[role="tab"]').forEach(btn => {
    _dom.tabs[btn.dataset.status] = btn;
  });
}


// ─────────────────────────────────────────────
// 3. GESTIÓN DE VISTAS
// ─────────────────────────────────────────────

function _switchView(viewName) {
  if (viewName === _state.view) return;
  // Guard de autenticación para Biblioteca
  if (viewName === 'library') {
    const isAuthed = FirebaseService.isAuthenticated();
    if (!isAuthed) {
      _showToast('Acceso restringido. Inicia sesión para ver tu biblioteca.', 'info');
      viewName = 'search';
    }
  }
  _state.view = viewName;

  ['search', 'library', 'feed'].forEach(v => {
    const el = document.getElementById(`view${_capitalize(v)}`);
    if (!el) return;
    const isActive = v === viewName;
    el.hidden = !isActive;
    el.classList.toggle('vh-view--hidden', !isActive);
  });

  ['navSearch', 'navLibrary', 'navFeed'].forEach(id => {
    const btn = _dom[id];
    if (!btn) return;
    const isActive = btn.dataset.view === viewName;
    btn.classList.toggle('vh-nav__btn--active', isActive);
    btn.setAttribute('aria-current', isActive ? 'page' : 'false');
  });

  if (viewName === 'library') _renderLibrary();
}

function _capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Muestra u oculta el tab de Comunidad según el estado de auth.
 * Llamado desde auth-controller cuando cambia la sesión.
 * @param {boolean} isAuthenticated
 */
function setFeedTabVisible(isAuthenticated) {
  if (_dom.navFeedItem) _dom.navFeedItem.hidden = !isAuthenticated;
}


// ─────────────────────────────────────────────
// 4. SISTEMA DE BÚSQUEDA
// ─────────────────────────────────────────────

function _onSearchInput(e) {
  const query = e.target.value.trim();

  if (_dom.searchClear) _dom.searchClear.hidden = query.length === 0;

  _state.searchPage  = 1;
  _state.searchQuery = query;

  clearTimeout(_searchDebounceTimer);

  if (query.length < 2) {
    _setSearchState('idle');
    _clearSearchResults();
    return;
  }

  _setSearchState('loading');
  _searchDebounceTimer = setTimeout(() => _executeSearch(query, 1), DEBOUNCE_MS);
}

async function _executeSearch(query, page) {
  try {
    const result = await VndbService.searchVns(query, { page });

    _state.searchHasMore = result.more;
    _state.searchPage    = page;

    if (result.items.length === 0) {
      _setSearchState('empty', query);
      _clearSearchResults();
      return;
    }

    _setSearchState('');
    _renderSearchResults(result.items);
    _updatePagination(page, result.more);

  } catch (err) {
    const msg = (err && err.code === 400)
      ? 'La búsqueda no es válida para VNDB. Intenta con otro término.'
      : (err?.message || 'Error en búsqueda');
    _setSearchState('error', msg);
    _clearSearchResults();
    console.error('[UI] Error en búsqueda:', err);
  }
}

function _renderSearchResults(vnList) {
  const grid = _dom.searchResults;
  if (!grid) return;

  while (grid.firstChild) grid.removeChild(grid.firstChild);

  const fragment = document.createDocumentFragment();

  vnList.forEach((vnEntry, index) => {
    _state.vnCache.set(vnEntry.id, vnEntry);

    const libEntry    = LibraryStore.getEntry(vnEntry.id);
    const isSaved     = libEntry !== null;
    const savedStatus = libEntry?.status ?? null;

    fragment.appendChild(
      RenderEngine.createVnCard(vnEntry, { isSaved, savedStatus, index })
    );
  });

  grid.appendChild(fragment);
}

function _updatePagination(currentPage, hasMore) {
  if (!_dom.searchPagination) return;

  _dom.searchPagination.hidden = currentPage <= 1 && !hasMore;
  if (_dom.prevPage) _dom.prevPage.disabled = currentPage <= 1;
  if (_dom.nextPage) _dom.nextPage.disabled = !hasMore;
  if (_dom.pageInfo) _dom.pageInfo.textContent = `Página ${currentPage}`;
}

function _clearSearchResults() {
  const grid = _dom.searchResults;
  if (!grid) return;
  while (grid.firstChild) grid.removeChild(grid.firstChild);
  if (_dom.searchPagination) _dom.searchPagination.hidden = true;
}

function _setSearchState(state, extra = '') {
  const container = _dom.searchState;
  if (!container) return;

  while (container.firstChild) container.removeChild(container.firstChild);

  switch (state) {
    case 'idle': {
      const hint = document.createElement('div');
      hint.className = 'vh-search-state__idle';
      const p = document.createElement('p');
      p.className   = 'vh-search-state__hint';
      p.textContent = 'Escribe al menos 2 caracteres para buscar';
      hint.appendChild(p);
      container.appendChild(hint);
      break;
    }
    case 'loading':
      container.appendChild(RenderEngine.createLoadingState());
      break;
    case 'empty':
      container.appendChild(RenderEngine.createEmptySearchState(extra));
      break;
    case 'error':
      container.appendChild(RenderEngine.createErrorState(extra));
      break;
    default:
      break;
  }
}


// ─────────────────────────────────────────────
// 5. SISTEMA DE PESTAÑAS
// ─────────────────────────────────────────────

function _activateTab(tabStatus) {
  if (tabStatus === _state.activeTab) return;
  _state.activeTab = tabStatus;

  Object.entries(_dom.tabs).forEach(([status, btn]) => {
    const isActive = status === tabStatus;
    btn.classList.toggle('vh-tab--active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  });

  Object.entries(_dom.tabPanels).forEach(([panelId, panel]) => {
    const isActive = panelId === tabStatus;
    panel.hidden = !isActive;
    panel.classList.toggle('vh-tabpanel--hidden', !isActive);
  });
}

function _renderLibrary() {
  const stats = LibraryStore.getStats();
  RenderEngine.updateTabCounts(stats);
  RenderEngine.updateLibraryStats(stats);

  _renderPanel('all',      LibraryStore.getEntriesByStatus(null));
  _renderPanel('pending',  LibraryStore.getEntriesByStatus(VN_STATUS.PENDING));
  _renderPanel('playing',  LibraryStore.getEntriesByStatus(VN_STATUS.PLAYING));
  _renderPanel('finished', LibraryStore.getRankedFinished());
  _renderPanel('dropped',  LibraryStore.getEntriesByStatus(VN_STATUS.DROPPED));
}

async function _renderPanel(panelId, entries) {
  const grid       = _dom.panelGrids[panelId];
  const emptyState = _dom.emptyStates[panelId];
  if (!grid) return;

  while (grid.firstChild) grid.removeChild(grid.firstChild);

  if (entries.length === 0) {
    if (emptyState) emptyState.hidden = false;
    return;
  }

  if (emptyState) emptyState.hidden = true;

  const uncachedIds = entries
    .map(e => e.vnId)
    .filter(id => !_state.vnCache.has(id));

  if (uncachedIds.length > 0) {
    try {
      const vnList = await VndbService.getVnsByIds(uncachedIds);
      vnList.forEach(vn => _state.vnCache.set(vn.id, vn));
    } catch (err) {
      console.warn('[UI] No se pudieron cargar metadatos:', err);
      // Fallback: intentar snapshots locales para cada ID
      uncachedIds.forEach(id => {
        const snap = VndbService.getLocalMetaSnapshot?.(id);
        if (snap) _state.vnCache.set(id, snap);
      });
    }
  }

  const fragment = document.createDocumentFragment();

  entries.forEach((libraryEntry, index) => {
    const vnEntry = _state.vnCache.get(libraryEntry.vnId) ?? {
      id: libraryEntry.vnId, title: libraryEntry.vnId,
      imageUrl: '', imageIsAdult: false,
      rating: 'N/A', released: '', tags: [], developers: [],
    };
    fragment.appendChild(RenderEngine.createLibraryCard(vnEntry, libraryEntry, index));
  });

  grid.appendChild(fragment);
}


// ─────────────────────────────────────────────
// 6. MENÚ FLOTANTE DE ESTADO
// ─────────────────────────────────────────────

function _openStatusMenu(vnId, triggerBtn) {
  _openStatusModal(vnId);
}

function _closeStatusMenu() {
  if (_dom.statusMenu)  _dom.statusMenu.hidden  = true;
  if (_dom.menuOverlay) _dom.menuOverlay.hidden = true;
  _state.menuTargetVnId = null;
}

/**
 * Aplica el estado seleccionado en el menú flotante.
 * MODIFICADO v2: abre el modal correspondiente según el nuevo estado.
 *
 * REGLAS DE MODAL:
 *  - FINISHED → ModalReview.open()  (formulario de puntuación)
 *  - PLAYING  → ModalLog.open()     (bitácora, solo si ya estaba en otro estado)
 *  - DROPPED  → ModalComment.open() (comentario de abandono)
 *  - PENDING  → sin modal
 *
 * @param {string} status - Nuevo estado seleccionado.
 */
function _applyStatusSelection(status) {
  const vnId = _state.menuTargetVnId;
  if (!vnId) return;

  _closeStatusMenu();

  const existingEntry = LibraryStore.getEntry(vnId);
  const meta          = VN_STATUS_META[status];
  const vnEntry       = _state.vnCache.get(vnId);
  const vnTitle       = vnEntry?.title ?? vnId;
  const vnImageUrl    = vnEntry?.imageUrl ?? '';

  if (!existingEntry) {
    // Nueva entrada en la biblioteca
    LibraryStore.addVn(vnId, status);
    _showToast(`${meta.icon} Añadida como "${meta.label}"`, 'success');
  } else if (existingEntry.status !== status) {
    // Cambio de estado
    const oldMeta = VN_STATUS_META[existingEntry.status];
    LibraryStore.updateStatus(vnId, status);
    _showToast(`${meta.icon} Movida de "${oldMeta.label}" → "${meta.label}"`, 'info');
  } else {
    // Mismo estado: solo abrimos el modal si aplica (para editar)
  }

  // Abrir modal según el nuevo estado
  _openModalForStatus(status, vnId, vnTitle, vnImageUrl);

  // Refrescar la card en el buscador si estamos en esa vista
  if (_state.view === 'search') _refreshSearchCard(vnId);
}

/**
 * Abre el modal correspondiente al estado seleccionado.
 *
 * @param {string} status
 * @param {string} vnId
 * @param {string} vnTitle
 * @param {string} vnImageUrl
 */
function _openModalForStatus(status, vnId, vnTitle, vnImageUrl) {
  switch (status) {
    case VN_STATUS.FINISHED:
      ModalReview.open(vnId, vnTitle, vnImageUrl);
      break;

    case VN_STATUS.PLAYING:
      ModalLog.open(vnId, vnTitle);
      break;

    case VN_STATUS.DROPPED:
      ModalComment.open(vnId, vnTitle);
      break;

    case VN_STATUS.PENDING:
    default:
      // Sin modal para Pendiente
      break;
  }
}

function _refreshSearchCard(vnId) {
  const card = _dom.searchResults?.querySelector(`[data-vn-id="${vnId}"]`);
  if (!card) return;

  const footer = card.querySelector('.vh-card__footer');
  const addBtn = footer?.querySelector('[data-action="open-status-menu"]');
  if (!addBtn) return;

  const libEntry = LibraryStore.getEntry(vnId);
  const vnEntry  = _state.vnCache.get(vnId);
  if (!vnEntry) return;

  const newBtn = _buildAddButtonPublic(vnEntry, !!libEntry, libEntry?.status ?? null);
  footer.replaceChild(newBtn, addBtn);
}

function _buildAddButtonPublic(vnEntry, isSaved, savedStatus) {
  const el = document.createElement('button');

  if (isSaved && savedStatus) {
    el.className      = 'vh-card__add-btn vh-card__add-btn--saved';
    el.dataset.action = 'open-status-menu';
    el.dataset.vnId   = vnEntry.id;
    el.setAttribute('aria-label', `Cambiar estado de ${vnEntry.title}`);

    const meta  = VN_STATUS_META[savedStatus];
    const icon  = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = meta?.icon ?? '✓';

    const label = document.createElement('span');
    label.textContent = meta?.label ?? 'Guardada';

    el.appendChild(icon);
    el.appendChild(label);
  } else {
    el.className      = 'vh-card__add-btn';
    el.dataset.action = 'open-status-menu';
    el.dataset.vnId   = vnEntry.id;
    el.setAttribute('aria-label', `Añadir ${vnEntry.title} a biblioteca`);

    const plus = document.createElement('span');
    plus.setAttribute('aria-hidden', 'true');
    plus.textContent = '+';

    const label = document.createElement('span');
    label.textContent = 'Añadir';

    el.appendChild(plus);
    el.appendChild(label);
  }

  return el;
}


// ─────────────────────────────────────────────
// 7. OBSERVER DEL STORE
// ─────────────────────────────────────────────

function _onStoreChange(event, payload) {
  if (event === 'error') {
    _showToast(payload ?? 'Error al guardar', 'error');
    return;
  }

  if (_state.view === 'library') _renderLibrary();

  const stats = LibraryStore.getStats();
  RenderEngine.updateTabCounts(stats);
  RenderEngine.updateLibraryStats(stats);
}


// ─────────────────────────────────────────────
// 8. TOAST
// ─────────────────────────────────────────────

let _toastTimer = null;

function _showToast(message, type = 'info') {
  const toast = _dom.toast;
  if (!toast) return;

  const iconEl = toast.querySelector('.vh-toast__icon');
  const msgEl  = toast.querySelector('.vh-toast__message');

  if (iconEl) iconEl.textContent = { success: '✓', error: '✕', info: 'ℹ' }[type] ?? 'ℹ';
  if (msgEl)  msgEl.textContent  = String(message);

  toast.className = `vh-toast vh-toast--${type}`;
  toast.hidden    = false;

  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    if (_dom.toast) _dom.toast.hidden = true;
  }, TOAST_DURATION_MS);
}


// ─────────────────────────────────────────────
// 9. REGISTRO DE EVENTOS
// ─────────────────────────────────────────────

function _bindEvents() {

  // Toggle tema
  _dom.themeToggle?.addEventListener('click', () => ThemeManager.toggle());

  // Navegación principal
  ['navSearch', 'navLibrary', 'navFeed'].forEach(id => {
    _dom[id]?.addEventListener('click', (e) => {
      _switchView(e.currentTarget.dataset.view);
    });
  });

  // Buscador
  _dom.searchInput?.addEventListener('input', _onSearchInput);
  _dom.searchInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(_searchDebounceTimer);
      const query = e.target.value.trim();
      if (query.length >= 2) {
        _setSearchState('loading');
        _executeSearch(query, 1);
      }
    }
  });

  // Limpiar búsqueda
  _dom.searchClear?.addEventListener('click', () => {
    if (_dom.searchInput) _dom.searchInput.value = '';
    _dom.searchClear.hidden = true;
    _setSearchState('idle');
    _clearSearchResults();
  });

  // Paginación
  _dom.prevPage?.addEventListener('click', () => {
    if (_state.searchPage > 1) _executeSearch(_state.searchQuery, _state.searchPage - 1);
  });
  _dom.nextPage?.addEventListener('click', () => {
    if (_state.searchHasMore) _executeSearch(_state.searchQuery, _state.searchPage + 1);
  });

  // Pestañas
  document.querySelector('.vh-tabs')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[role="tab"]');
    if (btn) _activateTab(btn.dataset.status);
  });

  document.querySelector('.vh-tabs')?.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const tabs    = [...document.querySelectorAll('[role="tab"]')];
    const idx     = tabs.indexOf(document.activeElement);
    if (idx === -1) return;
    const nextIdx = e.key === 'ArrowRight'
      ? (idx + 1) % tabs.length
      : (idx - 1 + tabs.length) % tabs.length;
    tabs[nextIdx].focus();
    tabs[nextIdx].click();
    e.preventDefault();
  });

  // Grid de búsqueda
  _dom.searchResults?.addEventListener('click', _handleGridClick);

  // Paneles de biblioteca
  document.getElementById('viewLibrary')?.addEventListener('click', _handleLibraryClick);

  // Menú flotante
  _dom.statusMenu?.addEventListener('click', (e) => {
    const btn = e.target.closest('[role="menuitem"][data-status]');
    if (btn) _applyStatusSelection(btn.dataset.status);
  });

  _dom.statusMenu?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') _closeStatusMenu();
  });

  _dom.menuOverlay?.addEventListener('click', _closeStatusMenu);

  // Botón "ir a búsqueda" desde estados vacíos
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-go-search]')) {
      _switchView('search');
      _dom.searchInput?.focus();
    }
  });
  window.addEventListener('resize', () => {
    if (!_dom.statusMenu || _dom.statusMenu.hidden) return;
    _closeStatusMenu();
  });
  window.addEventListener('scroll', () => {
    if (!_dom.statusMenu || _dom.statusMenu.hidden) return;
    _closeStatusMenu();
  }, { passive: true });
}

function _handleGridClick(e) {
  const btn = e.target.closest('[data-action][data-vn-id]');
  if (!btn) return;
  if (btn.dataset.action === 'open-status-menu') {
    _openStatusMenu(btn.dataset.vnId, btn);
  }
}

function _handleLibraryClick(e) {
  const btn = e.target.closest('[data-action][data-vn-id]');
  if (!btn) return;

  const { action, vnId } = btn.dataset;

  switch (action) {
    case 'open-status-menu':
      _openStatusMenu(vnId, btn);
      break;
    case 'remove-vn':
      _confirmAndRemove(vnId);
      break;
    case 'edit-log':
      // Botón de editar bitácora desde la card de biblioteca
      _openModalForStatus(VN_STATUS.PLAYING, vnId,
        _state.vnCache.get(vnId)?.title ?? vnId, '');
      break;
    case 'edit-review':
      // Botón de editar review desde la card de biblioteca
      _openModalForStatus(VN_STATUS.FINISHED, vnId,
        _state.vnCache.get(vnId)?.title   ?? vnId,
        _state.vnCache.get(vnId)?.imageUrl ?? '');
      break;
    case 'edit-comment':
      // Botón de editar comentario desde la card de biblioteca
      _openModalForStatus(VN_STATUS.DROPPED, vnId,
        _state.vnCache.get(vnId)?.title ?? vnId, '');
      break;
  }
}

function _confirmAndRemove(vnId) {
  const title     = _state.vnCache.get(vnId)?.title ?? vnId;
  const confirmed = window.confirm(
    `¿Eliminar "${title}" de tu biblioteca?\nEsta acción no se puede deshacer.`
  );
  if (!confirmed) return;
  LibraryStore.removeVn(vnId);
  _showToast(`"${title}" eliminada de la biblioteca`, 'success');
}

function _openStatusModal(vnId) {
  _state.menuTargetVnId = vnId;
  let overlay = document.getElementById('statusSelectOverlay');
  let modal   = document.getElementById('statusSelectModal');

  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'vh-modal-overlay';
    overlay.id        = 'statusSelectOverlay';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.hidden = true;
    document.body.appendChild(overlay);
  }

  if (!modal) {
    modal = document.createElement('div');
    modal.className = 'vh-modal';
    modal.id        = 'statusSelectModal';

    const header = document.createElement('div');
    header.className = 'vh-modal__header';
    const title = document.createElement('h2');
    title.className   = 'vh-modal__title';
    title.textContent = 'Añadir a biblioteca';
    const closeBtn = document.createElement('button');
    closeBtn.className   = 'vh-modal__close';
    closeBtn.setAttribute('aria-label', 'Cerrar');
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', _closeStatusModal);
    header.appendChild(title);
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'vh-modal__body';
    const list = document.createElement('ul');
    list.className = 'vh-status-menu__list';
    list.setAttribute('role', 'menu');

    const options = [
      ['pending','📌','Pendiente'],
      ['playing','🎮','Jugando'],
      ['finished','🏆','Finalizado'],
      ['dropped','❌','Abandonada'],
    ];
    options.forEach(([status, icon, label]) => {
      const li = document.createElement('li');
      li.setAttribute('role','none');
      const btn = document.createElement('button');
      btn.className = `vh-status-menu__option vh-status-menu__option--${status}`;
      btn.setAttribute('role','menuitem');
      btn.dataset.status = status;
      const i = document.createElement('span');
      i.setAttribute('aria-hidden','true');
      i.textContent = icon;
      const s = document.createElement('span');
      s.textContent = label;
      btn.appendChild(i);
      btn.appendChild(s);
      btn.addEventListener('click', () => _applyStatusSelection(status));
      li.appendChild(btn);
      list.appendChild(li);
    });
    body.appendChild(list);

    const footer = document.createElement('div');
    footer.className = 'vh-modal__footer';
    const cancel = document.createElement('button');
    cancel.className   = 'vh-btn vh-btn--ghost';
    cancel.textContent = 'Cancelar';
    cancel.addEventListener('click', _closeStatusModal);
    footer.appendChild(cancel);

    modal.appendChild(header);
    modal.appendChild(body);
    modal.appendChild(footer);
    overlay.appendChild(modal);

    // Cerrar al click fuera
    overlay.addEventListener('click', _closeStatusModal);
    // Cerrar con Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !overlay.hidden) _closeStatusModal();
    });
  }

  // Si el modal existe pero no está dentro del overlay, moverlo
  if (modal.parentElement !== overlay) {
    overlay.appendChild(modal);
  }

  overlay.hidden = false;
  modal.hidden   = false;
}

function _closeStatusModal() {
  const overlay = document.getElementById('statusSelectOverlay');
  const modal   = document.getElementById('statusSelectModal');
  if (overlay) overlay.hidden = true;
  if (modal)   modal.hidden   = true;
  _state.menuTargetVnId = null;
}
function _ensureStatusMenu() {
  if (_dom.statusMenu && _dom.menuOverlay) return;
  const existingMenu = document.getElementById('statusMenu');
  const existingOverlay = document.getElementById('menuOverlay');
  if (existingMenu && existingOverlay) {
    _dom.statusMenu = existingMenu;
    _dom.menuOverlay = existingOverlay;
    if (!existingMenu.dataset.bound) {
      existingMenu.addEventListener('click', (e) => {
        const btn = e.target.closest('[role="menuitem"][data-status]');
        if (btn) _applyStatusSelection(btn.dataset.status);
      });
      existingMenu.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') _closeStatusMenu();
      });
      existingOverlay.addEventListener('click', _closeStatusMenu);
      existingMenu.dataset.bound = 'true';
    }
    return;
  }
  const menu = document.createElement('div');
  menu.className = 'vh-status-menu';
  menu.id = 'statusMenu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Seleccionar estado para la biblioteca');
  menu.hidden = true;
  const title = document.createElement('p');
  title.className = 'vh-status-menu__title';
  title.textContent = 'Añadir a biblioteca como:';
  const list = document.createElement('ul');
  list.className = 'vh-status-menu__list';
  list.setAttribute('role', 'none');
  const options = [
    ['pending','📌','Pendiente'],
    ['playing','🎮','Jugando'],
    ['finished','🏆','Finalizado'],
    ['dropped','❌','Abandonada'],
  ];
  options.forEach(([status, icon, label]) => {
    const li = document.createElement('li');
    li.setAttribute('role','none');
    const btn = document.createElement('button');
    btn.className = `vh-status-menu__option vh-status-menu__option--${status}`;
    btn.setAttribute('role','menuitem');
    btn.dataset.status = status;
    const i = document.createElement('span');
    i.setAttribute('aria-hidden','true');
    i.textContent = icon;
    const s = document.createElement('span');
    s.textContent = label;
    btn.appendChild(i);
    btn.appendChild(s);
    li.appendChild(btn);
    list.appendChild(li);
  });
  menu.appendChild(title);
  menu.appendChild(list);
  const overlay = document.createElement('div');
  overlay.className = 'vh-overlay';
  overlay.id = 'menuOverlay';
  overlay.hidden = true;
  overlay.setAttribute('aria-hidden','true');
  document.body.appendChild(menu);
  document.body.appendChild(overlay);
  _dom.statusMenu = menu;
  _dom.menuOverlay = overlay;
  menu.addEventListener('click', (e) => {
    const btn = e.target.closest('[role="menuitem"][data-status]');
    if (btn) _applyStatusSelection(btn.dataset.status);
  });
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') _closeStatusMenu();
  });
  overlay.addEventListener('click', _closeStatusMenu);
}

// ─────────────────────────────────────────────
// 10. INICIALIZACIÓN
// ─────────────────────────────────────────────

function init() {
  _cacheDOM();
  _bindEvents();
  try {
    const params = new URLSearchParams(window.location.search);
    const seed   = params.get('search')?.trim();
    if (seed && _dom.searchInput) {
      _dom.searchInput.value = seed;
      _dom.searchClear.hidden = false;
      _setSearchState('loading');
      _executeSearch(seed, 1);
    } else {
      _setSearchState('idle');
    }
  } catch {
    _setSearchState('idle');
  }
  LibraryStore.subscribe(_onStoreChange);
  console.info('[UI] Controlador inicializado ✓');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

export { setFeedTabVisible };
