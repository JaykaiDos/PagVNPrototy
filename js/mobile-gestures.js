/**
 * @file js/mobile-gestures.js
 * @description Sistema de gestos táctiles para VN-Hub.
 *
 * MÓDULOS EXPORTADOS:
 *  - SwipeNavigator   — swipe horizontal para cambiar entre vistas principales
 *  - PullToRefresh    — pull-to-refresh para recargar la vista activa
 *  - TouchFeedback    — haptic feedback leve en acciones (si disponible)
 *  - MobileNavManager — hamburger menu + bottom bar sync
 *
 * PRINCIPIOS:
 *  - Sin dependencias externas.
 *  - Passive event listeners para no bloquear el scroll nativo.
 *  - Respeta prefers-reduced-motion.
 *  - Limpia sus listeners al destruirse (no memory leaks).
 *
 * @module mobile-gestures
 */

'use strict';


// ─────────────────────────────────────────────────────────────
// UTILIDADES INTERNAS
// ─────────────────────────────────────────────────────────────

/**
 * Comprueba si el dispositivo tiene pantalla táctil.
 * @returns {boolean}
 */
function _isTouchDevice() {
  return window.matchMedia('(pointer: coarse)').matches
    || navigator.maxTouchPoints > 0;
}

/**
 * Comprueba si el usuario prefiere reducir animaciones.
 * @returns {boolean}
 */
function _prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Vibración háptica leve usando Vibration API (si disponible).
 * @param {'light'|'medium'|'heavy'} [intensity='light']
 */
function _haptic(intensity = 'light') {
  if (!navigator.vibrate) return;
  const patterns = { light: [10], medium: [20], heavy: [40, 20, 40] };
  navigator.vibrate(patterns[intensity] ?? patterns.light);
}


// ─────────────────────────────────────────────────────────────
// 1. SWIPE NAVIGATOR
//    Detecta swipe izquierda/derecha y cambia entre las vistas
//    principales (Buscar ↔ Biblioteca ↔ Comunidad ↔ Perfil).
// ─────────────────────────────────────────────────────────────

/**
 * @typedef {Object} SwipeNavigatorOptions
 * @property {string[]} views         — IDs de los botones de nav en orden
 * @property {number}   [threshold]   — px mínimos para registrar swipe (default: 60)
 * @property {number}   [maxVertical] — px máx de desviación vertical permitida (default: 80)
 * @property {Function} [onSwipe]     — callback(direction: 'left'|'right', newViewId: string)
 */

const SwipeNavigator = (() => {

  /** @type {SwipeNavigatorOptions|null} */
  let _opts = null;

  /** @type {string[]} IDs de los botones de nav visibles */
  let _viewIds = [];

  /** @type {number} Índice de la vista activa */
  let _activeIndex = 0;

  // Estado del toque activo
  let _startX = 0;
  let _startY = 0;
  let _startTime = 0;
  let _tracking = false;

  // AbortController para cleanup limpio
  let _abortCtrl = null;

  /**
   * Obtiene el índice de la vista activa leyendo el DOM.
   * @returns {number}
   */
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

  /**
   * Navega a la vista en el índice dado, disparando un click en el botón.
   * @param {number} index
   * @param {'left'|'right'} direction
   */
  function _navigateTo(index, direction) {
    if (index < 0 || index >= _viewIds.length) return;

    const btn = document.getElementById(_viewIds[index]);
    if (!btn || btn.closest('[hidden]')) return;

    _activeIndex = index;
    _haptic('light');

    // Disparar click para que ui-controller maneje el cambio de vista
    btn.click();

    if (_opts?.onSwipe) {
      _opts.onSwipe(direction, _viewIds[index]);
    }
  }

  /**
   * Maneja touchstart: registra punto de inicio.
   * @param {TouchEvent} e
   */
  function _onTouchStart(e) {
    // No iniciar si el touch viene de un scroll container (tabs, cards-grid)
    const target = e.target.closest(
      '.vh-tabs, .vep-tags, .vep-year__presets, .vh-cards-grid, input, textarea, select, [contenteditable]'
    );
    if (target) return;

    // No iniciar dentro de modales abiertos
    if (document.querySelector('.vh-modal-backdrop:not([hidden])')) return;

    const t = e.touches[0];
    _startX    = t.clientX;
    _startY    = t.clientY;
    _startTime = performance.now();
    _tracking  = true;
  }

  /**
   * Maneja touchend: evalúa si fue swipe válido.
   * @param {TouchEvent} e
   */
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

    // Validar: horizontal dominante, distancia suficiente, velocidad razonable
    if (absDx < threshold) return;
    if (absDy > maxVertical) return;
    if (absDx < absDy * 1.5) return; // debe ser dominantemente horizontal
    if (dt > 600) return; // muy lento no es swipe intencional

    _activeIndex = _getActiveIndex();

    if (dx < 0) {
      // Swipe izquierda → vista siguiente
      _navigateTo(_activeIndex + 1, 'left');
    } else {
      // Swipe derecha → vista anterior
      _navigateTo(_activeIndex - 1, 'right');
    }
  }

  /**
   * Cancela el tracking en caso de gestos multi-toque.
   */
  function _onTouchCancel() {
    _tracking = false;
  }

  return {
    /**
     * Inicializa el SwipeNavigator.
     *
     * @param {SwipeNavigatorOptions} opts
     */
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

    /**
     * Destruye los listeners y limpia el estado.
     */
    destroy() {
      _abortCtrl?.abort();
      _abortCtrl = null;
      _opts = null;
    },
  };
})();


// ─────────────────────────────────────────────────────────────
// 2. PULL TO REFRESH
//    Detecta pull-down en la parte superior de la página y
//    llama al callback de refresco de la vista activa.
// ─────────────────────────────────────────────────────────────

/**
 * @typedef {Object} PullToRefreshOptions
 * @property {Function}       onRefresh     — async callback a ejecutar al hacer pull
 * @property {number}         [threshold]   — px necesarios para activar (default: 80)
 * @property {number}         [maxPull]     — px máximos de arrastre visual (default: 120)
 * @property {HTMLElement}    [container]   — el elemento que hace scroll (default: document)
 */

const PullToRefresh = (() => {

  let _opts      = null;
  let _indicator = null;
  let _startY    = 0;
  let _currentY  = 0;
  let _tracking  = false;
  let _loading   = false;
  let _abortCtrl = null;

  /**
   * Crea o recupera el elemento indicador de PTR.
   * @returns {HTMLElement}
   */
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

  /**
   * Calcula si la página está en el tope (sin scroll).
   * @returns {boolean}
   */
  function _isAtTop() {
    return (window.scrollY || document.documentElement.scrollTop) <= 2;
  }

  /**
   * Actualiza el indicador visualmente.
   * @param {number} progress — 0 a 1
   */
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

    // Resistencia — no se mueve 1:1 con el dedo
    const maxPull = _opts?.maxPull ?? 120;
    const threshold = _opts?.threshold ?? 80;
    const resistance = 0.45;
    const pulled = Math.min(dy * resistance, maxPull);

    _updateIndicator(pulled / threshold);

    // Prevenir scroll nativo mientras hacemos pull
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
      // ── Activar refresh ──
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

  /**
   * Resetea el indicador con animación suave.
   */
  function _resetIndicator() {
    if (!_indicator) return;
    _indicator.classList.remove('vh-ptr--loading', 'vh-ptr--triggered');
    _updateIndicator(0);
    _startY   = 0;
    _currentY = 0;
  }

  return {
    /**
     * Inicializa el PullToRefresh.
     * @param {PullToRefreshOptions} opts
     */
    init(opts) {
      if (!_isTouchDevice()) return;

      _opts      = opts;
      _indicator = _getOrCreateIndicator();
      _abortCtrl = new AbortController();
      const { signal } = _abortCtrl;

      // NOTA: touchmove necesita passive:false para poder llamar preventDefault.
      // Se añade solo cuando el documento está en el tope para minimizar el impacto.
      document.addEventListener('touchstart', _onTouchStart,  { passive: true,  signal });
      document.addEventListener('touchmove',  _onTouchMove,   { passive: false, signal });
      document.addEventListener('touchend',   _onTouchEnd,    { passive: true,  signal });
      document.addEventListener('touchcancel',_onTouchCancel, { passive: true,  signal });

      console.info('[PullToRefresh] Inicializado.');
    },

    /**
     * Destruye listeners y remueve el indicador del DOM.
     */
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
//    Gestiona apertura/cierre del drawer hamburger,
//    sincroniza el bottom bar con la vista activa,
//    y oculta la top-nav en móvil (reemplazada por bottom bar).
// ─────────────────────────────────────────────────────────────

const MobileNavManager = (() => {

  /** @type {boolean} */
  let _isOpen = false;

  /** @type {AbortController|null} */
  let _abortCtrl = null;

  /**
   * Inyecta los elementos de UI necesarios para mobile que no están en el HTML estático:
   *  - El botón hamburger en el header
   *  - El overlay del drawer
   *  - La bottom navigation bar
   *
   * Se ejecuta UNA SOLA VEZ en init().
   */
  function _injectMobileUI() {

    // ── Hamburger button ──
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
      // Insertar al inicio del inner del header
      const headerInner = document.querySelector('.vh-header__inner');
      if (headerInner) headerInner.prepend(btn);
    }

    // ── Overlay ──
    if (!document.getElementById('vhNavOverlay')) {
      const overlay = document.createElement('div');
      overlay.id          = 'vhNavOverlay';
      overlay.className   = 'vh-nav-overlay';
      overlay.setAttribute('aria-hidden', 'true');
      document.body.appendChild(overlay);
    }

    // ── ID en la nav ──
    const nav = document.querySelector('.vh-main-nav');
    if (nav && !nav.id) nav.id = 'vhMainNav';

    // ── Bottom Navigation Bar ──
    if (!document.getElementById('vhBottomNav')) {
      const bottomNav = document.createElement('nav');
      bottomNav.id        = 'vhBottomNav';
      bottomNav.className = 'vh-bottom-nav';
      bottomNav.setAttribute('aria-label', 'Navegación inferior');

      // Espeja los elementos de la nav principal
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
        btn.dataset.syncTo    = id; // ID del botón nav desktop
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

    // ── Swipe hint (primera visita) ──
    if (!document.getElementById('vhSwipeHint') && !localStorage.getItem('vnh_swipe_hint_seen')) {
      const hint = document.createElement('div');
      hint.id        = 'vhSwipeHint';
      hint.className = 'vh-swipe-hint';
      hint.setAttribute('aria-hidden', 'true');
      hint.textContent = '← Desliza para navegar →';
      document.body.appendChild(hint);

      // Mostrar solo en móvil
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

  /**
   * Abre el drawer de navegación.
   */
  function _openDrawer() {
    _isOpen = true;
    document.documentElement.setAttribute('data-nav-open', 'true');
    document.body.style.overflow = 'hidden';

    const btn = document.getElementById('vhHamburger');
    if (btn) {
      btn.setAttribute('aria-expanded', 'true');
      btn.setAttribute('aria-label', 'Cerrar menú de navegación');
    }

    // Foco al primer botón de nav para accesibilidad
    const firstNavBtn = document.querySelector('.vh-main-nav .vh-nav__btn:not([disabled])');
    setTimeout(() => firstNavBtn?.focus(), 100);
  }

  /**
   * Cierra el drawer de navegación.
   */
  function _closeDrawer() {
    _isOpen = false;
    document.documentElement.removeAttribute('data-nav-open');
    document.body.style.overflow = '';

    const btn = document.getElementById('vhHamburger');
    if (btn) {
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('aria-label', 'Abrir menú de navegación');
      btn.focus(); // devolver foco al botón hamburger
    }
  }

  /**
   * Alterna el estado del drawer.
   */
  function _toggleDrawer() {
    _isOpen ? _closeDrawer() : _openDrawer();
  }

  /**
   * Sincroniza el estado activo del bottom bar con la vista actual.
   * @param {string} viewId — data-view del botón activo
   */
  function syncActiveView(viewId) {
    const allBtns = document.querySelectorAll('.vh-bottom-nav__btn');
    allBtns.forEach(btn => {
      const isActive = btn.dataset.view === viewId;
      btn.classList.toggle('vh-bottom-nav__btn--active', isActive);
      btn.setAttribute('aria-current', isActive ? 'page' : 'false');
    });
  }

  /**
   * Reconstruye el bottom bar cuando nuevos nav items se hacen visibles
   * (ej: después de login, aparecen "Comunidad" y "Perfil").
   */
  function rebuildBottomNav() {
    const existing = document.getElementById('vhBottomNav');
    if (existing) existing.remove();

    // Eliminar el flag para que _injectMobileUI lo recree
    _injectMobileUI();
    _bindBottomNavEvents();
  }

  /**
   * Enlaza los eventos de los botones del bottom nav.
   */
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
    /**
     * Inicializa el MobileNavManager.
     * Debe llamarse DESPUÉS de que el DOM esté listo y los nav items visibles.
     */
    init() {
      _injectMobileUI();

      _abortCtrl = new AbortController();
      const { signal } = _abortCtrl;

      // ── Hamburger click ──
      document.addEventListener('click', (e) => {
        const hamburger = e.target.closest('#vhHamburger');
        if (hamburger) { _toggleDrawer(); return; }

        // Click en overlay → cerrar
        if (e.target.id === 'vhNavOverlay') { _closeDrawer(); return; }

        // Click en nav btn → cerrar drawer
        if (e.target.closest('.vh-main-nav .vh-nav__btn')) {
          _closeDrawer();
          _haptic('light');
          return;
        }
      }, { signal });

      // ── Escape key → cerrar drawer ──
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && _isOpen) _closeDrawer();
      }, { signal });

      // ── Bottom nav events ──
      _bindBottomNavEvents();

      // ── Observar cambios en nav items (login/logout) ──
      const navList = document.querySelector('.vh-nav__list');
      if (navList) {
        const observer = new MutationObserver(() => rebuildBottomNav());
        observer.observe(navList, { childList: true, subtree: true, attributes: true });
      }

      console.info('[MobileNavManager] Inicializado.');
    },

    syncActiveView,
    rebuildBottomNav,

    /**
     * Destruye todos los listeners.
     */
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
// 4. LAZY IMAGE OBSERVER
//    Aplica fade-in a imágenes con loading="lazy" cuando
//    entran al viewport. Más suave que el comportamiento nativo.
// ─────────────────────────────────────────────────────────────

const LazyImageManager = (() => {

  /** @type {IntersectionObserver|null} */
  let _observer = null;

  /**
   * Reemplaza una imagen que falló por un placeholder div controlado.
   * Actúa como segunda línea de defensa tras el onerror de render-engine.
   *
   * CUÁNDO se ejecuta este handler (y no el de render-engine):
   *  - La imagen entró al viewport DESPUÉS de ser creada por render-engine.
   *  - El onerror de render-engine ya se disparó y replaceChild fue llamado.
   *  - En ese caso, `img.parentNode` ya es null → esta función es un no-op seguro.
   *  - Si por alguna razón render-engine no registró su onerror, este actúa.
   *
   * @param {HTMLImageElement} img
   */
  function _handleImageError(img) {
    // Si render-engine ya reemplazó la imagen, parentNode es null → salir
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
   * Se ejecuta cuando una imagen entra al viewport.
   *
   * @param {IntersectionObserverEntry[]} entries
   */
  function _onIntersect(entries) {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;

      const img = entry.target;

      // Dejar de observar inmediatamente — ya entró al viewport
      _observer?.unobserve(img);

      // Si ya cargó (estaba en caché), añadir clase directamente
      if (img.complete && img.naturalWidth > 0) {
        img.classList.add('is-loaded');
        return;
      }

      // Si ya falló (naturalWidth === 0 y complete === true)
      if (img.complete && img.naturalWidth === 0) {
        _handleImageError(img);
        return;
      }

      // Imagen aún cargando — registrar handlers
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
     * Inicializa el IntersectionObserver para el fade-in de imágenes.
     *
     * PROGRESSIVE ENHANCEMENT:
     * La clase 'js-lazy-active' activa el CSS de fade-in (opacity: 0 → 1).
     * Si IntersectionObserver no está disponible, las imágenes son visibles
     * con comportamiento nativo — nunca quedan invisibles.
     */
    init() {
      if (!window.IntersectionObserver) return;

      // Activar fade-in CSS solo cuando JS está operativo
      document.body.classList.add('js-lazy-active');

      _observer = new IntersectionObserver(_onIntersect, {
        rootMargin: '100px 0px', // precargar 100px antes del viewport
        threshold:  0.01,
      });

      this.observeAll();
    },

    /**
     * Observa todas las imágenes lazy de cards que aún no cargaron.
     * Llamar tras cada render de nuevas cards.
     */
    observeAll() {
      if (!_observer) return;
      const imgs = document.querySelectorAll(
        '.vh-card__cover[loading="lazy"]:not(.is-loaded)'
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