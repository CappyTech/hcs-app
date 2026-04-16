/**
 * ui-helpers.js — Global CSP-safe UI behaviour
 *
 * Replaces all inline event handlers (onclick=, onsubmit=, etc.) to comply
 * with CSP script-src-attr 'none'.
 *
 * Patterns handled:
 *   data-confirm="message"           → shows confirm() before form submit or button click
 *   data-dismiss-target="elementId"  → removes the target element on click
 *   data-modal-open="modalId"        → removes 'hidden' class from modal on click
 *   data-modal-close="modalId"       → adds 'hidden' class to modal on click
 *   data-modal-param-*               → sets a hidden input value inside a modal on click
 *   data-submit-once                 → disables the submit button and changes text on submit
 *   data-submit-once-text            → replacement text for the button (default: "Running…")
 */
document.addEventListener('DOMContentLoaded', function () {

  // ── data-confirm ─────────────────────────────────────────────────────────
  // Usage: <button data-confirm="Are you sure?"> or <form data-confirm="...">
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-confirm]');
    if (!btn) return;
    // If the button is inside a form, let the form's own submit listener handle it
    // (avoid double-confirming); only act if the element is itself a submit button
    // without a wrapping form that also has data-confirm.
    var msg = btn.getAttribute('data-confirm');
    if (!confirm(msg)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true); // capture phase so we beat form submit

  document.addEventListener('submit', function (e) {
    var form = e.target.closest('form[data-confirm]');
    if (!form) return;
    var msg = form.getAttribute('data-confirm');
    if (!confirm(msg)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);

  // ── data-dismiss-target ───────────────────────────────────────────────────
  // Usage: <button data-dismiss-target="toastId">
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-dismiss-target]');
    if (!btn) return;
    var id = btn.getAttribute('data-dismiss-target');
    var el = document.getElementById(id);
    if (el) el.remove();
  });

  // ── data-modal-open / data-modal-close ───────────────────────────────────
  // Usage: <button data-modal-open="myModal">
  //        <button data-modal-close="myModal">
  document.addEventListener('click', function (e) {
    var opener = e.target.closest('[data-modal-open]');
    if (opener) {
      var modal = document.getElementById(opener.getAttribute('data-modal-open'));
      if (modal) modal.classList.remove('hidden');
    }
    var closer = e.target.closest('[data-modal-close]');
    if (closer) {
      var modal = document.getElementById(closer.getAttribute('data-modal-close'));
      if (modal) modal.classList.add('hidden');
    }
  });

  // ── data-modal-param-* ────────────────────────────────────────────────────
  // Set hidden input values inside a modal when a trigger button is clicked.
  // Usage: <button data-modal-open="myModal"
  //                data-modal-param-uuid="<%= entry.uuid %>"
  //                data-modal-param-name="<%= entry.name %>">
  // Sets <input name="uuid"> and <input name="name"> inside #myModal.
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-modal-open]');
    if (!btn) return;
    var modalId = btn.getAttribute('data-modal-open');
    var modal = document.getElementById(modalId);
    if (!modal) return;
    var attrs = btn.attributes;
    for (var i = 0; i < attrs.length; i++) {
      var name = attrs[i].name;
      if (name.startsWith('data-modal-param-')) {
        var paramName = name.slice('data-modal-param-'.length);
        var input = modal.querySelector('[name="' + paramName + '"]');
        if (input) input.value = attrs[i].value;
      }
    }
  });

  // ── data-submit-once ─────────────────────────────────────────────────────
  // Usage: <form data-submit-once>
  //          <button type="submit" data-submit-once-text="Running…">Submit</button>
  document.addEventListener('submit', function (e) {
    var form = e.target.closest('form[data-submit-once]');
    if (!form) return;
    var btn = form.querySelector('[type="submit"]');
    if (!btn) return;
    var text = btn.getAttribute('data-submit-once-text') || 'Running\u2026';
    btn.disabled = true;
    btn.textContent = text;
  });

});
