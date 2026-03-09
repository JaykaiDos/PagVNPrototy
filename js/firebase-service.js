'use strict';

/**
 * @file js/firebase-service.js
 * @description Servicio Firebase para VN-Hub.
 *              Auth Google + Firestore (biblioteca + feed social).
 *              CDN-only, sin npm. Compatible 100% GitHub Pages.
 *
 * SCHEMA FIRESTORE:
 *  users/{uid}/meta/profile     → datos del perfil y privacidad
 *  users/{uid}/library/{vnId}   → entradas de biblioteca
 *  feed/{uid_vnId}              → reseñas públicas
 */

import { initializeApp }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAnalytics }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-analytics.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup,
  signOut, onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, sendPasswordResetEmail,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, deleteDoc,
  collection, getDocs, query, orderBy, limit,
  serverTimestamp, writeBatch,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';


// ── Configuración ────────────────────────────────────────────────────
const _config = Object.freeze({
  apiKey:            'AIzaSyDiuwi3frjLFlEgJ7XqH8-98W5ABkVbFHM',
  authDomain:        'vnhub-82ff6.firebaseapp.com',
  projectId:         'vnhub-82ff6',
  storageBucket:     'vnhub-82ff6.firebasestorage.app',
  messagingSenderId: '973583347837',
  appId:             '1:973583347837:web:1ce7fe9b5ef8b338dc4114',
  measurementId:     'G-39L0K7BS7P',
});

// ── Inicialización ───────────────────────────────────────────────────
const _app      = initializeApp(_config);
const _analytics = getAnalytics(_app);
const _auth     = getAuth(_app);
const _db       = getFirestore(_app);
const _provider = new GoogleAuthProvider();
_provider.setCustomParameters({ prompt: 'select_account' });

// ── Estado interno ───────────────────────────────────────────────────
/** @type {import('firebase/auth').User|null} */
let _currentUser = null;
/** @type {Set<Function>} */
const _authListeners = new Set();


// ════════════════════════════════════════════════════════
// 1. AUTENTICACIÓN
// ════════════════════════════════════════════════════════

/**
 * Login con Google (popup). Crea perfil en Firestore si es nuevo usuario.
 * @returns {Promise<{uid,displayName,photoURL,email}>}
 */
async function signInWithGoogle() {
  const result = await signInWithPopup(_auth, _provider);
  await _ensureProfileExists(result.user);
  return _mapUser(result.user);
}

/** Cierra sesión. @returns {Promise<void>} */
async function signOutUser() {
  await signOut(_auth);
}

/**
 * Suscribe un callback a cambios de autenticación.
 * Se invoca inmediatamente con el estado actual.
 * @param {function(user:object|null):void} callback
 * @returns {function} Desuscribirse
 */
function onAuthChange(callback) {
  _authListeners.add(callback);
  callback(_currentUser ? _mapUser(_currentUser) : null);
  return () => _authListeners.delete(callback);
}

/** @returns {{uid,displayName,photoURL,email}|null} */
function getCurrentUser() {
  return _currentUser ? _mapUser(_currentUser) : null;
}

/** @returns {boolean} */
function isAuthenticated() {
  return _currentUser !== null;
}

/** Obtiene el ID token JWT del usuario actual (para integraciones). */
async function getIdToken() {
  if (!_currentUser) return null;
  return await _currentUser.getIdToken(/* forceRefresh */ false);
}

// Helpers privados de auth
function _mapUser(u) {
  return {
    uid:         u.uid,
    displayName: u.displayName ?? 'Usuario',
    photoURL:    u.photoURL    ?? '',
    email:       u.email       ?? '',
  };
}

async function _ensureProfileExists(user) {
  const ref  = doc(_db, 'users', user.uid, 'meta', 'profile');
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      displayName: user.displayName ?? 'Usuario',
      photoURL:    user.photoURL    ?? '',
      email:       user.email       ?? '',
      privacy:     'public',
      createdAt:   serverTimestamp(),
      updatedAt:   serverTimestamp(),
    });
  }
}

// Listener global de auth — ejecuta una vez al cargar el módulo
onAuthStateChanged(_auth, (user) => {
  _currentUser = user;
  const mapped = user ? _mapUser(user) : null;
  _authListeners.forEach(cb => {
    try { cb(mapped); } catch (e) { console.error('[Firebase] authListener error:', e); }
  });
});

/**
 * Registro con email y contraseña.
 * @param {string} email
 * @param {string} password
 */
async function signUpWithEmailPassword(email, password) {
  const cred = await createUserWithEmailAndPassword(_auth, email, password);
  await _ensureProfileExists(cred.user);
  return _mapUser(cred.user);
}

/**
 * Inicio de sesión con email y contraseña.
 * @param {string} email
 * @param {string} password
 */
async function signInWithEmailPassword(email, password) {
  const cred = await signInWithEmailAndPassword(_auth, email, password);
  return _mapUser(cred.user);
}

/**
 * Envía correo de recuperación de contraseña.
 * @param {string} email
 */
async function resetPassword(email) {
  await sendPasswordResetEmail(_auth, email);
  return true;
}


// ════════════════════════════════════════════════════════
// 2. PERFIL
// ════════════════════════════════════════════════════════

/**
 * Obtiene el perfil de un usuario.
 * @param {string|null} uid — default: usuario actual
 * @returns {Promise<object|null>}
 */
async function getUserProfile(uid = null) {
  const target = uid ?? _currentUser?.uid;
  if (!target) return null;
  const snap = await getDoc(doc(_db, 'users', target, 'meta', 'profile'));
  return snap.exists() ? snap.data() : null;
}

/**
 * Actualiza la privacidad del perfil.
 * @param {'public'|'friends'|'private'} privacy
 */
async function updatePrivacy(privacy) {
  _assertAuth();
  if (!['public', 'friends', 'private'].includes(privacy)) {
    throw new TypeError(`[Firebase] Privacidad inválida: "${privacy}"`);
  }
  await setDoc(
    doc(_db, 'users', _currentUser.uid, 'meta', 'profile'),
    { privacy, updatedAt: serverTimestamp() },
    { merge: true },
  );
}


// ════════════════════════════════════════════════════════
// 3. SINCRONIZACIÓN DE BIBLIOTECA
// ════════════════════════════════════════════════════════

/**
 * Guarda o actualiza una entrada en Firestore.
 * @param {string} vnId
 * @param {object} entry — LibraryEntry del store local
 */
async function saveLibraryEntry(vnId, entry) {
  _assertAuth();
  _validateVnId(vnId);
  const ref = doc(_db, 'users', _currentUser.uid, 'library', vnId);
  const data = {
    vnId:       vnId,
    status:     entry.status,
    log:        entry.log ?? '',
    comment:    entry.comment ?? '',
    favRoute:   entry.favRoute ?? '',
    review:     entry.review ?? '',
    isSpoiler:  Boolean(entry.isSpoiler),
    addedAt:    null,
    updatedAt:  serverTimestamp(),    // Auditoría
  };
  if (entry.score && typeof entry.score.finalScore === 'number') {
    data.score = entry.score;
  }
  await setDoc(ref, data, { merge: true });
}

/**
 * Elimina una entrada de la biblioteca en Firestore.
 * @param {string} vnId
 */
async function deleteLibraryEntry(vnId) {
  _assertAuth();
  _validateVnId(vnId);
  await deleteDoc(doc(_db, 'users', _currentUser.uid, 'library', vnId));
}

/**
 * Carga toda la biblioteca del usuario desde Firestore.
 * @returns {Promise<object[]>}
 */
async function loadLibraryFromCloud() {
  _assertAuth();
  const snap = await getDocs(
    collection(_db, 'users', _currentUser.uid, 'library'),
  );
  return snap.docs.map(d => ({ ...d.data(), vnId: d.id }));
}

/**
 * Sube la biblioteca local completa a Firestore (batch atómico).
 * Usado cuando el usuario inicia sesión con datos locales existentes.
 * @param {object[]} entries
 * @returns {Promise<number>} Cantidad de entradas subidas
 */
async function uploadLibraryBatch(entries) {
  _assertAuth();
  if (!Array.isArray(entries) || entries.length === 0) return 0;

  const CHUNK = 490; // Límite Firestore: 500 ops/batch
  let uploaded = 0;

  for (let i = 0; i < entries.length; i += CHUNK) {
    const batch = writeBatch(_db);
    entries.slice(i, i + CHUNK).forEach(e => {
      if (!e?.vnId || !/^v\d+$/.test(e.vnId)) return;
      const ref = doc(_db, 'users', _currentUser.uid, 'library', e.vnId);
      const data = {
        vnId:       e.vnId,
        status:     e.status,
        log:        e.log ?? '',
        comment:    e.comment ?? '',
        favRoute:   e.favRoute ?? '',
        review:     e.review ?? '',
        isSpoiler:  Boolean(e.isSpoiler),
        addedAt:    null,
        updatedAt:  serverTimestamp(),
      };
      if (e.score && typeof e.score.finalScore === 'number') {
        data.score = e.score;
      }
      batch.set(ref, data, { merge: true });
      uploaded++;
    });
    await batch.commit();
  }
  return uploaded;
}


// ════════════════════════════════════════════════════════
// 4. FEED SOCIAL
// ════════════════════════════════════════════════════════

/**
 * Publica una reseña en el feed público.
 * Solo funciona si el perfil del usuario es "public".
 *
 * @param {{vnId,vnTitle,vnImageUrl,finalScore,scoreLabel,review,isSpoiler}} params
 * @returns {Promise<string|null>} ID del doc creado, o null si perfil no es público
 */
async function publishToFeed({ vnId, vnTitle, vnImageUrl, finalScore, scoreLabel, review, isSpoiler }) {
  _assertAuth();
  const profile = await getUserProfile();
  if (profile?.privacy !== 'public') return null;

  const docId = `${_currentUser.uid}_${vnId}`;
  await setDoc(doc(_db, 'feed', docId), {
    uid:         _currentUser.uid,
    displayName: _currentUser.displayName ?? 'Usuario',
    photoURL:    _currentUser.photoURL    ?? '',
    vnId,
    vnTitle:     String(vnTitle    ?? '').slice(0, 200),
    vnImageUrl:  /^https:\/\//i.test(vnImageUrl) ? vnImageUrl : '',
    finalScore:  Number(finalScore) || 0,
    scoreLabel:  String(scoreLabel  ?? ''),
    review:      String(review      ?? '').slice(0, 2000),
    isSpoiler:   Boolean(isSpoiler),
    publishedAt: serverTimestamp(),
  });
  return docId;
}

/**
 * Elimina la reseña del feed (ej: al cambiar privacidad o eliminar la VN).
 * @param {string} vnId
 */
async function removeFromFeed(vnId) {
  if (!_currentUser) return;
  await deleteDoc(doc(_db, 'feed', `${_currentUser.uid}_${vnId}`)).catch(() => {});
}

/**
 * Obtiene las últimas reseñas del feed público.
 * @param {number} count — máx 50
 * @returns {Promise<object[]>}
 */
async function getPublicFeed(count = 20) {
  const n = Math.min(Math.max(1, Number(count) || 20), 50);
  const snap = await getDocs(
    query(collection(_db, 'feed'), orderBy('publishedAt', 'desc'), limit(n)),
  );
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}


// ════════════════════════════════════════════════════════
// 5. HELPERS PRIVADOS
// ════════════════════════════════════════════════════════

function _assertAuth() {
  if (!_currentUser) throw new Error('[Firebase] Requiere autenticación.');
}

function _validateVnId(vnId) {
  if (typeof vnId !== 'string' || !/^v\d+$/.test(vnId)) {
    throw new TypeError(`[Firebase] ID inválido: "${vnId}"`);
  }
}

/** Elimina valores undefined para que Firestore no los rechace. */
function _clean(obj) {
  return JSON.parse(JSON.stringify(obj, (_, v) => v === undefined ? null : v));
}


// ════════════════════════════════════════════════════════
// EXPORTACIÓN
// ════════════════════════════════════════════════════════
export {
  // Auth
  signInWithGoogle, signOutUser, onAuthChange, getCurrentUser, isAuthenticated,
  signUpWithEmailPassword, signInWithEmailPassword, getIdToken,
  resetPassword,
  // Perfil
  getUserProfile, updatePrivacy,
  // Biblioteca
  saveLibraryEntry, deleteLibraryEntry, loadLibraryFromCloud, uploadLibraryBatch,
  // Feed
  publishToFeed, removeFromFeed, getPublicFeed,
};

async function getSpanishSynopsis(vnId) {
  _validateVnId(vnId);
  const snap = await getDoc(doc(_db, 'synopsis', vnId));
  return snap.exists() ? snap.data() : null;
}

export { getSpanishSynopsis };
