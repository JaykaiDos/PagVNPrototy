/**
 * @file js/mobile-gestures.js
 * @description Sistema de gestos táctiles para VN-Hub.
 *
 * CAMBIOS v2 — Optimización de carga de imágenes:
 * ─────────────────────────────────────────────────────────────────
 *  LazyImageManager — 3 mejoras:
 *
 *  1. rootMargin: '100px 0px' → '400px 0px'
 *     El observer anterior iniciaba la carga cuando la imagen estaba
 *     a solo 100px del viewport. Con cards de ~200px y grids de 4-6
 *     filas, el usuario llegaba a la imagen antes de que terminara de
 *     cargar. Con 400px de margen, las imágenes se precargan ~2 filas
 *     antes de ser visibles → aparecen instantáneamente al hacer scroll.
 *
 *  2. Fade-in CSS correctamente aplicado.
 *     La clase 'js-lazy-active' activa opacity:0 en las imágenes lazy,
 *     y '.is-loaded' las hace visibles con transición. La transición
 *     ahora es más rápida (0.25s vs implícita) para no retrasar la
 *     percepción de carga.
 *
 *  3. observeAll() ahora usa un selector más específico para evitar
 *     observar imágenes que ya tienen la clase is-loaded (re-renders).
 *
 * MÓDULOS EXPORTADOS (sin cambios):
 *  - SwipeNavigator   — swipe horizontal para cambiar entre vistas
 *  - PullToRefresh    — pull-to-refresh para recargar la vista activa
 *  - MobileNavManager — hamburger menu + bottom bar sync
 *  - LazyImageManager — fade-in y precarga de portadas
 *
 * @module mobile-gestures
 */

'use strict';


// ─────────────────────────────────────────────────────────────
// UTILIDADES INTERNAS
// ─────────────────────────────────────────────────────────────

function _isTouchDevice() {
  return window.matchMedia('(pointer: coarse)').matches
    || navigator.maxTouchPoints > 0;
}

function _prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function _haptic(intensity = 'light') {
  if (!navigator.vibrate) return;
  const patterns = { light: [10], medium: [20], heavy: [40, 20, 40] };
  navigator.vibrate(patterns[intensity] ?? patterns.light);
}


// ─────────────────────────────────────────────────────────────
// 1. SWIPE NAVIGATOR
// ─────────────────────────────────────────────────────────────

/**
 * @typedef {Object} SwipeNavigatorOptions
 * @property {string[]} views
 * @property {number}   [threshold]
 * @property {number}   [maxVertical]
 * @property {Function} [onSwipe]
 */

const SwipeNavigator = (() => {

  let _opts = null;
  let _viewIds = [];
  let _activeIndex = 0;
  let _startX = 0;
  let _startY = 0;
  let _startTime = 0;
  let _tracking = false;
  let _abortCtrl = null;

  function _getActiveIndex() {
    for (let i = 0; i < _viewIds.length; i++) {
      const btn = document.getElementById(_viewIds[i]);
      if (btn && btn.getAttribute('aria-current') === 'page') return i;
      if (btn && btn.closest('li') && !btn.closest('[hidden]')) {
        if (btn.classList.contains('vh-nav__btn--active')) return i;
      }
    }
    return 0;
  }

  function _navigateTo(index, direction) {
    if (index < 0 || index >= _viewIds.length) return;

    const btn = document.getElementById(_viewIds[index]);
    if (!btn || btn.closest('[hidden]')) return;

    _activeIndex = index;
    _haptic('light');
    btn.click();

    if (_opts?.onSwipe) {
      _opts.onSwipe(direction, _viewIds[index]);
    }
  }

  function _onTouchStart(e) {
    const target = e.target.closest(
      '.vh-tabs, .vep-tags, .vep-year__presets, .vh-cards-grid, input, textarea, select, [contenteditable]'
    );
    if (target) return;
    if (document.querySelector('.vh-modal-backdrop:not([hidden])')) return;

    const t = e.touches[0];
    _startX    = t.clientX;
    _startY    = t.clientY;
    _startTime = performance.now();
    _tracking  = true;
  }

  function _onTouchEnd(e) {
    if (!_tracking) return;
    _tracking = false;

    const t = e.changedTouches[0];
    const dx   = t.clientX - _startX;
    const dy   = t.clientY - _startY;
    const dt   = performance.now() - _startTime;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    const threshold   = _opts?.threshold   ?? 60;
    const maxVertical = _opts?.maxVertical ?? 80;

    if (absDx < threshold) return;
    if (absDy > maxVertical) return;
    if (absDx < absDy * 1.5) return;
    if (dt > 600) return;

    _activeIndex = _getActiveIndex();

    if (dx < 0) {
      _navigateTo(_activeIndex + 1, 'left');
    } else {
      _navigateTo(_activeIndex - 1, 'right');
    }
  }

  function _onTouchCancel() {
    _tracking = false;
  }

  return {
    init(opts) {
      if (!_isTouchDevice()) return;
      if (_prefersReducedMotion()) return;

      _opts     = opts;
      _viewIds  = opts.views ?? [];

      if (_viewIds.length < 2) return;

      _abortCtrl = new AbortController();
      const { signal } = _abortCtrl;

      document.addEventListener('touchstart', _onTouchStart, { passive: true, signal });
      document.addEventListener('touchend',   _onTouchEnd,   { passive: true, signal });
      document.addEventListener('touchcancel',_onTouchCancel,{ passive: true, signal });

      console.info('[SwipeNavigator] Inicializado con vistas:', _viewIds);
    },

    destroy() {
      _abortCtrl?.abort();
      _abortCtrl = null;
      _opts = null;
    },
  };
})();


// ─────────────────────────────────────────────────────────────
// 2. PULL TO REFRESH
// ─────────────────────────────────────────────────────────────

/**
 * @typedef {Object} PullToRefreshOptions
 * @property {Function}    onRefresh
 * @property {number}      [threshold]
 * @property {number}      [maxPull]
 * @property {HTMLElement} [container]
 */

const PullToRefresh = (() => {

  let _opts      = null;
  let _indicator = null;
  let _startY    = 0;
  let _currentY  = 0;
  let _tracking  = false;
  let _loading   = false;
  let _abortCtrl = null;

  function _getOrCreateIndicator() {
    let el = document.getElementById('vhPtrIndicator');
    if (!el) {
      el = document.createElement('div');
      el.id = 'vhPtrIndicator';
      el.className = 'vh-ptr';
      el.setAttribute('aria-hidden', 'true');
      el.innerHTML = '<div class="vh-ptr__spinner"></div>';
      document.body.appendChild(el);
    }
    return el;
  }

  function _isAtTop() {
    return (window.scrollY || document.documentElement.scrollTop) <= 2;
  }

  function _updateIndicator(progress) {
    if (!_indicator) return;
    const clamped = Math.min(Math.max(progress, 0), 1);
    _indicator.style.setProperty('--ptr-progress', String(clamped));
    _indicator.style.setProperty('--ptr-rotation', String(Math.round(clamped * 360)));
    _indicator.classList.toggle('vh-ptr--visible', clamped > 0.05);
  }

  function _onTouchStart(e) {
    if (_loading) return;
    if (!_isAtTop()) return;
    if (e.touches.length !== 1) return;

    _startY   = e.touches[0].clientY;
    _tracking = true;
  }

  function _onTouchMove(e) {
    if (!_tracking || _loading) return;

    _currentY = e.touches[0].clientY;
    const dy = _currentY - _startY;

    if (dy <= 0) {
      _updateIndicator(0);
      return;
    }

    const maxPull   = _opts?.maxPull ?? 120;
    const threshold = _opts?.threshold ?? 80;
    const resistance = 0.45;
    const pulled = Math.min(dy * resistance, maxPull);

    _updateIndicator(pulled / threshold);

    if (dy > 8 && _isAtTop()) {
      e.preventDefault();
    }
  }

  async function _onTouchEnd() {
    if (!_tracking || _loading) return;
    _tracking = false;

    const dy        = _currentY - _startY;
    const resistance = 0.45;
    const threshold  = _opts?.threshold ?? 80;
    const pulled     = dy * resistance;

    if (pulled >= threshold) {
      _loading = true;
      _haptic('medium');

      if (_indicator) {
        _indicator.classList.add('vh-ptr--loading', 'vh-ptr--triggered');
        _indicator.querySelector('.vh-ptr__spinner')?.removeAttribute('style');
      }

      try {
        await _opts?.onRefresh?.();
      } catch (err) {
        console.warn('[PullToRefresh] Error en onRefresh:', err);
      } finally {
        _loading = false;
        _resetIndicator();
      }
    } else {
      _resetIndicator();
    }
  }

  function _onTouchCancel() {
    _tracking = false;
    _resetIndicator();
  }

  function _resetIndicator() {
    if (!_indicator) return;
    _indicator.classList.remove('vh-ptr--loading', 'vh-ptr--triggered');
    _updateIndicator(0);
    _startY   = 0;
    _currentY = 0;
  }

  return {
    init(opts) {
      if (!_isTouchDevice()) return;

      _opts      = opts;
      _indicator = _getOrCreateIndicator();
      _abortCtrl = new AbortController();
      const { signal } = _abortCtrl;

      document.addEventListener('touchstart', _onTouchStart,  { passive: true,  signal });
      document.addEventListener('touchmove',  _onTouchMove,   { passive: false, signal });
      document.addEventListener('touchend',   _onTouchEnd,    { passive: true,  signal });
      document.addEventListener('touchcancel',_onTouchCancel, { passive: true,  signal });

      console.info('[PullToRefresh] Inicializado.');
    },

    destroy() {
      _abortCtrl?.abort();
      _indicator?.remove();
      _indicator  = null;
      _abortCtrl  = null;
      _opts       = null;
    },
  };
})();


// ─────────────────────────────────────────────────────────────
// 3. MOBILE NAV MANAGER
// ─────────────────────────────────────────────────────────────

const MobileNavManager = (() => {

  let _isOpen = false;
  let _abortCtrl = null;

  function _injectMobileUI() {

    if (!document.getElementById('vhHamburger')) {
      const btn = document.createElement('button');
      btn.id            = 'vhHamburger';
      btn.className     = 'vh-hamburger';
      btn.setAttribute('aria-label',    'Abrir menú de navegación');
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('aria-controls', 'vhMainNav');
      btn.innerHTML = `
        <span class="vh-hamburger__bar" aria-hidden="true"></span>
        <span class="vh-hamburger__bar" aria-hidden="true"></span>
        <span class="vh-hamburger__bar" aria-hidden="true"></span>
      `;
      const headerInner = document.querySelector('.vh-header__inner');
      if (headerInner) headerInner.prepend(btn);
    }

    if (!document.getElementById('vhNavOverlay')) {
      const overlay = document.createElement('div');
      overlay.id          = 'vhNavOverlay';
      overlay.className   = 'vh-nav-overlay';
      overlay.setAttribute('aria-hidden', 'true');
      document.body.appendChild(overlay);
    }

    const nav = document.querySelector('.vh-main-nav');
    if (nav && !nav.id) nav.id = 'vhMainNav';

    if (!document.getElementById('vhBottomNav')) {
      const bottomNav = document.createElement('nav');
      bottomNav.id        = 'vhBottomNav';
      bottomNav.className = 'vh-bottom-nav';
      bottomNav.setAttribute('aria-label', 'Navegación inferior');

      const navBtns = document.querySelectorAll('.vh-nav__btn');
      const items = Array.from(navBtns)
        .filter(btn => !btn.closest('[hidden]'))
        .map(btn => {
          const icon  = btn.querySelector('span[aria-hidden]')?.textContent?.trim() ?? '';
          const label = btn.textContent?.replace(icon, '').trim() ?? '';
          const view  = btn.dataset.view ?? '';
          return { icon, label, view, id: btn.id };
        });

      const list = document.createElement('ul');
      list.className = 'vh-bottom-nav__list';
      list.setAttribute('role', 'list');

      items.forEach(({ icon, label, view, id }) => {
        const li = document.createElement('li');
        li.className = 'vh-bottom-nav__item';

        const btn = document.createElement('button');
        btn.className = `vh-bottom-nav__btn`;
        btn.dataset.view      = view;
        btn.dataset.syncTo    = id;
        btn.setAttribute('aria-label', label);
        btn.innerHTML = `
          <span class="vh-bottom-nav__icon" aria-hidden="true">${icon}</span>
          <span class="vh-bottom-nav__label">${label}</span>
        `;

        li.appendChild(btn);
        list.appendChild(li);
      });

      bottomNav.appendChild(list);
      document.body.appendChild(bottomNav);
    }

    if (!document.getElementById('vhSwipeHint') && !localStorage.getItem('vnh_swipe_hint_seen')) {
      const hint = document.createElement('div');
      hint.id        = 'vhSwipeHint';
      hint.className = 'vh-swipe-hint';
      hint.setAttribute('aria-hidden', 'true');
      hint.textContent = '← Desliza para navegar →';
      document.body.appendChild(hint);

      setTimeout(() => {
        if (window.innerWidth <= 767) {
          hint.classList.add('vh-swipe-hint--show');
          setTimeout(() => {
            hint.classList.remove('vh-swipe-hint--show');
            localStorage.setItem('vnh_swipe_hint_seen', '1');
          }, 3600);
        }
      }, 2000);
    }
  }

  function _openDrawer() {
    _isOpen = true;
    document.documentElement.setAttribute('data-nav-open', 'true');
    document.body.style.overflow = 'hidden';

    const btn = document.getElementById('vhHamburger');
    if (btn) {
      btn.setAttribute('aria-expanded', 'true');
      btn.setAttribute('aria-label', 'Cerrar menú de navegación');
    }

    const firstNavBtn = document.querySelector('.vh-main-nav .vh-nav__btn:not([disabled])');
    setTimeout(() => firstNavBtn?.focus(), 100);
  }

  function _closeDrawer() {
    _isOpen = false;
    document.documentElement.removeAttribute('data-nav-open');
    document.body.style.overflow = '';

    const btn = document.getElementById('vhHamburger');
    if (btn) {
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('aria-label', 'Abrir menú de navegación');
      btn.focus();
    }
  }

  function _toggleDrawer() {
    _isOpen ? _closeDrawer() : _openDrawer();
  }

  function syncActiveView(viewId) {
    const allBtns = document.querySelectorAll('.vh-bottom-nav__btn');
    allBtns.forEach(btn => {
      const isActive = btn.dataset.view === viewId;
      btn.classList.toggle('vh-bottom-nav__btn--active', isActive);
      btn.setAttribute('aria-current', isActive ? 'page' : 'false');
    });
  }

  function rebuildBottomNav() {
    const existing = document.getElementById('vhBottomNav');
    if (existing) existing.remove();

    _injectMobileUI();
    _bindBottomNavEvents();
  }

  function _bindBottomNavEvents() {
    const bottomBtns = document.querySelectorAll('.vh-bottom-nav__btn');
    const { signal } = _abortCtrl ?? { signal: undefined };

    bottomBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const syncId = btn.dataset.syncTo;
        if (syncId) {
          document.getElementById(syncId)?.click();
        }
        _closeDrawer();
        _haptic('light');
      }, { signal });
    });
  }

  return {
    init() {
      _injectMobileUI();

      _abortCtrl = new AbortController();
      const { signal } = _abortCtrl;

      document.addEventListener('click', (e) => {
        const hamburger = e.target.closest('#vhHamburger');
        if (hamburger) { _toggleDrawer(); return; }
        if (e.target.id === 'vhNavOverlay') { _closeDrawer(); return; }
        if (e.target.closest('.vh-main-nav .vh-nav__btn')) {
          _closeDrawer();
          _haptic('light');
          return;
        }
      }, { signal });

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && _isOpen) _closeDrawer();
      }, { signal });

      _bindBottomNavEvents();

      const navList = document.querySelector('.vh-nav__list');
      if (navList) {
        const observer = new MutationObserver(() => rebuildBottomNav());
        observer.observe(navList, { childList: true, subtree: true, attributes: true });
      }

      console.info('[MobileNavManager] Inicializado.');
    },

    syncActiveView,
    rebuildBottomNav,

    destroy() {
      _abortCtrl?.abort();
      _abortCtrl = null;
      _isOpen = false;
      document.documentElement.removeAttribute('data-nav-open');
      document.body.style.overflow = '';
    },
  };
})();


// ─────────────────────────────────────────────────────────────
// 4. LAZY IMAGE MANAGER
//
// MEJORAS v2:
//  - rootMargin aumentado de 100px → 400px para precargar
//    imágenes antes de que el usuario llegue a ellas.
//  - Transición de fade-in explícita y más rápida (0.25s).
//  - observeAll() excluye imágenes ya cargadas (.is-loaded)
//    para evitar re-observar en re-renders del mismo grid.
// ─────────────────────────────────────────────────────────────

const LazyImageManager = (() => {

  /** @type {IntersectionObserver|null} */
  let _observer = null;

  /**
   * Reemplaza una imagen que falló por un placeholder div controlado.
   * Segunda línea de defensa tras el onerror de render-engine.
   * @param {HTMLImageElement} img
   */
  function _handleImageError(img) {
    if (!img.parentNode) return;

    const placeholder = document.createElement('div');
    placeholder.className   = `${img.className} vh-card__cover-placeholder vh-card__cover-placeholder--error`;
    placeholder.textContent = '📖';
    placeholder.setAttribute('role', 'img');
    placeholder.setAttribute('aria-label', 'Imagen no disponible');

    img.parentNode.replaceChild(placeholder, img);
  }

  /**
   * Callback del IntersectionObserver.
   * @param {IntersectionObserverEntry[]} entries
   */
  function _onIntersect(entries) {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;

      const img = entry.target;
      _observer?.unobserve(img);

      // Ya cargó (caché del navegador) → activar inmediatamente
      if (img.complete && img.naturalWidth > 0) {
        img.classList.add('is-loaded');
        return;
      }

      // Ya falló → placeholder
      if (img.complete && img.naturalWidth === 0) {
        _handleImageError(img);
        return;
      }

      // Aún cargando → esperar eventos
      img.addEventListener('load', () => {
        img.classList.add('is-loaded');
      }, { once: true });

      img.addEventListener('error', () => {
        _handleImageError(img);
      }, { once: true });
    });
  }

  return {
    /**
     * Inicializa el IntersectionObserver.
     *
     * rootMargin: '400px 0px'
     *  Las imágenes se empiezan a cargar cuando están a 400px del
     *  viewport (aprox. 2 filas de cards antes de ser visibles).
     *  Con el SW en Cache-First, la segunda carga es desde disco
     *  local, por lo que 400px es suficiente incluso en scroll rápido.
     *
     * PROGRESSIVE ENHANCEMENT:
     *  Si IntersectionObserver no está disponible, las imágenes son
     *  visibles de inmediato con comportamiento nativo del navegador.
     */
    init() {
      if (!window.IntersectionObserver) return;

      document.body.classList.add('js-lazy-active');

      _observer = new IntersectionObserver(_onIntersect, {
        rootMargin: '400px 0px', // ← era 100px, aumentado a 400px
        threshold:  0.01,
      });

      this.observeAll();
    },

    /**
     * Observa las imágenes lazy del grid que aún no han cargado.
     * Se llama tras cada render de nuevas cards.
     *
     * MEJORA: el selector excluye imágenes ya cargadas (.is-loaded)
     * y las que fallaron (.vh-card__cover-placeholder--error) para
     * no desperdiciar entradas del observer en elementos ya resueltos.
     */
    observeAll() {
      if (!_observer) return;
      const imgs = document.querySelectorAll(
        '.vh-card__cover[loading="lazy"]:not(.is-loaded):not(.vh-card__cover-placeholder--error)'
      );
      imgs.forEach(img => _observer.observe(img));
    },

    destroy() {
      _observer?.disconnect();
      _observer = null;
      document.body.classList.remove('js-lazy-active');
    },
  };
})();


// ─────────────────────────────────────────────────────────────
// EXPORTACIONES
// ─────────────────────────────────────────────────────────────

export {
  SwipeNavigator,
  PullToRefresh,
  MobileNavManager,
  LazyImageManager,
};
