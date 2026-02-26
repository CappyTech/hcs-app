/**
 * Alpine.js CSP-safe component registrations.
 * This file MUST be loaded before alpine-csp.min.js so that
 * Alpine.data() calls are registered before Alpine.start().
 */
document.addEventListener('alpine:init', function () {

  /**
   * profileTabs – tabbed panel switcher used on the user profile page.
   * Usage:  <div x-data="profileTabs">
   *           <button x-bind="tab('employee')">…</button>
   *           <div x-bind="panel('employee')">…</div>
   *         </div>
   *
   * The first tab declared in the markup is auto-activated on init.
   */
  Alpine.data('profileTabs', function () {
    return {
      activeTab: '',

      init: function () {
        // Auto-select the first tab button found inside this component
        var first = this.$el.querySelector('[data-tab]');
        if (first) this.activeTab = first.getAttribute('data-tab');
      },

      /** Bind helper for tab buttons */
      tab: function (name) {
        var self = this;
        return {
          ['@click']: function () { self.activeTab = name; },
          [':class']: function () {
            return self.activeTab === name
              ? 'border-green-500 text-green-600 dark:text-green-400'
              : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300';
          },
          [':aria-selected']: function () { return self.activeTab === name; }
        };
      },

      /** Bind helper for tab panels */
      panel: function (name) {
        var self = this;
        return {
          ['x-show']: function () { return self.activeTab === name; }
        };
      }
    };
  });

});
