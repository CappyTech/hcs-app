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

  /**
   * helpDocs – search + active-link highlighting for /help
   */
  Alpine.data('helpDocs', function () {
    return {
      q: '',
      noResults: false,

      search: function () {
        var q = this.q.toLowerCase().trim();
        var anyVisible = false;

        var sections = document.querySelectorAll('[data-help-section]');
        sections.forEach(function (section) {
          var sectionVisible = false;
          var articles = section.querySelectorAll('[data-help-article]');
          articles.forEach(function (article) {
            var text = article.getAttribute('data-search-text') || '';
            var visible = !q || text.indexOf(q) !== -1;
            article.style.display = visible ? '' : 'none';
            if (visible) {
              sectionVisible = true;
              anyVisible = true;
            }
          });
          section.style.display = sectionVisible ? '' : 'none';
          var navCat = document.querySelector('[data-nav-cat="' + section.getAttribute('data-help-section') + '"]');
          if (navCat) navCat.style.display = sectionVisible ? '' : 'none';
        });

        var navArts = document.querySelectorAll('[data-nav-art]');
        navArts.forEach(function (navArt) {
          var id = navArt.getAttribute('data-nav-art');
          var article = document.getElementById(id);
          navArt.style.display = (!article || article.style.display === 'none') ? 'none' : '';
        });

        this.noResults = !anyVisible && q.length > 0;
      },

      highlightActive: function (id) {
        document.querySelectorAll('[data-nav-art] a').forEach(function (a) {
          a.classList.remove('text-green-600', 'dark:text-green-400', 'bg-green-50', 'dark:bg-green-900/20', 'font-medium');
        });
        var link = document.querySelector('[data-nav-art="' + id + '"] a');
        if (link) {
          link.classList.add('text-green-600', 'font-medium', 'bg-green-50');
        }
        var article = document.getElementById(id);
        if (article) {
          article.classList.add('ring-2', 'ring-green-400', 'ring-offset-2', 'dark:ring-offset-gray-950');
          setTimeout(function () {
            article.classList.remove('ring-2', 'ring-green-400', 'ring-offset-2', 'dark:ring-offset-gray-950');
          }, 800);
        }
      }
    };
  });

});
