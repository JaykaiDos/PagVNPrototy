'use strict';

/**
 * @file js/app-init.js
 * @description Punto de entrada de VN-Hub.
 *              Orquesta la inicialización de todos los módulos en orden.
 *
 * ORDEN DE ARRANQUE:
 *  1. LibraryStore.init()      — Carga biblioteca desde localStorage
 *  2. ThemeManager.init()      — Aplica tema guardado
 *  3. AuthController.init()    — Activa Auth Firebase y renderiza header
 *  4. FirebaseSync.init()      — Suscribe el store a Firebase para sync automático
 *
 * FILOSOFÍA:
 *  - Este archivo NO contiene lógica de negocio.
 *  - Solo orquesta la secuencia de arranque.
 *  - Cada módulo falla de forma aislada (no bloquea los demás).
 */

import * as ProfileController from './profile-controller.js';
import * as FeedController from './feed-controller.js';
import * as LibraryStore    from './library-store.js';
import * as AuthController  from './auth-controller.js';
import * as FirebaseService from './firebase-service.js';
import { STORAGE_KEY_THEME, DEFAULT_THEME } from './constants.js';


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
//    Escucha mutaciones del LibraryStore y las replica
//    en Firestore si hay sesión activa.
//    Desacoplado: ni LibraryStore ni FirebaseService
//    se conocen entre sí — este módulo los conecta.
// ════════════════════════════════════════════════════════

const FirebaseSync = {

  /**
   * Suscribe el Observer del store para sincronizar
   * cada mutación con Firestore en segundo plano.
   */
  init() {
    LibraryStore.subscribe(this._onStoreEvent.bind(this));
  },

  /**
   * Callback del Observer del store.
   * Solo actúa si hay usuario autenticado.
   *
   * @param {'add'|'update'|'remove'|'error'} event
   * @param {{vnId: string, entry: object}|null} payload
   */
  async _onStoreEvent(event, payload) {
    // Sin sesión activa: no sincronizar
    if (!FirebaseService.isAuthenticated()) return;

    try {
      switch (event) {
        case 'add':
        case 'update': {
          if (!payload?.vnId) return;
          const entry = LibraryStore.getEntry(payload.vnId);
          if (entry) {
            await FirebaseService.saveLibraryEntry(payload.vnId, entry);
            console.info(`[FirebaseSync] Guardada "${payload.vnId}" en Firestore.`);
          }
          break;
        }

        case 'remove': {
          if (!payload?.vnId) return;
          await FirebaseService.deleteLibraryEntry(payload.vnId);
          // Si tenía reseña publicada en el feed, también la eliminamos
          await FirebaseService.removeFromFeed(payload.vnId);
           console.info(`[FirebaseSync] Eliminada "${payload.vnId}" de Firestore y del feed (si existía).`);
          break;
        }

        case 'error':
          // Errores del store no se sincronizan, solo se loguean
          console.warn('[FirebaseSync] Evento de error en el store:', payload);
          break;
      }
    } catch (err) {
      // Los errores de sync son silenciosos para el usuario
      // (la app sigue funcionando con localStorage como fallback)
      console.error('[FirebaseSync] Error al sincronizar con Firestore:', err);
    }
  },
};


// ════════════════════════════════════════════════════════
// 3. BOOTSTRAP
// ════════════════════════════════════════════════════════

/**
 * Inicializa todos los módulos en orden.
 * Cada paso está en try/catch independiente para resiliencia.
 */
function _bootstrap() {

  // ── 1. Biblioteca local (CRÍTICO: debe ser primero)
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

  // ── 3. Auth Controller (Firebase Auth + render del header)
  try {
    AuthController.init();
  } catch (err) {
    console.error('[VN-Hub] Error al inicializar AuthController:', err);
  }

  // ── 4. Sincronización automática store → Firestore
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

  console.info('[VN-Hub] Aplicación inicializada ✓');
}

_bootstrap();


// ════════════════════════════════════════════════════════
// EXPORTACIÓN
// ════════════════════════════════════════════════════════
export { ThemeManager };
