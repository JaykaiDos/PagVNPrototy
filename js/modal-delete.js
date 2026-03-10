'use strict';

/**
 * @file js/modal-delete.js
 * @description Modal de confirmación de eliminación de VN de la biblioteca.
 *
 * Responsabilidad Única: gestiona SOLO el diálogo de confirmación.
 * La lógica de eliminación se inyecta como callback onConfirm.
 *
 * Uso:
 *   import * as ModalDelete from './modal-delete.js';
 *   ModalDelete.open(vnId, title, imgUrl, onConfirmCallback);
 */

const IDS = Object.freeze({
  OVERLAY:     'deleteConfirmOverlay',
  MODAL:       'deleteConfirmModal',
  HEADING:     'deleteModalHeading',
  COVER:       'deleteConfirmCover',
  TITLE:       'deleteConfirmTitle',
  MSG:         'deleteConfirmMsg',
  BTN_CANCEL:  'deleteConfirmCancel',
  BTN_CONFIRM: 'deleteConfirmBtn',
});

function open(vnId, title, imgUrl, onConfirm) {
  if (!document.getElementById(IDS.OVERLAY)) {
    document.body.appendChild(_buildModal());
    _bindEscapeKey();
  }
  _updateContent(vnId, title, imgUrl);
  _wireConfirmButton(onConfirm);
  const overlay = document.getElementById(IDS.OVERLAY);
  const modal   = document.getElementById(IDS.MODAL);
  overlay.hidden = false;
  overlay.setAttribute('aria-hidden', 'false');
  modal.hidden   = false;
  document.getElementById(IDS.BTN_CANCEL)?.focus();
}

function close() {
  const overlay = document.getElementById(IDS.OVERLAY);
  const modal   = document.getElementById(IDS.MODAL);
  if (overlay) { overlay.hidden = true; overlay.setAttribute('aria-hidden', 'true'); }
  if (modal)   { modal.hidden   = true; }
}

function _updateContent(vnId, title, imgUrl) {
  const titleEl    = document.getElementById(IDS.TITLE);
  const msgEl      = document.getElementById(IDS.MSG);
  const imgEl      = document.getElementById(IDS.COVER);
  const confirmBtn = document.getElementById(IDS.BTN_CONFIRM);
  if (titleEl)    titleEl.textContent = title;
  if (msgEl)      msgEl.textContent   = `"${title}" será eliminada de tu biblioteca de forma permanente.`;
  if (confirmBtn) confirmBtn.dataset.vnId = vnId;
  const isValidSrc = typeof imgUrl === 'string' && /^https?:\/\//i.test(imgUrl);
  if (imgEl) {
    imgEl.hidden = !isValidSrc;
    if (isValidSrc) imgEl.setAttribute('src', imgUrl);
  }
}

function _wireConfirmButton(onConfirm) {
  const oldBtn = document.getElementById(IDS.BTN_CONFIRM);
  if (!oldBtn) return;
  const newBtn = oldBtn.cloneNode(true);
  newBtn.addEventListener('click', () => { close(); if (typeof onConfirm === 'function') onConfirm(); });
  oldBtn.parentNode.replaceChild(newBtn, oldBtn);
}

function _bindEscapeKey() {
  document.addEventListener('keydown', (e) => {
    const overlay = document.getElementById(IDS.OVERLAY);
    if (e.key === 'Escape' && overlay && !overlay.hidden) close();
  });
}

function _el(tag, cls = '', attrs = {}) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  return el;
}

function _buildModal() {
  const overlay = _el('div', 'vh-modal-overlay', {
    id: IDS.OVERLAY, role: 'dialog', 'aria-modal': 'true',
    'aria-labelledby': IDS.HEADING,
  });
  overlay.hidden = true;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const modal = _el('div', 'vh-modal vh-modal--sm', { id: IDS.MODAL });
  modal.hidden = true;
  modal.addEventListener('click', (e) => e.stopPropagation());

  modal.appendChild(_buildHeader());
  modal.appendChild(_buildBody());
  modal.appendChild(_buildFooter());
  overlay.appendChild(modal);
  return overlay;
}

function _buildHeader() {
  const header = _el('div', 'vh-modal__header');
  const left   = _el('div', 'vh-delete-modal__header-left');
  const iconWrap = _el('div', 'vh-delete-modal__icon-wrap');
  const icon     = _el('span', 'vh-delete-modal__danger-icon', { 'aria-hidden': 'true' });
  icon.textContent = '🗑️';
  iconWrap.appendChild(icon);
  const textGroup = _el('div', '');
  const h2 = _el('h2', 'vh-modal__title', { id: IDS.HEADING });
  h2.textContent = 'Eliminar novela';
  const sub = _el('p', 'vh-modal__subtitle');
  sub.textContent = 'Acción permanente · No se puede deshacer';
  textGroup.appendChild(h2);
  textGroup.appendChild(sub);
  left.appendChild(iconWrap);
  left.appendChild(textGroup);
  const closeBtn = _el('button', 'vh-modal__close', { 'aria-label': 'Cerrar' });
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', close);
  header.appendChild(left);
  header.appendChild(closeBtn);
  return header;
}

function _buildBody() {
  const body = _el('div', 'vh-modal__body');
  const card = _el('div', 'vh-delete-modal__content-card');
  const img  = _el('img', 'vh-delete-modal__cover', {
    id: IDS.COVER, alt: 'Portada de la novela', loading: 'lazy',
  });
  img.hidden = true;
  const textBlock    = _el('div', 'vh-delete-modal__text-block');
  const titleEl      = _el('strong', 'vh-delete-modal__vn-title', { id: IDS.TITLE });
  const msgEl        = _el('p', 'vh-delete-modal__msg',            { id: IDS.MSG   });
  const warningPill  = _el('div', 'vh-delete-modal__warning-pill', { 'aria-live': 'polite' });
  const wIcon = _el('span', '', { 'aria-hidden': 'true' });
  wIcon.textContent = '⚠';
  const wText = _el('span', '');
  wText.textContent = 'Esta acción no se puede deshacer';
  warningPill.appendChild(wIcon);
  warningPill.appendChild(wText);
  textBlock.appendChild(titleEl);
  textBlock.appendChild(msgEl);
  textBlock.appendChild(warningPill);
  card.appendChild(img);
  card.appendChild(textBlock);
  body.appendChild(card);
  return body;
}

function _buildFooter() {
  const footer = _el('div', 'vh-modal__footer');
  const cancelBtn  = _el('button', 'vh-btn vh-btn--ghost',  { id: IDS.BTN_CANCEL  });
  cancelBtn.textContent = 'Cancelar';
  cancelBtn.addEventListener('click', close);
  const confirmBtn = _el('button', 'vh-btn vh-btn--danger', { id: IDS.BTN_CONFIRM });
  const trashSpan  = _el('span', '', { 'aria-hidden': 'true' });
  trashSpan.textContent = '🗑';
  const labelSpan  = _el('span', '');
  labelSpan.textContent = 'Sí, eliminar';
  confirmBtn.appendChild(trashSpan);
  confirmBtn.appendChild(labelSpan);
  footer.appendChild(cancelBtn);
  footer.appendChild(confirmBtn);
  return footer;
}

export { open, close };