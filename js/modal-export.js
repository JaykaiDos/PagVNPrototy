/**
 * @file js/modal-export.js
 * @description Controlador del modal de exportación de listas de VNs como PNG.
 *
 * RESPONSABILIDAD (SRP):
 *  Este módulo gestiona ÚNICAMENTE la UI del modal de exportación:
 *    - Abrir/cerrar el overlay con animación.
 *    - Mostrar el resumen de la sección a exportar.
 *    - Delegar la generación de la imagen a ExportEngine.
 *    - Actualizar el estado de la barra de progreso.
 *    - Mostrar el resultado final (éxito / error).
 *
 *  La generación del PNG es responsabilidad de ExportEngine (export-engine.js).
 *  La obtención de datos es responsabilidad del llamador (ui-controller.js).
 *
 * USO:
 *   import { ModalExport } from './modal-export.js';
 *
 *   // Abrir modal para la sección "Finalizado":
 *   ModalExport.open({
 *     status:  VN_STATUS.FINISHED,
 *     entries: LibraryStore.getEntriesByStatus(VN_STATUS.FINISHED),
 *     vnCache: _state.vnCache,
 *     theme:   document.documentElement.dataset.theme,
 *   });
 *
 * ESTRUCTURA HTML QUE GESTIONA (inyectada por este módulo en el body):
 *
 *   <div class="vh-export-overlay" id="exportOverlay" role="dialog" ...>
 *     <div class="vh-export-panel">
 *       <span class="vh-export-modal__icon">📸</span>
 *       <h2  class="vh-export-modal__title">Exportar Sección</h2>
 *       <p   class="vh-export-modal__subtitle">...</p>
 *       <div class="vh-export-modal__badge-wrap">
 *         <span class="vh-export-modal__badge vh-export-modal__badge--{status}">
 *           {icon} {label}
 *         </span>
 *       </div>
 *       <div class="vh-export-modal__count">...</div>
 *       <div class="vh-export-progress">
 *         <p   class="vh-export-progress__msg" id="exportProgressMsg"></p>
 *         <div class="vh-export-progress__track">
 *           <div class="vh-export-progress__fill" id="exportProgressFill"></div>
 *         </div>
 *       </div>
 *       <div class="vh-export-modal__actions">
 *         <button class="vh-export-modal__confirm" id="exportConfirmBtn">...</button>
 *         <button class="vh-export-modal__cancel"  id="exportCancelBtn">Cancelar</button>
 *       </div>
 *     </div>
 *   </div>
 *
 * ACCESIBILIDAD:
 *  - role="dialog" + aria-modal="true" + aria-labelledby en el overlay.
 *  - Foco atrapado dentro del modal mientras está abierto.
 *  - ESC cierra el modal (solo si no está en progreso de exportación).
 */

'use strict';

import { VN_STATUS, VN_STATUS_META } from './constants.js';
import { ExportEngine }              from './export-engine.js';


// ─────────────────────────────────────────────
// 1. ESTADO INTERNO DEL MÓDULO
// ─────────────────────────────────────────────

const _state = {
  /** @type {boolean} Si la exportación está en progreso. */
  isExporting: false,

  /** @type {string|null} Estado de la sección actualmente configurada. */
  currentStatus: null,
};

/** @type {object} Caché de referencias DOM del modal (creadas una sola vez). */
let _dom = null;


// ─────────────────────────────────────────────
// 2. CREACIÓN DEL DOM DEL MODAL (lazy, una vez)
//    Se inyecta en el <body> la primera vez que
//    se abre el modal, no al cargar la página.
// ─────────────────────────────────────────────

/**
 * Construye e inyecta el HTML del modal en el <body>.
 * Solo se llama una vez (patrón lazy initialization).
 * @returns {object} Mapa de referencias a los elementos internos.
 */
function _buildModalDOM() {
  const overlay = document.createElement('div');
  overlay.id              = 'exportOverlay';
  overlay.className       = 'vh-export-overlay';
  overlay.setAttribute('role',        'dialog');
  overlay.setAttribute('aria-modal',  'true');
  overlay.setAttribute('aria-labelledby', 'exportModalTitle');

  // HTML interno del panel (construido con strings seguros — sin datos de usuario)
  overlay.innerHTML = `
    <div class="vh-export-panel" id="exportPanel">

      <span class="vh-export-modal__icon" id="exportIcon" aria-hidden="true">📸</span>

      <h2 class="vh-export-modal__title" id="exportModalTitle">
        Exportar como imagen
      </h2>

      <p class="vh-export-modal__subtitle">
        Se generará una imagen PNG con tu lista de novelas.<br>
        Perfecta para compartir por WhatsApp o redes sociales.
      </p>

      <div class="vh-export-modal__badge-wrap">
        <span class="vh-export-modal__badge" id="exportStatusBadge" aria-label="Sección a exportar">
          <!-- Llenado dinámicamente por _populateModal() -->
        </span>
      </div>

      <div class="vh-export-modal__count" id="exportCountInfo" aria-live="polite">
        <!-- Llenado dinámicamente por _populateModal() -->
      </div>

      <div class="vh-export-progress" id="exportProgressSection" hidden>
        <p class="vh-export-progress__msg" id="exportProgressMsg" aria-live="polite">
          Preparando…
        </p>
        <div class="vh-export-progress__track" role="progressbar"
          aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"
          aria-label="Progreso de exportación">
          <div class="vh-export-progress__fill" id="exportProgressFill"></div>
        </div>
      </div>

      <div class="vh-export-modal__actions" id="exportActions">
        <button
          class="vh-export-modal__confirm"
          id="exportConfirmBtn"
          type="button"
        >
          <span aria-hidden="true">📸</span> Generar imagen
        </button>
        <button
          class="vh-export-modal__cancel"
          id="exportCancelBtn"
          type="button"
        >
          Cancelar
        </button>
      </div>

    </div>
  `;

  document.body.appendChild(overlay);

  // Cachear referencias (evita múltiples querySelector por operación)
  return {
    overlay,
    panel:           overlay.querySelector('#exportPanel'),
    icon:            overlay.querySelector('#exportIcon'),
    title:           overlay.querySelector('#exportModalTitle'),
    badge:           overlay.querySelector('#exportStatusBadge'),
    countInfo:       overlay.querySelector('#exportCountInfo'),
    progressSection: overlay.querySelector('#exportProgressSection'),
    progressMsg:     overlay.querySelector('#exportProgressMsg'),
    progressFill:    overlay.querySelector('#exportProgressFill'),
    actions:         overlay.querySelector('#exportActions'),
    confirmBtn:      overlay.querySelector('#exportConfirmBtn'),
    cancelBtn:       overlay.querySelector('#exportCancelBtn'),
  };
}

/**
 * Devuelve las referencias DOM del modal, creándolas si aún no existen.
 * @returns {object} Mapa de referencias DOM.
 */
function _getDOM() {
  if (!_dom) {
    _dom = _buildModalDOM();
    _attachEventListeners();
  }
  return _dom;
}


// ─────────────────────────────────────────────
// 3. POBLACIÓN DEL MODAL CON DATOS DE LA SECCIÓN
// ─────────────────────────────────────────────

/**
 * Rellena el modal con la información del estado y la cantidad de VNs.
 * SEGURIDAD: usa textContent (nunca innerHTML con datos externos).
 *
 * @param {string} status    - Estado de la sección (VN_STATUS).
 * @param {number} count     - Cantidad de VNs en la sección.
 * @param {number} maxExport - Máximo de VNs que se incluirán en la imagen.
 */
function _populateModal(status, count, maxExport) {
  const dom  = _getDOM();
  const meta = VN_STATUS_META[status];

  // Badge del estado
  dom.badge.textContent = `${meta.icon} ${meta.label}`;
  dom.badge.className   = `vh-export-modal__badge vh-export-modal__badge--${status}`;

  // Info de cantidad
  const exportCount = Math.min(count, maxExport);
  dom.countInfo.innerHTML = '';

  // Construir contenido seguro sin innerHTML con datos de usuario
  const countNode = document.createElement('span');
  if (count > maxExport) {
    countNode.innerHTML =
      `Se exportarán las primeras <strong>${exportCount}</strong> de <strong>${count}</strong> novelas ` +
      `(máximo ${maxExport} por imagen).`;
  } else {
    countNode.innerHTML =
      `Se exportarán <strong>${exportCount}</strong> novela${exportCount !== 1 ? 's' : ''} en la imagen.`;
  }
  dom.countInfo.appendChild(countNode);

  // Resetear a estado inicial (confirmación)
  _setPhase('confirm');
}


// ─────────────────────────────────────────────
// 4. FASES DEL MODAL
//    confirm  → muestra botón de confirmar
//    progress → muestra barra de progreso, oculta botones
//    done     → icono de check, botón de cerrar
//    error    → mensaje de error, botón de reintentar
// ─────────────────────────────────────────────

/**
 * Transiciona el modal a una fase visual específica.
 *
 * @param {'confirm'|'progress'|'done'|'error'} phase
 * @param {string} [message] - Mensaje a mostrar en la fase de error.
 */
function _setPhase(phase, message = '') {
  const dom = _getDOM();

  switch (phase) {

    case 'confirm':
      dom.icon.textContent                    = '📸';
      dom.icon.classList.remove('vh-export-modal__icon--done');
      dom.progressSection.hidden              = true;
      dom.actions.hidden                      = false;
      dom.confirmBtn.disabled                 = false;
      dom.confirmBtn.textContent              = '';
      dom.confirmBtn.innerHTML                = '<span aria-hidden="true">📸</span> Generar imagen';
      dom.cancelBtn.textContent               = 'Cancelar';
      dom.progressFill.className              = 'vh-export-progress__fill';
      dom.progressFill.style.width            = '0%';
      break;

    case 'progress':
      dom.progressSection.hidden              = false;
      dom.actions.hidden                      = true;
      dom.progressFill.className              = 'vh-export-progress__fill vh-export-progress__fill--indeterminate';
      dom.progressMsg.textContent             = 'Preparando datos…';
      break;

    case 'done':
      dom.icon.textContent                    = '✅';
      dom.icon.classList.add('vh-export-modal__icon--done');
      dom.progressFill.className              = 'vh-export-progress__fill vh-export-progress__fill--done';
      dom.progressMsg.textContent             = '¡Imagen exportada! Revisa tu carpeta de descargas.';
      dom.actions.hidden                      = false;
      dom.confirmBtn.hidden                   = true;
      dom.cancelBtn.textContent               = 'Cerrar';
      break;

    case 'error':
      dom.icon.textContent                    = '⚠️';
      dom.progressFill.className              = 'vh-export-progress__fill';
      dom.progressFill.style.width            = '0%';
      dom.progressMsg.textContent             = message || 'Ocurrió un error al generar la imagen.';
      dom.actions.hidden                      = false;
      dom.confirmBtn.hidden                   = false;
      dom.confirmBtn.disabled                 = false;
      dom.confirmBtn.innerHTML                = '<span aria-hidden="true">🔄</span> Reintentar';
      dom.cancelBtn.textContent               = 'Cancelar';
      break;
  }
}


// ─────────────────────────────────────────────
// 5. LÓGICA DE EXPORTACIÓN
//    Delega en ExportEngine y actualiza la UI.
// ─────────────────────────────────────────────

/**
 * Pasos de progreso y su porcentaje visual correspondiente.
 * @type {Record<string, number>}
 */
const PROGRESS_STEPS = Object.freeze({
  'Preparando datos…':       10,
  'Cargando portadas…':      40,
  'Generando imagen…':       75,
  'Descargando imagen…':     90,
  '✅ Imagen exportada correctamente.': 100,
});

/**
 * Callback de progreso: actualiza el mensaje y la barra.
 * @param {string} msg
 */
function _onProgress(msg) {
  const dom = _getDOM();
  dom.progressMsg.textContent = msg;

  const pct = PROGRESS_STEPS[msg] ?? null;
  if (pct !== null) {
    dom.progressFill.classList.remove('vh-export-progress__fill--indeterminate');
    dom.progressFill.style.width = `${pct}%`;
    dom.progressFill.parentElement?.setAttribute('aria-valuenow', String(pct));
  }
}

/**
 * Almacén de las opciones de exportación actuales.
 * Se actualiza en cada llamada a open().
 * @type {object|null}
 */
let _currentExportOptions = null;

/**
 * Ejecuta el proceso de exportación.
 * Maneja errores conocidos (sin entradas, error de Canvas) con mensajes claros.
 */
async function _runExport() {
  if (_state.isExporting || !_currentExportOptions) return;

  const dom = _getDOM();
  _state.isExporting = true;
  dom.confirmBtn.disabled = true;

  _setPhase('progress');

  try {
    await ExportEngine.generate({
      ..._currentExportOptions,
      onProgress: _onProgress,
    });

    _setPhase('done');

  } catch (error) {
    console.error('[ModalExport] Error durante la exportación:', error);

    // Mensajes de error amigables según el tipo de error
    let userMessage = 'Ocurrió un error inesperado al generar la imagen.';

    if (error instanceof RangeError) {
      userMessage = 'Esta sección no tiene novelas para exportar.';
    } else if (error instanceof TypeError && error.message.includes('Canvas')) {
      userMessage = 'Tu navegador no soporta la generación de imágenes. Intenta con Chrome o Firefox.';
    } else if (error.name === 'SecurityError') {
      userMessage = 'Error de permisos al acceder a las portadas. Intenta recargar la página.';
    }

    _setPhase('error', userMessage);

  } finally {
    _state.isExporting = false;
    dom.confirmBtn.hidden   = false;
    dom.confirmBtn.disabled = false;
  }
}


// ─────────────────────────────────────────────
// 6. EVENTOS
// ─────────────────────────────────────────────

/**
 * Registra todos los listeners del modal una sola vez.
 * Se llama desde _getDOM() en la primera creación.
 */
function _attachEventListeners() {
  const dom = _getDOM();

  // Confirmar → ejecutar exportación
  dom.confirmBtn.addEventListener('click', _runExport);

  // Cancelar / Cerrar → cerrar modal
  dom.cancelBtn.addEventListener('click', () => {
    if (!_state.isExporting) close();
  });

  // Click en el overlay fuera del panel → cerrar (solo si no exportando)
  dom.overlay.addEventListener('click', (e) => {
    if (e.target === dom.overlay && !_state.isExporting) close();
  });

  // Tecla ESC → cerrar (solo si no exportando)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dom.overlay.classList.contains('is-visible') && !_state.isExporting) {
      close();
    }
  });
}


// ─────────────────────────────────────────────
// 7. TRAMPA DE FOCO (Accesibilidad)
// ─────────────────────────────────────────────

/**
 * Mueve el foco al primer elemento interactivo del modal al abrirlo.
 */
function _trapFocus() {
  const dom = _getDOM();
  // Enfocar el botón de confirmar (primer elemento lógico)
  setTimeout(() => dom.confirmBtn?.focus(), 60);
}

/**
 * Devuelve el foco al elemento que tenía el foco antes de abrir el modal.
 * @type {Element|null}
 */
let _previousFocus = null;

function _savePreviousFocus() {
  _previousFocus = document.activeElement;
}

function _restorePreviousFocus() {
  if (_previousFocus && typeof _previousFocus.focus === 'function') {
    _previousFocus.focus();
    _previousFocus = null;
  }
}


// ─────────────────────────────────────────────
// 8. API PÚBLICA
// ─────────────────────────────────────────────

/**
 * Abre el modal de exportación configurado para una sección específica.
 *
 * @param {object} options
 * @param {string}  options.status    - Estado de la sección (VN_STATUS).
 * @param {object[]} options.entries  - LibraryEntries de esa sección.
 * @param {Map<string, object>} options.vnCache - Cache de datos VNDB.
 * @param {'light'|'dark'} options.theme - Tema activo del documento.
 *
 * @throws {TypeError} Si status es inválido.
 * @throws {RangeError} Si entries está vacío.
 */
function open({ status, entries, vnCache, theme = 'light' }) {
  // Validaciones previas (feedback inmediato al usuario)
  if (!Object.values(VN_STATUS).includes(status)) {
    throw new TypeError(`[ModalExport] Estado desconocido: "${status}".`);
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    // En lugar de lanzar error, mostrar modal informativo con sección vacía
    console.warn('[ModalExport] La sección está vacía. No hay nada que exportar.');
    return; // Silencioso: la UI ya muestra el empty state al usuario
  }

  // Guardar opciones para _runExport()
  _currentExportOptions = { status, entries, vnCache, theme };
  _state.currentStatus  = status;

  // Poblar modal con datos de la sección
  const dom = _getDOM();
  _populateModal(status, entries.length, 36 /* MAX_ENTRIES de ExportEngine */);

  // Resetear estado del botón confirmar
  dom.confirmBtn.hidden = false;

  // Animación de apertura
  _savePreviousFocus();
  dom.overlay.classList.add('is-visible');
  document.body.style.overflow = 'hidden'; // Prevenir scroll del fondo

  _trapFocus();
}

/**
 * Cierra el modal y restaura el estado inicial.
 * No interrumpe una exportación en curso (seguridad de datos).
 */
function close() {
  if (_state.isExporting) return; // No cerrar durante exportación

  const dom = _getDOM();
  dom.overlay.classList.remove('is-visible');
  document.body.style.overflow = '';

  // Resetear estado tras la animación de cierre
  setTimeout(() => {
    _setPhase('confirm');
    _currentExportOptions = null;
    _state.currentStatus  = null;
  }, 400); // Duración de --vh-transition-slow

  _restorePreviousFocus();
}


// ─────────────────────────────────────────────
// EXPORTACIÓN DEL MÓDULO
// ─────────────────────────────────────────────
export const ModalExport = Object.freeze({ open, close });
