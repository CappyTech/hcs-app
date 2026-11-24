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
 *   <i class="bi …">                  → hidden from screen readers unless it carries its own label
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
  // Opening a modal makes it a dialog for assistive tech, moves focus into it and
  // keeps Tab inside it; Escape or a close button shuts it and returns focus to
  // the button that opened it (WCAG 2.1.2, 2.4.3, 4.1.2).
  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  var openModal = null, modalOpener = null;
  function focusables(modal) {
    return Array.prototype.filter.call(modal.querySelectorAll(FOCUSABLE), function (el) { return el.offsetParent !== null; });
  }
  function showModal(modal, opener) {
    if (!modal.getAttribute('role')) modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    if (!modal.getAttribute('aria-labelledby') && !modal.getAttribute('aria-label')) {
      var heading = modal.querySelector('h1, h2, h3, h4');
      if (heading) {
        if (!heading.id) heading.id = modal.id + '-title';
        modal.setAttribute('aria-labelledby', heading.id);
      }
    }
    modal.classList.remove('hidden');
    openModal = modal;
    modalOpener = opener || null;
    var first = focusables(modal)[0];
    if (first) first.focus();
    else { modal.setAttribute('tabindex', '-1'); modal.focus(); }
  }
  function hideModal(modal) {
    modal.classList.add('hidden');
    if (openModal === modal) {
      openModal = null;
      if (modalOpener && document.body.contains(modalOpener)) modalOpener.focus();
      modalOpener = null;
    }
  }
  document.addEventListener('click', function (e) {
    var opener = e.target.closest('[data-modal-open]');
    if (opener) {
      var modal = document.getElementById(opener.getAttribute('data-modal-open'));
      if (modal) showModal(modal, opener);
    }
    var closer = e.target.closest('[data-modal-close]');
    if (closer) {
      var modal = document.getElementById(closer.getAttribute('data-modal-close'));
      if (modal) hideModal(modal);
    }
  });
  document.addEventListener('keydown', function (e) {
    if (!openModal || openModal.classList.contains('hidden')) return;
    if (e.key === 'Escape') { e.preventDefault(); hideModal(openModal); return; }
    if (e.key !== 'Tab') return;
    var items = focusables(openModal);
    if (!items.length) { e.preventDefault(); return; }
    var first = items[0], last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || !openModal.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !openModal.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
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

  // ── searchable ref-list inputs ────────────────────────────────────────────
  // Usage: <input data-reflist-target="reflist_<key>" …>
  // Filters label[data-search] items inside the target list by text.
  document.addEventListener('input', function (e) {
    var input = e.target.closest('input[data-reflist-target]');
    if (!input) return;
    var listId = input.getAttribute('data-reflist-target');
    var list = document.getElementById(listId);
    if (!list) return;
    var term = input.value.toLowerCase();
    list.querySelectorAll('label[data-search]').forEach(function (label) {
      label.style.display = label.getAttribute('data-search').includes(term) ? '' : 'none';
    });
  });

  // ── Form error summary ───────────────────────────────────────────────────
  // When a form comes back with problems, move focus to the summary so keyboard
  // and screen-reader users land on it (WCAG 3.3.1). Its links jump to the field.
  var errorSummary = document.querySelector('[data-error-summary]');
  if (errorSummary) {
    errorSummary.focus();
    errorSummary.addEventListener('click', function (e) {
      var link = e.target.closest('a[href^="#"]');
      if (!link) return;
      var field = document.getElementById(decodeURIComponent(link.getAttribute('href').slice(1)));
      if (!field) return;
      e.preventDefault();
      field.scrollIntoView({ block: 'center' });
      field.focus();
    });
  }

  // ── Links that open a new tab ────────────────────────────────────────────
  // Tell screen-reader users before they lose their place (WCAG G201). Links that
  // already say so in their name are left alone.
  document.querySelectorAll('a[target="_blank"]').forEach(function (a) {
    var name = (a.getAttribute('aria-label') || a.textContent || '').toLowerCase();
    if (/new (tab|window)/.test(name)) return;
    if (a.getAttribute('aria-label')) {
      a.setAttribute('aria-label', a.getAttribute('aria-label') + ' (opens in a new tab)');
    } else {
      var hint = document.createElement('span');
      hint.className = 'sr-only';
      hint.textContent = ' (opens in a new tab)';
      a.appendChild(hint);
    }
  });

  // ── Decorative Bootstrap Icons ───────────────────────────────────────────
  // Icon-font glyphs are private-use characters that some screen readers read out
  // as junk. Hide every <i class="bi …"> that has no accessible name of its own;
  // the control around it carries the text or aria-label (WCAG 1.1.1 / 4.1.2).
  // The observer catches icons that Alpine or fetch-rendered fragments add later.
  function hideDecorativeIcons(root) {
    if (!root || !root.querySelectorAll) return;
    var icons = root.querySelectorAll('i.bi:not([aria-hidden]):not([aria-label]):not([role])');
    for (var i = 0; i < icons.length; i++) icons[i].setAttribute('aria-hidden', 'true');
  }
  hideDecorativeIcons(document);
  if ('MutationObserver' in window) {
    new MutationObserver(function (mutations) {
      for (var m = 0; m < mutations.length; m++) {
        var added = mutations[m].addedNodes;
        for (var n = 0; n < added.length; n++) {
          var node = added[n];
          if (node.nodeType !== 1) continue;
          if (node.matches && node.matches('i.bi:not([aria-hidden]):not([aria-label]):not([role])')) {
            node.setAttribute('aria-hidden', 'true');
          } else {
            hideDecorativeIcons(node);
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

});
