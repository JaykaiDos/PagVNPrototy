'use strict';

/**
 * @file js/auth-controller.js
 * @description Controlador de UI para autenticación.
 *
 * CAMBIOS v5 — Login móvil con Bottom Sheet:
 * ─────────────────────────────────────────────────────────────────
 *  PROBLEMA DETECTADO:
 *   En viewports ≤ 767px el panel de login usaba position:absolute
 *   con right:0 dentro del header comprimido. Al no haber espacio
 *   horizontal suficiente, el panel se desbordaba fuera de la pantalla
 *   o quedaba invisible. Además, el scroll interno del formulario
 *   (inputs de email/password) bloqueaba el gestor de scroll nativo
 *   del navegador móvil causando problemas de UX.
 *
 *  SOLUCIÓN:
 *   Se introduce detección de viewport al abrir el panel.
 *   - Desktop (> 767px) → comportamiento anterior: dropdown bajo el botón.
 *   - Móvil  (≤ 767px)  → Bottom Sheet: modal deslizable desde abajo,
 *     con overlay oscuro semitransparente y handle visual de arrastre.
 *     El formulario se renderiza dentro del sheet con las mismas
 *     acciones que el dropdown (Google, email/password, recuperar).
 *
 *  PRINCIPIOS APLICADOS:
 *   - SRP: _openLoginPanel() decide el modo; _openLoginDropdown() y
 *     _openLoginSheet() son responsables exclusivos de cada UI.
 *   - DRY: los campos y handlers del formulario se construyen una sola
 *     vez en _buildLoginForm() y se reutilizan en ambos modos.
 *   - Sin duplicación de listeners: el bottom sheet se crea lazy
 *     la primera vez y se reutiliza en llamadas posteriores.
 *
 * CAMBIOS v4 (previos, mantenidos):
 *  - _renderLoginButton(): formulario como dropdown desplegable.
 *  - FIX email login: stopPropagation en botones del formulario.
 */

import * as FirebaseService from './firebase-service.js';
import * as LibraryStore    from './library-store.js';


// ── Referencias DOM (cacheadas al init) ─────────────────────────────
const _dom = {};

/** Referencia al bottom sheet creado (singleton lazy). */
let _sheet     = null;
/** Referencia al overlay del bottom sheet (singleton lazy). */
let _sheetBg   = null;
/** Referencia al trigger del login (para restaurar foco al cerrar). */
let _lastTrigger = null;


// ─────────────────────────────────────────────
// HELPERS INTERNOS
// ─────────────────────────────────────────────

/** @returns {boolean} true si el viewport es móvil (≤ 767px) */
function _isMobile() {
  return window.matchMedia('(max-width: 767px)').matches;
}

function _cacheDOM() {
  _dom.authContainer = document.getElementById('authContainer');
}


// ════════════════════════════════════════════════════════
// 1. RENDER DEL HEADER SEGÚN ESTADO DE AUTH
// ════════════════════════════════════════════════════════

/**
 * Renderiza el botón de login.
 * En desktop abre un dropdown bajo el botón.
 * En móvil abre un bottom sheet desde la parte inferior.
 */
function _renderLoginButton() {
  if (!_dom.authContainer) return;

  while (_dom.authContainer.firstChild) {
    _dom.authContainer.removeChild(_dom.authContainer.firstChild);
  }

  // ── Wrapper ──
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'position:relative;';

  // ── Botón trigger ──
  const trigger = document.createElement('button');
  trigger.className = 'vh-auth-btn--login';
  trigger.setAttribute('aria-label', 'Iniciar sesión');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-haspopup', 'dialog');

  const triggerIcon = document.createElement('span');
  triggerIcon.setAttribute('aria-hidden', 'true');
  triggerIcon.textContent = '✦';

  const triggerLabel = document.createElement('span');
  triggerLabel.textContent = 'Iniciar sesión';

  trigger.appendChild(triggerIcon);
  trigger.appendChild(triggerLabel);

  // ── Panel dropdown (desktop) ──
  const panel = document.createElement('div');
  panel.id        = 'loginPanel';
  panel.hidden    = true;
  panel.className = 'vh-login-dropdown';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Formulario de inicio de sesión');

  // Construir el formulario DESKTOP dentro del dropdown
  panel.appendChild(_buildLoginForm('dropdown'));

  // ── Toggle: decide desktop vs móvil ──
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    _lastTrigger = trigger;

    if (_isMobile()) {
      // En móvil: SIEMPRE abrir el bottom sheet, nunca el dropdown
      _openLoginSheet(trigger);
    } else {
      // En desktop: toggle del dropdown
      const isOpen = !panel.hidden;
      if (isOpen) {
        _closeLoginDropdown(panel, trigger);
      } else {
        _openLoginDropdown(panel, trigger);
      }
    }
  });

  // ── Cerrar dropdown al clickear fuera (desktop) ──
  document.addEventListener('click', (e) => {
    if (!panel.hidden && !wrapper.contains(e.target)) {
      _closeLoginDropdown(panel, trigger);
    }
  });

  // ── Cerrar con Escape (desktop) ──
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) {
      _closeLoginDropdown(panel, trigger);
      trigger.focus();
    }
  });

  wrapper.appendChild(trigger);
  wrapper.appendChild(panel);
  _dom.authContainer.appendChild(wrapper);
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

  const wrapper = document.createElement('div');
  wrapper.className = 'vh-user-menu';
  wrapper.id        = 'userMenu';

  const trigger = document.createElement('button');
  trigger.className   = 'vh-user-menu__trigger';
  trigger.setAttribute('aria-label', `Menú de usuario: ${user.displayName}`);
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-haspopup', 'true');

  // Avatar
  const avatar = document.createElement('div');
  avatar.className = 'vh-user-menu__avatar';

  if (user.photoURL) {
    const img     = document.createElement('img');
    const safeUrl = /^https:\/\//i.test(user.photoURL) ? user.photoURL : '';
    img.setAttribute('src',     safeUrl);
    img.setAttribute('alt',     user.displayName);
    img.setAttribute('loading', 'lazy');
    img.onerror = () => { avatar.textContent = user.displayName.charAt(0).toUpperCase(); };
    avatar.appendChild(img);
  } else {
    avatar.textContent = user.displayName.charAt(0).toUpperCase();
  }

  const name = document.createElement('span');
  name.className   = 'vh-user-menu__name';
  name.textContent = user.displayName.slice(0, 18) + (user.displayName.length > 18 ? '…' : '');

  const arrow = document.createElement('span');
  arrow.className   = 'vh-user-menu__arrow';
  arrow.setAttribute('aria-hidden', 'true');
  arrow.textContent = '▾';

  trigger.appendChild(avatar);
  trigger.appendChild(name);
  trigger.appendChild(arrow);

  const dropdown = _buildDropdown(user, trigger);
  dropdown.id    = 'userDropdown';

  wrapper.appendChild(trigger);
  wrapper.appendChild(dropdown);
  _dom.authContainer.appendChild(wrapper);

  trigger.addEventListener('click', () => _toggleDropdown(trigger, dropdown));

  document.addEventListener('click', (e) => {
    if (!wrapper.contains(e.target)) _closeDropdown(trigger, dropdown);
  }, { capture: true });
}

/**
 * Construye el dropdown con opciones del usuario.
 * @param {{uid, displayName, email}} user
 * @param {HTMLElement} trigger
 * @returns {HTMLElement}
 */
function _buildDropdown(user, trigger) {
  const dropdown = document.createElement('div');
  dropdown.className = 'vh-user-menu__dropdown';
  dropdown.setAttribute('role',   'menu');
  dropdown.setAttribute('hidden', '');

  const emailEl = document.createElement('p');
  emailEl.className   = 'vh-user-menu__email';
  emailEl.textContent = user.email;
  dropdown.appendChild(emailEl);

  dropdown.appendChild(_buildSeparator());

  // Ver mi perfil
  const profileBtn = document.createElement('button');
  profileBtn.className = 'vh-user-menu__item';
  profileBtn.setAttribute('role', 'menuitem');

  const profileIcon = document.createElement('span');
  profileIcon.setAttribute('aria-hidden', 'true');
  profileIcon.textContent = '👤';

  const profileLabel = document.createElement('span');
  profileLabel.textContent = 'Ver mi perfil';

  profileBtn.appendChild(profileIcon);
  profileBtn.appendChild(profileLabel);
  profileBtn.addEventListener('click', () => {
    _closeDropdown(trigger, dropdown);
    document.dispatchEvent(
      new CustomEvent('vnh:navigate', { detail: { view: 'profile', uid: null } })
    );
  });

  dropdown.appendChild(profileBtn);
  dropdown.appendChild(_buildSeparator());
  dropdown.appendChild(_buildPrivacySelector());
  dropdown.appendChild(_buildSeparator());

  // Cerrar sesión
  const logoutBtn = document.createElement('button');
  logoutBtn.className = 'vh-user-menu__item vh-user-menu__item--danger';
  logoutBtn.setAttribute('role', 'menuitem');

  const logoutIcon = document.createElement('span');
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
    { value: 'public',  icon: '🌐', text: 'Público'     },
    { value: 'friends', icon: '👥', text: 'Solo amigos' },
    { value: 'private', icon: '🔒', text: 'Privado'     },
  ];

  const btnGroup = document.createElement('div');
  btnGroup.className = 'vh-privacy-selector__group';

  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className   = 'vh-privacy-selector__btn';
    btn.dataset.privacy = opt.value;
    btn.setAttribute('role', 'menuitem');

    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = opt.icon;

    const text = document.createElement('span');
    text.textContent = opt.text;

    btn.appendChild(icon);
    btn.appendChild(text);
    btn.addEventListener('click', () => _handlePrivacyChange(opt.value, btnGroup));
    btnGroup.appendChild(btn);
  });

  wrapper.appendChild(btnGroup);

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
// 2. FORMULARIO DE LOGIN (reutilizable en dropdown y sheet)
// ════════════════════════════════════════════════════════

/**
 * Construye el contenido del formulario de login.
 * Se llama tanto para el dropdown (desktop) como para el
 * bottom sheet (móvil), asegurando IDs únicos por contexto
 * para evitar colisiones en el DOM.
 *
 * @param {'dropdown'|'sheet'} context - Contexto de renderizado
 * @returns {DocumentFragment}
 */
function _buildLoginForm(context) {
  const suffix = context === 'sheet' ? '_sheet' : '';
  const frag   = document.createDocumentFragment();

  // ── Botón Google ──
  const googleBtn = document.createElement('button');
  googleBtn.className = 'vh-auth-btn vh-auth-btn--login vh-login-google-btn';
  googleBtn.id        = `loginBtnGoogle${suffix}`;
  googleBtn.setAttribute('aria-label', 'Iniciar sesión con Google');
  googleBtn.setAttribute('type', 'button');

  const gIcon = document.createElement('span');
  gIcon.setAttribute('aria-hidden', 'true');
  gIcon.textContent = '✦';

  const gLabel = document.createElement('span');
  gLabel.textContent = 'Continuar con Google';

  googleBtn.appendChild(gIcon);
  googleBtn.appendChild(gLabel);

  googleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (context === 'sheet') _closeLoginSheet();
    _handleLogin();
  });

  // ── Separador visual ──
  const divider = document.createElement('div');
  divider.className   = 'vh-login-divider';
  divider.setAttribute('aria-hidden', 'true');

  const divLine1 = document.createElement('span');
  const divText  = document.createElement('span');
  divText.textContent = 'o';
  const divLine2 = document.createElement('span');

  divider.appendChild(divLine1);
  divider.appendChild(divText);
  divider.appendChild(divLine2);

  // ── Campo email ──
  const emailField = document.createElement('div');
  emailField.className = 'vh-field';

  const emailLabel = document.createElement('label');
  emailLabel.className   = 'vh-field__label';
  emailLabel.htmlFor     = `authEmail${suffix}`;
  emailLabel.textContent = 'Correo electrónico';

  const emailInput = document.createElement('input');
  emailInput.className     = 'vh-field__input';
  emailInput.id            = `authEmail${suffix}`;
  emailInput.type          = 'email';
  emailInput.autocomplete  = 'email';
  emailInput.placeholder   = 'tu@correo.com';

  emailField.appendChild(emailLabel);
  emailField.appendChild(emailInput);

  // ── Campo contraseña ──
  const pwField = document.createElement('div');
  pwField.className = 'vh-field';

  const pwLabel = document.createElement('label');
  pwLabel.className   = 'vh-field__label';
  pwLabel.htmlFor     = `authPassword${suffix}`;
  pwLabel.textContent = 'Contraseña';

  // Wrapper para input + toggle de visibilidad
  const pwWrap = document.createElement('div');
  pwWrap.className = 'vh-field__pw-wrap';

  const pwInput = document.createElement('input');
  pwInput.className     = 'vh-field__input';
  pwInput.id            = `authPassword${suffix}`;
  pwInput.type          = 'password';
  pwInput.autocomplete  = 'current-password';
  pwInput.placeholder   = '••••••••';

  // Botón ojo para mostrar/ocultar contraseña
  const eyeBtn = document.createElement('button');
  eyeBtn.type      = 'button';
  eyeBtn.className = 'vh-field__pw-eye';
  eyeBtn.setAttribute('aria-label', 'Mostrar contraseña');
  eyeBtn.setAttribute('aria-pressed', 'false');
  eyeBtn.textContent = '👁';
  eyeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isVisible = pwInput.type === 'text';
    pwInput.type = isVisible ? 'password' : 'text';
    eyeBtn.setAttribute('aria-pressed', String(!isVisible));
    eyeBtn.setAttribute('aria-label', isVisible ? 'Mostrar contraseña' : 'Ocultar contraseña');
    eyeBtn.style.opacity = isVisible ? '0.5' : '1';
  });

  pwWrap.appendChild(pwInput);
  pwWrap.appendChild(eyeBtn);

  // Mensaje de error
  const errorMsg = document.createElement('p');
  errorMsg.className  = 'vh-field__hint vh-auth-error';
  errorMsg.id         = `authError${suffix}`;
  errorMsg.style.display = 'none';
  errorMsg.setAttribute('role', 'alert');
  errorMsg.setAttribute('aria-live', 'polite');

  pwField.appendChild(pwLabel);
  pwField.appendChild(pwWrap);
  pwField.appendChild(errorMsg);

  // ── Botones de acción ──
  const actions = document.createElement('div');
  actions.className = 'vh-login-actions';

  const btnLogin = document.createElement('button');
  btnLogin.className   = 'vh-btn vh-btn--primary';
  btnLogin.type        = 'button';
  btnLogin.id          = `btnEmailLogin${suffix}`;
  btnLogin.textContent = 'Iniciar sesión';

  const btnSignup = document.createElement('button');
  btnSignup.className   = 'vh-btn vh-btn--ghost';
  btnSignup.type        = 'button';
  btnSignup.id          = `btnEmailSignup${suffix}`;
  btnSignup.textContent = 'Registrarse';

  const btnReset = document.createElement('button');
  btnReset.className   = 'vh-btn vh-btn--ghost vh-login-reset-btn';
  btnReset.type        = 'button';
  btnReset.id          = `btnResetPassword${suffix}`;
  btnReset.textContent = '¿Olvidaste tu contraseña?';

  // stopPropagation para no cerrar el panel al hacer clic
  [btnLogin, btnSignup, btnReset].forEach(btn => {
    btn.addEventListener('click', (e) => e.stopPropagation());
  });

  // Helpers para leer los campos de ESTE formulario específico
  const getEmail = () => emailInput.value.trim();
  const getPw    = () => pwInput.value;
  const showErr  = (msg) => {
    errorMsg.textContent = msg;
    errorMsg.style.display = 'block';
    emailInput.setAttribute('aria-invalid', 'true');
  };
  const clearErr = () => {
    errorMsg.textContent = '';
    errorMsg.style.display = 'none';
    emailInput.removeAttribute('aria-invalid');
  };

  btnLogin.addEventListener('click', () => _handleEmailLoginLocal(getEmail, getPw, showErr, clearErr));
  btnSignup.addEventListener('click', () => _handleEmailSignupLocal(getEmail, getPw, showErr, clearErr));
  btnReset.addEventListener('click', () => _handlePasswordResetLocal(getEmail, showErr, clearErr));

  // Enter en contraseña dispara login
  pwInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.stopPropagation();
      _handleEmailLoginLocal(getEmail, getPw, showErr, clearErr);
    }
  });

  actions.appendChild(btnLogin);
  actions.appendChild(btnSignup);

  frag.appendChild(googleBtn);
  frag.appendChild(divider);
  frag.appendChild(emailField);
  frag.appendChild(pwField);
  frag.appendChild(actions);
  frag.appendChild(btnReset);

  return frag;
}


// ════════════════════════════════════════════════════════
// 3. DROPDOWN (desktop)
// ════════════════════════════════════════════════════════

/**
 * Abre el dropdown de login (desktop).
 * @param {HTMLElement} panel
 * @param {HTMLElement} trigger
 */
function _openLoginDropdown(panel, trigger) {
  panel.hidden = false;
  trigger.setAttribute('aria-expanded', 'true');
  // Foco al primer input del formulario
  requestAnimationFrame(() => {
    panel.querySelector('input[type="email"]')?.focus();
  });
}

/**
 * Cierra el dropdown de login (desktop).
 * @param {HTMLElement} panel
 * @param {HTMLElement} trigger
 */
function _closeLoginDropdown(panel, trigger) {
  panel.hidden = true;
  trigger.setAttribute('aria-expanded', 'false');
}


// ════════════════════════════════════════════════════════
// 4. BOTTOM SHEET (móvil)
// ════════════════════════════════════════════════════════

/**
 * Crea el bottom sheet la primera vez (lazy singleton).
 * Las llamadas posteriores reutilizan el elemento existente.
 */
function _ensureSheet() {
  if (_sheet) return;

  // ── Overlay semitransparente ──
  _sheetBg = document.createElement('div');
  _sheetBg.className = 'vh-login-sheet-bg';
  _sheetBg.setAttribute('aria-hidden', 'true');
  _sheetBg.addEventListener('click', _closeLoginSheet);

  // ── Sheet container ──
  _sheet = document.createElement('div');
  _sheet.className = 'vh-login-sheet';
  _sheet.setAttribute('role', 'dialog');
  _sheet.setAttribute('aria-modal', 'true');
  _sheet.setAttribute('aria-label', 'Iniciar sesión');

  // Handle visual de arrastre (decorativo)
  const handle = document.createElement('div');
  handle.className = 'vh-login-sheet__handle';
  handle.setAttribute('aria-hidden', 'true');

  // Header del sheet
  const header = document.createElement('div');
  header.className = 'vh-login-sheet__header';

  const title = document.createElement('h2');
  title.className   = 'vh-login-sheet__title';
  title.textContent = 'Iniciar sesión';

  const closeBtn = document.createElement('button');
  closeBtn.type      = 'button';
  closeBtn.className = 'vh-login-sheet__close';
  closeBtn.setAttribute('aria-label', 'Cerrar panel de inicio de sesión');
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', _closeLoginSheet);

  header.appendChild(title);
  header.appendChild(closeBtn);

  // Cuerpo del sheet con el formulario
  const body = document.createElement('div');
  body.className = 'vh-login-sheet__body';
  body.appendChild(_buildLoginForm('sheet'));

  _sheet.appendChild(handle);
  _sheet.appendChild(header);
  _sheet.appendChild(body);

  document.body.appendChild(_sheetBg);
  document.body.appendChild(_sheet);

  // Cerrar con Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _sheet?.classList.contains('is-open')) {
      _closeLoginSheet();
    }
  });
}

/**
 * Abre el bottom sheet de login (móvil).
 * @param {HTMLElement} trigger - Botón que disparó la apertura (para ARIA)
 */
function _openLoginSheet(trigger) {
  _ensureSheet();

  trigger.setAttribute('aria-expanded', 'true');
  _sheetBg.classList.add('is-open');
  _sheet.classList.add('is-open');

  // Prevenir scroll del body mientras el sheet está abierto
  document.body.style.overflow = 'hidden';

  // Foco al primer input del formulario del sheet
  requestAnimationFrame(() => {
    _sheet.querySelector('input[type="email"]')?.focus();
  });
}

/**
 * Cierra el bottom sheet de login (móvil).
 */
function _closeLoginSheet() {
  if (!_sheet) return;

  _sheet.classList.remove('is-open');
  _sheetBg.classList.remove('is-open');
  document.body.style.overflow = '';

  // Restaurar foco al trigger
  if (_lastTrigger) {
    _lastTrigger.setAttribute('aria-expanded', 'false');
    _lastTrigger.focus();
  }
}


// ════════════════════════════════════════════════════════
// 5. HANDLERS DE AUTENTICACIÓN
// ════════════════════════════════════════════════════════

/**
 * Inicia sesión con Google.
 * Al completarse correctamente el popup, Firebase dispara onAuthChange,
 * que llama a _renderUserMenu() y limpia toda la UI de login.
 */
async function _handleLogin() {
  try {
    await FirebaseService.signInWithGoogle();
  } catch (err) {
    console.error('[AuthController] Error al iniciar sesión con Google:', err);
  }
}

/**
 * Validaciones locales reutilizables.
 * Separadas de _validateEmail/_validatePassword globales para
 * mantener SRP (cada handler tiene sus propios callbacks de error).
 */
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

/**
 * Login con email/password usando callbacks del formulario local.
 * Al cerrar sesión satisfactoriamente, el sheet/dropdown se cierra
 * automáticamente vía _onAuthChange → _renderUserMenu.
 *
 * @param {()=>string} getEmail
 * @param {()=>string} getPw
 * @param {(msg:string)=>void} showErr
 * @param {()=>void} clearErr
 */
async function _handleEmailLoginLocal(getEmail, getPw, showErr, clearErr) {
  try {
    clearErr();
    const email = getEmail();
    const pw    = getPw();

    if (!_validateEmail(email)) { showErr('Correo inválido.'); return; }
    if (pw.length < 1)          { showErr('Ingresá tu contraseña.'); return; }

    await FirebaseService.signInWithEmailPassword(email, pw);
    // El sheet/dropdown se cierra automáticamente al dispararse _onAuthChange
    _closeLoginSheet();

  } catch (err) {
    showErr('No se pudo iniciar sesión. Verificá tus datos.');
    console.error('[AuthController] Email login error:', err);
  }
}

/**
 * Registro con email/password.
 * @param {()=>string} getEmail
 * @param {()=>string} getPw
 * @param {(msg:string)=>void} showErr
 * @param {()=>void} clearErr
 */
async function _handleEmailSignupLocal(getEmail, getPw, showErr, clearErr) {
  try {
    clearErr();
    const email = getEmail();
    const pw    = getPw();

    if (!_validateEmail(email)) {
      showErr('Correo inválido.');
      return;
    }
    if (!_validatePassword(pw)) {
      showErr('Contraseña insegura. Usá 8+ caracteres con mayúscula, minúscula y número.');
      return;
    }

    await FirebaseService.signUpWithEmailPassword(email, pw);
    _closeLoginSheet();

  } catch (err) {
    showErr('No se pudo registrar. Es posible que el correo ya exista.');
    console.error('[AuthController] Signup error:', err);
  }
}

/**
 * Recuperación de contraseña por email.
 * @param {()=>string} getEmail
 * @param {(msg:string)=>void} showErr
 * @param {()=>void} clearErr
 */
async function _handlePasswordResetLocal(getEmail, showErr, clearErr) {
  try {
    clearErr();
    const email = getEmail();

    if (!_validateEmail(email)) { showErr('Correo inválido.'); return; }

    await FirebaseService.resetPassword(email);
    showErr('✅ Enviamos un correo de recuperación a tu bandeja de entrada.');

  } catch (err) {
    showErr('No se pudo enviar el correo de recuperación.');
    console.error('[AuthController] Reset password error:', err);
  }
}

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
    btn.classList.toggle(
      'vh-privacy-selector__btn--active',
      btn.dataset.privacy === activeValue
    );
  });
}


// ════════════════════════════════════════════════════════
// 6. DROPDOWN HELPERS (menú de usuario autenticado)
// ════════════════════════════════════════════════════════

function _toggleDropdown(trigger, dropdown) {
  const isOpen = !dropdown.hidden;
  isOpen ? _closeDropdown(trigger, dropdown) : _openDropdown(trigger, dropdown);
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
// 7. SINCRONIZACIÓN BIBLIOTECA LOCAL → FIRESTORE
// ════════════════════════════════════════════════════════

/**
 * Al iniciar sesión, sincroniza la biblioteca local con Firestore.
 * Firestore tiene prioridad (source of truth en la nube).
 * @param {string} uid
 */
async function _syncLibraryOnLogin(uid) {
  try {
    const localEntries = LibraryStore.getEntriesByStatus(null);
    if (localEntries.length > 0) {
      const uploaded = await FirebaseService.uploadLibraryBatch(localEntries);
      console.info(`[AuthController] ${uploaded} entradas locales subidas a Firestore para ${uid}.`);
    }

    const cloudEntries = await FirebaseService.loadLibraryFromCloud();
    LibraryStore.clearAll();

    cloudEntries.forEach(entry => {
      if (!entry?.vnId || !entry?.status) return;

      LibraryStore.addVn(entry.vnId, entry.status);

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

      if (entry.status === 'playing' && entry.log) {
        try {
          LibraryStore.updateLog(entry.vnId, entry.log);
        } catch (e) {
          console.warn(`[AuthController] No se pudo restaurar log de "${entry.vnId}":`, e);
        }
      }

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
// 8. CALLBACK DE CAMBIO DE AUTENTICACIÓN
// ════════════════════════════════════════════════════════

/**
 * Se dispara cuando Firebase detecta un cambio de sesión.
 * @param {{uid,displayName,photoURL,email}|null} user
 */
async function _onAuthChange(user) {
  // Cerrar sheet si está abierto (el usuario acaba de iniciar sesión)
  if (_sheet?.classList.contains('is-open')) {
    _closeLoginSheet();
  }

  if (user) {
    _renderUserMenu(user);
    await _syncLibraryOnLogin(user.uid);

    try {
      const { setFeedTabVisible } = await import('./ui-controller.js');
      setFeedTabVisible(true);
    } catch {}

    try {
      const { getPendingProfileUid } = await import('./profile-controller.js');
      const pendingUid = getPendingProfileUid();
      if (pendingUid && pendingUid !== user.uid) {
        const { openProfile } = await import('./profile-controller.js');
        openProfile(pendingUid);
        return;
      }
    } catch {}

  } else {
    _renderLoginButton();
    try {
      LibraryStore.clearAll();
      const { setFeedTabVisible } = await import('./ui-controller.js');
      setFeedTabVisible(false);
    } catch {}
  }
}


// ════════════════════════════════════════════════════════
// 9. INICIALIZACIÓN
// ════════════════════════════════════════════════════════

function init() {
  _cacheDOM();

  if (!_dom.authContainer) {
    console.warn('[AuthController] #authContainer no encontrado en el DOM.');
    return;
  }

  FirebaseService.onAuthChange(_onAuthChange);
  console.info('[AuthController] Inicializado ✓');
}

export { init };