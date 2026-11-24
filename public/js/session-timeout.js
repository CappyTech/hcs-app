/**
 * session-timeout.js — warn before the session ends (WCAG 2.2.1 Timing Adjustable).
 *
 * layout.ejs writes the session's expiry into <meta name="session-expires-at">.
 * Two minutes before it, an alert dialog offers "Stay signed in", which calls
 * POST /session/extend (sessionTimeoutRoutes.js) for a fresh 8 hours. If the
 * time runs out, the dialog says so, so nobody keeps typing into a form that
 * can no longer be saved.
 *
 * CSP-safe: no inline handlers; the dialog is built with DOM calls.
 */
(function () {
  'use strict';

  var meta = document.querySelector('meta[name="session-expires-at"]');
  if (!meta) return;
  var expiresAt = parseInt(meta.getAttribute('content'), 10);
  if (!isFinite(expiresAt)) return;

  var WARN_BEFORE_MS = 2 * 60 * 1000;
  var dialog = null, countdown = null, tickTimer = null, warnTimer = null, endTimer = null;
  var returnFocusTo = null;

  function csrf() {
    var m = document.querySelector('meta[name="csrf-token"]');
    return m ? m.getAttribute('content') : '';
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  function closeDialog() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (dialog) { dialog.remove(); dialog = null; }
    if (returnFocusTo && document.body.contains(returnFocusTo)) returnFocusTo.focus();
    returnFocusTo = null;
  }

  function buildDialog(title, message, buttons) {
    closeDialog();
    returnFocusTo = document.activeElement;
    var overlay = el('div', 'fixed inset-0 z-[90] flex items-center justify-center bg-gray-900/50 p-4');
    var box = el('div', 'w-full max-w-sm rounded-xl bg-white dark:bg-gray-800 shadow-xl p-6');
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'session-timeout-title');
    box.setAttribute('aria-describedby', 'session-timeout-message');
    var h = el('h2', 'text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2', title);
    h.id = 'session-timeout-title';
    var p = el('p', 'text-sm text-gray-700 dark:text-gray-300 mb-5');
    p.id = 'session-timeout-message';
    p.appendChild(message);
    var row = el('div', 'flex flex-wrap justify-end gap-2');
    buttons.forEach(function (b) { row.appendChild(b); });
    box.appendChild(h); box.appendChild(p); box.appendChild(row);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    dialog = overlay;
    // Keep Tab inside the dialog.
    overlay.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      var f = box.querySelectorAll('button, a[href]');
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    if (buttons[0]) buttons[0].focus();
  }

  function button(label, primary) {
    var b = el(primary ? 'button' : 'button', primary
      ? 'px-4 py-2 rounded-lg text-sm font-medium bg-green-600 hover:bg-green-700 text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2'
      : 'px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500', label);
    b.type = 'button';
    return b;
  }

  function minutesLeft() {
    var s = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    var m = Math.floor(s / 60), r = s % 60;
    return m > 0 ? m + ' minute' + (m === 1 ? '' : 's') + (r ? ' ' + r + ' seconds' : '') : r + ' seconds';
  }

  function extend() {
    return fetch('/session/extend', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-CSRF-Token': csrf(), 'Accept': 'application/json' }
    }).then(function (res) {
      if (!res.ok) throw new Error('extend failed');
      return res.json();
    }).then(function (data) {
      if (data && data.expiresAt) { expiresAt = data.expiresAt; schedule(); }
      closeDialog();
    }).catch(function () { showExpired(); });
  }

  function showWarning() {
    var stay = button('Stay signed in', true);
    var later = button('Dismiss', false);
    stay.addEventListener('click', extend);
    later.addEventListener('click', closeDialog);
    countdown = el('span', null, minutesLeft());
    var msg = document.createDocumentFragment();
    msg.appendChild(document.createTextNode('For your security you will be signed out in '));
    msg.appendChild(countdown);
    msg.appendChild(document.createTextNode('. Anything you have not saved will be lost.'));
    buildDialog('Are you still there?', msg, [stay, later]);
    // Update the visible countdown each second; screen readers heard the message
    // once when the dialog opened, so the ticking text is not a live region.
    tickTimer = setInterval(function () { if (countdown) countdown.textContent = minutesLeft(); }, 1000);
  }

  function showExpired() {
    var signIn = button('Sign in again', true);
    signIn.addEventListener('click', function () {
      window.location.href = '/user/login?next=' + encodeURIComponent(window.location.pathname);
    });
    var msg = document.createDocumentFragment();
    msg.appendChild(document.createTextNode('You have been signed out because the session ended. Copy anything you typed before signing in again.'));
    var close = button('Close', false);
    close.addEventListener('click', closeDialog);
    buildDialog('You have been signed out', msg, [signIn, close]);
  }

  function schedule() {
    clearTimeout(warnTimer); clearTimeout(endTimer);
    var now = Date.now();
    var warnIn = expiresAt - WARN_BEFORE_MS - now;
    var endIn = expiresAt - now;
    // setTimeout overflows above ~24.8 days; sessions are hours long.
    if (endIn <= 0) { showExpired(); return; }
    warnTimer = setTimeout(showWarning, Math.max(0, warnIn));
    endTimer = setTimeout(showExpired, endIn);
  }

  schedule();
})();
