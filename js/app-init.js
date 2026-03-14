'use strict';

/**
 * @file js/app-init.js
 * @description Punto de entrada único de VN-Hub.
 *              Orquesta la inicialización de todos los módulos en orden.
 *
 * CORRECCIÓN v3 — UiController.init is not a function:
 *
 *  ui-controller.js NO exporta init(). Su inicialización ocurre mediante
 *  un bloque auto-init al final del módulo (patrón DOMContentLoaded).
 *  Llamar UiController.init() desde aquí lanzaba TypeError.
 *
 *  explore-controller.js SÍ exporta init(), pero también tiene auto-init
 *  propio. Llamarlo explícitamente causaba doble inicialización (el mensaje
 *  "[ExploreController] inicializado" aparecía dos veces en consola).
 *
 *  SOLUCIÓN: Para módulos con auto-init propio, basta con importarlos.
 *  El navegador evalúa el módulo al importarlo, ejecutando el auto-init.
 *  No se necesita llamar ninguna función adicional desde aquí.
 *
 *  MÓDULOS CON AUTO-INIT (solo importar, no llamar init()):
 *    - ui-controller.js      → init() interna, no exportada
 *    - explore-controller.js → init() exportada, pero tiene auto-init propio
 *
 *  MÓDULOS SIN AUTO-INIT (llamar init() explícitamente desde bootstrap):
 *    - LibraryStore, ThemeManager, AuthController, FirebaseSync
 *    - FeedController, ProfileController, MobileSystem
 *
 * FILOSOFÍA:
 *  - Este archivo NO contiene lógica de negocio.
 *  - Solo orquesta la secuencia de arranque.
 *  - Cada módulo falla de forma aislada (no bloquea los demás).
 */

import * as ProfileController from './profile-controller.js';
import * as FeedController    from './feed-controller.js';
import * as LibraryStore      from './library-store.js';
import * as AuthController    from './auth-controller.js';
import * as FirebaseService   from './firebase-service.js';

// Importados para forzar su carga y ejecutar su auto-init interno.
// NO se llama ningún método sobre ellos — se auto-inicializan solos.
import './ui-controller.js';
import './explore-controller.js';

import {
  SwipeNavigator,
  PullToRefresh,
  MobileNavManager,
  LazyImageManager,
} from './mobile-gestures.js';
import { STORAGE_KEY_THEME, DEFAULT_THEME, VN_STATUS } from './constants.js';


// ════════════════════════════════════════════════════════
// 1. THEME MANAGER
// ════════════════════════════════════════════════════════

/**
 * Gestión del tema visual (light/dark).
 * SRP: única responsabilidad es leer/escribir el tema.
 */
const ThemeManager = {

  init() {
    const saved = localStorage.getItem(STORAGE_KEY_THEME);
    const theme = (saved === 'light' || saved === 'dark') ? saved : DEFAULT_THEME;
    this._apply(theme);
  },

  toggle() {
    const current = document.documentElement.dataset.theme ?? DEFAULT_THEME;
    const next    = current === 'light' ? 'dark' : 'light';
    this._apply(next);
    return next;
  },

  current() {
    return document.documentElement.dataset.theme ?? DEFAULT_THEME;
  },

  _apply(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(STORAGE_KEY_THEME, theme);
  },
};


// ════════════════════════════════════════════════════════
// 2. FIREBASE SYNC
// ════════════════════════════════════════════════════════

const FirebaseSync = {

  init() {
    LibraryStore.subscribe(this._onStoreEvent.bind(this));
  },

  async _onStoreEvent(event, payload) {
    if (!FirebaseService.isAuthenticated()) return;

    try {
      switch (event) {

        case 'add':
        case 'update': {
          if (!payload?.vnId) return;
          const entry = LibraryStore.getEntry(payload.vnId);
          if (!entry) return;
          await FirebaseService.saveLibraryEntry(payload.vnId, entry);
          console.info(`[FirebaseSync] Biblioteca actualizada: "${payload.vnId}".`);
          await this._syncFeed(entry);
          break;
        }

        case 'remove': {
          if (!payload?.vnId) return;
          await FirebaseService.deleteLibraryEntry(payload.vnId);
          await FirebaseService.removeFromFeed(payload.vnId);
          await FeedController.notifyReviewPublished();
          console.info(`[FirebaseSync] Eliminada "${payload.vnId}" de biblioteca y feed.`);
          break;
        }

        case 'error':
          console.warn('[FirebaseSync] Evento de error en el store:', payload);
          break;
      }
    } catch (err) {
      console.error('[FirebaseSync] Error al sincronizar con Firestore:', err);
    }
  },

  async _syncFeed(entry) {
    if (entry.status !== VN_STATUS.FINISHED) {
      await FirebaseService.removeFromFeed(entry.vnId);
      await FeedController.notifyReviewPublished();
      console.info(
        `[FirebaseSync] Reseña de "${entry.vnId}" retirada del feed (estado: ${entry.status}).`
      );
    }
  },
};


// ════════════════════════════════════════════════════════
// 3. MOBILE SYSTEM
// ════════════════════════════════════════════════════════

/** IDs de los botones de navegación en orden izquierda→derecha. */
const NAV_VIEW_IDS = ['navSearch', 'navLibrary', 'navFeed', 'navProfile'];

/**
 * Obtiene el data-view de la vista activa en este momento.
 * @returns {string}
 */
function _getActiveViewId() {
  return document.querySelector('.vh-view:not([hidden])')?.dataset?.view ?? '';
}

/**
 * Inicializa todos los módulos del sistema mobile.
 * Ejecutado con requestAnimationFrame para garantizar DOM pintado.
 */
function _initMobileSystem() {

  try {
    MobileNavManager.init();
    document.querySelectorAll('.vh-nav__btn').forEach(btn => {
      btn.addEventListener('click', () => {
        MobileNavManager.syncActiveView(btn.dataset.view ?? '');
      });
    });
    MobileNavManager.syncActiveView(_getActiveViewId());
  } catch (err) {
    console.error('[VN-Hub] Error al inicializar MobileNavManager:', err);
  }

  try {
    SwipeNavigator.init({
      views:       NAV_VIEW_IDS,
      threshold:   60,
      maxVertical: 80,
      onSwipe: (_direction, viewBtnId) => {
        const viewId = document.getElementById(viewBtnId)?.dataset?.view ?? '';
        MobileNavManager.syncActiveView(viewId);
      },
    });
  } catch (err) {
    console.error('[VN-Hub] Error al inicializar SwipeNavigator:', err);
  }

  try {
    PullToRefresh.init({
      threshold: 80,
      maxPull:   120,
      onRefresh: async () => {
        const activeViewId = _getActiveViewId();
        switch (activeViewId) {
          case 'search': {
            const searchInput = document.getElementById('searchInput');
            if (searchInput?.value?.trim()) {
              searchInput.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
              document.querySelector('.vep-quick__btn[aria-pressed="true"]')?.click();
            }
            break;
          }
          case 'library':
            document.dispatchEvent(new CustomEvent('vnh:library:refresh'));
            break;
          case 'feed':
            await FeedController.notifyReviewPublished?.();
            break;
          case 'profile':
            document.dispatchEvent(new CustomEvent('vnh:profile:refresh'));
            break;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      },
    });
  } catch (err) {
    console.error('[VN-Hub] Error al inicializar PullToRefresh:', err);
  }

  try {
    LazyImageManager.init();
    document.addEventListener('vnh:cards:rendered', () => {
      LazyImageManager.observeAll();
    });
  } catch (err) {
    console.error('[VN-Hub] Error al inicializar LazyImageManager:', err);
  }
}


// ════════════════════════════════════════════════════════
// 4. BOOTSTRAP
// ════════════════════════════════════════════════════════

/**
 * Inicializa todos los módulos en orden.
 * Cada paso está en try/catch independiente para resiliencia.
 *
 * ORDEN:
 *  1. LibraryStore      — fuente de verdad local, siempre primero
 *  2. ThemeManager      — evita FOUC antes del primer paint
 *  3. AuthController    — renderiza el header
 *  4. FirebaseSync      — se suscribe al store
 *  5. FeedController    — feed de comunidad
 *  6. ProfileController — perfil de usuario
 *  NOTA: ui-controller y explore-controller ya corrieron su auto-init
 *        al ser evaluados por el import al inicio de este archivo.
 *  7. Mobile system     — requiere DOM pintado → requestAnimationFrame
 */
function _bootstrap() {

  // ── 1. Biblioteca local
  try {
    LibraryStore.init();
  } catch (err) {
    console.error('[VN-Hub] Error al inicializar LibraryStore:', err);
  }

  // ── 2. Tema visual
  try {
    ThemeManager.init();
  } catch (err) {
    console.error('[VN-Hub] Error al aplicar tema:', err);
  }

  // ── 3. Auth Controller
  try {
    AuthController.init();
  } catch (err) {
    console.error('[VN-Hub] Error al inicializar AuthController:', err);
  }

  // ── 4. Firebase Sync
  try {
    FirebaseSync.init();
  } catch (err) {
    console.error('[VN-Hub] Error al inicializar FirebaseSync:', err);
  }

  // ── 5. Feed Controller
  try {
    FeedController.init();
  } catch (err) {
    console.error('[VN-Hub] Error al inicializar FeedController:', err);
  }

  // ── 6. Profile Controller
  try {
    ProfileController.init();
  } catch (err) {
    console.error('[VN-Hub] Error al inicializar ProfileController:', err);
  }

  // ── 7. Log de debug en desarrollo
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    LibraryStore.subscribe((event, payload) => {
      console.debug(`[LibraryStore] ${event}:`, payload?.vnId ?? payload);
    });
  }

  // ── 8. Sistema mobile (requiere DOM completamente pintado)
  requestAnimationFrame(() => {
    _initMobileSystem();
  });

  console.info('[VN-Hub] Aplicación inicializada ✓');
}

_bootstrap();


// ════════════════════════════════════════════════════════
// EXPORTACIÓN
// ════════════════════════════════════════════════════════
export { ThemeManager };