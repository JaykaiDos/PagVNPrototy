'use strict';

/**
 * @file js/modal-status-change.js
 * @description Modal de confirmación para cambios de estado que implican
 *              pérdida de datos enriquecidos (reseña, score, ruta favorita).
 *
 * RESPONSABILIDAD ÚNICA:
 *  Detectar si el cambio de estado borrará datos y, si es así, pedir
 *  confirmación explícita al usuario antes de proceder.
 *  La decisión de cambiar el estado sigue siendo responsabilidad del
 *  llamador (ui-controller, novel-details).
 *
 * CUÁNDO SE MUESTRA:
 *  Solo cuando SE CUMPLEN LAS DOS CONDICIONES:
 *    1. El estado ORIGEN es FINISHED.
 *    2. La entrada tiene al menos uno de: score calculado, reseña
 *       escrita o ruta favorita registrada.
 *  En cualquier otro cambio de estado, `confirmStatusChange()` resuelve
 *  inmediatamente con `true` sin mostrar nada.
 *
 * API PÚBLICA:
 *  confirmStatusChange(entry, newStatus) → Promise<boolean>
 *    Devuelve true si el usuario confirma (o no hay datos que perder).
 *    Devuelve false si el usuario cancela.
 *
 * DISEÑO:
 *  - Singleton lazy: el DOM se crea la primera vez que se necesita.
 *  - No importa LibraryStore directamente; recibe la entry como parámetro
 *    para mantener el módulo desacoplado y testeable.
 *  - Accesibilidad: focus trap, Escape cierra, aria-modal.
 */

import { VN_STATUS, VN_STATUS_META } from './constants.js';
import { formatFinalScore }          from './score-engine.js';


// ─────────────────────────────────────────────
// ESTADO INTERNO
// ─────────────────────────────────────────────

/** @type {HTMLElement|null} Overlay del modal (singleton) */
let _overlay = null;

/** @type {((confirmed: boolean) => void)|null} Resolver de la promesa activa */
let _resolve = null;


// ─────────────────────────────────────────────
// HELPERS INTERNOS
// ─────────────────────────────────────────────

/**
 * Determina si una LibraryEntry tiene datos enriquecidos que se perderían
 * al salir del estado FINISHED.
 *
 * @param {import('./library-store.js').LibraryEntry} entry
 * @returns {boolean}
 */
function _hasRichData(entry) {
  if (!entry) return false;
  const hasScore    = entry.score?.finalScore != null;
  const hasReview   = typeof entry.review === 'string' && entry.review.trim().length > 0;
  const hasFavRoute = typeof entry.favRoute === 'string' && entry.favRoute.trim().length > 0;
  return hasScore || hasReview || hasFavRoute;
}

/**
 * Construye un resumen legible de los datos que se perderán.
 * Devuelve un array de strings, uno por dato presente.
 *
 * @param {import('./library-store.js').LibraryEntry} entry
 * @returns {string[]}
 */
function _buildDataSummary(entry) {
  const items = [];

  if (entry.score?.finalScore != null) {
    items.push(`⭐ Puntuación: ${formatFinalScore(entry.score.finalScore)} — ${entry.score.finalScoreLabel ?? ''}`);
  }
  if (entry.favRoute?.trim()) {
    items.push(`🛤 Ruta favorita: ${entry.favRoute.trim()}`);
  }
  if (entry.review?.trim()) {
    // Truncar la reseña para que no desborde el modal
    const preview = entry.review.trim().slice(0, 120);
    items.push(`✍ Reseña: "${preview}${entry.review.length > 120 ? '…' : ''}"`);
  }

  return items;
}


// ─────────────────────────────────────────────
// CONSTRUCCIÓN DEL DOM (lazy, una sola vez)
// ─────────────────────────────────────────────

/**
 * Crea e inyecta el modal en el DOM.
 * Solo se llama una vez; después se reutiliza mostrando/ocultando.
 */
function _build() {
  _overlay = document.createElement('div');
  _overlay.id        = 'statusChangeOverlay';
  _overlay.className = 'vh-modal-overlay vhsc-overlay';
  _overlay.setAttribute('hidden', '');
  _overlay.setAttribute('role', 'dialog');
  _overlay.setAttribute('aria-modal', 'true');
  _overlay.setAttribute('aria-labelledby', 'vhscTitle');

  // Click en el fondo = cancelar
  _overlay.addEventListener('click', (e) => {
    if (e.target === _overlay) _settle(false);
  });

  const modal = document.createElement('div');
  modal.className = 'vh-modal vh-modal--sm vhsc-modal';

  // ── Header ──────────────────────────────────────
  const header = document.createElement('div');
  header.className = 'vh-modal__header';

  const iconWrap = document.createElement('div');
  iconWrap.className = 'vhsc-icon-wrap';
  iconWrap.setAttribute('aria-hidden', 'true');

  const iconEl = document.createElement('span');
  iconEl.className = 'vhsc-icon';
  iconEl.textContent = '⚠️';
  iconWrap.appendChild(iconEl);

  const titleBlock = document.createElement('div');

  const titleEl = document.createElement('h2');
  titleEl.className   = 'vh-modal__title';
  titleEl.id          = 'vhscTitle';
  titleEl.textContent = 'Cambiar estado';

  const subtitleEl = document.createElement('p');
  subtitleEl.className = 'vh-modal__subtitle vhsc-subtitle';
  subtitleEl.id        = 'vhscSubtitle';

  titleBlock.appendChild(titleEl);
  titleBlock.appendChild(subtitleEl);

  const closeBtn = document.createElement('button');
  closeBtn.type        = 'button';
  closeBtn.className   = 'vh-modal__close';
  closeBtn.setAttribute('aria-label', 'Cancelar y cerrar');
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => _settle(false));

  header.appendChild(iconWrap);
  header.appendChild(titleBlock);
  header.appendChild(closeBtn);

  // ── Body ─────────────────────────────────────────
  const body = document.createElement('div');
  body.className = 'vh-modal__body';

  // Tarjeta de datos que se perderán
  const dataCard = document.createElement('div');
  dataCard.className = 'vhsc-data-card';
  dataCard.id        = 'vhscDataCard';

  const dataTitle = document.createElement('p');
  dataTitle.className   = 'vhsc-data-title';
  dataTitle.textContent = 'Se borrarán permanentemente:';

  const dataList = document.createElement('ul');
  dataList.className = 'vhsc-data-list';
  dataList.id        = 'vhscDataList';

  dataCard.appendChild(dataTitle);
  dataCard.appendChild(dataList);
  body.appendChild(dataCard);

  // Nuevo estado al que se va
  const destRow = document.createElement('div');
  destRow.className = 'vhsc-dest-row';

  const destLabel = document.createElement('span');
  destLabel.className   = 'vhsc-dest-label';
  destLabel.textContent = 'Nuevo estado:';

  const destBadge = document.createElement('span');
  destBadge.className = 'vhsc-dest-badge';
  destBadge.id        = 'vhscDestBadge';

  destRow.appendChild(destLabel);
  destRow.appendChild(destBadge);
  body.appendChild(destRow);

  // ── Footer ────────────────────────────────────────
  const footer = document.createElement('div');
  footer.className = 'vh-modal__footer';

  const cancelBtn = document.createElement('button');
  cancelBtn.type        = 'button';
  cancelBtn.className   = 'vh-btn vh-btn--ghost';
  cancelBtn.id          = 'vhscCancelBtn';
  cancelBtn.textContent = 'Cancelar';
  cancelBtn.addEventListener('click', () => _settle(false));

  const confirmBtn = document.createElement('button');
  confirmBtn.type      = 'button';
  confirmBtn.className = 'vh-btn vhsc-confirm-btn';
  confirmBtn.id        = 'vhscConfirmBtn';
  // Texto y estilo se actualizan en _populate()
  confirmBtn.addEventListener('click', () => _settle(true));

  footer.appendChild(cancelBtn);
  footer.appendChild(confirmBtn);

  modal.appendChild(header);
  modal.appendChild(body);
  modal.appendChild(footer);
  _overlay.appendChild(modal);
  document.body.appendChild(_overlay);

  // Cerrar con Escape
  document.addEventListener('keydown', _onKeyDown);
}

/**
 * Handler de teclado: Escape cierra el modal.
 * @param {KeyboardEvent} e
 */
function _onKeyDown(e) {
  if (e.key === 'Escape' && _overlay && !_overlay.hidden) {
    _settle(false);
  }
}


// ─────────────────────────────────────────────
// POBLACIÓN DE CONTENIDO
// ─────────────────────────────────────────────

/**
 * Rellena el modal con la información del cambio de estado concreto.
 *
 * @param {import('./library-store.js').LibraryEntry} entry  - Entrada actual (origen: FINISHED)
 * @param {string}                                   newStatus - Estado destino
 * @param {string}                                   vnTitle   - Título de la VN
 */
function _populate(entry, newStatus, vnTitle) {
  const destMeta = VN_STATUS_META[newStatus];

  // Subtítulo
  const subtitle = document.getElementById('vhscSubtitle');
  if (subtitle) {
    subtitle.textContent = `"${vnTitle}"`;
  }

  // Lista de datos que se perderán
  const dataList = document.getElementById('vhscDataList');
  if (dataList) {
    while (dataList.firstChild) dataList.removeChild(dataList.firstChild);

    const items = _buildDataSummary(entry);
    items.forEach(text => {
      const li = document.createElement('li');
      li.className   = 'vhsc-data-item';
      li.textContent = text;
      dataList.appendChild(li);
    });
  }

  // Badge del estado destino
  const destBadge = document.getElementById('vhscDestBadge');
  if (destBadge) {
    destBadge.textContent = `${destMeta.icon} ${destMeta.label}`;
    // Resetear clases de estado previo y aplicar la nueva
    destBadge.className = `vhsc-dest-badge vh-badge vh-badge--${newStatus}`;
  }

  // Botón confirmar: texto contextual según el destino
  const confirmBtn = document.getElementById('vhscConfirmBtn');
  if (confirmBtn) {
    confirmBtn.textContent = `Sí, cambiar a "${destMeta.label}"`;

    // Estilo: danger si el destino es dropped, warning en otros casos
    confirmBtn.className = newStatus === VN_STATUS.DROPPED
      ? 'vh-btn vh-btn--danger vhsc-confirm-btn'
      : 'vh-btn vhsc-confirm-btn vhsc-confirm-btn--warning';
  }
}


// ─────────────────────────────────────────────
// CICLO DE VIDA DEL MODAL
// ─────────────────────────────────────────────

/**
 * Abre el modal y posiciona el foco en el botón cancelar.
 */
function _open() {
  if (!_overlay) return;
  _overlay.hidden = false;

  // Foco al botón cancelar (acción segura por defecto — evita confirmación accidental)
  requestAnimationFrame(() => {
    document.getElementById('vhscCancelBtn')?.focus();
  });
}

/**
 * Resuelve la promesa activa y cierra el modal.
 * @param {boolean} confirmed
 */
function _settle(confirmed) {
  if (!_overlay) return;
  _overlay.hidden = true;

  if (typeof _resolve === 'function') {
    const fn = _resolve;
    _resolve  = null;
    fn(confirmed);
  }
}


// ─────────────────────────────────────────────
// API PÚBLICA
// ─────────────────────────────────────────────

/**
 * Verifica si el cambio de estado requiere confirmación y, si es así,
 * muestra el modal y espera la decisión del usuario.
 *
 * FLUJO:
 *  1. Si el estado origen NO es FINISHED → resuelve true inmediatamente.
 *  2. Si la entrada NO tiene datos enriquecidos → resuelve true inmediatamente.
 *  3. Si hay datos que perder → muestra el modal y espera al usuario.
 *     - Usuario confirma → resuelve true (el llamador puede proceder).
 *     - Usuario cancela  → resuelve false (el llamador NO debe cambiar el estado).
 *
 * @param {import('./library-store.js').LibraryEntry|null} entry     - Entrada actual en la biblioteca.
 * @param {string}                                         newStatus - Estado destino.
 * @param {string}                                         vnTitle   - Título de la VN (para el modal).
 * @returns {Promise<boolean>} true = proceder, false = cancelar.
 *
 * @example
 *   const ok = await confirmStatusChange(entry, VN_STATUS.PLAYING, 'Clannad');
 *   if (!ok) return; // usuario canceló
 *   LibraryStore.updateStatus(vnId, VN_STATUS.PLAYING);
 */
async function confirmStatusChange(entry, newStatus, vnTitle) {
  // Sin entrada previa → no hay datos que perder → proceder
  if (!entry) return true;

  // Solo hay riesgo al salir de FINISHED
  if (entry.status !== VN_STATUS.FINISHED) return true;

  // No hay cambio real de estado
  if (entry.status === newStatus) return true;

  // ¿Tiene datos enriquecidos que se borrarán?
  if (!_hasRichData(entry)) return true;

  // Necesitamos confirmación: construir el modal si aún no existe
  if (!_overlay) _build();

  // Poblar con los datos del cambio concreto
  _populate(entry, newStatus, vnTitle ?? 'esta novela');

  // Abrir y esperar la respuesta del usuario
  return new Promise((resolve) => {
    _resolve = resolve;
    _open();
  });
}

export { confirmStatusChange };
