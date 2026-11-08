# Permission groups and job roles

Status: **phase 1 built** (6.89.0); **phase 2a (Site Ops) built** (6.90.0); **phase 2b (Payroll, CIS) built** (6.91.0); **phase 2c (Documents, Website) built** (6.92.0); **phase 2d built** (6.94.0), which completes phase 2; **phase 3a (project scope) built** (6.95.0); **phase 3b (two-stage week approval) built** (6.96.0), which completes phase 3; **decision 3 (self-approval) decided and built** (6.98.0); **phase 4 (role editor) built** (6.99.0); **phase 5a (training & cards) built** (6.100.0); **phase 5b (inductions) built** (6.101.0). Phases 5c–5d are planned below.

## Why

Until now a user had exactly one `role`, from a fixed list (`admin`, `accountant`,
`employee`, `subcontractor`, `client`, `hmrc`, `auditor`). That list has
no place for the people who actually run a construction business, such as a Director,
Contracts Manager, Site Manager or Office Manager. In a small firm, one person
also usually covers several of those jobs.

This design adds:

- **Permission groups**: bundles of access to one area of the business.
- **Levels and scopes** on each group grant: how much access, and over which records.
- **Job roles**: named sets of group grants.
- **Several roles per user.** Access is the union of everything they hold.

## The model

### Groups

Defined in [`mongoose/config/accessGroupsConfig.js`](../mongoose/config/accessGroupsConfig.js).
Each group lists the department dashboards it opens, the models it touches and
the controlled routes (`routeAccess`) it reaches at each level.

| Group | Covers |
|---|---|
| Site Ops | Attendance, assignments, locations, vehicle deployment; daily/weekly views; attendance approval at *approve* |
| Commercial | Projects, quotes, contracts, and the customers, suppliers and purchases behind them (read-only) |
| Finance | Ledgers, KashFlow reference data, accountant portal. Bank reconciliation and payments only at *manage* |
| CIS | Subcontractor verification at *view*; CIS dashboard and returns (the deductions) from *approve* |
| Payroll | Employee records (pay rates, NI number), pay runs, RTI, weekly flow |
| HR | Holidays and approvals, tasks. **No employee record**: see "Pay data" below |
| Fleet | Vehicles, MOT/insurance/tax, servicing, fuel and mileage |
| Health & Safety | Placeholder. RAMS, inductions, training and accident book come in phase 5 |
| Documents | Document queues and data entry, letterhead and policies |
| Website | Public website content |
| System | Users, settings, integrations, logs and security. In full only for System Administrator (`admin`) |

### Levels

`view` < `edit` < `approve` < `manage`. Each level includes the ones below it.

| Level | Model operations | Plus |
|---|---|---|
| view | read, list | the group's `view` routes |
| edit | create, read, update, list | `edit` routes |
| approve | same as edit | `approve` routes (sign-off actions) |
| manage | create, read, update, **delete**, list | `manage` routes |

Models in the REST namespace (written only by the sync adapter) and the bank
records (created only through `/bank`'s own flow) are **read-only at every
level** (`READ_ONLY_MODELS`).

### Scopes

| Scope | Meaning | State |
|---|---|---|
| all | every record | enforced |
| project | only records on the user's sites: contracts that name them in **Site managers / supervisors** (`contract.siteManagers`) and aren't Completed | **read and list** through the generic routes (3a); recording and approving attendance through routes that check each record (3b) |

**How project scope works** (3a, 6.95.0):

- `projectScopeService.resolve(user)` finds the contracts that name the user
  and aren't Completed, and from them the sets each model filters on:
  contract ids, project ids and KashFlow project Numbers, quote ids,
  location ids. It's cached per request and fails closed (empty sets) on a
  database error.
- `accessGroupsConfig.PROJECT_SCOPE_FIELDS` says how each model is limited:
  contract, project, location and quote by `_id`; assignment and vehicle
  deployment by `contractId`; attendance by `contractId` or `projectId`;
  purchase by `ProjectNumber`. A model not listed (customer, supplier,
  vehicle) can't be granted at project scope.
- In the generic CRUD routes a project-scoped grant compiles to
  `r:project,l:project`, whatever its level (`PROJECT_SCOPE_MAX_LEVEL =
  'view'`), because the generic update and delete routes don't check a
  record's scope.
- Routes that do check each record ask `hasGroup(user, group, level,
  { project: true })`, and there a project-scoped grant counts at its full
  level (3b): recording on `/daily`, the inline attendance editor, and the
  approval routes.
- It reaches only routes whose data is filtered per record
  (`PROJECT_SCOPE_ROUTES`, today `/daily`), and no department dashboards:
  the weekly views, overviews and dashboards show whole-set figures.
- `scopeQuery` returns the site filter, or `{ $or: [own, sites] }` when the
  user also has own-records access. An unscoped grant from any role still
  lifts all scoping. Code that filters records in memory uses
  `matchesFilter(record, filter)`.

### Job roles

| Job role | Slug | Grants |
|---|---|---|
| Director | `director` | **manage**: Finance, CIS, Payroll, Documents (decision 3) · approve on the other business groups · view on System |
| System Administrator | `admin` (legacy) | everything |
| Contracts Manager | `contractsManager` | approve: Site Ops, Commercial · view: CIS, Fleet, H&S |
| Quantity Surveyor / Estimator | `quantitySurveyor` | edit: Commercial · view: CIS |
| Site Manager | `siteManager` | approve: Site Ops · view: Commercial, Fleet, H&S, all **project-scoped** (phase 3) |
| Supervisor / Foreman | `supervisor` | edit: Site Ops, **project-scoped** (phase 3) |
| Office Manager | `officeManager` | edit: Documents, HR, Fleet · view: Site Ops |
| Bookkeeper / Accounts | `accountant` (legacy) | unchanged |
| Payroll / HR Officer | `payrollHr` | approve: Payroll, HR · view: Site Ops |
| Health & Safety Advisor | `healthSafetyAdvisor` | edit: H&S · view: Site Ops |
| Fleet / Plant Manager | `fleetManager` | manage: Fleet |
| Employee, Subcontractor | legacy | unchanged |
| Client, HMRC, Auditor (external) | legacy | unchanged |

Every job role requires two-factor authentication by default (it's added to the
`REQUIRE_2FA_ROLES` default list).

### Seeing values (money)

Each job role has a `values` rule that says whether it sees money: day and pay
rates, costs, and purchase and project values.

| Rule | Roles | Meaning |
|---|---|---|
| always | Director, Contracts Manager, Quantity Surveyor, Payroll / HR | always see values |
| never | Office Manager, H&S Advisor, Fleet Manager | never see values |
| flag | **Site Manager, Supervisor** | per person: the user's **Can see values** checkbox (`user.canSeeValues`) |

`admin` and `accountant` always see values.

A grant marked `values: true` only applies when the role sees values. Site
Manager's and Supervisor's Commercial grant is marked this way. A 'flag' role is
compiled twice, as `siteManager` (no values grants) and `siteManager+values`
(all grants). `rbac.rolesOf(user)` picks one from the checkbox.
`rbac.canSeeValues(user)` gives the same answer for code that hides figures.

## How a user holds several roles

- `user.role` stays the **primary role**, a single legacy value. For office and site
  staff this is normally `employee`. That links their own attendance, holidays
  and vehicle, the same as today.
- `user.roles[]` holds **job roles**. The schema only accepts job role slugs, and
  `rbac.rolesOf(user)` ignores anything else. So the secondary list can never be
  used to hand out `admin` or another primary role.
- Access is the **union** of the primary role and every job role. Where one role
  grants an operation `:own` and another grants it unscoped, the unscoped grant wins.

Job roles and **Can see values** are set on the user's edit page (**Job roles**
card), which posts to `POST /admin/users/:uuid/roles` (admin only). Each change is
written to the security audit log as `role_changed` with `field: 'roles'` or
`field: 'canSeeValues'`. The generic user form can't write either field
(`hideFields` on create, `bodyDeny` on update).

## How it is enforced

Job roles are **compiled** at startup (`compileJobRoles()` in
`rolePermissionsConfig.js`) into the same `roleDepartments`, `roleModelAccess`
and `routeAccess` tables the hand-written roles use. Every RBAC helper
(`canAccess`, `canAccessRoute`, `canAccessDepartment`, `getDepartmentsForRole`,
`getListableModels`, `getOwnershipConfig`) accepts a single role or an array.
Call sites pass `rbac.rolesOf(req.user)`.

Route guards (`ensureRoles`) name primary roles. A job role gets past one only
where its groups reach:

1. **Generic CRUD and list routes**: the model grant for that operation.
2. **Department dashboards**: the department grant.
3. **Other routes**: the path's `routeAccess` entry. **Never past a guard that
   names `admin` alone.** `routeAccess` matches by longest prefix, so without
   this rule a grant on `/bank` would also open the admin-only reversal routes
   beneath it. Moving an admin-only page into a group is a deliberate change made
   one route at a time (phase 2).

### Group guards (phase 2)

`authService.ensureGroup(group, level, ...roles)` is how a route is opened to
job roles on purpose. It admits admin, the legacy roles it names, and any job
role holding `group` at `level` or above:

```js
router.post('/attendance/:uuid/approve', authService.ensureGroup('siteOps', 'approve'), ...);
router.post('/attendance/inline', authService.ensureGroup('siteOps', 'edit', 'admin', 'accountant'), ...);
// any of several grants:
authService.ensureGroup([{ group: 'siteOps', level: 'edit' }, { group: 'payroll', level: 'view' }], null, 'admin', 'accountant');
```

In code and views, `rbac.hasGroup(user, group, level)` answers the same
question, and `canGroup(group, level)` is available in every view. Only grants
enforced today count: a project-scoped grant doesn't until phase 3.

A route has two layers: its own guard and the global `ensureRouteAccess`
check, driven by `routeAccess`. When a guard is opened to a group, that
group's `routes` must list the path too, or the global check still refuses it.
`tests/permissionGroups.test.js` checks every `ensureGroup` guard in
`mongoose/routes/` against the global check, for every job role.

### Pay data

The employee record holds pay rates and the NI number, and there is no
field-level permission yet. So the whole record sits in **Payroll**, not HR. HR
without Payroll covers holidays and tasks. A field-level split is a phase 2
candidate.

## What phase 1 does not do yet

These gaps are deliberate. They are the plan for the next phases.

- **Direct role checks.** The ones left compare `req.user.role` on purpose
  (see "Still admin-only on purpose" under phase 2). They fail closed: a
  direct check can only show less, never more. Ownership
  scoping (`dataScopingService`, `filterAttendanceForUser`) already reads every
  role: a Contracts Manager whose primary role is `employee` sees every week on
  `/weekly`, because Site Ops grants attendance unscoped.
- **Writes on site.** Site Manager and Supervisor record and approve
  attendance on their sites (3b). Other site records (assignments, vehicle
  deployments) are read only for them.
- **Bank and payments** open to `admin`, `accountant` and Director, under separation of duties (decision 3 below).
- **Health & Safety** has no models yet.

## Phases

Each phase is its own PR, merged before the next one starts (hcs-app is rebase-merge only, with no stacked PRs).

1. **Groups, job roles, `user.roles[]`, multi-role helpers.** *(this PR)*
   No change for any existing user. A user with no job roles gets exactly the
   access they had before.
2. **Move direct role checks to group checks**, one area per PR, each using
   `ensureGroup` / `hasGroup` / `canSeeValues`:
   - **2a, Site Ops** *(6.90.0, built)*: daily, weekly and management weekly
     views; weekly flow; inline attendance, assignment and vehicle deployment
     edits; attendance approve, reject and bulk approve; pay on the weekly view.
   - **2b, Payroll and CIS** *(6.91.0, built)*. Payroll view: dashboard,
     runs, submissions log, FPS/EPS/pension downloads. Edit: create and
     calculate runs, override an entry, employee pay. Approve: lock a run.
     CIS approve: dashboard and returns. At **manage**, so admin-only for
     now: unlock a run, post the payroll journal, submit FPS/EPS/pension,
     assign a subcontractor, change a purchase's supplier. Payroll settings
     and tax rates are System settings and stay admin-only.
   - **2c, Documents and Website** *(6.92.0, built)*. Documents view: queues,
     documents, files, reading reports, mail rules guide, ingest tracker,
     documents overview, letterhead and policies. Edit: data entry, a
     document's type, supplier and flags, letterhead, policies. Approve:
     reopen an entry, undo a credit note or Not for KashFlow, link a document
     to a KashFlow purchase, delete a policy. At **manage**, so admin-only for
     now: send to KashFlow, create a supplier, re-send an invoice email,
     unlink, reassign, re-ingest, sync fields, delete, remove, the repair
     tools and the reading fixture. Website edit drafts, approve publishes,
     unpublishes and deletes, manage changes settings.

     Routes are guarded in two layers: `routeAccess` opens every `/paperless`,
     `/company-docs` and `/website` page at the group's **view** level, and
     each route's `ensureGroup` asks for the level that action needs.
   - **2d, the rest** *(6.94.0, built)*. System view: the audit trail and
     security events (read-only). Finance manage: receipt and purchase
     changes. Generic CRUD hooks: Site Ops edit records attendance for
     anyone (pay fields only if it sees values; the payroll lock still
     applies), and HR edit raises holiday requests for anyone. Search, help,
     the purchase → Paperless link and the account page's 2FA notice follow
     every role held.
   - Later: consider a field-level split of the employee record.

   **Still admin-only on purpose** (each is a direct admin check or a System
   setting, held by no job role):
   - editing attendance inside a locked payroll period, and the weekly
     flow's "record as admin" path;
   - bank auto-confirm and reversing a sign-off;
   - the company mailbox (`/mail`), the live log feed, logs, settings,
     integrations, users and the signed-in sessions panel;
   - handling other people's GDPR requests;
   - the Paperless audit timeline on a document.

   No other pay-hiding checks compare roles directly: pay visibility goes
   through `rbac.canSeeValues(user)`.
3. **Project scope.**
   - **3a** *(6.95.0, built)*: a contract names its site managers and
     supervisors (decided over deriving it from weekly assignments: explicit,
     and a manager needn't be on a labour assignment). Project-scoped grants
     give read and list on those contracts' records; Site Manager and
     Supervisor are assignable. See "How project scope works" above.
   - **3b** *(6.96.0, built)*: two-stage week approval, below, with
     scope-checked routes for recording and approving attendance on the
     user's sites (`attendanceApprovalService`).

   **Two-stage week approval** (decision 2). Attendance today goes `pending` →
   `approved` / `rejected` in one admin step. Phase 3 adds a middle state:
   - `pending` → **`site-approved`**: Site Manager (Site Ops approve, project
     scope) approves the week for their projects.
   - `site-approved` → **`approved`**: Contracts Manager approves.
   - Either can reject back to the person who submitted it.
   - Each step records who approved and when.
   - Payroll, the weekly flow and CIS read only `approved`.

   The Contracts Manager step is required, so a week a Site Manager approved
   doesn't reach payroll until a Contracts Manager approves it too. Admin can
   still approve in one step, for cover.

   **As built (3b, 6.96.0):**
   - The site step applies where the record's contract (or, without one, its
     project) belongs to a running contract that names a site manager. Other
     records, including sick, holiday and off days, go straight to the
     Contracts Manager.
   - The site step is taken by a Site Ops approve grant on the viewer's sites
     (a Site Manager, or a Contracts Manager who is also named on the
     contract). The final step needs Site Ops approve over all records.
   - The person who took the site step can't take the final step. This is
     separation of duties inside one chain; the wider self-approval question
     (decision 3) is still open.
   - Reject works from pending or site approved, for anyone who could
     approve the current step, and for the Site Manager on their own sites.
   - Recording: a **Record a day** form on `/daily` (and the inline editor)
     lets a Supervisor or Site Manager record on their contracts only, for
     people assigned to them that week. The generic attendance form always
     creates `pending` for non-admins.
   - Holiday accrual and payroll use only `approved`. The weekly views and
     the weekly flow count `site-approved` as still waiting.
4. **Role editor.** Edit job roles and groups from the config store instead of
   code, in line with the single-tenant config direction. Each company sets its
   own roles.

   **As built (6.99.0):** `/admin/job-roles`, admin only.
   - Job roles are editable; **groups are not**. A group's departments,
     models and routes are tied to code (a route only exists in code), so
     they stay in `accessGroupsConfig.groups`.
   - Change any job role's name, description, money rule (`values`), on/off,
     and the level it holds on each group, with own-sites scope and the
     money-bearing flag per grant. Add job roles (they start off, with no
     grants). Reset a built-in role; delete an added one once nobody holds it.
   - The code definitions are the defaults (`defaultJobRoles`, frozen). The
     INTERNAL `jobRoleConfig` collection holds the whole definition of every
     role a company changed or added. `jobRoleConfigService` validates,
     stores and applies: `applyJobRoleOverrides()` rebuilds `jobRoles` and
     `JOB_ROLE_SLUGS` in place, and `rbac.recompileJobRoles()` resets the
     compiled tables to their hand-written state and compiles again. Loaded
     at startup after the overview config; a stored role that no longer
     validates is skipped with a warning.
   - Rules: groups and levels from config only; one grant per group; System
     at view at most; project scope only on groups where it limits something
     (`groupScopable`); slugs never collide with a legacy role.
   - Any level is allowed, including manage on the money groups (user's
     decision): separation of duties already applies to every user who isn't
     admin or accountant.
   - A role turned off stays in users' `roles[]` but compiles to nothing and
     can't be assigned. `user.roles` is no longer an enum (slugs change at
     runtime); assignment still only saves available job roles.
   - The public Roles page shows the written day-to-day notes only while a
     role is as shipped.
5. **Health & Safety module.** RAMS, inductions, training/cards, accident book.

   **Decided (2026-11-08):** four PRs, one record each — 5a training & cards,
   5b inductions, 5c RAMS, 5d accident book.
   - Cards, training and inductions warn before they expire, like vehicles:
     a daily job gives admins and Health & Safety job roles a task and a
     summary email 30 days ahead, and emails the person.
   - Site Managers and Supervisors record inductions and RAMS sign-offs on
     their own sites (project scope); the H&S Advisor works on every site.
   - The accident book holds health data (UK GDPR special category): full
     entries are read by admins and Health & Safety at approve or above.
     Anyone on site can report one and sees only their own report.

   **5a as built (6.100.0):** INTERNAL `trainingRecord` — held by an employee
   or a CIS subcontractor (not both), with an optional operative name for
   someone a subcontractor firm sends; type from a fixed list (site cards,
   plant tickets, SMSTS/SSSTS, first aid, common courses, Other), card number,
   provider, issued, expiry and checked dates. Generic CRUD and list pages,
   guarded by the RBAC matrix only: the Health & Safety group now holds the
   model, so the H&S Advisor (edit) records them; employees and
   subcontractors read their own (`r:own,l:own`). New overview area
   `/overview/healthSafety` with the Training & cards node (expired, due in
   30 days, unchecked). `healthSafetyComplianceService` (job
   `training-expiry`, daily) mirrors `hrComplianceService`; reminder
   recipients are admins plus users holding an on job role with the H&S area
   at edit or above at all-sites scope. Training records aren't site records,
   so the Site Manager's project-scoped H&S view gives nothing here yet.

   **5b as built (6.101.0):** INTERNAL `induction` — contract (the site), the
   person (employee or CIS subcontractor, optional operative name), date,
   inducted by, topics covered (fixed list), signed, re-induction due, notes.
   - `induction` is in `PROJECT_SCOPE_FIELDS` by `contractId`, so a
     project-scoped H&S grant lists and reads its sites' inductions.
   - Site Manager's H&S grant goes from view to **edit**, project-scoped; the
     Supervisor gets the same grant (it had none).
   - Project-scoped writes go through `/inductions/record`
     (`inductionController`, in `PROJECT_SCOPE_ROUTES`): it offers only the
     viewer's open contracts and the people assigned to them from four weeks
     back to a week ahead, and checks both again on save. Admins and H&S on
     every site see every open contract there, and use the generic pages too.
     The daily attendance page links to it, because a project-scoped grant
     doesn't open the H&S overviews.
   - Employees and subcontractors read their own (`r:own,l:own`).
   - Overview node Site inductions (last 30 days, re-induction overdue / due,
     not signed) under the Health & Safety area, with a Record an induction
     action.
   - `healthSafetyComplianceService` now scans a list of sources (training,
     inductions); a re-induction task also goes to the contract's
     `siteManagers`. Each source closes its stale tasks only after its own
     clean scan.

## Open decisions

All three decisions are made.

1. **Money on site.** *Decided: per person.* Site Managers and Supervisors
   have a **Can see values** checkbox, off by default. See "Seeing values" above.
2. **Approval chain.** *Decided: yes, the Contracts Manager approves the week
   after the Site Manager.* The chain is Supervisor (signs off the day), then Site
   Manager (approves the week, for their projects), then Contracts Manager
   (approves the week), then payroll. Payroll only uses weeks the Contracts Manager
   has approved. Built in phase 3, because the Site Manager step needs project
   scope. Until then, approval is still the single admin step it is today. See
   "Two-stage week approval" in phase 3.
3. **Self-approval.** *Decided (6.98.0): Directors hold manage, and a second
   person is always needed.* The Director job role holds **manage** on
   Finance, CIS, Payroll and Documents, so it can send money and submissions
   out of the app. `separationOfDutiesService` blocks it (never just logs)
   from taking the outward step on something it took the step before on:

   | First step (recorded as) | Blocked outward step |
   |---|---|
   | saved the Documents entry (`entry.savedBy`) | send that invoice to KashFlow (a dry run is still allowed) |
   | saved the entry for a purchase (`entry.savedBy`, by `kashflowPurchaseNumber`) | pay it in bulk payments (preview and confirm both refuse) |
   | confirmed a bank match in the period (`bankMatch.reviewedBy`) | sign that period off |
   | locked the payroll run (`payrollRun.lockedBy`, new) | submit its FPS or pension, post its journal |

   - The legacy `admin` and `accountant` roles are exempt: they did all of
     this alone before job roles, and admin stays the one-person cover (as
     with attendance approval).
   - No other job role holds manage on these groups (a test enforces it).
   - Manage also grants delete on the groups' models; REST and bank records
     stay read-only at every level (`READ_ONLY_MODELS`).
   - Actions with no recorded first step are open to a Director without a
     check: unlocking a run, the EPS (monthly, not per run), CIS
     subcontractor assignment and supplier change, receipt and purchase
     submission changes, and the Documents repair tools.
   - Bank and payments routes moved from `ensureRoles('admin', 'accountant')`
     to `ensureGroup('finance', 'manage', 'admin', 'accountant')`. Reversing a
     confirmation and reopening a signed period stay admin-only.
