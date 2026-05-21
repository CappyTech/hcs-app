# hcs-app UI Guidelines

> **For AI agents:** Read this file before writing any EJS view, partial, or UI change. It is the single source of truth for how pages look and behave in hcs-app.

---

## 1. Core Constraints

### No inline scripts. No `fetch()`.
Helmet enforces a strict CSP. This means:
- **No `<script>` tags in EJS views** (except the narrow exceptions in `layout.ejs` which are `nonce`-gated or hash-allow-listed by the security team).
- **No `fetch()`, `XMLHttpRequest`, or `axios` in the browser**.
- All interactivity must be **HTML forms** — `<form method="GET">` for filtering/search, `<form method="POST">` for mutations.
- The one legitimate exception is Alpine.js, which is loaded globally via a CSP-approved `src=""` attribute. You may use `x-data`, `x-show`, `x-bind`, `x-on` etc. for purely presentational toggles (collapse, tab switching) that require no server round-trip. Do **not** use Alpine to make network requests.

### CSRF
Every POST/PUT/DELETE form must include a CSRF token. Use the partial:
```ejs
<%- include('../partials/csrfHidden') %>
```
or inline when the partial path is inconvenient:
```ejs
<input type="hidden" name="_csrf" value="<%= typeof csrfToken !== 'undefined' ? csrfToken : '' %>">
```
`csrfToken` is always available in `res.locals` — never pass it explicitly from the controller.

### Views are partials, not full pages
Views in `mongoose/views/tailwindcss/` are **injected into** `layout.ejs` — they must **not** contain `<html>`, `<head>`, `<body>`, or `<nav>`. Start directly with a wrapping `<div>`.

---

## 2. Layout & Spacing

### Page wrapper
Every top-level view starts with:
```ejs
<div class="max-w-7xl mx-auto py-10 px-4 sm:px-6 lg:px-8">
```

### Page header pattern
```ejs
<div class="flex items-center gap-3 mb-6">
  <a href="/section" class="text-sm text-green-700 dark:text-green-400 hover:underline">← Back to list</a>
  <span class="text-gray-400">/</span>
  <h1 class="text-xl font-bold"><%= title %></h1>
</div>
```

### Section headings inside cards
```ejs
<h2 class="font-semibold text-sm uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-3">Section Name</h2>
```

---

## 3. Cards

### Standard card
```ejs
<div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl shadow-sm p-4">
  ...
</div>
```
Use `rounded-xl` for smaller/nested cards, `rounded-2xl` for primary content cards.

### Coloured state cards
Replace border/background with semantic colours:
- **Success/linked:** `border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-900/20`
- **Warning:** `border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20`
- **Error/mismatch:** `border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20`
- **Info:** `border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/20`

---

## 4. Typography

| Use | Class |
|-----|-------|
| Page title `<h1>` | `text-xl font-bold` or `text-2xl font-bold` |
| Card section `<h2>` | `font-semibold text-sm uppercase tracking-wide text-gray-500 dark:text-gray-400` |
| Body text | `text-sm text-gray-700 dark:text-gray-300` |
| Muted/label text | `text-sm font-medium text-gray-500 dark:text-gray-400` |
| Mono values (IDs, codes, hashes) | `font-mono text-xs` |
| Danger text | `text-red-700 dark:text-red-400` |
| Success text | `text-green-700 dark:text-green-400` |
| Amber/warning text | `text-amber-700 dark:text-amber-400` |

---

## 5. Buttons

### Primary action
```html
<button type="submit"
  class="text-sm bg-green-600 hover:bg-green-700 text-white px-5 py-2 rounded-lg shadow-sm font-medium transition">
  Save
</button>
```

### Secondary / outline
```html
<a href="/path"
  class="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600
         bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300
         hover:bg-gray-50 dark:hover:bg-gray-800 text-sm font-medium transition shadow-sm">
  <i class="bi bi-arrow-left"></i> Back
</a>
```

### Danger
```html
<button type="submit"
  class="text-sm bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg shadow-sm font-medium transition">
  Delete
</button>
```

### Disabled / already-actioned state
```html
<button type="button" disabled
  class="text-xs px-3 py-1.5 rounded-lg border border-green-400 text-green-700 dark:text-green-400
         bg-white dark:bg-gray-900 cursor-default opacity-60">
  Done
</button>
```

### Small inline action (table rows, list items)
```html
<button type="submit"
  class="text-xs px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-700 text-white shadow-sm font-medium transition">
  Link
</button>
```

---

## 6. Forms

### Search / filter form (GET — no CSRF needed)
```ejs
<form method="GET" action="/section" class="flex gap-2 flex-wrap">
  <input name="q" value="<%= q %>" placeholder="Search..."
    class="flex-1 min-w-0 text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2
           bg-white dark:bg-gray-800 text-gray-900 dark:text-white
           focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent" />
  <button type="submit"
    class="text-sm bg-green-600 hover:bg-green-700 text-white px-5 py-2 rounded-lg shadow-sm font-medium transition">
    Search
  </button>
</form>
```

### Mutation form (POST)
```ejs
<form method="POST" action="/section/<%= item.id %>/action">
  <%- include('../partials/csrfHidden') %>
  <input type="hidden" name="field" value="<%= value %>">
  <button type="submit" class="...">Confirm</button>
</form>
```

### Select / dropdown
```html
<select name="field"
  class="text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2
         bg-white dark:bg-gray-800 text-gray-900 dark:text-white
         focus:outline-none focus:ring-2 focus:ring-green-500">
  <option value="">— Choose —</option>
</select>
```

---

## 7. Flash Messages

**Do not render flash inline in views.** Flash partials are included once in `layout.ejs` and render globally as toast notifications:
- Success: bottom-right, green, auto-dismiss 4 s
- Error: top-right, red, auto-dismiss 5 s

In controllers, set flash before redirecting:
```js
req.flash('success', 'Record saved.');
req.flash('error', 'Something went wrong.');
res.redirect('/section');
```

If you must show an inline contextual message (e.g. form validation), use the card colour pattern from §3, not the toast partials.

---

## 8. Tables & Lists

### Standard data table
```ejs
<div class="overflow-hidden border border-gray-200 dark:border-gray-700 rounded-2xl shadow-sm">
  <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700 text-sm">
    <thead class="bg-gray-50 dark:bg-gray-800">
      <tr>
        <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Column
        </th>
      </tr>
    </thead>
    <tbody class="divide-y divide-gray-100 dark:divide-gray-700 bg-white dark:bg-gray-900">
      <% items.forEach(item => { %>
        <tr class="hover:bg-gray-50 dark:hover:bg-gray-800 transition">
          <td class="px-4 py-3 text-gray-900 dark:text-white"><%= item.field %></td>
        </tr>
      <% }) %>
    </tbody>
  </table>
</div>
```

### Divide-list (no table, card rows)
```ejs
<div class="divide-y divide-gray-100 dark:divide-gray-700">
  <% items.forEach(item => { %>
    <div class="flex items-start gap-4 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800">
      ...
    </div>
  <% }) %>
</div>
```

### Empty state
```ejs
<div class="text-sm text-gray-400 dark:text-gray-500 p-6 rounded-2xl border border-dashed
            border-gray-200 dark:border-gray-700 text-center">
  No records found.
</div>
```

---

## 9. Pagination

Standard prev/next link pattern (pass all active filters through):
```ejs
<% if (pages > 1) { %>
  <div class="flex justify-between items-center px-4 py-3 border-t border-gray-100 dark:border-gray-700">
    <% if (page > 1) { %>
      <a href="?q=<%= encodeURIComponent(q) %>&page=<%= page - 1 %>"
         class="text-xs px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700
                bg-white dark:bg-gray-900 hover:bg-green-600 hover:text-white transition">← Prev</a>
    <% } else { %><span></span><% } %>
    <span class="text-xs text-gray-500">Page <%= page %> of <%= pages %></span>
    <% if (page < pages) { %>
      <a href="?q=<%= encodeURIComponent(q) %>&page=<%= page + 1 %>"
         class="text-xs px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700
                bg-white dark:bg-gray-900 hover:bg-green-600 hover:text-white transition">Next →</a>
    <% } else { %><span></span><% } %>
  </div>
<% } %>
```

---

## 10. Badges & Tags

### Status badge (inline pill)
```html
<span class="text-[11px] px-2 py-0.5 rounded-full bg-green-100 text-green-800 border border-green-200
             dark:bg-green-900/40 dark:text-green-300 dark:border-green-700">
  active
</span>
```
Swap green for `amber`, `red`, `blue`, `slate` as appropriate.

### Tag chips (from document tags etc.)
```html
<span class="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 border border-slate-200
             dark:bg-slate-900/40 dark:text-slate-300 dark:border-slate-700">
  tag-name
</span>
```

---

## 11. Icons

Bootstrap Icons (`bi bi-*`) are loaded globally. Use them as:
```html
<i class="bi bi-link-45deg"></i>
<i class="bi bi-exclamation-triangle-fill text-amber-600"></i>
<i class="bi bi-check-circle-fill text-green-600"></i>
```
Common icons: `bi-receipt`, `bi-people`, `bi-building`, `bi-cash-coin`, `bi-link-45deg`, `bi-x-lg`, `bi-check2`, `bi-arrow-left`, `bi-box-arrow-up-right`, `bi-exclamation-triangle-fill`, `bi-info-circle`.

---

## 12. Colour System

The brand accent is **green**. Use it for primary actions, active states, and positive indicators.

| Role | Light | Dark |
|------|-------|------|
| Primary action / accent | `green-600` | `green-500` |
| Primary hover | `green-700` | `green-600` |
| Links / back nav | `text-green-700` | `dark:text-green-400` |
| Success state | `green-50` bg, `green-300` border | `green-900/20` bg, `green-700` border |
| Warning | `amber-50` bg, `amber-300` border | `amber-900/20` bg, `amber-700` border |
| Error / danger | `red-50` bg, `red-300` border | `red-900/20` bg, `red-700` border |
| Info | `blue-50` bg, `blue-300` border | `blue-900/20` bg, `blue-700` border |
| Page background | `bg-gray-50` | `dark:bg-gray-900` |
| Card background | `bg-white` | `dark:bg-gray-900` |
| Card border | `border-gray-200` | `dark:border-gray-700` |
| Subtle row hover | `hover:bg-gray-50` | `dark:hover:bg-gray-800` |

---

## 13. Grid Layouts

### Two-column (detail + side panel)
```html
<div class="grid md:grid-cols-2 gap-4"> ... </div>
```

### Asymmetric (e.g. 2/5 detail + 3/5 search)
```html
<div class="grid lg:grid-cols-5 gap-6">
  <div class="lg:col-span-2"> ... </div>
  <div class="lg:col-span-3"> ... </div>
</div>
```

### Three-column dashboard tiles
```html
<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"> ... </div>
```

---

## 14. Available Partials

| Path | Purpose |
|------|---------|
| `partials/csrfHidden` | `<input type="hidden" name="_csrf" ...>` |
| `partials/errorAlert` | Red toast for `flash.error[]` (rendered by layout) |
| `partials/successAlert` | Green toast for `flash.success[]` (rendered by layout) |
| `partials/footer` | Page footer |
| `partials/_formField` | Labelled form field row |
| `partials/form-create` | Generic create form shell |
| `partials/form-update` | Generic update form shell |
| `partials/listTable` | Generic paginated list table |

---

## 15. Date & Currency Formatting

Always format in EJS with locale helpers — never rely on raw ISO strings:
```ejs
<%= new Date(item.date).toLocaleDateString('en-GB') %>   <%# DD/MM/YYYY %>
<%= new Date(item.date).toLocaleString('en-GB') %>       <%# DD/MM/YYYY, HH:MM:SS %>
<%= (amount ?? 0).toFixed(2) %>                          <%# 2 decimal places %>
```
Currency values are stored as plain numbers; prefix `£` in the template.

---

## 16. Do Not

- Do not add `<style>` blocks to views (use Tailwind classes; one-off CSS belongs in `assets/tailwind.css`).
- Do not add `<script>` blocks to views.
- Do not use inline `onclick=`, `onsubmit=`, or any HTML event attributes.
- Do not link to `mongoose/views/mongoose/` — that folder is unused.
- Do not duplicate flash message rendering — the layout handles it.
- Do not use `!important` in class strings unless absolutely necessary.
- Do not use arbitrary Tailwind values (e.g. `w-[347px]`) unless the exact pixel value is genuinely required; prefer named scale values.
