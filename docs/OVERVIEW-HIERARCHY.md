# Overview Hierarchy — Design & Handover

Status: **pilot built.** Pilot order decided by Jack on 2026-10-09: **HR → Employee → Supplier (subcontractor)**. All three are built (6.59.0, branch `feat/overview-hierarchy`). See §7 for what's built and how to continue.

## 1. The goal (in Jack's words, condensed)

- Overviews should form a **hierarchy**: home → area overviews → model overviews → the model's list table.
- Each level links **one level down**, never skipping. Example of today's bug: on `/overview/human`, *Holiday Balances → View all* goes to `/employeeHolidays`; it should go to `/overview/holiday`.
- **Every model has an overview** showing information specific to it. The **list table is the final layer**: closest to the rows, with all the specifics.
- It must be **procedural**: a model is added with its data; that data is *defined and selected for a specific depth*. Pages are generated from those definitions, not hand-written.
- The existing procedural list system (`listControllerConfig`) was built for development (developer MVP). The app is now **user-centred**; the definitions must describe what a person needs, not what the schema contains.
- **End goal for the home page: defined per user.** Not every user wants to see the same things, and not every user is permitted to see everything.

## 2. Where things stand today (verified in code, 2026-10-09)

### Overview pages — 10, all one level deep, all hand-built

| Route | Controller fn | Service | Template | Roles (route guard) |
|---|---|---|---|---|
| `/overview/fleet` | `getFleetOverview` | (inline / fleetService) | `overview/fleet.ejs` | admin |
| `/overview/human` | `getHumanOverview` | `humanOverviewService.js` | `overview/human.ejs` | admin |
| `/overview/holiday` | `getHolidayOverview` | `holidayOverviewService.js` | `overview/holiday.ejs` | admin |
| `/overview/finance` | `getFinanceOverview` | `financeOverviewService.js` | `overview/finance.ejs` | admin, accountant |
| `/overview/projects` | `getProjectsOverview` (+ POST `/check`, `/:number/complete`) | `projectsOverviewService.js` | `overview/projects.ejs` | admin |
| `/overview/admin` | `getAdminOverview` | `adminOverviewService.js` | `overview/admin.ejs` | admin |
| `/overview/documents` | `getDocumentsOverview` | `documentsOverviewService.js` | `overview/documents.ejs` | admin |
| `/overview/subcontractors` | `getSubcontractorsOverview` | `subcontractorsOverviewService.js` | `overview/subcontractors.ejs` | admin, accountant, hmrc |
| `/overview/payroll` | `getPayrollOverview` | `payrollOverviewService.js` | `overview/payroll.ejs` | admin, accountant |
| `/overview/policies` | `getPoliciesOverview` | `policiesOverviewService.js` | `overview/policies.ejs` | admin |

Files: routes `mongoose/routes/overviewRoutes.js`; controller `mongoose/controllers/overviewController.js` (thin: call service, render); services `mongoose/services/*OverviewService.js`; templates `mongoose/views/tailwindcss/overview/*.ejs` (~2,300 lines total). Role facts are mirrored in `mongoose/config/rolePermissionsConfig.js` (~line 230).

Links out of each overview today (almost all go straight to list pages):
- **human** → `/employees`, `/employeeHolidays`, `/assignments`, `/contracts`, `/attendances`, create forms, and `/overview/fleet` (the **only** overview→overview link in the app).
- **holiday** → `/holidayRequests`, `/employeeHolidays`, `/holidays`, `/holidayCustoms`.
- **fleet** → `/vehicles`, `/vehicleServices`, `/vehicleMileageLogs`, `/vehicleFuelLogs`.
- **finance** → `/invoices`, `/purchases`.
- **projects** → `/contracts`, `/assignments`, `/projects`.
- **subcontractors** → `/suppliers`, `/users`, `/subcontractor/assign`.
- **payroll** → `/payroll/runs`, `/payroll/submissions`, `/payroll/dashboard`, payroll settings.
- **documents** → `/ocrDocuments`, `/paperless/queues`, `/paperless/ocr` (+ filters), shadow report, docs.heroncs.co.uk.
- **policies** → `/company-docs/policies`, letterhead.
- **admin** → `/users`.

### Home page

`mongoose/views/tailwindcss/index.ejs` lines ~31–41: a hard-coded array of 8 overview tiles, each gated by `canDept(dept)` (`res.locals.canDept`, set in `app.js` ~line 495 from `rbac.canAccessDepartment`). Holiday sits beside HR rather than under it. Admin and Policies aren't on home.

**Existing mismatch to fix along the way:** home shows the Holiday tile to `management` users, but `/overview/holiday` is admin-only, so they get a forbidden page. In general, tile visibility (department-based) and route guards (role-based) are two separate rules today; the new system must use **one** permission check for both.

### List tables

`mongoose/config/listControllerConfig.js` (37 models, ~1,850 lines) consumed by `mongoose/controllers/listController.js`. Developer-centred because:
- **Opt-out:** every schema field shows unless listed in `hideFields` (e.g. `employee` hides 9 fields). New schema fields appear automatically.
- Columns are derived from the **first document's keys** (`generateHeaders`), so legacy docs missing a field can drop a column (6.58.0 added a `rowFields` workaround).
- Labels come from field names unless overridden in `labelOverrides`.
- Per-model custom layouts are special-cased in `partials/listTable.ejs` (`if modelName === 'task'` …).
- No link between overview figures and list filters: "3 contracts ending soon" opens the unfiltered list.

The 37 list models: assignment attendance contract customer employee holiday invoice location meta project quote purchase session subcontractor supplier task user employeeHoliday holidayRequest vehicle holidayDismissal holidayCustom OcrDocument OcrDocumentIngest nominal note vatrate journal vatReturn accountingPeriod country currency quoteCategory purchaseOrderCategory vehicleFuelLog vehicleMileageLog vehicleService.

Related config: `CRUDControllerConfig.js` (forms/read pages), `dashboardTilesConfig.js` + `dashboardTileMetaConfig.js` (department dashboards: icons/groups per model), `departmentsConfig` (department dashboards routed in `indexRoutes.js`).

## 3. Agreed design

### Depths

| Depth | Page | Generated from |
|---|---|---|
| 0 | **Home** | The hierarchy + the user's home layout (per user, filtered by permission) |
| 1 | **Area overview** (`/overview/human`) | Each child model's *summary* contribution |
| 2 | **Model overview** (`/overview/employee`) | The model's overview definition |
| 3 | **List** (`/employees`) | The model's list definition (row detail lives here and on the read page) |

### Rules

1. **One definition per model**, describing it at every depth, in one place.
2. **Opt-in, not opt-out.** Each depth names what it shows. A new schema field appears nowhere until someone places it.
3. **Every figure is a link one level down, pre-filtered.** "Contracts ending in 60 days: 3" opens the list showing exactly those 3. The list must accept the same filter vocabulary the overview uses (query-string filters `listController` already supports where possible).
4. **The hierarchy is data.** Which models sit under which area, the order, and the labels. Breadcrumbs, home tiles and "View all" links are generated from it.
5. **One permission check** decides visibility at every depth (tile, panel, figure, link, page), and it is the same check the route enforces. Use `rbac` / `rolePermissionsConfig` + `customPermissions`; don't add a parallel rule.
6. **User-facing wording.** Labels are what the person recognises ("Contracts ending soon"), never field names.
7. **Escape hatch:** bespoke panels that don't fit a generic pattern (payroll submissions, document queues, the projects financial check, attendance/payroll aggregations) are registered as named *custom panels* a definition can include. Everything else is generic.
8. **Lookup/reference models** (country, currency, vatrate, meta, session, location, quoteCategory, purchaseOrderCategory, accountingPeriod…) get only depth 3, linked from their parent overview. No near-empty overview pages.
9. A model reachable from two areas (Suppliers: Finance and Subcontractors) has **one** overview; the breadcrumb follows the area you came from (or a primary parent if unknown).
10. **Single-tenant config direction** (see memory `project-hcs-app-single-tenant-config`): definitions live in code first, shaped as plain data so they can later move to the config store and be edited per deployment.

### Per-user home (end goal)

- Home = the user's chosen items, intersected with what they're permitted to see. Permission always wins; a saved preference can never reveal something the user can't access.
- Items a user can pin: area tiles, model overview tiles, and individual figures/panels from any overview (e.g. "Holiday requests awaiting approval").
- Store per user on the INTERNAL `user` model (e.g. `homeLayout: [{ ref, order, size? }]`), where `ref` is a stable id from the definitions (e.g. `employee.figure.contractsEndingSoon`). Unknown or no-longer-permitted refs are skipped silently.
- **Default layout per role** (from config) when the user hasn't customised; "Reset to default" available.
- Customise UI on the home page itself (add/remove/reorder). Build this **after** the hierarchy works; phase 4 below.

### Sketch of a definition (proposal — refine when building)

```js
// mongoose/config/views/employee.js  (one file per model, or one registry file)
export default {
  model: 'employee',
  label: { one: 'Employee', many: 'Employees' },
  parent: 'hr',                       // area id, or [primary, ...others]
  permission: { route: '/employees' },// reuse the route's rule
  summary: {                          // depth 1: what the area overview shows for this model
    figures: ['active', 'contractsEndingSoon'],
  },
  figures: {                          // reusable, each one links to a filtered list
    active:              { label: 'Active employees', count: { status: 'active' } },
    contractsEndingSoon: { label: 'Contracts ending in 60 days', severity: 'warning',
                           count: { status: 'active', 'contract.endDate': { within: '60d' } } },
  },
  overview: {                         // depth 2
    figures: ['active', 'contractsEndingSoon', 'unassigned'],
    breakdowns: [{ label: 'By type', by: 'type' }, { label: 'By status', by: 'status' }],
    attention: [{ figure: 'contractsEndingSoon', show: ['name', 'contract.endDate'] }],
    recent: { label: 'Recent hires', sort: { hireDate: -1 }, limit: 5, show: ['name', 'hireDate'] },
    panels: [],                       // names of registered custom panels
  },
  list: {                             // depth 3 (replaces listControllerConfig entry)
    columns: [ { field: 'name', label: 'Name', link: 'read' }, { field: 'position', label: 'Role' }, /* … */ ],
    tabs: { by: 'status', values: ['all', 'active', 'inactive'] },
    filters: ['status', 'type', 'ir35'],
    sort: { name: 1 },
  },
};
```

A hierarchy file declares areas: `{ id: 'hr', label: 'Human Resources', icon: 'bi-people', children: ['employee', 'holiday', 'attendance', 'task'] }`, etc.

### Draft hierarchy (★ = model overview that doesn't exist yet)

- **Home**
  - **HR** (`/overview/human` → becomes generated area page)
    - Employees ★ → `/employees`
    - Holiday (exists, becomes model-group overview) → employeeHolidays, holidayRequests, holidays, holidayCustoms, holidayDismissals
    - Attendance ★ → `/attendances`
    - Tasks ★ → `/tasks`
  - **Projects** → Contracts ★, Assignments ★, Projects ★
  - **Finance** → Invoices ★, Purchases ★, Customers ★, Quotes ★, Suppliers ★, Nominals ★, VAT ★ (vatReturn, journal)
  - **Fleet** → Vehicles ★, Services ★, Mileage ★, Fuel ★
  - **Subcontractors / CIS** → Suppliers (shared), CIS returns
  - **Payroll** (custom panels: runs, submissions)
  - **Documents** (custom panels: queues, OCR, shadow report)
  - **Policies**
  - **Admin** → Users, Sessions (list only)

Not yet decided: final placement of note, location, OcrDocumentIngest; whether Holiday is one overview with sub-lists or several model overviews.

## 4. Plan

1. **Engine:** definition format + hierarchy registry; generic area/model overview controller + template; figure → filtered-list links (extend `listController` filters as needed); breadcrumbs; single permission check. Lists keep using `listControllerConfig` until step 3 converts them.
2. **Pilot — HR end to end:** HR area page generated; Employees, Holiday, Attendance, Tasks model overviews; lists filtered from figures. Check on real pages with Jack before continuing. Fix the Holiday Balances link and the management/holiday permission mismatch here.
3. **Roll out** area by area (Fleet, Projects, Finance, Subcontractors, then the custom-panel-heavy Payroll/Documents). Convert each model's list to the opt-in `list` definition; retire each bespoke `*OverviewService` + template once replaced. Generated home tiles from the hierarchy (role-default only).
4. **Per-user home:** `homeLayout` on user, role defaults, customise UI, permission intersection.

Each step: own branch, version bump + CHANGELOG (new pages/routes = MINOR), `npm test`, tag `v*` (see AGENTS.md).

## 5. Open questions for Jack

1. HR as the pilot — confirmed? (proposed; not yet answered). Reference analysis (2026-10-09), counting models that point *at* each model (audit-style `user` refs excluded):
   - **Employee — 11**, all ObjectId refs inside INTERNAL: assignment, attendance, employeeHoliday, holidayRequest, payrollEntry, policyDocument, user, vehicle, vehicleDeployment, vehicleFuelLog, vehicleMileageLog. Spans 7 areas (HR, Holiday, Payroll, Fleet, Projects, Policies, Admin).
   - **Supplier — 11**: 8 INTERNAL refs (assignment, attendance, employee, user, vehicle, vehicleDeployment, vehicleFuelLog, vehicleMileageLog) + 3 REST joins by `SupplierCode`/`SupplierId` (purchase, purchaseOrder, bankTransaction). The only hub spanning both namespaces; has two parent areas (Finance, Subcontractors).
   - **Project — 9**: 4 INTERNAL (attendance, contract, vehicle, vehicleMileageLog) + 5 REST by `ProjectNumber` (invoice, purchase, purchaseOrder, quote, bankTransaction).
   - Customer 5, contract 4, vehicle 4. (`user` has 11 refs but they're mostly "who did it" audit links.)
   - **Recommendation:** pilot the **Employee** model overview inside HR. It touches the most areas through clean ObjectId refs, so it tests cross-area, pre-filtered links without the code-based REST joins. Do **Supplier second**, to prove REST joins and a model with two parents.
2. Home before per-user layouts: top-level areas only (Holiday reached via HR)? (proposed; not yet answered)
3. Holiday: one overview over all holiday models, or separate model overviews?
4. Should non-admin roles (employee, subcontractor) get overviews of their own data, or keep today's home shortcuts?
5. Where should definitions live long-term: code config only, or the config store (editable per deployment)?

## 6. Other in-flight work at the time of writing

- **hcs-app PR #148** (6.58.0 task fixes) is **merged**, squashed into master as `f82e5bd`. Post-deploy notes are in the PR body.
- **Tag to fix (for Jack):** `v6.58.0` still points at the pre-squash branch commit `45a5d0c`, which isn't on master. Re-point it at `f82e5bd` (needs a force-push of the tag). For future squash merges, tag on master after merging.
- `v6.57.2` tag was missing and has been added.

## 7. Progress & how to continue

### Built (6.59.0, branch `feat/overview-hierarchy`)

| Piece | File |
|---|---|
| Areas (depth 1) | `mongoose/config/overviews/areas.js` |
| Nodes (models or groups) | `mongoose/config/overviews/nodes/*.js`: employee, attendance, task, leave (Holiday group + holidayRequest, employeeHoliday, holiday, holidayCustom), vehicle (list-only) |
| Registry + `validate()` | `mongoose/config/overviews/index.js` |
| Engine | `mongoose/services/overviewEngine.js`: `compileWhere`, `breadcrumbs`, `buildArea`, `buildNodeOverview`, `resolveListView`, `customPanels` |
| Routes | `overviewRoutes.js` registers every area path and node `overviewPath` from the registry (guarded by `routeAccess`) |
| Template | `views/tailwindcss/overview/generated.ejs` (area + node), `partials/breadcrumbs.ejs` |
| List integration | `listController.js` applies `?view=` and passes `overviewCrumbs`/`activeView`; `listTable.ejs` shows breadcrumbs + "Showing: …" banner and keeps `view` across paging/tabs/filters |
| Home tiles | `index.ejs` filters tiles with `res.locals.canRoute` (added in `app.js`) |
| Permissions | `routeAccess` entries for `/overview/employee`, `/overview/attendance`, `/overview/task` (admin) |
| Tests | `tests/overviewEngine.test.js` (registry validity, filter vocabulary, breadcrumbs, list views, area + node pages with mocked models) |
| Removed | `humanOverviewService.js`, `overview/human.ejs` |

**Definition format as built** (differs slightly from the §3 sketch):
- Node: `{ id, model?, label: { one, many }, icon?, description?, parents: [areaOrNodeId…], overviewPath?, listPath?, actions?: [{ label, href, op }], figures?: { id: { label, where, severity?, hint? } }, summary?: [figureRef], overview?: { figures, breakdowns: [{ label, by, where?, labels? }], lists: [{ figure|where, title?, sort, limit, columns: [{ field, label, format?, ref?: { model, field } }] }], panels: [customPanelName], related: [figureRef] } }`.
- Figure refs: `'figureId'` (own) or `'nodeId.figureId'`. Group nodes (no `model`) own no figures and borrow others' in `summary`.
- `where` vocabulary: plain Mongo plus `$withinNextDays`, `$withinPastDays`, `$notAfterDays`, `$beforeNow`, `$set` (resolved at request time).
- Breakdown segments link via the list's own `tabsby` or select `filters` when they cover the field; otherwise unlinked.
- `?view=` only ever applies a definition from code (unknown/foreign refs ignored), ANDed with the list's normal data scoping.

**Checked live (2026-10-09, 6.59.0 deployed):** `/overview/human`, `/overview/employee`, `/employees?view=employee.active` (breadcrumbs, "Showing" bar, 8 rows) and `/overview/subcontractor` all work with real data. Fixed in 6.59.1 (PR #150):
- unclear wording on area-card links and related figures
- **the subcontractor rule.** `WithholdingTaxRate >= 0` matched 764 suppliers. Jack chose the CIS-details rule app-wide: `cisService.cisSupplierQuery()`, extended with WHT rate > 0, is now the only definition, used by the list, overview, pickers and purchase join.

### Supplier (subcontractor) — built

- Area `subcontractors` (`/overview/subcontractors`, admin/accountant/hmrc) replaces the bespoke page; node `subcontractor` (`/overview/subcontractor`) is the KashFlow `supplier` model listed through the `subcontractor` **alias list**. New node fields: `listName` (the alias) and `baseWhere` (the same `cisSupplierQuery()` as the alias `baseFilter`), so counts match the list. Node `user` (list-only) and figure `employee.ir35Subcontractor` back the related figures.
- KashFlow join: custom panel `subcontractorRecentPurchases` matches purchases by `SupplierCode` (REST data has no ObjectId refs).
- Actions can be gated by a controlled route (`action.route`) instead of a model op. Example: "Edit CIS details" needs `/subcontractor/assign`, which is admin-only.
- `listController`'s alias handler applies `?view=` and breadcrumbs too.
- **Two-parent test still pending:** a plain `supplier` node (all suppliers, `/suppliers`) under a generated Finance area would give Suppliers two parents. Do it when Finance is converted.

### Fleet — built (6.60.0, branch `feat/overview-fleet`)

- Area `fleet` (`/overview/fleet`) replaces the bespoke page (`fleetService` removed). Nodes `vehicle`, `vehicleService`, `vehicleFuelLog` and `vehicleMileageLog` are defined in `nodes/vehicle.js` and `nodes/fleetLogs.js`, each with its own overview.
- **Sum figures:** `{ sum: 'field', format: 'money' | unit: 'mi' }` totals the matching rows, and the link still opens those rows.
- New task figures `task.vehicleReminders` and `task.employeeReminders` (open system tasks matched by `systemKey` prefix) are linked from the Vehicles and Employees overviews.

### Projects — built (6.61.0, branch `feat/overview-projects`)

- Area `projects` (`/overview/projects`) replaces the bespoke page. Nodes `contract`, `assignment` and `project` (KashFlow REST) are in `nodes/projects.js`.
- `where` accepts `$expr` for comparing two fields (income vs target), passed through unchanged.
- **Partial panels:** a custom panel may return `{ partial, locals, always }`. `generated.ejs` then includes `overview/<partial>` with those locals; this is for features with forms or modals. `projectFinancials` holds the old financial table plus the Run Financial Check and Mark Complete modals; their POST routes stay at `/overview/projects/check` and `/overview/projects/:number/complete` and now redirect to `/overview/project`.

### Next

1. Convert the next areas: Finance (adds the second parent for suppliers), then Payroll/Documents/Policies/Admin with custom panels (partial panels suit their forms).
3. Lists: replace each model's `listControllerConfig` entry with an opt-in `list` definition on its node (§3 rule 2).
4. Per-user home (§3).

### Decisions still open
Q2–Q5 in §5 (home = top-level areas only? Holiday shape? non-admin overviews? config store?). Until answered: home still shows the Holiday tile; Holiday stays the hand-built page as a group node.
