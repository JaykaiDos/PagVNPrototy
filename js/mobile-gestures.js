/**
 * @file js/mobile-gestures.js
 * @description Sistema de gestos táctiles para VN-Hub.
 *
 * REESCRITURA v3 — Corrección definitiva de carga de imágenes:
 * ─────────────────────────────────────────────────────────────────
 *  LazyImageManager — Problemas encontrados y corregidos:
 *
 *  BUG-01: El evento 'vnh:cards:rendered' nunca se disparaba desde
 *    render-engine.js ni ui-controller.js, por lo que observeAll()
 *    post-render jamás se ejecutaba. Las imágenes quedaban en negro
 *    porque el observer se inicializaba ANTES de que existieran en el DOM.
 *    FIX: MutationObserver sobre los grids de cards para detectar
 *    automáticamente cuando se insertan nuevas imágenes, sin depender
 *    de eventos externos que nadie emitía.
 *
 *  BUG-02: Conflicto entre loading="lazy" nativo y el IntersectionObserver
 *    manual. El navegador posponía la carga (lazy nativo), el observer
 *    la esperaba (lazy manual), y el resultado era que ninguno avanzaba
 *    en ciertos estados de scroll/viewport.
 *    FIX: Las imágenes en el viewport o cercanas se fuerzan a loading="eager"
 *    en el momento de observación. Las lejanas mantienen lazy nativo como
 *    fallback de segundo nivel.
 *
 *  BUG-03: Sin timeout. Una imagen que tardaba en responder bloqueaba
 *    su slot indefinidamente, mostrando fondo negro sin fallback.
 *    FIX: Timeout de 8 segundos por imagen. Si vence, se muestra el
 *    placeholder de emoji sin esperar más.
 *
 *  BUG-04: observeAll() con selector muy específico que excluía imágenes
 *    recién insertadas si aún no tenían la clase correcta.
 *    FIX: Selector simplificado + MutationObserver que cubre todos los casos.
 *
 * MÓDULOS EXPORTADOS:
 *  - SwipeNavigator   — swipe horizontal para cambiar entre vistas
 *  - PullToRefresh    — pull-to-refresh para recargar la vista activa
 *  - MobileNavManager — hamburger menu + bottom bar sync
 *  - LazyImageManager — carga progresiva de portadas con fallbacks robustos
 *
 * @module mobile-gestures
 * @version 3.0
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
// 4. LAZY IMAGE MANAGER — v3 REESCRITURA COMPLETA
//
// ARQUITECTURA:
//  El problema central era que el sistema dependía de un evento
//  'vnh:cards:rendered' que NUNCA se emitía desde el código que
//  renderiza las cards. Esto causaba que las imágenes insertadas
//  después del init() no fueran observadas nunca.
//
//  SOLUCIÓN: MutationObserver sobre el documento completo para
//  detectar la inserción de nuevas imágenes de forma automática,
//  independientemente de qué módulo las inserte y sin requerir
//  ningún evento personalizado.
//
// FLUJO CORREGIDO:
//  1. init() → activa body.js-lazy-active + IntersectionObserver
//  2. MutationObserver detecta nuevos <img class="vh-card__cover">
//  3. Para cada imagen nueva → _processImage()
//     a. Si está en viewport → forzar eager + marcar loaded
//     b. Si está cerca (rootMargin 600px) → IntersectionObserver
//     c. Al intersectar → remover lazy nativo + disparar carga real
//  4. Timeout de 8s por imagen → fallback a placeholder si falla
//
// ─────────────────────────────────────────────────────────────

const LazyImageManager = (() => {

  /** @type {IntersectionObserver|null} */
  let _observer = null;

  /** @type {MutationObserver|null} - Detecta nuevas imágenes en el DOM */
  let _mutationObserver = null;

  /**
   * Timeout por imagen en ms.
   * Si la imagen no carga en este tiempo, se muestra el placeholder.
   * 8 segundos es generoso pero evita esperas infinitas.
   */
  const IMAGE_LOAD_TIMEOUT_MS = 8_000;

  /**
   * Selector de imágenes de portada que deben cargarse progresivamente.
   * Importante: NO incluir .is-loaded para evitar re-procesar.
   */
  const IMG_SELECTOR = '.vh-card__cover[src]:not(.is-loaded):not([data-vnh-processing])';

  // ── HELPERS ──────────────────────────────────────────────────

  /**
   * Reemplaza una imagen que falló o tardó demasiado por un placeholder.
   * Opera tanto en el caso de error como de timeout.
   *
   * @param {HTMLImageElement} img
   * @param {'error'|'timeout'} reason
   */
  function _applyPlaceholder(img, reason = 'error') {
    if (!img.parentNode || img.dataset.vhnFailed) return;
    img.dataset.vhnFailed = '1';

    const placeholder = document.createElement('div');
    placeholder.className   = `${img.className.replace(/is-loaded/g, '')} vh-card__cover-placeholder vh-card__cover-placeholder--error`;
    placeholder.textContent = '📖';
    placeholder.setAttribute('role', 'img');
    placeholder.setAttribute('aria-label', `Imagen no disponible${reason === 'timeout' ? ' (timeout)' : ''}`);

    img.parentNode.replaceChild(placeholder, img);

    if (reason === 'timeout') {
      console.debug('[LazyImageManager] Timeout de imagen, mostrando placeholder.');
    }
  }

  /**
   * Marca una imagen como cargada correctamente.
   * Añade la clase is-loaded que activa el fade-in CSS.
   *
   * @param {HTMLImageElement} img
   */
  function _markLoaded(img) {
    if (!img.parentNode || img.dataset.vhnFailed) return;
    img.classList.add('is-loaded');
  }

  /**
   * Adjunta los event listeners de carga a una imagen,
   * incluyendo un timeout de seguridad.
   *
   * FLUJO:
   *  - Si ya cargó (caché del navegador) → marcar inmediatamente.
   *  - Si falló → placeholder inmediato.
   *  - Si está cargando → esperar load/error + timeout.
   *
   * @param {HTMLImageElement} img
   */
  function _attachLoadHandlers(img) {
    // Marcar como en procesamiento para no duplicar handlers
    img.dataset.vhnProcessing = '1';

    // Caso 1: ya está en caché del navegador → completo inmediatamente
    if (img.complete) {
      if (img.naturalWidth > 0) {
        _markLoaded(img);
      } else {
        _applyPlaceholder(img, 'error');
      }
      return;
    }

    // Caso 2: aún cargando → instalar handlers + timeout
    let settled = false;

    const settle = (success) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (success) {
        _markLoaded(img);
      } else {
        _applyPlaceholder(img, 'error');
      }
    };

    // Timeout de seguridad: si la imagen no responde, mostrar placeholder
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        _applyPlaceholder(img, 'timeout');
      }
    }, IMAGE_LOAD_TIMEOUT_MS);

    img.addEventListener('load',  () => settle(true),  { once: true });
    img.addEventListener('error', () => settle(false), { once: true });
  }

  /**
   * Procesa una imagen recién detectada.
   *
   * DECISIÓN DE ESTRATEGIA:
   *  - Si el IntersectionObserver está disponible → delegar observación.
   *  - Si no → carga inmediata (progressive enhancement).
   *
   * @param {HTMLImageElement} img
   */
  function _processImage(img) {
    // Saltar si ya fue procesada, no tiene src, o es un placeholder
    if (
      img.dataset.vhnProcessing ||
      img.dataset.vhnFailed      ||
      img.classList.contains('is-loaded') ||
      !img.getAttribute('src')
    ) return;

    // Sin IntersectionObserver: cargar directamente
    if (!_observer) {
      _attachLoadHandlers(img);
      return;
    }

    // Con IntersectionObserver: registrar para observación lazy
    // La marca de procesamiento se añade dentro de _attachLoadHandlers
    // al intersectar; aquí solo marcamos que el observer la tiene.
    img.dataset.vhnProcessing = 'pending';
    _observer.observe(img);
  }

  /**
   * Callback del IntersectionObserver.
   * Cuando una imagen entra en el área de observación, se activa su carga.
   *
   * CORRECCIÓN BUG-02:
   *  Al intersectar, forzamos loading="eager" para cancelar el defer
   *  nativo del navegador. Sin esto, el navegador podía ignorar la imagen
   *  a pesar de estar en el viewport porque ya la había deferido con lazy.
   *
   * @param {IntersectionObserverEntry[]} entries
   */
  function _onIntersect(entries) {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;

      const img = /** @type {HTMLImageElement} */ (entry.target);
      _observer?.unobserve(img);

      // Forzar eager loading para cancelar el defer nativo
      // Esto es seguro porque ya sabemos que la imagen está cerca del viewport
      img.setAttribute('loading', 'eager');

      // Adjuntar handlers de carga
      _attachLoadHandlers(img);
    });
  }

  /**
   * Escanea el DOM completo en busca de imágenes sin procesar.
   * Se llama después de cada renderizado masivo.
   */
  function _scanAll() {
    const imgs = document.querySelectorAll(IMG_SELECTOR);
    imgs.forEach(_processImage);
  }

  /**
   * Configura el MutationObserver que detecta nuevas imágenes
   * insertadas en el DOM por cualquier módulo (render-engine,
   * explore-controller, etc.) sin requerir eventos personalizados.
   *
   * CORRECCIÓN BUG-01:
   *  Antes se dependía de 'vnh:cards:rendered', que nunca se emitía.
   *  Ahora el MutationObserver detecta cualquier inserción de nodo
   *  que contenga imágenes de portada.
   */
  function _startMutationObserver() {
    if (!window.MutationObserver) return;

    // Debounce para evitar múltiples _scanAll() en ráfagas de inserción
    let scanTimer = null;
    const debouncedScan = () => {
      clearTimeout(scanTimer);
      scanTimer = setTimeout(_scanAll, 50);
    };

    _mutationObserver = new MutationObserver((mutations) => {
      let hasNewImages = false;

      for (const mutation of mutations) {
        if (mutation.type !== 'childList') continue;

        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;

          // Verificar si el nodo añadido ES una imagen de portada
          // o CONTIENE imágenes de portada
          if (
            (node.matches && node.matches('.vh-card__cover')) ||
            (node.querySelector && node.querySelector('.vh-card__cover'))
          ) {
            hasNewImages = true;
            break;
          }
        }
        if (hasNewImages) break;
      }

      if (hasNewImages) {
        debouncedScan();
      }
    });

    // Observar todo el body: cualquier inserción de cards en cualquier grid
    _mutationObserver.observe(document.body, {
      childList: true,
      subtree:   true,
    });
  }

  // ── API PÚBLICA ──────────────────────────────────────────────

  return {

    /**
     * Inicializa el sistema de carga progresiva.
     *
     * CAMBIOS v3:
     *  1. rootMargin ampliado a 600px para precargar más agresivamente.
     *  2. MutationObserver sustituye al evento 'vnh:cards:rendered'.
     *  3. _scanAll() inicial cubre imágenes ya presentes al init.
     *  4. Timeout de 8s por imagen para evitar esperas indefinidas.
     */
    init() {
      if (!window.IntersectionObserver) {
        // Sin IO: marcar y cargar todo directamente
        document.body.classList.add('js-lazy-active');
        _scanAll();
        return;
      }

      document.body.classList.add('js-lazy-active');

      _observer = new IntersectionObserver(_onIntersect, {
        // 600px de margen: ~3 filas de cards se precargan antes de ser visibles.
        // Mayor margen = menos negro = mejor UX especialmente en conexiones lentas.
        rootMargin: '600px 0px',
        threshold:  0,
      });

      // Escanear imágenes que ya están en el DOM al inicializar
      _scanAll();

      // Activar el MutationObserver para detectar inserción de nuevas cards
      _startMutationObserver();

      // Mantener compatibilidad: también escuchar el evento si alguien lo emite
      document.addEventListener('vnh:cards:rendered', _scanAll);

      console.info('[LazyImageManager] Inicializado v3 con MutationObserver ✓');
    },

    /**
     * Fuerza un escaneo manual del DOM.
     * Útil para ser llamado desde código externo si es necesario.
     * Preservado por compatibilidad hacia atrás con app-init.js.
     */
    observeAll() {
      _scanAll();
    },

    /**
     * Limpia todos los recursos del manager.
     */
    destroy() {
      _observer?.disconnect();
      _observer = null;

      _mutationObserver?.disconnect();
      _mutationObserver = null;

      document.removeEventListener('vnh:cards:rendered', _scanAll);
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