'use strict';

/**
 * @file js/auth-controller.js
 * @description Controlador de UI para autenticación.
 *              Maneja el botón de login/logout y el panel de perfil
 *              en el header. Reacciona a cambios de auth via onAuthChange().
 *
 * RESPONSABILIDAD ÚNICA:
 *  - Renderizar el estado del usuario en el header.
 *  - Disparar signInWithGoogle() / signOutUser().
 *  - Sincronizar la biblioteca local con Firestore al iniciar sesión.
 *
 * NO hace: lógica de negocio, llamadas a VNDB, renders de cards.
 */

import * as FirebaseService from './firebase-service.js';
import * as LibraryStore    from './library-store.js';


// ── Referencias DOM (cacheadas al init) ─────────────────────────────
const _dom = {};

function _cacheDOM() {
  _dom.authContainer = document.getElementById('authContainer');
}


// ════════════════════════════════════════════════════════
// 1. RENDER DEL HEADER SEGÚN ESTADO DE AUTH
// ════════════════════════════════════════════════════════

/**
 * Renderiza el botón de login (usuario no autenticado).
 */
function _renderLoginButton() {
  if (!_dom.authContainer) return;

  // Limpiamos contenido anterior
  while (_dom.authContainer.firstChild) {
    _dom.authContainer.removeChild(_dom.authContainer.firstChild);
  }

  const box = document.createElement('div');
  box.className = 'vh-login-box';

  const googleBtn = document.createElement('button');
  googleBtn.className   = 'vh-auth-btn vh-auth-btn--login';
  googleBtn.id          = 'loginBtnGoogle';
  googleBtn.setAttribute('aria-label', 'Iniciar sesión con Google');
  const gIcon = document.createElement('span'); gIcon.setAttribute('aria-hidden', 'true'); gIcon.textContent = '✦';
  const gLabel= document.createElement('span'); gLabel.textContent = 'Iniciar con Google';
  googleBtn.appendChild(gIcon); googleBtn.appendChild(gLabel);
  googleBtn.addEventListener('click', _handleLogin);

  const form = document.createElement('div');
  form.className = 'vh-login-form';
  form.innerHTML = `
    <div class="vh-field">
      <label class="vh-field__label" for="authEmail">Correo electrónico</label>
      <input class="vh-field__input" id="authEmail" type="email" autocomplete="email" />
    </div>
    <div class="vh-field">
      <label class="vh-field__label" for="authPassword">Contraseña</label>
      <input class="vh-field__input" id="authPassword" type="password" autocomplete="current-password" />
      <p class="vh-field__hint" id="authError" style="color:var(--vh-danger);display:none;"></p>
    </div>
    <div class="vh-login-actions" style="display:flex;gap:.5rem;margin-top:.5rem;">
      <button class="vh-btn vh-btn--primary" id="btnEmailLogin">Iniciar sesión</button>
      <button class="vh-btn vh-btn--ghost"   id="btnEmailSignup">Registrarse</button>
      <button class="vh-btn vh-btn--ghost"   id="btnResetPassword">Recuperar contraseña</button>
    </div>
  `;

  box.appendChild(googleBtn);
  box.appendChild(form);
  _dom.authContainer.appendChild(box);

  document.getElementById('btnEmailLogin')?.addEventListener('click', _handleEmailLogin);
  document.getElementById('btnEmailSignup')?.addEventListener('click', _handleEmailSignup);
  document.getElementById('btnResetPassword')?.addEventListener('click', _handlePasswordReset);
}

/**
 * Renderiza el avatar + nombre + botón logout (usuario autenticado).
 * @param {{uid, displayName, photoURL, email}} user
 */
function _renderUserMenu(user) {
  if (!_dom.authContainer) return;

  while (_dom.authContainer.firstChild) {
    _dom.authContainer.removeChild(_dom.authContainer.firstChild);
  }

  // Wrapper del menú de usuario
  const wrapper = document.createElement('div');
  wrapper.className = 'vh-user-menu';
  wrapper.id        = 'userMenu';

  // Botón disparador (avatar + nombre)
  const trigger = document.createElement('button');
  trigger.className   = 'vh-user-menu__trigger';
  trigger.setAttribute('aria-label', `Menú de usuario: ${user.displayName}`);
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-haspopup', 'true');

  // Avatar
  const avatar = document.createElement('div');
  avatar.className = 'vh-user-menu__avatar';

  if (user.photoURL) {
    const img    = document.createElement('img');
    // Validamos que sea https para prevenir javascript: URIs
    const safeUrl = /^https:\/\//i.test(user.photoURL) ? user.photoURL : '';
    img.setAttribute('src',     safeUrl);
    img.setAttribute('alt',     user.displayName);
    img.setAttribute('loading', 'lazy');
    img.onerror = () => { avatar.textContent = user.displayName.charAt(0).toUpperCase(); };
    avatar.appendChild(img);
  } else {
    // Inicial como fallback
    avatar.textContent = user.displayName.charAt(0).toUpperCase();
  }

  // Nombre (truncado si es largo)
  const name = document.createElement('span');
  name.className   = 'vh-user-menu__name';
  name.textContent = user.displayName.slice(0, 18) + (user.displayName.length > 18 ? '…' : '');

  // Flecha indicadora
  const arrow = document.createElement('span');
  arrow.className      = 'vh-user-menu__arrow';
  arrow.setAttribute('aria-hidden', 'true');
  arrow.textContent    = '▾';

  trigger.appendChild(avatar);
  trigger.appendChild(name);
  trigger.appendChild(arrow);

  // Dropdown
  const dropdown = _buildDropdown(user);
  dropdown.id    = 'userDropdown';

  wrapper.appendChild(trigger);
  wrapper.appendChild(dropdown);
  _dom.authContainer.appendChild(wrapper);

  // Toggle dropdown al click
  trigger.addEventListener('click', () => _toggleDropdown(trigger, dropdown));

  // Cerrar al click fuera
  document.addEventListener('click', (e) => {
    if (!wrapper.contains(e.target)) _closeDropdown(trigger, dropdown);
  }, { capture: true });
}

/**
 * Construye el dropdown con opciones del usuario.
 * @param {{uid, displayName, email}} user
 * @returns {HTMLElement}
 */
function _buildDropdown(user) {
  const dropdown = document.createElement('div');
  dropdown.className = 'vh-user-menu__dropdown';
  dropdown.setAttribute('role',   'menu');
  dropdown.setAttribute('hidden', '');

  // Email (solo informativo)
  const emailEl = document.createElement('p');
  emailEl.className   = 'vh-user-menu__email';
  emailEl.textContent = user.email;
  dropdown.appendChild(emailEl);

  // Separador
  dropdown.appendChild(_buildSeparator());

  // Selector de privacidad
  dropdown.appendChild(_buildPrivacySelector());

  // Separador
  dropdown.appendChild(_buildSeparator());

  // Botón cerrar sesión
  const logoutBtn = document.createElement('button');
  logoutBtn.className   = 'vh-user-menu__item vh-user-menu__item--danger';
  logoutBtn.setAttribute('role', 'menuitem');

  const logoutIcon  = document.createElement('span');
  logoutIcon.setAttribute('aria-hidden', 'true');
  logoutIcon.textContent = '↩';

  const logoutLabel = document.createElement('span');
  logoutLabel.textContent = 'Cerrar sesión';

  logoutBtn.appendChild(logoutIcon);
  logoutBtn.appendChild(logoutLabel);
  logoutBtn.addEventListener('click', _handleLogout);
  dropdown.appendChild(logoutBtn);

  return dropdown;
}

/**
 * Construye el selector de privacidad del perfil.
 * @returns {HTMLElement}
 */
function _buildPrivacySelector() {
  const wrapper = document.createElement('div');
  wrapper.className = 'vh-privacy-selector';

  const label = document.createElement('p');
  label.className   = 'vh-privacy-selector__label';
  label.textContent = 'Privacidad del perfil';
  wrapper.appendChild(label);

  const options = [
    { value: 'public',  icon: '🌐', text: 'Público'       },
    { value: 'friends', icon: '👥', text: 'Solo amigos'   },
    { value: 'private', icon: '🔒', text: 'Privado'       },
  ];

  const btnGroup = document.createElement('div');
  btnGroup.className = 'vh-privacy-selector__group';

  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className   = 'vh-privacy-selector__btn';
    btn.dataset.privacy = opt.value;
    btn.setAttribute('role', 'menuitem');

    const icon  = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = opt.icon;

    const text  = document.createElement('span');
    text.textContent = opt.text;

    btn.appendChild(icon);
    btn.appendChild(text);

    btn.addEventListener('click', () => _handlePrivacyChange(opt.value, btnGroup));
    btnGroup.appendChild(btn);
  });

  wrapper.appendChild(btnGroup);

  // Cargamos la privacidad actual y marcamos el botón activo
  FirebaseService.getUserProfile().then(profile => {
    if (!profile) return;
    _markActivePrivacy(btnGroup, profile.privacy);
  }).catch(() => {});

  return wrapper;
}

function _buildSeparator() {
  const hr = document.createElement('hr');
  hr.className = 'vh-user-menu__separator';
  return hr;
}


// ════════════════════════════════════════════════════════
// 2. HANDLERS DE EVENTOS
// ════════════════════════════════════════════════════════

/**
 * Maneja el click en "Iniciar sesión".
 * Tras login, sincroniza biblioteca local → Firestore.
 */
async function _handleLogin() {
  try {
    await FirebaseService.signInWithGoogle();
  } catch (err) {
    console.error('[AuthController] Error al iniciar sesión:', err);
  }
}

function _validateEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function _validatePassword(pw) {
  return typeof pw === 'string'
    && pw.length >= 8
    && /[A-Z]/.test(pw)
    && /[a-z]/.test(pw)
    && /\d/.test(pw);
}

function _showAuthError(msg) {
  const el = document.getElementById('authError');
  if (el) { el.textContent = msg; el.style.display = 'block'; }
}

function _clearAuthError() {
  const el = document.getElementById('authError');
  if (el) { el.textContent = ''; el.style.display = 'none'; }
}

async function _handleEmailLogin() {
  try {
    _clearAuthError();
    const email = document.getElementById('authEmail')?.value.trim() ?? '';
    const pw    = document.getElementById('authPassword')?.value ?? '';
    if (!_validateEmail(email)) { _showAuthError('Correo inválido.'); return; }
    if (pw.length < 1) { _showAuthError('Ingresa tu contraseña.'); return; }
    await FirebaseService.signInWithEmailPassword(email, pw);
  } catch (err) {
    _showAuthError('No se pudo iniciar sesión. Verifica tus datos.');
    console.error('[AuthController] Email login error:', err);
  }
}

async function _handleEmailSignup() {
  try {
    _clearAuthError();
    const email = document.getElementById('authEmail')?.value.trim() ?? '';
    const pw    = document.getElementById('authPassword')?.value ?? '';
    if (!_validateEmail(email)) { _showAuthError('Correo inválido.'); return; }
    if (!_validatePassword(pw)) {
      _showAuthError('Contraseña insegura. Usa 8+ caracteres con mayúscula, minúscula y número.');
      return;
    }
    await FirebaseService.signUpWithEmailPassword(email, pw);
  } catch (err) {
    _showAuthError('No se pudo registrar. Es posible que el correo ya exista.');
    console.error('[AuthController] Signup error:', err);
  }
}

async function _handlePasswordReset() {
  try {
    _clearAuthError();
    const email = document.getElementById('authEmail')?.value.trim() ?? '';
    if (!_validateEmail(email)) { _showAuthError('Correo inválido.'); return; }
    await FirebaseService.resetPassword(email);
    _showAuthError('Enviamos un correo de recuperación a tu bandeja de entrada.');
  } catch (err) {
    _showAuthError('No se pudo enviar el correo de recuperación.');
    console.error('[AuthController] Reset password error:', err);
  }
}
/** Maneja el click en "Cerrar sesión". */
async function _handleLogout() {
  try {
    await FirebaseService.signOutUser();
  } catch (err) {
    console.error('[AuthController] Error al cerrar sesión:', err);
  }
}

/**
 * Maneja el cambio de privacidad del perfil.
 * @param {'public'|'friends'|'private'} privacy
 * @param {HTMLElement} btnGroup
 */
async function _handlePrivacyChange(privacy, btnGroup) {
  try {
    await FirebaseService.updatePrivacy(privacy);
    _markActivePrivacy(btnGroup, privacy);
  } catch (err) {
    console.error('[AuthController] Error al actualizar privacidad:', err);
  }
}

/**
 * Marca visualmente el botón de privacidad activo.
 * @param {HTMLElement} btnGroup
 * @param {string} activeValue
 */
function _markActivePrivacy(btnGroup, activeValue) {
  btnGroup.querySelectorAll('[data-privacy]').forEach(btn => {
    btn.classList.toggle('vh-privacy-selector__btn--active', btn.dataset.privacy === activeValue);
  });
}


// ════════════════════════════════════════════════════════
// 3. DROPDOWN HELPERS
// ════════════════════════════════════════════════════════

function _toggleDropdown(trigger, dropdown) {
  const isOpen = !dropdown.hidden;
  if (isOpen) {
    _closeDropdown(trigger, dropdown);
  } else {
    _openDropdown(trigger, dropdown);
  }
}

function _openDropdown(trigger, dropdown) {
  dropdown.hidden = false;
  trigger.setAttribute('aria-expanded', 'true');
  trigger.querySelector('.vh-user-menu__arrow').textContent = '▴';
}

function _closeDropdown(trigger, dropdown) {
  dropdown.hidden = true;
  trigger.setAttribute('aria-expanded', 'false');
  const arrow = trigger.querySelector('.vh-user-menu__arrow');
  if (arrow) arrow.textContent = '▾';
}


// ════════════════════════════════════════════════════════
// 4. SINCRONIZACIÓN BIBLIOTECA LOCAL → FIRESTORE
// ════════════════════════════════════════════════════════

/**
 * Al iniciar sesión, sincroniza la biblioteca local con Firestore.
 *
 * ESTRATEGIA: Firestore tiene prioridad (source of truth en la nube).
 *
 * CORRECCIÓN BUG «Score/review perdido tras login»:
 *   Antes se usaba LibraryStore.addVn(entry.vnId, entry.status), que crea
 *   una entrada con todos los campos en valores por defecto, descartando
 *   el score, la review, el log y el resto de campos guardados en Firestore.
 *
 *   Ahora se usa LibraryStore.addVn() solo para registrar la entrada con su
 *   estado correcto, y luego se restauran los campos avanzados (score, review,
 *   favRoute, isSpoiler, log, comment) con las funciones de actualización
 *   específicas de cada estado.
 *
 * @param {string} uid - UID del usuario autenticado.
 */
async function _syncLibraryOnLogin(uid) {
  try {
    // 1. Subir entradas locales que aún no están en Firestore
    const localEntries = LibraryStore.getEntriesByStatus(null);
    if (localEntries.length > 0) {
      const uploaded = await FirebaseService.uploadLibraryBatch(localEntries);
      console.info(`[AuthController] ${uploaded} entradas locales subidas a Firestore para ${uid}.`);
    }

    // 2. Cargar la biblioteca completa desde la nube
    const cloudEntries = await FirebaseService.loadLibraryFromCloud();

    // 3. Limpiar el store local antes de repoblarlo
    LibraryStore.clearAll();

    // 4. Restaurar CADA entrada con TODOS sus campos (no solo status)
    cloudEntries.forEach(entry => {
      if (!entry?.vnId || !entry?.status) return;

      // 4a. Crear la entrada base con el estado correcto
      LibraryStore.addVn(entry.vnId, entry.status);

      // 4b. Restaurar campos específicos de FINISHED (score, review, favRoute)
      if (entry.status === 'finished' && entry.score?.finalScore != null) {
        try {
          LibraryStore.updateReview(entry.vnId, entry.score, {
            favRoute:  entry.favRoute  ?? '',
            review:    entry.review    ?? '',
            isSpoiler: Boolean(entry.isSpoiler),
          });
        } catch (e) {
          console.warn(`[AuthController] No se pudo restaurar review de "${entry.vnId}":`, e);
        }
      }

      // 4c. Restaurar bitácora de PLAYING (log)
      if (entry.status === 'playing' && entry.log) {
        try {
          LibraryStore.updateLog(entry.vnId, entry.log);
        } catch (e) {
          console.warn(`[AuthController] No se pudo restaurar log de "${entry.vnId}":`, e);
        }
      }

      // 4d. Restaurar comentario de DROPPED (comment)
      if (entry.status === 'dropped' && entry.comment) {
        try {
          LibraryStore.updateComment(entry.vnId, entry.comment);
        } catch (e) {
          console.warn(`[AuthController] No se pudo restaurar comment de "${entry.vnId}":`, e);
        }
      }
    });

    console.info(`[AuthController] Biblioteca restaurada desde la nube (${cloudEntries.length} entradas).`);

  } catch (err) {
    console.error('[AuthController] Error en sincronización:', err);
  }
}


// ════════════════════════════════════════════════════════
// 5. CALLBACK DE CAMBIO DE AUTENTICACIÓN
// ════════════════════════════════════════════════════════

/**
 * Reacciona a los cambios de estado de autenticación.
 * Llamado por onAuthChange() de firebase-service.
 *
 * @param {{uid,displayName,photoURL,email}|null} user
 */
async function _onAuthChange(user) {
  if (user) {
    _renderUserMenu(user);
    await _syncLibraryOnLogin(user.uid);
  } else {
    _renderLoginButton();
    try { LibraryStore.clearAll(); } catch {}
  }
}


// ════════════════════════════════════════════════════════
// 6. INICIALIZACIÓN
// ════════════════════════════════════════════════════════

/**
 * Inicializa el controlador de autenticación.
 * Llamado desde app-init.js tras el bootstrap principal.
 */
function init() {
  _cacheDOM();

  if (!_dom.authContainer) {
    console.warn('[AuthController] #authContainer no encontrado en el DOM.');
    return;
  }

  // Suscribirse a cambios de auth — se ejecuta inmediatamente con el estado actual
  FirebaseService.onAuthChange(_onAuthChange);

  console.info('[AuthController] Inicializado ✓');
}

export { init };