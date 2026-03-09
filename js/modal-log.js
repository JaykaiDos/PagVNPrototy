'use strict';

/**
 * @file js/modal-log.js
 * @description Modal de bitácora para VNs en estado "Jugando".
 *              Permite al usuario escribir impresiones y progreso actual.
 *
 * SRP: Solo gestiona el modal de bitácora.
 *      La persistencia la delega en LibraryStore.updateLog().
 */

import * as LibraryStore from './library-store.js';


// ── Estado y referencias DOM ─────────────────────────────────────────
const _state = { vnId: null, vnTitle: '' };
let _overlay  = null;
let _textarea = null;


// ════════════════════════════════════════════════════════
// 1. CONSTRUCCIÓN DEL MODAL
// ════════════════════════════════════════════════════════

function _build() {
  _overlay = document.createElement('div');
  _overlay.className = 'vh-modal-overlay';
  _overlay.id        = 'modalLogOverlay';
  _overlay.setAttribute('hidden', '');
  _overlay.setAttribute('role', 'dialog');
  _overlay.setAttribute('aria-modal', 'true');
  _overlay.setAttribute('aria-labelledby', 'modalLogTitle');

  const modal = document.createElement('div');
  modal.className = 'vh-modal';

  // ── Header ──
  const header = document.createElement('div');
  header.className = 'vh-modal__header';

  const titleBlock = document.createElement('div');

  const title = document.createElement('h2');
  title.className   = 'vh-modal__title';
  title.id          = 'modalLogTitle';
  title.textContent = '🎮 Bitácora de Progreso';

  const subtitle = document.createElement('p');
  subtitle.className = 'vh-modal__subtitle';
  subtitle.id        = 'modalLogSubtitle';

  titleBlock.appendChild(title);
  titleBlock.appendChild(subtitle);

  const closeBtn = document.createElement('button');
  closeBtn.className   = 'vh-modal__close';
  closeBtn.setAttribute('aria-label', 'Cerrar modal');
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', close);

  header.appendChild(titleBlock);
  header.appendChild(closeBtn);

  // ── Body ──
  const body = document.createElement('div');
  body.className = 'vh-modal__body';

  const field = document.createElement('div');
  field.className = 'vh-field';

  const label = document.createElement('label');
  label.className   = 'vh-field__label';
  label.htmlFor     = 'logTextarea';
  label.textContent = 'Impresiones y progreso actual';

  _textarea = document.createElement('textarea');
  _textarea.className   = 'vh-field__textarea';
  _textarea.id          = 'logTextarea';
  _textarea.placeholder = 'ej: Terminé la ruta de Rin. El final me dejó sin palabras…';
  _textarea.maxLength   = 1000;
  _textarea.rows        = 6;

  // Contador de caracteres
  const counter = document.createElement('p');
  counter.className = 'vh-field__label';
  counter.id        = 'logCounter';
  counter.style.cssText = 'text-align:right; margin-top:0.25rem;';
  counter.textContent = '0 / 1000';

  _textarea.addEventListener('input', () => {
    counter.textContent = `${_textarea.value.length} / 1000`;
  });

  field.appendChild(label);
  field.appendChild(_textarea);
  field.appendChild(counter);
  body.appendChild(field);

  // ── Footer ──
  const footer = document.createElement('div');
  footer.className = 'vh-modal__footer';

  const cancelBtn = document.createElement('button');
  cancelBtn.className   = 'vh-btn vh-btn--ghost';
  cancelBtn.textContent = 'Cancelar';
  cancelBtn.addEventListener('click', close);

  const saveBtn = document.createElement('button');
  saveBtn.className   = 'vh-btn vh-btn--primary';
  saveBtn.textContent = '💾 Guardar bitácora';
  saveBtn.addEventListener('click', _handleSave);

  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);

  // Ensamblar
  modal.appendChild(header);
  modal.appendChild(body);
  modal.appendChild(footer);
  _overlay.appendChild(modal);
  document.body.appendChild(_overlay);

  // Cerrar al click fuera del modal
  _overlay.addEventListener('click', (e) => {
    if (e.target === _overlay) close();
  });

  // Cerrar con Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !_overlay.hidden) close();
  });
}


// ════════════════════════════════════════════════════════
// 2. HANDLERS
// ════════════════════════════════════════════════════════

function _handleSave() {
  if (!_state.vnId || !_textarea) return;

  const log = _textarea.value.trim();
  LibraryStore.updateLog(_state.vnId, log);
  close();
}


// ════════════════════════════════════════════════════════
// 3. API PÚBLICA
// ════════════════════════════════════════════════════════

/**
 * Abre el modal de bitácora para una VN.
 * Pre-carga el log existente si lo hay.
 *
 * @param {string} vnId
 * @param {string} vnTitle
 */
function open(vnId, vnTitle) {
  if (!_overlay) _build();

  _state.vnId    = vnId;
  _state.vnTitle = vnTitle;

  const subtitle = document.getElementById('modalLogSubtitle');
  if (subtitle) subtitle.textContent = vnTitle;

  // Pre-cargar log existente
  const entry = LibraryStore.getEntry(vnId);
  if (_textarea) {
    _textarea.value = entry?.log ?? '';
    const counter   = document.getElementById('logCounter');
    if (counter) counter.textContent = `${_textarea.value.length} / 1000`;
    _textarea.focus();
  }

  _overlay.hidden = false;
}

/** Cierra el modal. */
function close() {
  if (_overlay) _overlay.hidden = true;
  _state.vnId = null;
}

export { open, close };