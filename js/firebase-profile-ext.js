'use strict';

/**
 * @file js/firebase-profile-ext.js
 * @description Extensión del servicio Firebase para perfiles públicos.
 *
 * FUNCIONES NUEVAS:
 *  - getPublicProfile(uid)   → Lee users/{uid}/meta/profile respetando privacidad.
 *  - getPublicLibrary(uid)   → Lee users/{uid}/library si el perfil es público.
 *  - getPublicReviews(uid)   → Filtra la biblioteca a entradas con review.
 *
 * SEGURIDAD:
 *  - Valida el UID antes de cualquier consulta a Firestore.
 *  - getPublicLibrary() verifica la privacidad del perfil antes de devolver datos.
 *
 * INTEGRACIÓN:
 *  Agrega estas funciones al firebase-service.js existente mediante import/re-export,
 *  o copia las funciones directamente en firebase-service.js.
 *
 * DEPENDE DE: firebase-service.js (para _db y la instancia de Firestore ya inicializada)
 *
 * NOTA: Como el _db es privado en firebase-service.js, esta extensión necesita
 *       acceder a Firestore mediante las funciones públicas ya existentes, o bien
 *       copiar las 3 funciones directamente en firebase-service.js.
 *
 *       SE RECOMIENDA copiar directamente en firebase-service.js (ver instrucciones abajo).
 */

/**
 * ══════════════════════════════════════════════════════════════
 * INSTRUCCIONES DE INTEGRACIÓN EN firebase-service.js
 * ══════════════════════════════════════════════════════════════
 *
 * 1. Abrir firebase-service.js
 * 2. Agregar las siguientes tres funciones dentro del mismo archivo,
 *    ANTES de la línea "export { ... }":
 *
 *    - getPublicProfile(uid)
 *    - getPublicLibrary(uid, isOwn)
 *    - getPublicReviews(uid, isOwn)
 *
 * 3. Agregar los tres nombres al bloque "export { ... }" al final.
 *
 * Las funciones usan _db, doc, getDoc, collection, getDocs
 * que ya están disponibles en firebase-service.js.
 * ══════════════════════════════════════════════════════════════
 */


// ─────────────────────────────────────────────────────────────
// FUNCIONES PARA COPIAR EN firebase-service.js
// ─────────────────────────────────────────────────────────────

/**
 * Obtiene el perfil público de cualquier usuario por UID.
 * Si el perfil es privado, devuelve solo { privacy: 'private', displayName }.
 *
 * DIFERENCIA con getUserProfile():
 *  getUserProfile() solo funciona para el usuario autenticado.
 *  getPublicProfile() permite consultar perfiles de otros usuarios.
 *
 * @param {string} uid — UID del usuario a consultar (cualquier usuario).
 * @returns {Promise<object|null>}
 */
async function getPublicProfile(uid) {
  _validateUid(uid);
  const snap = await getDoc(doc(_db, 'users', uid, 'meta', 'profile'));
  if (!snap.exists()) return null;
  return snap.data();
}

/**
 * Obtiene la biblioteca completa de un usuario.
 * Verifica la privacidad del perfil antes de devolver datos.
 *
 * @param {string}  uid   — UID del usuario dueño de la biblioteca.
 * @param {boolean} isOwn — true si el solicitante es el mismo usuario.
 * @returns {Promise<object[]>} Array de LibraryEntry o [] si es privado.
 */
async function getPublicLibrary(uid, isOwn = false) {
  _validateUid(uid);

  // Si no es el perfil propio, verificar privacidad antes de leer
  if (!isOwn) {
    const profile = await getPublicProfile(uid);
    if (!profile || profile.privacy !== 'public') return [];
  }

  const snap = await getDocs(collection(_db, 'users', uid, 'library'));
  return snap.docs.map(d => ({ ...d.data(), vnId: d.id }));
}

/**
 * Devuelve solo las entradas con reseña escrita de la biblioteca de un usuario.
 * Usa getPublicLibrary() internamente, respetando la misma lógica de privacidad.
 *
 * @param {string}  uid
 * @param {boolean} isOwn
 * @returns {Promise<object[]>}
 */
async function getPublicReviews(uid, isOwn = false) {
  const entries = await getPublicLibrary(uid, isOwn);
  return entries.filter(e =>
    e.status === 'finished' &&
    typeof e.review === 'string' &&
    e.review.trim().length > 0
  );
}

/**
 * Valida que el UID tenga el formato correcto de Firebase.
 * Previene consultas con IDs malformados o inyección de rutas.
 * @param {string} uid
 * @throws {TypeError} Si el UID no es válido.
 */
function _validateUid(uid) {
  if (typeof uid !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(uid)) {
    throw new TypeError(`[Firebase] UID inválido: "${uid}"`);
  }
}

/*
 * ══════════════════════════════════════════════════════════════
 * BLOQUE PARA AGREGAR AL export {} DE firebase-service.js:
 *
 *   getPublicProfile, getPublicLibrary, getPublicReviews,
 *
 * ══════════════════════════════════════════════════════════════
 */