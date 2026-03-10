/**
 * @file js/export-engine.js
 * @description Motor de exportación de listas de Visual Novels como imagen PNG compartible.
 *              Genera imágenes optimizadas para WhatsApp usando Canvas API.
 *              100% compatible con GitHub Pages (sin backend, sin dependencias externas).
 *
 * SOLUCIÓN CORS:
 *  Las imágenes de VNDB (s2.vndb.org) no permiten crossOrigin="anonymous" desde
 *  dominios externos. La solución es cargar las imágenes SIN el atributo crossOrigin,
 *  usando elementos <img> reales. El navegador las cargará desde su caché si ya
 *  las mostró en la UI. Si el canvas queda "tainted", el catch en _download()
 *  emite un mensaje de error claro al usuario.
 *
 * LAYOUT POR ESTADO (minimalista — máxima legibilidad en WhatsApp):
 *  FINISHED  → portada + título + mi puntuación personal (★ X.X)
 *  PLAYING   → portada + título
 *  PENDING   → portada + título
 *  DROPPED   → portada + título
 *
 * GRID: 4 columnas · máx. 24 VNs · canvas 1080px (estándar compartir).
 */

'use strict';

import { VN_STATUS, VN_STATUS_META } from './constants.js';


// ─────────────────────────────────────────────
// 1. CONFIGURACIÓN DE LAYOUT
// ─────────────────────────────────────────────

const CFG = Object.freeze({
  canvasWidth:      1080,
  outerPadH:        44,
  outerPadV:        32,
  gridCols:         4,
  cardGap:          16,
  cardRadius:       14,
  headerHeight:     110,
  footerHeight:     56,
  /** Relación alto/ancho de cada card (portada tipo novela) */
  cardAspect:       1.52,
  /** Máximo de VNs exportadas por imagen */
  maxEntries:       24,
  /** Escala HiDPI para nitidez en pantallas Retina */
  devicePixelRatio: 2,
});


// ─────────────────────────────────────────────
// 2. PALETAS DE COLOR (light / dark)
// ─────────────────────────────────────────────

const THEMES = Object.freeze({
  light: {
    bgTop:      '#f0e8f4',
    bgBottom:   '#fce7f3',
    bgAccent1:  'rgba(236,72,153,0.16)',
    bgAccent2:  'rgba(14,165,233,0.12)',
    card:       'rgba(255,255,255,0.88)',
    cardBorder: 'rgba(236,72,153,0.16)',
    cardShadow: 'rgba(175,60,120,0.18)',
    titleText:  '#2d1b3d',
    subText:    '#5b4068',
    mutedText:  '#a891b8',
    vnTitle:    '#1e1030',
    scoreHigh:  '#16a34a',
    scoreMid:   '#d97706',
    scoreLow:   '#dc2626',
    accent:     '#ec4899',
    accent2:    '#0ea5e9',
    footerText: 'rgba(91,64,104,0.50)',
    coverBg:    '#e8d5f0',
    coverFg:    '#c084fc',
    divider:    'rgba(236,72,153,0.14)',
    gradStop:   'rgba(255,255,255,1)',
  },
  dark: {
    bgTop:      '#0a0608',
    bgBottom:   '#130508',
    bgAccent1:  'rgba(220,38,38,0.20)',
    bgAccent2:  'rgba(180,83,9,0.14)',
    card:       'rgba(26,12,18,0.96)',
    cardBorder: 'rgba(239,68,68,0.20)',
    cardShadow: 'rgba(0,0,0,0.60)',
    titleText:  '#f5ede8',
    subText:    '#c4a898',
    mutedText:  '#6b4e44',
    vnTitle:    '#f5ede8',
    scoreHigh:  '#4ade80',
    scoreMid:   '#fbbf24',
    scoreLow:   '#f87171',
    accent:     '#ef4444',
    accent2:    '#f59e0b',
    footerText: 'rgba(196,168,152,0.38)',
    coverBg:    '#1a0810',
    coverFg:    '#ef4444',
    divider:    'rgba(239,68,68,0.14)',
    gradStop:   'rgba(26,12,18,1)',
  },
});


// ─────────────────────────────────────────────
// 3. CARGA DE PORTADAS (sin CORS)
// ─────────────────────────────────────────────

/**
 * Valida que la URL sea de los CDN de VNDB.
 * @param {unknown} url
 * @returns {boolean}
 */
function _isVndbUrl(url) {
  return typeof url === 'string' && /^https:\/\/(?:s\d*\.)?vndb\.org\//i.test(url);
}

/**
 * Carga una imagen sin crossOrigin para aprovechar el caché del navegador.
 * El navegador ya habrá cargado estas imágenes al mostrar las cards de la UI.
 *
 * @param {string|null} url
 * @param {number}      [timeoutMs=5000]
 * @returns {Promise<HTMLImageElement|null>}
 */
function _loadImage(url, timeoutMs = 5000) {
  if (!_isVndbUrl(url)) return Promise.resolve(null);

  return new Promise(resolve => {
    const img   = new Image();
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled         = true;
      img.onload      = null;
      img.onerror     = null;
      clearTimeout(timer);
      resolve(result);
    };

    const timer   = setTimeout(() => finish(null), timeoutMs);
    img.onload    = () => finish(img);
    img.onerror   = () => finish(null);
    img.src       = url;           // Sin crossOrigin → usa caché del browser
  });
}

/**
 * Carga todas las portadas en paralelo y devuelve un Map (vnId → img|null).
 * @param {Array<{vnId: string, url: string|null}>} list
 * @returns {Promise<Map<string, HTMLImageElement|null>>}
 */
async function _loadAllCovers(list) {
  const results = await Promise.allSettled(list.map(item => _loadImage(item.url)));
  const map     = new Map();
  list.forEach((item, i) => {
    const r = results[i];
    map.set(item.vnId, r.status === 'fulfilled' ? r.value : null);
  });
  return map;
}


// ─────────────────────────────────────────────
// 4. HELPERS DE CANVAS
// ─────────────────────────────────────────────

/**
 * Dibuja un rectángulo con esquinas redondeadas (path sin fill/stroke).
 */
function _roundRect(ctx, x, y, w, h, r) {
  const cr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + cr, y);
  ctx.lineTo(x + w - cr, y);
  ctx.quadraticCurveTo(x + w, y,     x + w, y + cr);
  ctx.lineTo(x + w, y + h - cr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - cr, y + h);
  ctx.lineTo(x + cr, y + h);
  ctx.quadraticCurveTo(x,   y + h, x, y + h - cr);
  ctx.lineTo(x, y + cr);
  ctx.quadraticCurveTo(x,   y,     x + cr, y);
  ctx.closePath();
}

/**
 * Trunca texto añadiendo "…" si supera maxWidth.
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} maxWidth
 * @returns {string}
 */
function _clamp(ctx, text, maxWidth) {
  if (!text) return '';
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 0 && ctx.measureText(t + '…').width > maxWidth) {
    t = t.slice(0, -1);
  }
  return t + '…';
}

/**
 * Parte texto en líneas que caben en maxWidth. Devuelve máx. maxLines líneas.
 * La última línea se trunca con "…" si es necesario.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string}  text
 * @param {number}  maxWidth
 * @param {number}  maxLines
 * @returns {string[]}
 */
function _wrap(ctx, text, maxWidth, maxLines) {
  if (!text) return [];
  const words   = text.split(' ');
  const lines   = [];
  let   current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && current) {
      lines.push(current);
      if (lines.length >= maxLines) break;
      current = word;
    } else {
      current = candidate;
    }
  }

  if (current && lines.length < maxLines) {
    lines.push(current);
  }

  // Truncar última línea si aún desborda
  if (lines.length > 0) {
    lines[lines.length - 1] = _clamp(ctx, lines[lines.length - 1], maxWidth);
  }

  return lines.slice(0, maxLines);
}


// ─────────────────────────────────────────────
// 5. CAPAS DE DIBUJO
// ─────────────────────────────────────────────

/**
 * Fondo con gradiente base + manchas radiales de color.
 */
function _drawBackground(ctx, w, h, t) {
  const base = ctx.createLinearGradient(0, 0, 0, h);
  base.addColorStop(0, t.bgTop);
  base.addColorStop(1, t.bgBottom);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);

  const r1 = ctx.createRadialGradient(w * 0.15, h * 0.12, 0, w * 0.15, h * 0.12, w * 0.42);
  r1.addColorStop(0, t.bgAccent1);
  r1.addColorStop(1, 'transparent');
  ctx.fillStyle = r1;
  ctx.fillRect(0, 0, w, h);

  const r2 = ctx.createRadialGradient(w * 0.88, h * 0.08, 0, w * 0.88, h * 0.08, w * 0.36);
  r2.addColorStop(0, t.bgAccent2);
  r2.addColorStop(1, 'transparent');
  ctx.fillStyle = r2;
  ctx.fillRect(0, 0, w, h);
}

/**
 * Header: barra de acento | icono + título de sección + contador + fecha.
 */
function _drawHeader(ctx, w, status, count, t) {
  const meta = VN_STATUS_META[status];
  const midY = CFG.headerHeight / 2;
  const padH = CFG.outerPadH;

  // Barra decorativa izquierda
  ctx.fillStyle = t.accent;
  ctx.fillRect(padH, midY - 26, 4, 52);

  // Icono del estado
  ctx.font      = '34px serif';
  ctx.textAlign = 'left';
  ctx.fillText(meta.icon, padH + 18, midY + 11);

  // Título de la sección
  ctx.fillStyle = t.titleText;
  ctx.font      = `bold 34px "Playfair Display", Georgia, serif`;
  ctx.fillText(meta.label, padH + 68, midY - 4);

  // Contador de VNs
  ctx.fillStyle = t.subText;
  ctx.font      = `500 17px "DM Sans", "Helvetica Neue", sans-serif`;
  ctx.fillText(`${count} visual novel${count !== 1 ? 's' : ''}`, padH + 68, midY + 20);

  // Fecha de exportación (alineada a la derecha)
  const fecha = new Date().toLocaleDateString('es-AR', {
    day: '2-digit', month: 'long', year: 'numeric',
  });
  ctx.fillStyle = t.mutedText;
  ctx.font      = `400 13px "DM Sans", "Helvetica Neue", sans-serif`;
  ctx.textAlign = 'right';
  ctx.fillText(`Exportado el ${fecha}`, w - padH, midY + 20);

  // Línea divisoria
  ctx.strokeStyle = t.divider;
  ctx.lineWidth   = 1.5;
  ctx.beginPath();
  ctx.moveTo(padH, CFG.headerHeight - 10);
  ctx.lineTo(w - padH, CFG.headerHeight - 10);
  ctx.stroke();

  ctx.textAlign = 'left'; // resetear
}

/**
 * Dibuja la portada de una VN en un área recortada con bordes redondeados.
 * Si la imagen es null o falla, dibuja un placeholder de color.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {HTMLImageElement|null} img
 * @param {number} x
 * @param {number} y
 * @param {number} w   Ancho del área
 * @param {number} h   Alto del área
 * @param {number} r   Radio de borde
 * @param {ExportTheme} t
 */
function _drawCover(ctx, img, x, y, w, h, r, t) {
  ctx.save();
  _roundRect(ctx, x, y, w, h, r);
  ctx.clip();

  if (img && img.complete && img.naturalWidth > 0) {
    try {
      // Escalado tipo "object-fit: cover"
      const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
      const iw    = img.naturalWidth  * scale;
      const ih    = img.naturalHeight * scale;
      ctx.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
    } catch {
      // Canvas "tainted" u otro error → placeholder
      _placeholder(ctx, x, y, w, h, t);
    }
  } else {
    _placeholder(ctx, x, y, w, h, t);
  }

  ctx.restore();
}

/**
 * Placeholder cuando no hay portada disponible.
 */
function _placeholder(ctx, x, y, w, h, t) {
  ctx.fillStyle = t.coverBg;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = t.coverFg;
  ctx.font      = `${Math.floor(h * 0.30)}px serif`;
  ctx.textAlign = 'center';
  ctx.fillText('📖', x + w / 2, y + h * 0.57);
  ctx.textAlign = 'left';
}

/**
 * Dibuja UNA card individual.
 *
 * ESTRUCTURA VISUAL:
 *  ┌─────────────┐
 *  │             │  ← Portada (72% del alto)
 *  │    COVER    │
 *  │             │
 *  ├─────────────┤  ← Gradiente de transición
 *  │   Título    │  ← Área de texto (28%)
 *  │  ★ Score   │  ← Solo en FINISHED
 *  └─────────────┘
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} cw          Ancho de la card
 * @param {number} ch          Alto de la card
 * @param {string} title       Título de la VN
 * @param {HTMLImageElement|null} img
 * @param {string} status      Estado (VN_STATUS)
 * @param {object|null} entry  LibraryEntry (para score de FINISHED)
 * @param {ExportTheme} t
 */
function _drawCard(ctx, x, y, cw, ch, title, img, status, entry, t) {
  const r = CFG.cardRadius;

  // Sombra suave
  ctx.save();
  ctx.shadowColor   = t.cardShadow;
  ctx.shadowBlur    = 18;
  ctx.shadowOffsetY = 4;
  _roundRect(ctx, x, y, cw, ch, r);
  ctx.fillStyle = t.card;
  ctx.fill();
  ctx.restore();

  // Borde
  ctx.save();
  _roundRect(ctx, x, y, cw, ch, r);
  ctx.strokeStyle = t.cardBorder;
  ctx.lineWidth   = 1;
  ctx.stroke();
  ctx.restore();

  // Portada (72% superior)
  const coverH = Math.floor(ch * 0.72);
  _drawCover(ctx, img, x, y, cw, coverH, r, t);

  // Gradiente de transición portada → área texto
  ctx.save();
  _roundRect(ctx, x, y, cw, ch, r);
  ctx.clip();
  const grad = ctx.createLinearGradient(0, y + coverH - 30, 0, y + coverH + 2);
  grad.addColorStop(0, 'transparent');
  grad.addColorStop(1, t.gradStop);
  ctx.fillStyle = grad;
  ctx.fillRect(x, y + coverH - 30, cw, 32);
  ctx.restore();

  // ── Área de texto ──
  const textY  = y + coverH;
  const textH  = ch - coverH;
  const padX   = 10;
  const textW  = cw - padX * 2;

  if (status === VN_STATUS.FINISHED && entry?.score?.finalScore != null) {
    // FINISHED: título (1 línea) + score personal (grande)
    const score    = Number(entry.score.finalScore);
    const scoreStr = `★ ${score.toFixed(1)}`;
    const color    = score >= 7.5 ? t.scoreHigh : score >= 5.0 ? t.scoreMid : t.scoreLow;

    ctx.fillStyle = t.vnTitle;
    ctx.font      = `600 12px "DM Sans", "Helvetica Neue", sans-serif`;
    ctx.fillText(_clamp(ctx, title, textW), x + padX, textY + Math.floor(textH * 0.34));

    ctx.fillStyle = color;
    ctx.font      = `bold 18px "DM Sans", "Helvetica Neue", sans-serif`;
    ctx.fillText(scoreStr, x + padX, textY + Math.floor(textH * 0.78));

  } else {
    // PLAYING / PENDING / DROPPED: solo título (hasta 2 líneas centradas verticalmente)
    ctx.fillStyle = t.vnTitle;
    ctx.font      = `600 12px "DM Sans", "Helvetica Neue", sans-serif`;

    const lines  = _wrap(ctx, title, textW, 2);
    const lineH  = 15;
    const totalH = lines.length * lineH;
    const startY = textY + Math.floor((textH - totalH) / 2) + 12;

    lines.forEach((line, i) => ctx.fillText(line, x + padX, startY + i * lineH));
  }
}

/**
 * Dibuja el grid completo de cards.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{entry, title, img}>} items
 * @param {string} status
 * @param {object} layout   Resultado de _calcLayout()
 * @param {ExportTheme} t
 */
function _drawGrid(ctx, items, status, layout, t) {
  const { gridStartY, cardW, cardH, cols } = layout;
  const { outerPadH, cardGap } = CFG;

  items.forEach(({ entry, title, img }, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x   = outerPadH + col * (cardW + cardGap);
    const y   = gridStartY + row * (cardH + cardGap);
    _drawCard(ctx, x, y, cardW, cardH, title, img, status, entry, t);
  });
}

/**
 * Footer con marca de agua centrada.
 */
function _drawFooter(ctx, w, h, t) {
  const y = h - CFG.footerHeight + 18;

  ctx.strokeStyle = t.divider;
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(CFG.outerPadH, y - 10);
  ctx.lineTo(w - CFG.outerPadH, y - 10);
  ctx.stroke();

  ctx.fillStyle = t.footerText;
  ctx.textAlign = 'center';
  ctx.font      = `600 14px "Playfair Display", Georgia, serif`;
  ctx.fillText('✦ VN-Hub — Mi Biblioteca Personal de Visual Novels', w / 2, y + 10);
  ctx.font      = `400 11px "DM Sans", "Helvetica Neue", sans-serif`;
  ctx.fillText('vnhub.github.io', w / 2, y + 26);
  ctx.textAlign = 'left';
}


// ─────────────────────────────────────────────
// 6. CÁLCULO DE DIMENSIONES
// ─────────────────────────────────────────────

/**
 * Calcula las dimensiones del canvas y las métricas del grid.
 * @param {number} count - Número de items a renderizar.
 * @returns {{ canvasWidth, canvasHeight, cols, cardW, cardH, gridStartY }}
 */
function _calcLayout(count) {
  const { canvasWidth, outerPadH, outerPadV, gridCols,
          cardGap, headerHeight, footerHeight, cardAspect } = CFG;

  const gridW  = canvasWidth - outerPadH * 2;
  const cardW  = Math.floor((gridW - cardGap * (gridCols - 1)) / gridCols);
  const cardH  = Math.floor(cardW * cardAspect);
  const rows   = Math.ceil(count / gridCols);
  const gridH  = rows * cardH + (rows - 1) * cardGap;
  const height = headerHeight + outerPadV + gridH + outerPadV + footerHeight;

  return {
    canvasWidth,
    canvasHeight: height,
    cols:         gridCols,
    cardW,
    cardH,
    gridStartY:   headerHeight + outerPadV,
  };
}


// ─────────────────────────────────────────────
// 7. DESCARGA DEL PNG
// ─────────────────────────────────────────────

/**
 * Convierte el canvas a Blob y activa la descarga.
 * Si el canvas está "tainted" por imágenes de otro origen,
 * lanza un error claro para mostrar al usuario.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {string} status
 * @returns {Promise<void>}
 */
async function _download(canvas, status) {
  const date     = new Date().toISOString().slice(0, 10);
  const filename = `vnhub-${status}-${date}.png`;

  let blob;
  try {
    blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        b => b ? resolve(b) : reject(new Error('toBlob devolvió null')),
        'image/png',
      );
    });
  } catch {
    throw new Error(
      'Las portadas de VNDB bloquearon la exportación por seguridad del navegador. ' +
      'Recarga la página, navega a tu biblioteca para que las imágenes carguen, y vuelve a exportar.',
    );
  }

  const url = URL.createObjectURL(blob);
  const a   = Object.assign(document.createElement('a'), {
    href: url, download: filename, style: 'display:none',
  });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); document.body.removeChild(a); }, 1000);
}


// ─────────────────────────────────────────────
// 8. VALIDACIÓN DE ENTRADA
// ─────────────────────────────────────────────

/**
 * @param {unknown[]} entries
 * @param {string}    status
 * @throws {TypeError|RangeError}
 */
function _validate(entries, status) {
  if (!Array.isArray(entries)) {
    throw new TypeError('[ExportEngine] "entries" debe ser un Array.');
  }
  if (!Object.values(VN_STATUS).includes(status)) {
    throw new TypeError(`[ExportEngine] Estado inválido: "${status}".`);
  }
  if (entries.length === 0) {
    throw new RangeError(`[ExportEngine] No hay entradas en "${status}" para exportar.`);
  }
}


// ─────────────────────────────────────────────
// 9. PUNTO DE ENTRADA PÚBLICO
// ─────────────────────────────────────────────

/**
 * Genera y descarga la imagen PNG de exportación para una sección de estado.
 *
 * @param {object}           opts
 * @param {string}           opts.status      - Estado (VN_STATUS).
 * @param {object[]}         opts.entries     - LibraryEntries del estado.
 * @param {Map<string,object>} opts.vnCache   - Caché de datos VNDB.
 * @param {'light'|'dark'}   opts.theme       - Tema activo del documento.
 * @param {Function}         [opts.onProgress]- Callback(msg: string) para la UI.
 *
 * @returns {Promise<void>}
 * @throws {TypeError}   Si status o entries son inválidos.
 * @throws {RangeError}  Si entries está vacío.
 * @throws {Error}       Si el canvas no puede generarse o descargarse.
 *
 * @example
 *   await ExportEngine.generate({
 *     status:     VN_STATUS.FINISHED,
 *     entries:    LibraryStore.getEntriesByStatus(VN_STATUS.FINISHED),
 *     vnCache:    _state.vnCache,
 *     theme:      document.documentElement.dataset.theme ?? 'light',
 *     onProgress: msg => console.log(msg),
 *   });
 */
async function generate({ status, entries, vnCache, theme = 'light', onProgress }) {
  _validate(entries, status);

  const t       = THEMES[theme] ?? THEMES.light;
  const limited = entries.slice(0, CFG.maxEntries);
  const dpr     = CFG.devicePixelRatio;

  onProgress?.('Preparando datos…');

  // Lista de portadas a cargar
  const coverList = limited.map(entry => ({
    vnId: entry.vnId,
    url:  vnCache?.get(entry.vnId)?.imageUrl ?? null,
  }));

  onProgress?.('Cargando portadas…');
  const coverMap = await _loadAllCovers(coverList);

  // Combinar datos de store + caché VNDB + portada
  const items = limited.map(entry => ({
    entry,
    title: vnCache?.get(entry.vnId)?.title ?? entry.vnId,
    img:   coverMap.get(entry.vnId) ?? null,
  }));

  const layout = _calcLayout(items.length);
  onProgress?.('Generando imagen…');

  // Crear canvas HiDPI
  const canvas  = document.createElement('canvas');
  canvas.width  = layout.canvasWidth  * dpr;
  canvas.height = layout.canvasHeight * dpr;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('[ExportEngine] No se pudo obtener el contexto 2D del canvas.');
  ctx.scale(dpr, dpr);

  // Pintar capas en orden
  _drawBackground(ctx, layout.canvasWidth, layout.canvasHeight, t);
  _drawHeader(ctx, layout.canvasWidth, status, items.length, t);
  _drawGrid(ctx, items, status, layout, t);
  _drawFooter(ctx, layout.canvasWidth, layout.canvasHeight, t);

  onProgress?.('Descargando imagen…');
  await _download(canvas, status);
  onProgress?.('✅ Imagen exportada correctamente.');
}


// ─────────────────────────────────────────────
// EXPORTACIÓN DEL MÓDULO
// ─────────────────────────────────────────────
export const ExportEngine = Object.freeze({ generate });