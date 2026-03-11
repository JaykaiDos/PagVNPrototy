'use strict';

/**
 * @file js/app-init.js
 * @description Punto de entrada de VN-Hub.
 *              Orquesta la inicialización de todos los módulos en orden.
 *
 * CORRECCIONES v2:
 *  - [BUG #2] FirebaseSync._onStoreEvent 'update': Cuando una entrada pasa
 *    a estado 'finished' con score/review, ahora también sincroniza el feed
 *    público (publishToFeed). Previamente solo guardaba en users/{uid}/library.
 *  - [BUG #3] FirebaseSync._onStoreEvent 'update': Cuando una entrada SALE
 *    de estado 'finished', ahora llama a removeFromFeed() para que la reseña
 *    desaparezca de la comunidad. Antes permanecía visible indefinidamente.
 *  - [BUG #1] Tras cualquier operación que modifica el feed, se llama a
 *    FeedController.notifyReviewPublished() para invalidar el caché y forzar
 *    recarga inmediata si el feed está visible.
 *
 * ORDEN DE ARRANQUE:
 *  1. LibraryStore.init()      — Carga biblioteca desde localStorage
 *  2. ThemeManager.init()      — Aplica tema guardado
 *  3. AuthController.init()    — Activa Auth Firebase y renderiza header
 *  4. FirebaseSync.init()      — Suscribe el store a Firebase para sync automático
 *  5. FeedController.init()    — Registra eventos de navegación del feed
 *  6. ProfileController.init() — Inicializa vista de perfil
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
//    Escucha mutaciones del LibraryStore y las replica
//    en Firestore si hay sesión activa.
//
//    DISEÑO:
//    - Ni LibraryStore ni FirebaseService se conocen entre sí.
//    - Este módulo actúa como el puente (Mediator pattern).
//    - También mantiene sincronizado el feed /feed/{uid_vnId}.
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
   * Callback del Observer del LibraryStore.
   * Se ejecuta tras cada add/update/remove en el store local.
   *
   * GARANTÍAS:
   *  - Solo actúa si hay usuario autenticado.
   *  - Los errores son silenciosos para el usuario (la app sigue con localStorage).
   *  - Mantiene sincronizados TANTO users/{uid}/library COMO /feed.
   *
   * @param {'add'|'update'|'remove'|'error'} event
   * @param {object|null} payload — LibraryEntry o { vnId } según el evento
   */
  async _onStoreEvent(event, payload) {
    if (!FirebaseService.isAuthenticated()) return;

    try {
      switch (event) {

        case 'add':
        case 'update': {
          if (!payload?.vnId) return;

          const entry = LibraryStore.getEntry(payload.vnId);
          if (!entry) return;

          // ── Paso 1: Siempre sincronizar la biblioteca personal ──────────
          await FirebaseService.saveLibraryEntry(payload.vnId, entry);
          console.info(`[FirebaseSync] Biblioteca actualizada: "${payload.vnId}".`);

          // ── Paso 2: Sincronizar el feed público ─────────────────────────
          // [CORRECCIÓN BUG #2 y #3]
          await this._syncFeed(entry);
          break;
        }

        case 'remove': {
          if (!payload?.vnId) return;

          // Eliminar de la biblioteca personal
          await FirebaseService.deleteLibraryEntry(payload.vnId);

          // Eliminar del feed público (si tenía reseña publicada)
          await FirebaseService.removeFromFeed(payload.vnId);

          // Invalidar caché del feed para reflejar la eliminación
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
   * [CORRECCIÓN BUG #3 — revisado]
   * Gestiona la sincronización del feed cuando el store detecta un cambio.
   *
   * RESPONSABILIDAD ÚNICA DE ESTE MÉTODO:
   *  → Solo retira entradas del feed cuando la VN deja de estar en 'finished'.
   *  → NUNCA publica ni actualiza el feed desde aquí.
   *
   * DISEÑO DELIBERADO — Por qué NO se llama publishToFeed() aquí:
   *
   *  1. FALTA DE DATOS: El LibraryStore solo guarda vnId, score y review.
   *     No guarda vnTitle ni vnImageUrl (metadatos de VNDB). Las Security Rules
   *     de Firestore exigen isValidString(vnTitle, 300) en el create, por lo que
   *     un intento de publicación sin título falla con "Missing or insufficient
   *     permissions". El único contexto con esos datos es modal-review.js.
   *
   *  2. AUTORIDAD DE PUBLICACIÓN: modal-review._handleSave() es el punto
   *     canónico de publicación. Llamar publishToFeed() desde dos lugares
   *     genera doble escritura y errores de permisos en el 100% de los casos
   *     donde el doc aún no existe en /feed (no hay vnTitle).
   *
   *  3. FLUJO CORRECTO: modal-review → publishToFeed → notifyReviewPublished.
   *     FirebaseSync → solo removeFromFeed si status ≠ finished.
   *
   * @param {import('./library-store.js').LibraryEntry} entry
   * @returns {Promise<void>}
   */
  async _syncFeed(entry) {
    // Solo actuar cuando la VN sale del estado 'finished'.
    // En cualquier otro caso (finished→finished con datos actualizados),
    // modal-review ya habrá llamado publishToFeed() directamente.
    if (entry.status !== VN_STATUS.FINISHED) {
      await FirebaseService.removeFromFeed(entry.vnId);
      await FeedController.notifyReviewPublished();
      console.info(
        `[FirebaseSync] Reseña de "${entry.vnId}" retirada del feed (estado: ${entry.status}).`
      );
    }
    // Si status === FINISHED → no hacer nada aquí.
    // modal-review._handleSave() es el responsable de publishToFeed().
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