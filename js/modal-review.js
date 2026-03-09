'use strict';

/**
 * @file js/modal-review.js
 * @description Modal de clasificación detallada para VNs finalizadas.
 *              Renderiza el formulario de puntuación por categorías,
 *              calcula el score en tiempo real y persiste via LibraryStore.
 *
 * FLUJO:
 *  1. ui-controller llama a open(vnId, vnTitle)
 *  2. El usuario ajusta los sliders y completa la reseña
 *  3. Al confirmar: calculateScore() → LibraryStore.updateReview()
 *  4. Si hay sesión Firebase: publishToFeed() (si perfil es público)
 *  5. El modal se cierra y el Observer del store re-renderiza la biblioteca
 *
 * SRP: Este módulo SOLO gestiona el modal de review.
 *      No accede a VNDB, no toca el DOM fuera del modal.
 */

import { SCORE_CATEGORIES }                    from './constants.js';
import { calculateScore, formatFinalScore,
         getScoreLabel }                        from './score-engine.js';
import * as LibraryStore                        from './library-store.js';
import * as FirebaseService                     from './firebase-service.js';


// ── Estado interno del modal ─────────────────────────────────────────
const _state = {
  vnId:           null,
  vnTitle:        '',
  vnImageUrl:     '',
  finalScore:     null,
  hasAdultContent: true,
};

// ── Referencias DOM (cacheadas al crear el modal) ────────────────────
let _overlay  = null;
let _modal    = null;
let _sliders  = {};   // key → <input type="range">
let _values   = {};   // key → <span> que muestra el valor


// ════════════════════════════════════════════════════════
// 1. CREACIÓN DEL MODAL (una sola vez, se reutiliza)
// ════════════════════════════════════════════════════════

/**
 * Construye el modal en el DOM y lo adjunta al body.
 * Solo se llama una vez; después se muestra/oculta con hidden.
 */
function _build() {
  // Overlay
  _overlay = document.createElement('div');
  _overlay.className = 'vh-modal-overlay';
  _overlay.id        = 'modalReviewOverlay';
  _overlay.setAttribute('hidden', '');
  _overlay.setAttribute('role',   'dialog');
  _overlay.setAttribute('aria-modal', 'true');
  _overlay.setAttribute('aria-labelledby', 'modalReviewTitle');

  // Modal
  _modal = document.createElement('div');
  _modal.className = 'vh-modal';

  // ── Header ──
  const header = document.createElement('div');
  header.className = 'vh-modal__header';

  const titleBlock = document.createElement('div');

  const title = document.createElement('h2');
  title.className   = 'vh-modal__title';
  title.id          = 'modalReviewTitle';
  title.textContent = '🏆 Clasificación Final';

  const subtitle = document.createElement('p');
  subtitle.className = 'vh-modal__subtitle';
  subtitle.id        = 'modalReviewSubtitle';

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

  // Toggle adulto
  body.appendChild(_buildAdultToggle());

  // Grid de sliders
  body.appendChild(_buildScoreGrid());

  // Preview del puntaje total
  body.appendChild(_buildScorePreview());

  // Separador visual
  const sep = document.createElement('hr');
  sep.style.cssText = 'border:none; border-top:1px solid var(--vh-border); margin:0.25rem 0;';
  body.appendChild(sep);

  // Campo ruta favorita
  body.appendChild(_buildTextField('favRoute', 'Ruta Favorita', 'ej: Ruta de Rin, True End…', false));

  // Campo reseña
  body.appendChild(_buildTextareaField('review', 'Reseña', 'Escribe tu opinión sobre esta VN…'));

  // Checkbox spoiler
  body.appendChild(_buildSpoilerCheckbox());

  // ── Footer ──
  const footer = document.createElement('div');
  footer.className = 'vh-modal__footer';

  const cancelBtn = document.createElement('button');
  cancelBtn.className   = 'vh-btn vh-btn--ghost';
  cancelBtn.textContent = 'Cancelar';
  cancelBtn.addEventListener('click', close);

  const saveBtn = document.createElement('button');
  saveBtn.className   = 'vh-btn vh-btn--primary';
  saveBtn.id          = 'modalReviewSave';
  saveBtn.textContent = '💾 Guardar clasificación';
  saveBtn.addEventListener('click', _handleSave);

  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);

  // Ensamblar
  _modal.appendChild(header);
  _modal.appendChild(body);
  _modal.appendChild(footer);
  _overlay.appendChild(_modal);
  document.body.appendChild(_overlay);

  // Cerrar al click en el overlay (fuera del modal)
  _overlay.addEventListener('click', (e) => {
    if (e.target === _overlay) close();
  });

  // Cerrar con Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !_overlay.hidden) close();
  });
}


// ════════════════════════════════════════════════════════
// 2. BUILDERS DE SECCIONES DEL FORMULARIO
// ════════════════════════════════════════════════════════

/**
 * Toggle "¿Tiene contenido adulto?"
 * Muestra/oculta el slider de Escenas H.
 */
function _buildAdultToggle() {
  const wrapper = document.createElement('label');
  wrapper.className = 'vh-field vh-field--checkbox';

  const checkbox = document.createElement('input');
  checkbox.type    = 'checkbox';
  checkbox.id      = 'reviewHasAdult';
  checkbox.checked = true;
  checkbox.addEventListener('change', (e) => {
    _state.hasAdultContent = e.target.checked;
    _toggleAdultRow(e.target.checked);
    _recalculate();
  });

  const label = document.createElement('span');
  label.className   = 'vh-field__label';
  label.textContent = '¿Esta VN tiene contenido adulto (18+)?';

  wrapper.appendChild(checkbox);
  wrapper.appendChild(label);
  return wrapper;
}

/**
 * Grid de sliders por categoría de puntuación.
 */
function _buildScoreGrid() {
  const grid = document.createElement('div');
  grid.className = 'vh-score-grid';
  grid.id        = 'scoreGrid';

  // Solo categorías base (no bonus, que va por separado)
  const categories = SCORE_CATEGORIES.filter(c => !c.bonus);

  categories.forEach(cat => {
    const row = _buildSliderRow(cat);
    if (cat.optional) {
      row.dataset.adultRow = 'true';
    }
    grid.appendChild(row);
  });

  // Bonus (extra) — fila separada abajo del grid, ancho completo
  const bonusCat = SCORE_CATEGORIES.find(c => c.bonus);
  if (bonusCat) {
    const bonusRow = _buildSliderRow(bonusCat);
    bonusRow.style.gridColumn = '1 / -1';
    grid.appendChild(bonusRow);
  }

  return grid;
}

/**
 * Construye una fila de slider para una categoría.
 * @param {object} cat — ScoreCategory de constants.js
 */
function _buildSliderRow(cat) {
  const row = document.createElement('div');
  row.className = 'vh-score-row';

  const rowHeader = document.createElement('div');
  rowHeader.className = 'vh-score-row__header';

  const label = document.createElement('span');
  label.className   = 'vh-score-row__label';
  label.textContent = cat.label;

  const valueDisplay = document.createElement('span');
  valueDisplay.className   = 'vh-score-row__value';
  valueDisplay.id          = `scoreVal_${cat.key}`;
  valueDisplay.textContent = '5';

  rowHeader.appendChild(label);
  rowHeader.appendChild(valueDisplay);

  const slider = document.createElement('input');
  slider.type      = 'range';
  slider.className = 'vh-slider';
  slider.id        = `scoreSlider_${cat.key}`;
  slider.min       = '0';
  slider.max       = '10';
  slider.step      = '0.5';
  slider.value     = '5';
  slider.setAttribute('aria-label', `${cat.label} (0-10)`);

  slider.addEventListener('input', () => {
    valueDisplay.textContent = slider.value;
    _recalculate();
  });

  // Guardamos referencias para leer los valores al guardar
  _sliders[cat.key] = slider;
  _values[cat.key]  = valueDisplay;

  row.appendChild(rowHeader);
  row.appendChild(slider);
  return row;
}

/**
 * Sección de preview del puntaje total (actualizada en tiempo real).
 */
function _buildScorePreview() {
  const preview = document.createElement('div');
  preview.className = 'vh-score-preview';

  const labelEl = document.createElement('span');
  labelEl.className   = 'vh-score-preview__label';
  labelEl.textContent = 'Puntaje Final';

  const valueEl = document.createElement('span');
  valueEl.className = 'vh-score-preview__value';
  valueEl.id        = 'previewScore';
  valueEl.textContent = '—';

  const tagEl = document.createElement('span');
  tagEl.className = 'vh-score-preview__tag';
  tagEl.id        = 'previewLabel';
  tagEl.textContent = 'Ajusta los sliders';

  preview.appendChild(labelEl);
  preview.appendChild(valueEl);
  preview.appendChild(tagEl);
  return preview;
}

/**
 * Campo de texto de una línea (ej: ruta favorita).
 * @param {string} id
 * @param {string} label
 * @param {string} placeholder
 * @param {boolean} required
 */
function _buildTextField(id, label, placeholder, required = false) {
  const field = document.createElement('div');
  field.className = 'vh-field';

  const labelEl = document.createElement('label');
  labelEl.className   = 'vh-field__label';
  labelEl.htmlFor     = `review_${id}`;
  labelEl.textContent = label;
  if (!required) {
    const opt = document.createElement('span');
    opt.textContent = ' (opcional)';
    labelEl.appendChild(opt);
  }

  const input = document.createElement('input');
  input.type        = 'text';
  input.className   = 'vh-field__input';
  input.id          = `review_${id}`;
  input.placeholder = placeholder;
  input.maxLength   = 100;

  field.appendChild(labelEl);
  field.appendChild(input);
  return field;
}

/**
 * Campo de textarea (ej: reseña).
 * @param {string} id
 * @param {string} label
 * @param {string} placeholder
 */
function _buildTextareaField(id, label, placeholder) {
  const field = document.createElement('div');
  field.className = 'vh-field';

  const labelEl = document.createElement('label');
  labelEl.className   = 'vh-field__label';
  labelEl.htmlFor     = `review_${id}`;
  labelEl.textContent = label;

  const opt = document.createElement('span');
  opt.textContent = ' (opcional)';
  labelEl.appendChild(opt);

  const textarea = document.createElement('textarea');
  textarea.className   = 'vh-field__textarea';
  textarea.id          = `review_${id}`;
  textarea.placeholder = placeholder;
  textarea.maxLength   = 2000;
  textarea.rows        = 4;

  field.appendChild(labelEl);
  field.appendChild(textarea);
  return field;
}

/**
 * Checkbox de spoiler.
 */
function _buildSpoilerCheckbox() {
  const label = document.createElement('label');
  label.className = 'vh-field vh-field--checkbox';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.id   = 'review_isSpoiler';

  const text = document.createElement('span');
  text.className   = 'vh-field__label';
  text.textContent = '⚠ Esta reseña contiene spoilers';

  label.appendChild(checkbox);
  label.appendChild(text);
  return label;
}


// ════════════════════════════════════════════════════════
// 3. LÓGICA DE INTERACCIÓN
// ════════════════════════════════════════════════════════

/**
 * Muestra u oculta la fila del slider de contenido adulto.
 * @param {boolean} show
 */
function _toggleAdultRow(show) {
  const grid = document.getElementById('scoreGrid');
  if (!grid) return;
  grid.querySelectorAll('[data-adult-row]').forEach(row => {
    row.style.display = show ? '' : 'none';
  });
}

/**
 * Lee los valores de todos los sliders, calcula el score
 * y actualiza el preview en tiempo real.
 */
function _recalculate() {
  try {
    const input = _buildScoreInput();
    const result = calculateScore(input);

    _state.finalScore = result;

    const previewScore = document.getElementById('previewScore');
    const previewLabel = document.getElementById('previewLabel');

    if (previewScore) previewScore.textContent = formatFinalScore(result.finalScore);
    if (previewLabel) previewLabel.textContent  = result.finalScoreLabel;

  } catch {
    // Input incompleto aún — no mostramos error, solo dejamos el preview en "—"
  }
}

/**
 * Construye el objeto RawScoreInput a partir de los sliders del DOM.
 * @returns {import('./score-engine.js').RawScoreInput}
 */
function _buildScoreInput() {
  const input = { hasAdultContent: _state.hasAdultContent };

  SCORE_CATEGORIES.forEach(cat => {
    const slider = _sliders[cat.key];
    if (!slider) return;
    if (cat.optional && !_state.hasAdultContent) return;
    input[cat.key] = parseFloat(slider.value);
  });

  return input;
}


// ════════════════════════════════════════════════════════
// 4. GUARDAR
// ════════════════════════════════════════════════════════

/**
 * Maneja el click en "Guardar clasificación".
 * Valida, persiste en el store y opcionalmente publica en el feed.
 */
async function _handleSave() {
  const saveBtn = document.getElementById('modalReviewSave');

  try {
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Guardando…'; }

    // Calcular score final
    const scoreInput = _buildScoreInput();
    const scoreData  = calculateScore(scoreInput);

    // Leer campos de texto
    const favRoute  = document.getElementById('review_favRoute')?.value.trim()  ?? '';
    const review    = document.getElementById('review_review')?.value.trim()    ?? '';
    const isSpoiler = document.getElementById('review_isSpoiler')?.checked      ?? false;

    // Persistir en el store local
    LibraryStore.updateReview(_state.vnId, scoreData, { favRoute, review, isSpoiler });

    // Publicar en el feed si hay sesión activa
    if (FirebaseService.isAuthenticated()) {
      await FirebaseService.publishToFeed({
        vnId:       _state.vnId,
        vnTitle:    _state.vnTitle,
        vnImageUrl: _state.vnImageUrl,
        finalScore: scoreData.finalScore,
        scoreLabel: scoreData.finalScoreLabel,
        review,
        isSpoiler,
      }).catch(err => console.warn('[ModalReview] No se pudo publicar en feed:', err));
    }

    close();

  } catch (err) {
    console.error('[ModalReview] Error al guardar:', err);
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾 Guardar clasificación'; }
  }
}


// ════════════════════════════════════════════════════════
// 5. API PÚBLICA
// ════════════════════════════════════════════════════════

/**
 * Abre el modal de review para una VN específica.
 * Si la VN ya tiene review guardada, pre-carga los valores.
 *
 * @param {string} vnId
 * @param {string} vnTitle
 * @param {string} [vnImageUrl]
 */
function open(vnId, vnTitle, vnImageUrl = '') {
  if (!_overlay) _build();

  _state.vnId       = vnId;
  _state.vnTitle    = vnTitle;
  _state.vnImageUrl = vnImageUrl;

  // Actualizar subtítulo con el nombre de la VN
  const subtitle = document.getElementById('modalReviewSubtitle');
  if (subtitle) subtitle.textContent = vnTitle;

  // Pre-cargar valores si ya existe una review guardada
  const entry = LibraryStore.getEntry(vnId);
  if (entry?.score) {
    _preloadValues(entry);
  } else {
    _resetValues();
  }

  _recalculate();
  _overlay.hidden = false;

  // Focus al primer slider para accesibilidad
  const firstSlider = Object.values(_sliders)[0];
  firstSlider?.focus();
}

/** Cierra el modal. */
function close() {
  if (_overlay) _overlay.hidden = true;
  _state.vnId = null;
}

/**
 * Pre-carga los valores del formulario con una review existente.
 * @param {import('./library-store.js').LibraryEntry} entry
 */
function _preloadValues(entry) {
  const score = entry.score;

  // Restaurar sliders
  Object.entries(score.rawScores ?? {}).forEach(([key, val]) => {
    if (_sliders[key]) {
      _sliders[key].value  = val;
      if (_values[key]) _values[key].textContent = String(val);
    }
  });

  // Restaurar toggle adulto
  const adultCheckbox = document.getElementById('reviewHasAdult');
  if (adultCheckbox) {
    adultCheckbox.checked  = score.hasAdultContent;
    _state.hasAdultContent = score.hasAdultContent;
    _toggleAdultRow(score.hasAdultContent);
  }

  // Restaurar campos de texto
  const favInput    = document.getElementById('review_favRoute');
  const reviewInput = document.getElementById('review_review');
  const spoilerChk  = document.getElementById('review_isSpoiler');

  if (favInput)    favInput.value      = entry.favRoute  ?? '';
  if (reviewInput) reviewInput.value   = entry.review    ?? '';
  if (spoilerChk)  spoilerChk.checked  = entry.isSpoiler ?? false;
}

/**
 * Resetea todos los campos del formulario a sus valores por defecto.
 */
function _resetValues() {
  Object.values(_sliders).forEach(slider => { slider.value = '5'; });
  Object.values(_values).forEach(span   => { span.textContent = '5'; });

  _state.hasAdultContent = true;
  const adultCheckbox = document.getElementById('reviewHasAdult');
  if (adultCheckbox) adultCheckbox.checked = true;
  _toggleAdultRow(true);

  const favInput    = document.getElementById('review_favRoute');
  const reviewInput = document.getElementById('review_review');
  const spoilerChk  = document.getElementById('review_isSpoiler');

  if (favInput)    favInput.value     = '';
  if (reviewInput) reviewInput.value  = '';
  if (spoilerChk)  spoilerChk.checked = false;

  const previewScore = document.getElementById('previewScore');
  const previewLabel = document.getElementById('previewLabel');
  if (previewScore) previewScore.textContent = '—';
  if (previewLabel) previewLabel.textContent  = 'Ajusta los sliders';
}


// ════════════════════════════════════════════════════════
// EXPORTACIÓN
// ════════════════════════════════════════════════════════
export { open, close };