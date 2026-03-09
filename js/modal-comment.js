'use strict';

/**
 * @file js/modal-comment.js
 * @description Modal de comentario para VNs en estado "Abandonada".
 *              Permite al usuario explicar brevemente el motivo de abandono.
 *
 * SRP: Solo gestiona el modal de comentario de abandono.
 *      La persistencia la delega en LibraryStore.updateComment().
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
  _overlay.id        = 'modalCommentOverlay';
  _overlay.setAttribute('hidden', '');
  _overlay.setAttribute('role', 'dialog');
  _overlay.setAttribute('aria-modal', 'true');
  _overlay.setAttribute('aria-labelledby', 'modalCommentTitle');

  const modal = document.createElement('div');
  modal.className = 'vh-modal';

  // ── Header ──
  const header = document.createElement('div');
  header.className = 'vh-modal__header';

  const titleBlock = document.createElement('div');

  const title = document.createElement('h2');
  title.className   = 'vh-modal__title';
  title.id          = 'modalCommentTitle';
  title.textContent = '❌ Motivo de Abandono';

  const subtitle = document.createElement('p');
  subtitle.className = 'vh-modal__subtitle';
  subtitle.id        = 'modalCommentSubtitle';

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

  // Hint informativo
  const hint = document.createElement('p');
  hint.style.cssText  = 'font-size:0.85rem; color:var(--vh-text-muted); line-height:1.5;';
  hint.textContent    = 'No es necesario puntuar. Solo escribe brevemente por qué decidiste dejar esta VN.';
  body.appendChild(hint);

  const field = document.createElement('div');
  field.className = 'vh-field';

  const label = document.createElement('label');
  label.className   = 'vh-field__label';
  label.htmlFor     = 'commentTextarea';
  label.textContent = 'Comentario';

  const opt = document.createElement('span');
  opt.textContent = ' (opcional)';
  label.appendChild(opt);

  _textarea = document.createElement('textarea');
  _textarea.className   = 'vh-field__textarea';
  _textarea.id          = 'commentTextarea';
  _textarea.placeholder = 'ej: El ritmo era muy lento, quizás lo retome más adelante…';
  _textarea.maxLength   = 500;
  _textarea.rows        = 4;

  // Contador de caracteres
  const counter = document.createElement('p');
  counter.className = 'vh-field__label';
  counter.id        = 'commentCounter';
  counter.style.cssText = 'text-align:right; margin-top:0.25rem;';
  counter.textContent = '0 / 500';

  _textarea.addEventListener('input', () => {
    counter.textContent = `${_textarea.value.length} / 500`;
  });

  field.appendChild(label);
  field.appendChild(_textarea);
  field.appendChild(counter);
  body.appendChild(field);

  // ── Footer ──
  const footer = document.createElement('div');
  footer.className = 'vh-modal__footer';

  const skipBtn = document.createElement('button');
  skipBtn.className   = 'vh-btn vh-btn--ghost';
  skipBtn.textContent = 'Omitir';
  skipBtn.addEventListener('click', _handleSkip);

  const saveBtn = document.createElement('button');
  saveBtn.className   = 'vh-btn vh-btn--primary';
  saveBtn.textContent = '💾 Guardar comentario';
  saveBtn.addEventListener('click', _handleSave);

  footer.appendChild(skipBtn);
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

/** Guarda el comentario escrito. */
function _handleSave() {
  if (!_state.vnId || !_textarea) return;
  const comment = _textarea.value.trim();
  LibraryStore.updateComment(_state.vnId, comment);
  close();
}

/** Omite el comentario (cierra sin guardar texto, el estado ya fue cambiado). */
function _handleSkip() {
  close();
}


// ════════════════════════════════════════════════════════
// 3. API PÚBLICA
// ════════════════════════════════════════════════════════

/**
 * Abre el modal de comentario para una VN abandonada.
 * Pre-carga el comentario existente si lo hay.
 *
 * @param {string} vnId
 * @param {string} vnTitle
 */
function open(vnId, vnTitle) {
  if (!_overlay) _build();

  _state.vnId    = vnId;
  _state.vnTitle = vnTitle;

  const subtitle = document.getElementById('modalCommentSubtitle');
  if (subtitle) subtitle.textContent = vnTitle;

  // Pre-cargar comentario existente
  const entry = LibraryStore.getEntry(vnId);
  if (_textarea) {
    _textarea.value = entry?.comment ?? '';
    const counter   = document.getElementById('commentCounter');
    if (counter) counter.textContent = `${_textarea.value.length} / 500`;
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