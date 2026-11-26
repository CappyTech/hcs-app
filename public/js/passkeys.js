/**
 * passkeys.js — browser side of passkey sign-in (passkeyController.js).
 *
 * Wires three kinds of control, found by data attribute:
 *   [data-passkey-login]     login page: sign in with any passkey for this site
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
  function signIn(btn, optionsUrl, verifyUrl, extra) {
    var block = btn.closest('[data-passkey-block]');
    showError(block, '');
    busy(btn, true);
    post(optionsUrl, extra)
      .then(function (data) {
        if (!data.ok) throw new Error(data.error || 'Passkey sign-in is unavailable.');
        return navigator.credentials.get({ publicKey: requestOptions(data.options) });
      })
      .then(function (cred) {
        if (!cred) throw new Error('No passkey was chosen.');
        return post(verifyUrl, { response: credentialJSON(cred) });
      })
      .then(function (data) { finish(block, btn, data); })
      .catch(function (err) { busy(btn, false); showError(block, friendly(err)); });
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
      loginBtn.addEventListener('click', function () {
        signIn(loginBtn, '/user/passkey/login/options', '/user/passkey/login/verify', {
          next: loginBtn.getAttribute('data-next') || '',
        });
      });
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
