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

  /**
   * attendanceCell – inline Excel-like cell editor for the weekly attendance grid.
   *
   * Usage: <td x-data="attendanceCell({...props})">
   *
   * Props (all passed as plain JS object from the EJS template):
   *   uuid          {string|null}  — existing attendance UUID, null for new records
   *   isNew         {boolean}      — true when the cell is currently empty (create mode)
   *   isPending     {boolean}      — true when the record status is 'pending'
   *   isSubcontractor {boolean}    — true for subcontractor rows (uses dayRate not hoursWorked)
   *   employeeId    {string|null}  — mongo ObjectId string, for new records
   *   subcontractorId {string|null}
   *   date          {string}       — YYYY-MM-DD
   *   initType      {string}       — initial type value
   *   initHours     {number|null}
   *   initDayRate   {number|null}
   *   initLocationId {string|null}
   *   initContractId  {string|null}
   *
   * REVERT: remove this component and the x-data attributes from weeklyTable-excel.ejs.
   */
  Alpine.data('attendanceCell', function (props) {
    return {
      editing: false,
      saving: false,
      error: null,

      // Live display values (updated after a successful save)
      displayType: props.initType || 'work',
      displayHours: props.initHours || null,
      displayDayRate: props.initDayRate || null,
      displayLocationId: props.initLocationId || null,
      displayContractId: props.initContractId || null,

      // Form scratch state while editing
      form: {
        type: props.initType || 'work',
        hours: props.initHours || '',
        dayRate: props.initDayRate || '',
        locationId: props.initLocationId || '',
        contractId: props.initContractId || '',
      },

      // Reference data loaded once from embedded JSON blobs
      locations: [],
      contracts: [],

      // Persisted server state for cancel/rollback
      _saved: null,

      init: function () {
        // Load location/project options from CSP-safe JSON blobs
        try {
          var locEl = document.getElementById('attendance-locations-json');
          if (locEl) this.locations = JSON.parse(locEl.textContent) || [];
        } catch (e) { /* ignore */ }
        try {
          var contractEl = document.getElementById('attendance-contracts-json');
          if (contractEl) this.contracts = JSON.parse(contractEl.textContent) || [];
        } catch (e) { /* ignore */ }

        // Snapshot initial form state for cancel
        this._saved = Object.assign({}, this.form);
      },

      get needsLocationProject() {
        return this.form.type === 'work' || this.form.type === 'training';
      },

      get locationName() {
        var loc = this.locations.find(function (l) {
          return String(l._id) === this.displayLocationId;
        }.bind(this));
        return loc ? loc.name : '';
      },

      startEdit: function () {
        if (!props.isPending && !props.isNew) return; // read-only guard
        // Sync form to current display values before opening
        this.form.type = this.displayType;
        this.form.hours = this.displayHours != null ? this.displayHours : '';
        this.form.dayRate = this.displayDayRate != null ? this.displayDayRate : '';
        this.form.locationId = this.displayLocationId || '';
        this.form.contractId = this.displayContractId || '';
        this.error = null;
        this.editing = true;
        var self = this;
        this.$nextTick(function () {
          var first = self.$el.querySelector('select, input');
          if (first) first.focus();
        });
      },

      cancel: function () {
        // Rollback form to last-saved snapshot
        this.form = Object.assign({}, this._saved);
        this.editing = false;
        this.error = null;
      },

      handleKey: function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.save();
        } else if (e.key === 'Escape') {
          this.cancel();
        }
      },

      _unchanged: function () {
        return (
          this.form.type === this._saved.type &&
          String(this.form.hours) === String(this._saved.hours || '') &&
          String(this.form.dayRate) === String(this._saved.dayRate || '') &&
          String(this.form.locationId) === String(this._saved.locationId || '') &&
          String(this.form.contractId) === String(this._saved.contractId || '')
        );
      },

      save: function () {
        if (this._unchanged() && !props.isNew) {
          this.editing = false;
          return;
        }
        this.saving = true;
        this.error = null;

        var csrf = (document.querySelector('meta[name="csrf-token"]') || {}).content || '';
        var self = this;

        if (props.isNew) {
          // ── CREATE ──────────────────────────────────────────────────────
          var body = {
            date: props.date,
            type: self.form.type,
          };
          if (props.employeeId) body.employeeId = props.employeeId;
          if (props.subcontractorId) body.subcontractorId = props.subcontractorId;
          if (props.isSubcontractor) {
            if (self.form.dayRate !== '') body.dayRate = Number(self.form.dayRate);
          } else {
            if (self.form.hours !== '') body.hoursWorked = Number(self.form.hours);
          }
          if (self.form.locationId) body.locationId = self.form.locationId;
          if (self.form.contractId) body.contractId = self.form.contractId;

          fetch('/attendance/inline', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
            body: JSON.stringify(body),
          })
            .then(function (r) { return r.json(); })
            .then(function (data) {
              self.saving = false;
              if (!data.success) {
                self.error = data.error || 'Save failed.';
                return;
              }
              // Update display + props for subsequent edits
              self._applyServerRecord(data.record);
              props.isNew = false;
              props.isPending = true;
              props.uuid = data.record.uuid;
              self._saved = Object.assign({}, self.form);
              self.editing = false;
              // Reload page so row totals, headcount etc. reflect the new record
              window.location.reload();
            })
            .catch(function (err) {
              self.saving = false;
              self.error = 'Network error. Please try again.';
            });
        } else {
          // ── UPDATE ──────────────────────────────────────────────────────
          var updateBody = { type: self.form.type };
          if (props.isSubcontractor) {
            updateBody.dayRate = self.form.dayRate !== '' ? Number(self.form.dayRate) : null;
          } else {
            updateBody.hoursWorked = self.form.hours !== '' ? Number(self.form.hours) : null;
          }
          updateBody.locationId = self.form.locationId || null;
          updateBody.contractId = self.form.contractId || null;

          fetch('/attendance/' + props.uuid, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
            body: JSON.stringify(updateBody),
          })
            .then(function (r) { return r.json(); })
            .then(function (data) {
              self.saving = false;
              if (!data.success) {
                self.error = data.error || 'Save failed.';
                return;
              }
              self._applyServerRecord(data.record);
              self._saved = Object.assign({}, self.form);
              self.editing = false;
            })
            .catch(function (err) {
              self.saving = false;
              self.error = 'Network error. Please try again.';
            });
        }
      },

      _applyServerRecord: function (rec) {
        this.displayType = rec.type;
        this.displayHours = rec.hoursWorked;
        this.displayDayRate = rec.dayRate;
        this.displayLocationId = rec.locationId;
        this.displayContractId = rec.contractId;
        this.form.type = rec.type;
        this.form.hours = rec.hoursWorked != null ? rec.hoursWorked : '';
        this.form.dayRate = rec.dayRate != null ? rec.dayRate : '';
        this.form.locationId = rec.locationId || '';
        this.form.contractId = rec.contractId || '';
      },
    };
  });

});
