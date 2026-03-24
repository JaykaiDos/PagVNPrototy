'use strict';

/**
 * @file js/app-init.js
 * @description Punto de entrada único de VN-Hub.
 *              Orquesta la inicialización de todos los módulos en orden.
 *
 * CORRECCIÓN v4 — _syncFeed() se disparaba durante la restauración inicial:
 * ─────────────────────────────────────────────────────────────────────────
 *  PROBLEMA:
 *   auth-controller._syncLibraryOnLogin() restaura entradas desde Firestore
 *   llamando a LibraryStore.addVn() / updateReview() / updateLog() etc.
 *   Cada una de esas escrituras dispara el Observer del store con evento
 *   'add' o 'update', que a su vez llamaba a FirebaseSync._syncFeed().
 *   _syncFeed() comprueba: "¿el estado NO es finished? → removeFromFeed()".
 *   Resultado: durante la carga inicial se intentaban borrar del feed
 *   entradas en estado pending/playing/dropped que el usuario nunca tocó.
 *   En la consola aparecía:
 *     [FirebaseSync] Reseña de "vXXX" retirada del feed (estado: pending)
 *
 *  SOLUCIÓN — Flag `_isSyncing`:
 *   FirebaseSync expone un flag booleano que auth-controller activa
 *   ANTES de restaurar la biblioteca y desactiva AL TERMINAR.
 *   Mientras el flag está activo, _onStoreEvent ignora los eventos
 *   'add'/'update' para no disparar lógica de feed ni Firestore durante
 *   una operación de restauración que ya proviene de Firestore.
 *
 *   IMPORTANTE: el flag NO suprime los eventos 'remove' (que sí son
 *   intencionales incluso durante sincronización, aunque en la práctica
 *   no ocurren). Solo silencia las escrituras reactivas al feed.
 *
 * CORRECCIÓN v3 (previa, mantenida):
 *   UiController.init is not a function — ui-controller.js NO exporta
 *   init(); se auto-inicializa. Solo importar es suficiente.
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

  /**
   * Flag de sincronización inicial.
   *
   * PROPÓSITO:
   *  Cuando auth-controller restaura la biblioteca desde Firestore,
   *  cada escritura al store dispara el Observer con 'add'/'update'.
   *  Sin este flag, _syncFeed() intentaría borrar del feed entradas
   *  en estado pending/playing/dropped que el usuario nunca modificó.
   *
   *  Flujo correcto:
   *    1. auth-controller llama FirebaseSync.beginSync() → _isSyncing = true
   *    2. auth-controller restaura todas las entradas (addVn, updateReview…)
   *    3. auth-controller llama FirebaseSync.endSync()   → _isSyncing = false
   *    4. A partir de aquí, los eventos del store son acciones reales del
   *       usuario y se procesan normalmente.
   *
   * @type {boolean}
   */
  _isSyncing: false,

  /**
   * Activa el modo de sincronización silenciosa.
   * Llamar ANTES de restaurar entradas desde Firestore.
   */
  beginSync() {
    this._isSyncing = true;
  },

  /**
   * Desactiva el modo de sincronización silenciosa.
   * Llamar DESPUÉS de que auth-controller termine de restaurar la biblioteca.
   */
  endSync() {
    this._isSyncing = false;
  },

  init() {
    LibraryStore.subscribe(this._onStoreEvent.bind(this));
  },

  async _onStoreEvent(event, payload) {
    if (!FirebaseService.isAuthenticated()) return;

    // CORRECCIÓN v4:
    // Durante la restauración inicial (_isSyncing = true), los eventos
    // 'add'/'update' provienen de auth-controller reconstruyendo el store
    // con datos ya persistidos en Firestore. No tiene sentido escribir de
    // vuelta a Firestore ni modificar el feed en ese momento.
    //
    // Nota: 'remove' NO se suprime porque, aunque raro durante la sync,
    // un remove siempre es intencional y no genera el ruido del feed.
    if (this._isSyncing && (event === 'add' || event === 'update')) {
      return;
    }

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

  /**
   * Sincroniza el feed con el estado actual de la entrada.
   *
   * REGLA DE NEGOCIO:
   *  - Solo las entradas en estado FINISHED con reseña se publican en el feed.
   *  - Si el estado cambia a cualquier otro (pending, playing, dropped),
   *    se retira la reseña del feed si existía.
   *  - Esta función solo se llama ante cambios REALES del usuario
   *    (no durante la restauración inicial gracias al flag _isSyncing).
   *
   * @param {import('./library-store.js').LibraryEntry} entry
   */
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
 *  4. FirebaseSync      — se suscribe al store (con flag _isSyncing disponible)
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
  // IMPORTANTE: AuthController necesita acceso a FirebaseSync para usar
  // beginSync()/endSync() durante _syncLibraryOnLogin(). FirebaseSync
  // se expone vía la exportación de este módulo (ver abajo).
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

/**
 * ThemeManager — usado por ui-controller y novel-details para el toggle de tema.
 * FirebaseSync — exportado para que auth-controller pueda llamar
 *   beginSync()/endSync() y silenciar los eventos del store durante
 *   la restauración inicial de la biblioteca desde Firestore.
 */
export { ThemeManager, FirebaseSync };