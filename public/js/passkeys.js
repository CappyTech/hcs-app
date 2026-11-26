/**
 * passkeys.js — browser side of passkey sign-in (passkeyController.js).
 *
 * Wires three kinds of control, found by data attribute:
 *   [data-passkey-login]     login page: sign in with any passkey for this site;
 *                            also starts passkey autofill on the username box
 *   [data-passkey-2fa]       two-factor step: use this account's passkey
 *   [data-passkey-register]  Account Settings: a form that adds a passkey
 *
 * Each control sits in a [data-passkey-block] wrapper, which stays hidden
 * unless the browser supports passkeys. Errors go to the block's
 * [data-passkey-error] element. Endpoints reply { ok, options | redirect, error }.
 *
 * CSP-safe: no inline handlers, no eval.
 */
(function () {
  'use strict';

  var supported = !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create);

  function csrf() {
    var m = document.querySelector('meta[name="csrf-token"]');
    var v = m ? m.getAttribute('content') : '';
    if (v) return v;
    var i = document.querySelector('input[name="_csrf"]');
    return i ? i.value : '';
  }

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf(), Accept: 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'Unexpected reply (' + r.status + ').' }; });
    });
  }

  // ── base64url <-> ArrayBuffer ────────────────────────────────────────────
  function b64urlToBuf(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  function bufToB64url(buf) {
    var bytes = new Uint8Array(buf);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function creationOptions(o) {
    if (PublicKeyCredential.parseCreationOptionsFromJSON) return PublicKeyCredential.parseCreationOptionsFromJSON(o);
    var p = Object.assign({}, o);
    p.challenge = b64urlToBuf(o.challenge);
    p.user = Object.assign({}, o.user, { id: b64urlToBuf(o.user.id) });
    p.excludeCredentials = (o.excludeCredentials || []).map(function (c) {
      return Object.assign({}, c, { id: b64urlToBuf(c.id) });
    });
    return p;
  }
  function requestOptions(o) {
    if (PublicKeyCredential.parseRequestOptionsFromJSON) return PublicKeyCredential.parseRequestOptionsFromJSON(o);
    var p = Object.assign({}, o);
    p.challenge = b64urlToBuf(o.challenge);
    p.allowCredentials = (o.allowCredentials || []).map(function (c) {
      return Object.assign({}, c, { id: b64urlToBuf(c.id) });
    });
    return p;
  }

  function credentialJSON(cred) {
    if (typeof cred.toJSON === 'function') {
      try { return cred.toJSON(); } catch (_) { /* fall through */ }
    }
    var r = cred.response;
    var response = { clientDataJSON: bufToB64url(r.clientDataJSON) };
    if (r.attestationObject) {
      response.attestationObject = bufToB64url(r.attestationObject);
      if (typeof r.getTransports === 'function') response.transports = r.getTransports();
    }
    if (r.authenticatorData) response.authenticatorData = bufToB64url(r.authenticatorData);
    if (r.signature) response.signature = bufToB64url(r.signature);
    if (r.userHandle) response.userHandle = bufToB64url(r.userHandle);
    return {
      id: cred.id,
      rawId: bufToB64url(cred.rawId),
      type: cred.type,
      response: response,
      authenticatorAttachment: cred.authenticatorAttachment || undefined,
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
    };
  }

  function friendly(err) {
    if (!err) return 'Something went wrong.';
    if (err.name === 'NotAllowedError') return 'The passkey request was cancelled or timed out.';
    if (err.name === 'InvalidStateError') return 'That device already has a passkey for your account.';
    if (err.name === 'SecurityError') return 'Passkeys need this site to be opened at its proper address over HTTPS.';
    return err.message || String(err);
  }

  function showError(block, msg) {
    var el = block && block.querySelector('[data-passkey-error]');
    if (!el) { if (msg) window.alert(msg); return; }
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  function busy(btn, on) {
    if (!btn) return;
    btn.disabled = !!on;
    btn.setAttribute('aria-busy', on ? 'true' : 'false');
  }

  function finish(block, btn, data) {
    if (data && data.ok && data.redirect) { window.location.assign(data.redirect); return; }
    busy(btn, false);
    showError(block, (data && data.error) || 'Something went wrong.');
  }

  // ── Sign in (login page + two-factor step) ───────────────────────────────
  // `afterFail` runs when the attempt ends without signing in (used to put
  // the autofill request back).
  function signIn(btn, optionsUrl, verifyUrl, extra, afterFail) {
    var block = btn.closest('[data-passkey-block]');
    showError(block, '');
    busy(btn, true);
    var failed = function (msg) {
      busy(btn, false);
      showError(block, msg);
      if (afterFail) afterFail();
    };
    post(optionsUrl, extra)
      .then(function (data) {
        if (!data.ok) throw new Error(data.error || 'Passkey sign-in is unavailable.');
        return navigator.credentials.get({ publicKey: requestOptions(data.options) });
      })
      .then(function (cred) {
        if (!cred) throw new Error('No passkey was chosen.');
        return post(verifyUrl, { response: credentialJSON(cred), mode: extra && extra.mode });
      })
      .then(function (data) {
        if (data && data.ok && data.redirect) { window.location.assign(data.redirect); return; }
        failed((data && data.error) || 'Something went wrong.');
      })
      .catch(function (err) { failed(friendly(err)); });
  }

  // ── Passkey autofill (login page) ────────────────────────────────────────
  // Conditional mediation: the browser lists saved passkeys in the username
  // box's autofill dropdown (the input carries autocomplete="username webauthn").
  // The request waits quietly until one is picked. Only one WebAuthn request
  // may be open at a time, so the button aborts it first and puts it back
  // afterwards. It is renewed before the server's challenge expires.
  var AUTOFILL_RENEW_MS = 4 * 60 * 1000;
  var autofill = { controller: null, timer: null, block: null, next: '' };

  function stopAutofill() {
    if (autofill.timer) { clearTimeout(autofill.timer); autofill.timer = null; }
    if (autofill.controller) {
      var c = autofill.controller;
      autofill.controller = null;
      try { c.abort(); } catch (_) { /* already settled */ }
    }
  }

  function startAutofill() {
    stopAutofill();
    var controller = new AbortController();
    autofill.controller = controller;
    autofill.timer = setTimeout(startAutofill, AUTOFILL_RENEW_MS);
    post('/user/passkey/login/options', { mode: 'autofill', next: autofill.next })
      .then(function (data) {
        if (!data.ok || controller.signal.aborted) return null;
        return navigator.credentials.get({
          mediation: 'conditional',
          signal: controller.signal,
          publicKey: requestOptions(data.options),
        });
      })
      .then(function (cred) {
        if (!cred || controller.signal.aborted) return null;
        stopAutofill();
        return post('/user/passkey/login/verify', { response: credentialJSON(cred), mode: 'autofill' })
          .then(function (data) {
            if (data && data.ok && data.redirect) { window.location.assign(data.redirect); return; }
            showError(autofill.block, (data && data.error) || 'Passkey sign-in failed.');
            startAutofill();
          });
      })
      .catch(function (err) {
        // Aborted by the button or a renewal: nothing to report.
        if (controller.signal.aborted || (err && err.name === 'AbortError')) return;
        if (autofill.controller === controller) stopAutofill();
      });
  }

  function autofillAvailable() {
    if (typeof AbortController === 'undefined') return Promise.resolve(false);
    if (!PublicKeyCredential.isConditionalMediationAvailable) return Promise.resolve(false);
    return PublicKeyCredential.isConditionalMediationAvailable().catch(function () { return false; });
  }

  // ── Add a passkey (Account Settings) ─────────────────────────────────────
  function register(form) {
    var block = form.closest('[data-passkey-block]') || form;
    var btn = form.querySelector('button[type="submit"]');
    var nameInput = form.querySelector('[name="name"]');
    showError(block, '');
    busy(btn, true);
    post('/user/account/passkeys/options', {})
      .then(function (data) {
        if (!data.ok) throw new Error(data.error || 'Could not start adding a passkey.');
        return navigator.credentials.create({ publicKey: creationOptions(data.options) });
      })
      .then(function (cred) {
        if (!cred) throw new Error('No passkey was created.');
        return post('/user/account/passkeys/register', {
          response: credentialJSON(cred),
          name: nameInput ? nameInput.value : '',
        });
      })
      .then(function (data) { finish(block, btn, data); })
      .catch(function (err) { busy(btn, false); showError(block, friendly(err)); });
  }

  function init() {
    var blocks = document.querySelectorAll('[data-passkey-block]');
    for (var i = 0; i < blocks.length; i++) {
      if (supported) blocks[i].hidden = false;
    }
    var unsupported = document.querySelectorAll('[data-passkey-unsupported]');
    for (var j = 0; j < unsupported.length; j++) unsupported[j].hidden = supported;
    if (!supported) return;

    var loginBtn = document.querySelector('[data-passkey-login]');
    if (loginBtn) {
      var useAutofill = false;
      autofill.next = loginBtn.getAttribute('data-next') || '';
      autofill.block = loginBtn.closest('[data-passkey-block]');
      loginBtn.addEventListener('click', function () {
        stopAutofill();
        signIn(loginBtn, '/user/passkey/login/options', '/user/passkey/login/verify', {
          next: autofill.next,
        }, function () { if (useAutofill) startAutofill(); });
      });
      if (document.querySelector('input[autocomplete~="webauthn"]')) {
        autofillAvailable().then(function (ok) {
          useAutofill = !!ok;
          if (useAutofill) startAutofill();
        });
      }
    }

    var twoFABtn = document.querySelector('[data-passkey-2fa]');
    if (twoFABtn) {
      twoFABtn.addEventListener('click', function () {
        signIn(twoFABtn, '/user/2fa/passkey/options', '/user/2fa/passkey/verify', {});
      });
    }

    var regForm = document.querySelector('form[data-passkey-register]');
    if (regForm) {
      regForm.addEventListener('submit', function (e) {
        e.preventDefault();
        register(regForm);
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
