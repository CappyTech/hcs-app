# Permission groups and job roles

Status: **phase 1 built** (6.89.0). Phases 2–5 are planned below.

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
| project | only records on projects the user is assigned to | **phase 3**. A grant with this scope compiles to nothing for now, and a role that depends on one is shown but can't be ticked |

### Job roles

| Job role | Slug | Grants |
|---|---|---|
| Director | `director` | approve on every business group; view on System |
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

### Pay data

The employee record holds pay rates and the NI number, and there is no
field-level permission yet. So the whole record sits in **Payroll**, not HR. HR
without Payroll covers holidays and tasks. A field-level split is a phase 2
candidate.

## What phase 1 does not do yet

These gaps are deliberate. They are the plan for the next phases.

- **Direct role checks.** About 76 places in controllers, views and services
  compare `req.user.role` directly (for example "strip pay figures unless admin or
  accountant", "scope to own records if employee"). These still see only the
  **primary** role. A Contracts Manager whose primary role is `employee` can open
  `/weekly`, but that page still shows them only their own week. This fails
  closed: a direct check can only show less, never more.
- **Admin-only pages** (most `/overview/*` hand-built pages, `/paperless/*`,
  `/company-docs/*`, payroll screens guarded `admin` only) stay admin-only even
  where a group lists them.
- **Project scope.** Site Manager and Supervisor can't be assigned yet.
- **Bank and payments** stay with `admin` and `accountant` (decision 3 below).
- **Pay figures on attendance pages** are still hidden by direct "admin or
  accountant" checks. Phase 2 moves them to `rbac.canSeeValues(user)`.
- **Health & Safety** has no models yet.

## Phases

Each phase is its own PR, merged before the next one starts (hcs-app is rebase-merge only, with no stacked PRs).

1. **Groups, job roles, `user.roles[]`, multi-role helpers.** *(this PR)*
   No change for any existing user. A user with no job roles gets exactly the
   access they had before.
2. **Move direct role checks to group checks.** Go through the ~76 direct
   `role ===` checks and move each one to a level check, for example "has Site Ops
   approve" instead of `role === 'admin'`. Open the admin-only pages that groups
   list. Consider a field-level split of the employee record.
3. **Project scope.** Add a `:project` scope resolved from `assignment` (the
   user's employee or subcontractor on the assignment, then its contract and
   project). Enable Site Manager and Supervisor.

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
4. **Role editor.** Edit job roles and groups from the config store instead of
   code, in line with the single-tenant config direction. Each company sets its
   own roles.
5. **Health & Safety module.** RAMS, inductions, training/cards, accident book.

## Open decisions

Decisions 1 and 2 are made. Decision 3 has a default applied in phase 1; settle it before bank and payments are opened to job roles.

1. **Money on site.** *Decided: per person.* Site Managers and Supervisors
   have a **Can see values** checkbox, off by default. See "Seeing values" above.
2. **Approval chain.** *Decided: yes, the Contracts Manager approves the week
   after the Site Manager.* The chain is Supervisor (signs off the day), then Site
   Manager (approves the week, for their projects), then Contracts Manager
   (approves the week), then payroll. Payroll only uses weeks the Contracts Manager
   has approved. Built in phase 3, because the Site Manager step needs project
   scope. Until then, approval is still the single admin step it is today. See
   "Two-stage week approval" in phase 3.
3. **Self-approval.** When one person holds roles that let them both raise and
   approve the same item (for example entering a purchase and paying it), should
   the app block it or only log it? *Default for now: neither is needed, because
   bank reconciliation and payments are not granted to any job role.* Decide this
   before opening them up.
