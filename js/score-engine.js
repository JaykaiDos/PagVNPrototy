/**
 * @file score-engine.js
 * @description Motor de cálculo de puntaje ponderado para Visual Novels finalizadas.
 *              Implementa el sistema de pesos definido en el Mapa Maestro v1.
 *
 * SISTEMA DE PESOS:
 *  Historia / Guion       → 30%
 *  Personajes             → 15%
 *  Diseño Visual          →  6%
 *  Animaciones / CG       → 10%
 *  Escenas H (opcional)   → 15%
 *  Música / Voces         → 10%
 *  Interfaz / UX          →  4%
 *  Rejugabilidad / Extra  → 10%
 *  ─────────────────────────────
 *  BASE TOTAL             = 100%
 *  Puntos Extra (bonus)   → hasta +15% sobre el puntaje base
 *
 * ESCALA: 0–10 por categoría. Puntaje final en escala 0–10.
 *
 * CASO ESPECIAL — Escenas H (opcional):
 *  Si hasAdultContent = false, el 15% de "adult" se redistribuye
 *  proporcionalmente entre las demás categorías base.
 *
 * FÓRMULA COMPLETA:
 *  base_score   = Σ (rawScore_i × effectiveWeight_i) / 100
 *  bonus_points = (extra / 10) × 0.15 × base_score
 *  final_score  = min(10, base_score + bonus_points)
 *
 * PRINCIPIO DE DISEÑO (SRP):
 *  Este módulo SOLO calcula. NO persiste, NO renderiza.
 *  La persistencia es responsabilidad de library-store.js.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TESTS DE CONSOLA — Copiar y ejecutar en DevTools del navegador:
 *
 * import { calculateScore, getScoreLabel, getScoreBreakdown,
 *          formatFinalScore } from './score-engine.js';
 *
 * // 1. Cálculo básico con contenido adulto
 * const result = calculateScore({
 *   story: 9, characters: 8, art: 7, cg: 8,
 *   adult: 7, audio: 9, ux: 7, replayability: 8,
 *   extra: 5, hasAdultContent: true
 * });
 * console.log('Score final:', result.finalScore);         // ~8.xx
 * console.log('Label:', result.finalScoreLabel);          // "🌟 Muy Buena"
 * console.log('Base:', result.baseScore, '+ Bonus:', result.bonusPoints);
 *
 * // 2. Sin contenido adulto (redistribución de pesos)
 * const noAdult = calculateScore({
 *   story: 9, characters: 8, art: 7, cg: 8,
 *   audio: 9, ux: 7, replayability: 8,
 *   extra: 0, hasAdultContent: false
 * });
 * console.table(noAdult.effectiveWeights); // adult → 0, demás redistribuidos
 *
 * // 3. Breakdown para la UI
 * console.table(getScoreBreakdown(result));
 * // Muestra tabla: key, label, weight, rawScore, contribution, included
 *
 * // 4. Formatos de presentación
 * console.log(formatFinalScore(result.finalScore)); // "8.75"
 * console.log(getScoreLabel(9.6));   // "👑 Obra Maestra"
 * console.log(getScoreLabel(5.0));   // "😐 Mediocre"
 *
 * // 5. Validaciones (deben lanzar errores)
 * try { calculateScore({ story: 11 }); }
 * catch(e) { console.error(e.constructor.name + ':', e.message); } // RangeError
 *
 * try { calculateScore({ story: 'abc' }); }
 * catch(e) { console.error(e.constructor.name + ':', e.message); } // TypeError
 *
 * try { calculateScore(null); }
 * catch(e) { console.error(e.constructor.name + ':', e.message); } // TypeError
 * ─────────────────────────────────────────────────────────────────────────
 */

'use strict';

import { SCORE_CATEGORIES, SCORE_BASE_WEIGHT_TOTAL } from './constants.js';


// ─────────────────────────────────────────────
// 1. TIPOS (JSDoc)
// ─────────────────────────────────────────────

/**
 * @typedef {Object} RawScoreInput
 * @description Input del formulario de puntuación del usuario.
 *
 * @property {number}  story           - Historia / Guion (0-10). Requerido.
 * @property {number}  characters      - Personajes (0-10). Requerido.
 * @property {number}  art             - Diseño Visual (0-10). Requerido.
 * @property {number}  cg              - Animaciones / CG (0-10). Requerido.
 * @property {number}  [adult]         - Escenas H (0-10). Requerido si hasAdultContent=true.
 * @property {number}  audio           - Música, Voces y Sonidos (0-10). Requerido.
 * @property {number}  ux              - Interfaz / UX (0-10). Requerido.
 * @property {number}  replayability   - Rejugabilidad (0-10). Requerido.
 * @property {number}  [extra=0]       - Puntos Extra / impacto emocional (0-10). Opcional.
 * @property {boolean} [hasAdultContent=true] - false = omitir categoría adulta.
 */

/**
 * @typedef {Object} ScoreData
 * @description Resultado completo del cálculo. Guardado en LibraryEntry.score.
 *
 * @property {Record<string, number>} rawScores        - Puntuación bruta por categoría (0-10).
 * @property {Record<string, number>} weightedScores   - Contribución ponderada de cada categoría.
 * @property {Record<string, number>} effectiveWeights - Pesos efectivos aplicados (tras redistribución).
 * @property {number}                 baseScore         - Puntaje base (0-10), sin bonus.
 * @property {number}                 bonusPoints       - Puntos extra añadidos al base.
 * @property {number}                 finalScore        - Puntaje final (0-10), con bonus y cap.
 * @property {string}                 finalScoreLabel   - Clasificación verbal (ej: "👑 Obra Maestra").
 * @property {boolean}                hasAdultContent   - Si se incluyó la categoría adulta.
 * @property {string}                 calculatedAt      - Timestamp ISO 8601 del cálculo.
 */


// ─────────────────────────────────────────────
// 2. VALIDACIÓN DE INPUT
//    Funciones puras: no modifican estado externo.
//    Errores descriptivos para debugging y UX.
// ─────────────────────────────────────────────

/**
 * Valida que un valor de puntuación sea un número finito en [0, 10].
 * Redondea a 1 decimal para evitar ruido de punto flotante.
 *
 * @param {unknown} value - Valor a validar (puede venir de un input HTML).
 * @param {string}  field - Nombre del campo para el mensaje de error.
 * @returns {number} El valor validado, como número con 1 decimal.
 * @throws {TypeError}  Si el valor no es convertible a número finito.
 * @throws {RangeError} Si el valor está fuera del rango [0, 10].
 */
function _validateScore(value, field) {
  const num = Number(value);

  if (!Number.isFinite(num)) {
    throw new TypeError(
      `[ScoreEngine] "${field}" debe ser un número. Recibido: ${JSON.stringify(value)}`,
    );
  }

  if (num < 0 || num > 10) {
    throw new RangeError(
      `[ScoreEngine] "${field}" debe estar entre 0 y 10. Recibido: ${num}`,
    );
  }

  // 1 decimal: evita ruido como 8.300000000001
  return Math.round(num * 10) / 10;
}

/**
 * Valida y normaliza el objeto de input completo antes del cálculo.
 * Aplica los guards de cada campo según las reglas de negocio.
 *
 * @param {RawScoreInput} input - Input crudo del formulario.
 * @returns {RawScoreInput}     - Input completamente validado y normalizado.
 * @throws {TypeError|RangeError} Con mensaje descriptivo del campo inválido.
 */
function _validateInput(input) {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError(
      '[ScoreEngine] El input de calculateScore() debe ser un objeto. ' +
      `Recibido: ${input === null ? 'null' : typeof input}`,
    );
  }

  const validated = {
    hasAdultContent: Boolean(input.hasAdultContent ?? true),
  };

  // Validamos las categorías base (siempre requeridas, nunca opcionales, nunca bonus)
  const requiredCategories = SCORE_CATEGORIES.filter(c => !c.optional && !c.bonus);

  for (const category of requiredCategories) {
    if (input[category.key] === undefined || input[category.key] === null) {
      throw new TypeError(
        `[ScoreEngine] Falta la puntuación requerida para "${category.label}" (key: "${category.key}").`,
      );
    }
    validated[category.key] = _validateScore(input[category.key], category.label);
  }

  // Categoría adulta: requerida solo si hasAdultContent = true
  if (validated.hasAdultContent) {
    if (input.adult === undefined || input.adult === null) {
      throw new TypeError(
        '[ScoreEngine] hasAdultContent=true pero falta la puntuación de "Escenas H" (key: "adult").',
      );
    }
    validated.adult = _validateScore(input.adult, 'Escenas H');
  }

  // Bonus extra: opcional, default 0
  validated.extra = (input.extra !== undefined && input.extra !== null)
    ? _validateScore(input.extra, 'Puntos Extra')
    : 0;

  return validated;
}


// ─────────────────────────────────────────────
// 3. REDISTRIBUCIÓN DE PESOS
//    Cuando se omite la categoría "adult",
//    su peso (15%) se redistribuye de forma
//    proporcional entre las restantes categorías base.
// ─────────────────────────────────────────────

/**
 * Calcula los pesos efectivos finales de cada categoría.
 *
 * Caso hasAdultContent=true:  pesos originales del Mapa Maestro.
 * Caso hasAdultContent=false: el 15% de "adult" se reparte
 *                              proporcionalmente entre las demás categorías base.
 *
 * La suma de pesos efectivos debe ser siempre 100 (verificable en tests).
 *
 * @param {boolean} hasAdultContent - Si se incluye la categoría adulta.
 * @returns {Record<string, number>} Mapa de key → peso efectivo (suma = 100).
 */
function _computeEffectiveWeights(hasAdultContent) {
  const weights        = {};
  const baseCategories = SCORE_CATEGORIES.filter(c => !c.bonus);

  if (hasAdultContent) {
    // Caso simple: pesos del Mapa Maestro sin modificar
    baseCategories.forEach(c => { weights[c.key] = c.weight; });
    return weights;
  }

  // Caso redistribución: separamos adulta y no adultas
  const adultCategory      = baseCategories.find(c => c.optional);
  const nonAdultCategories = baseCategories.filter(c => !c.optional);

  const adultWeight    = adultCategory?.weight ?? 0;
  const nonAdultTotal  = nonAdultCategories.reduce((sum, c) => sum + c.weight, 0);

  nonAdultCategories.forEach(c => {
    // Cada categoría recibe su porción proporcional del peso liberado por "adult"
    const extraWeight = (c.weight / nonAdultTotal) * adultWeight;
    // Redondeamos a 2 decimales para evitar ruido en el cálculo final
    weights[c.key] = Math.round((c.weight + extraWeight) * 100) / 100;
  });

  // La categoría adulta tiene peso 0 (no participa en el cálculo)
  if (adultCategory) weights[adultCategory.key] = 0;

  return weights;
}


// ─────────────────────────────────────────────
// 4. MOTOR DE CÁLCULO PRINCIPAL
//    Función pura: mismo input → mismo output.
//    No depende ni modifica ningún estado externo.
// ─────────────────────────────────────────────

/**
 * Calcula el puntaje final ponderado de una Visual Novel finalizada.
 *
 * FÓRMULA DETALLADA:
 *  base_score   = Σ (rawScore_i × effectiveWeight_i) / 100
 *  extra_ratio  = extra / 10                          [0.0 – 1.0]
 *  bonus_points = extra_ratio × 0.15 × base_score     [proporcional al mérito]
 *  final_score  = min(10, base_score + bonus_points)   [cap en 10]
 *
 * El bonus es PROPORCIONAL al puntaje base, no a 10.
 * Esto evita que una VN mediocre suba demasiado con los puntos extra.
 *
 * @param {RawScoreInput} input - Puntuaciones del usuario (0-10 por categoría).
 * @returns {ScoreData}         - Resultado completo del cálculo.
 * @throws {TypeError|RangeError} Si algún campo del input es inválido.
 */
function calculateScore(input) {
  // ── Paso 1: Validar y normalizar el input
  const validated = _validateInput(input);

  // ── Paso 2: Calcular pesos efectivos (con o sin redistribución)
  const effectiveWeights = _computeEffectiveWeights(validated.hasAdultContent);

  // ── Paso 3: Calcular contribución ponderada de cada categoría
  const rawScores      = {};
  const weightedScores = {};
  let   baseScore      = 0;

  const baseCategories = SCORE_CATEGORIES.filter(c => !c.bonus);

  for (const category of baseCategories) {
    const score    = validated[category.key] ?? 0;
    const weight   = effectiveWeights[category.key] ?? 0;
    const weighted = (score * weight) / 100;

    rawScores[category.key]      = score;
    weightedScores[category.key] = Math.round(weighted * 1_000) / 1_000; // 3 decimales
    baseScore                   += weighted;
  }

  // Redondeamos el puntaje base a 2 decimales
  baseScore = Math.round(baseScore * 100) / 100;

  // ── Paso 4: Calcular bonus proporcional
  //    Extra = 10 → bonus = 15% del puntaje base
  //    Extra = 5  → bonus = 7.5% del puntaje base
  //    Extra = 0  → bonus = 0 (sin bonificación)
  const extraRatio  = (validated.extra ?? 0) / 10;
  const bonusPoints = Math.round(extraRatio * 0.15 * baseScore * 100) / 100;

  // ── Paso 5: Puntaje final con cap en 10
  const finalScore = Math.min(10, Math.round((baseScore + bonusPoints) * 100) / 100);

  return {
    rawScores,
    weightedScores,
    effectiveWeights,
    baseScore,
    bonusPoints,
    finalScore,
    finalScoreLabel: _getScoreLabel(finalScore),
    hasAdultContent: validated.hasAdultContent,
    calculatedAt:    new Date().toISOString(),
  };
}


// ─────────────────────────────────────────────
// 5. CLASIFICACIÓN VERBAL
//    Mapea un puntaje numérico a una etiqueta
//    humana con emoji para la UI.
// ─────────────────────────────────────────────

/**
 * @typedef {Object} ScoreThreshold
 * @property {number} min   - Puntaje mínimo inclusivo para esta clasificación.
 * @property {string} label - Nombre de la clasificación.
 * @property {string} icon  - Emoji representativo.
 * @property {string} css   - Clase CSS asociada (para estilos por clasificación).
 */

/**
 * Umbrales de clasificación ordenados de mayor a menor.
 * Se busca el primer umbral cuyo `min` sea <= al puntaje.
 *
 * INTEGRACIÓN CSS:
 *  Usar el campo `css` para aplicar clases de color:
 *  .score-masterpiece → dorado/especial
 *  .score-excellent   → degradado rosa-celeste (light) / rojo-dorado (dark)
 *  etc.
 *
 * @type {ScoreThreshold[]}
 */
const SCORE_THRESHOLDS = Object.freeze([
  { min: 9.5, label: 'Obra Maestra',            icon: '👑', css: 'score-masterpiece' },
  { min: 9.0, label: 'Excelente',               icon: '⭐', css: 'score-excellent'   },
  { min: 8.0, label: 'Muy Buena',               icon: '🌟', css: 'score-very-good'   },
  { min: 7.0, label: 'Buena',                   icon: '✨', css: 'score-good'         },
  { min: 6.0, label: 'Decente',                 icon: '👍', css: 'score-decent'       },
  { min: 5.0, label: 'Mediocre',                icon: '😐', css: 'score-mediocre'     },
  { min: 4.0, label: 'Por Debajo del Promedio', icon: '👎', css: 'score-below-avg'    },
  { min: 2.0, label: 'Mala',                    icon: '💔', css: 'score-bad'          },
  { min: 0,   label: 'Terrible',                icon: '💀', css: 'score-terrible'     },
]);

/**
 * Devuelve la clasificación verbal para un puntaje dado.
 * Función interna: no valida el puntaje (lo hace calculateScore antes).
 *
 * @param {number} score - Puntaje final (0-10).
 * @returns {string} Clasificación con emoji (ej: "👑 Obra Maestra").
 */
function _getScoreLabel(score) {
  const threshold = SCORE_THRESHOLDS.find(t => score >= t.min);
  return threshold
    ? `${threshold.icon} ${threshold.label}`
    : '❓ Sin clasificar';
}

/**
 * Versión pública de getScoreLabel para uso directo desde la UI.
 * Incluye validación y normalización del input.
 *
 * @param {number} score - Puntaje (0-10). Valores fuera de rango son ajustados.
 * @returns {string} Clasificación con emoji.
 *
 * @example
 *   getScoreLabel(9.6)  // → "👑 Obra Maestra"
 *   getScoreLabel(7.5)  // → "✨ Buena"
 *   getScoreLabel(NaN)  // → "❓ Sin clasificar"
 */
function getScoreLabel(score) {
  if (!Number.isFinite(score)) return '❓ Sin clasificar';
  const clamped = Math.max(0, Math.min(10, score));
  return _getScoreLabel(clamped);
}

/**
 * Devuelve el threshold completo para un puntaje dado.
 * Útil para obtener la clase CSS sin duplicar la lógica de búsqueda.
 *
 * @param {number} score - Puntaje (0-10).
 * @returns {ScoreThreshold|null}
 *
 * @example
 *   const t = getScoreThreshold(8.5);
 *   element.classList.add(t.css); // → 'score-very-good'
 */
function getScoreThreshold(score) {
  if (!Number.isFinite(score)) return null;
  const clamped = Math.max(0, Math.min(10, score));
  return SCORE_THRESHOLDS.find(t => clamped >= t.min) ?? null;
}


// ─────────────────────────────────────────────
// 6. HELPERS DE PRESENTACIÓN
//    Funciones puras para transformar ScoreData
//    en datos listos para la UI.
// ─────────────────────────────────────────────

/**
 * Genera un array de breakdown de categorías para la tabla de puntajes de la UI.
 * Cada elemento contiene toda la información necesaria para renderizar una fila.
 *
 * @param {ScoreData} scoreData - Resultado de calculateScore().
 * @returns {Array<{
 *   key: string,
 *   label: string,
 *   weight: number,
 *   rawScore: number,
 *   contribution: number,
 *   optional: boolean,
 *   included: boolean
 * }>}
 *
 * @example
 *   const rows = getScoreBreakdown(myScoreData);
 *   rows.forEach(row => {
 *     if (!row.included) return; // Saltar categorías con peso 0
 *     console.log(`${row.label}: ${row.rawScore}/10 × ${row.weight}% = ${row.contribution}`);
 *   });
 */
function getScoreBreakdown(scoreData) {
  return SCORE_CATEGORIES
    .filter(c => !c.bonus) // El bonus se muestra por separado en la UI
    .map(c => ({
      key:          c.key,
      label:        c.label,
      weight:       scoreData.effectiveWeights[c.key] ?? 0,
      rawScore:     scoreData.rawScores[c.key]        ?? 0,
      contribution: scoreData.weightedScores[c.key]   ?? 0,
      optional:     c.optional ?? false,
      // included = false si la categoría tiene peso 0 (adult en modo sin contenido)
      included:     (scoreData.effectiveWeights[c.key] ?? 0) > 0,
    }));
}

/**
 * Formatea un puntaje final para mostrar en la UI (2 decimales fijos).
 *
 * @param {number} score - Puntaje (0-10).
 * @returns {string} Ej: "8.75", "10.00". Devuelve "—" si no es número.
 *
 * @example
 *   formatFinalScore(8.75)  // → "8.75"
 *   formatFinalScore(10)    // → "10.00"
 *   formatFinalScore(NaN)   // → "—"
 */
function formatFinalScore(score) {
  if (!Number.isFinite(score)) return '—';
  return score.toFixed(2);
}

/**
 * Verifica en desarrollo que los pesos base sumen exactamente 100.
 * Útil para detectar errores si se editan los pesos en constants.js.
 *
 * @returns {boolean} true si la suma es correcta.
 *
 * @example
 *   console.assert(validateWeightSum(), 'ERROR: Los pesos base no suman 100!');
 */
function validateWeightSum() {
  const sum = SCORE_CATEGORIES
    .filter(c => !c.bonus)
    .reduce((acc, c) => acc + c.weight, 0);

  const isValid = sum === SCORE_BASE_WEIGHT_TOTAL;

  if (!isValid) {
    console.error(
      `[ScoreEngine] Los pesos base suman ${sum}, pero deberían sumar ${SCORE_BASE_WEIGHT_TOTAL}.`
    );
  }

  return isValid;
}


// ─────────────────────────────────────────────
// EXPORTACIÓN (API pública del módulo)
// ─────────────────────────────────────────────
export {
  // Función principal de cálculo (función pura)
  calculateScore,

  // Clasificación verbal
  getScoreLabel,
  getScoreThreshold,
  SCORE_THRESHOLDS,

  // Helpers de presentación para la UI
  getScoreBreakdown,
  formatFinalScore,

  // Utilidad de validación
  validateWeightSum,
};