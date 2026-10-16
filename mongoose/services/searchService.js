/**
 * searchService — one search box over every collection a person may list.
 *
 * The registry below names each searchable entity: which model it lives on,
 * which fields a typed term is matched against, how a hit is titled, and where
 * it links. A search runs every entity the signed-in person is allowed to list
 * (the same RBAC the list pages use, plus the ownership scoping that limits an
 * employee, subcontractor or client to their own records) in parallel, each
 * capped to a few hits, and returns the groups that found something.
 *
 * Matching is the list pages' own rule: a case-insensitive "contains" on string
 * fields and an exact match on numeric ones, so a typed invoice number finds
 * the invoice and a typed name finds the customer. There is no text index: the
 * collections here are a few thousand documents at most and every query is
 * capped by `limit` and `maxTimeMS`, so a scan is cheap. When a collection
 * grows past that, give it a text index and switch its entry to `$text`.
 *
 * Nothing here widens access. An entity is searched only when the role may
 * list the model, the read route's own middleware admits the role, and the
 * ownership filter resolves; the hit links to pages those guards protect.
 */

import mdb from './mongooseDatabaseService.js';
import rbac from '../config/rolePermissionsConfig.js';
import CRUDControllerConfig from '../config/CRUDControllerConfig.js';
import listControllerConfig from '../config/listControllerConfig.js';
import { scopeQuery as realScopeQuery } from '../../services/dataScopingService.js';
import realLogger from '../../services/loggerService.js';

export const MIN_QUERY_LENGTH = 2;
export const MAX_QUERY_LENGTH = 100;
export const DEFAULT_LIMIT = 5;
export const TYPE_LIMIT = 50;
const QUERY_TIMEOUT_MS = 3000;

const str = (v) => (v === undefined || v === null ? '' : String(v)).trim();
const num = (doc, field) => (doc[field] === undefined || doc[field] === null ? '' : String(doc[field]));

/**
 * The searchable entities, in the order their groups appear on the page.
 *
 *   key        group id, also the ?type= value for "show all"
 *   label      group heading
 *   ns/model   where it lives on mdb
 *   rbacModel  the model name rolePermissionsConfig knows (defaults to model)
 *   gate       extra guard: { department } mirrors a route's ensureDepartment
 *   fields     fields the term is matched against (nested paths allowed)
 *   title/subtitle/href  how a hit renders; `list` is the "show all" page
 *   sort       default ordering of hits
 */
export const ENTITIES = [
  { key: 'employee', label: 'Employees', ns: 'INTERNAL', model: 'employee', fields: ['name', 'email', 'phoneNumber', 'position', 'department'],
    title: (d) => str(d.name) || 'Employee', subtitle: (d) => [str(d.position), str(d.department)].filter(Boolean).join(' · '),
    href: (d) => `/employee/read/${d.uuid}`, list: '/employees', sort: { name: 1 } },
  { key: 'customer', label: 'Customers', ns: 'REST', model: 'customer', fields: ['Name', 'Code', 'DisplayName', 'VATNumber'],
    title: (d) => str(d.Name) || str(d.DisplayName) || 'Customer', subtitle: (d) => str(d.Code),
    href: (d) => `/customer/read/${d.uuid}`, list: '/customers', sort: { Name: 1 } },
  { key: 'supplier', label: 'Suppliers', ns: 'REST', model: 'supplier', fields: ['Name', 'Code', 'VatNumber', 'UniqueEntityNumber'],
    title: (d) => str(d.Name) || 'Supplier', subtitle: (d) => str(d.Code),
    href: (d) => `/supplier/read/${d.uuid}`, list: '/suppliers', sort: { Name: 1 } },
  { key: 'invoice', label: 'Invoices', ns: 'REST', model: 'invoice', fields: ['Number', 'CustomerName', 'CustomerReference'],
    title: (d) => `Invoice ${num(d, 'Number')}`.trim(), subtitle: (d) => [str(d.CustomerName), str(d.CustomerReference)].filter(Boolean).join(' · '),
    href: (d) => `/invoice/read/${d.uuid}`, list: '/invoices', sort: { Number: -1 } },
  { key: 'quote', label: 'Quotes', ns: 'REST', model: 'quote', fields: ['Number', 'CustomerName', 'CustomerReference'],
    title: (d) => `Quote ${num(d, 'Number')}`.trim(), subtitle: (d) => [str(d.CustomerName), str(d.CustomerReference)].filter(Boolean).join(' · '),
    href: (d) => `/quote/read/${d.uuid}`, list: '/quotes', sort: { Number: -1 } },
  { key: 'purchase', label: 'Purchases', ns: 'REST', model: 'purchase', fields: ['Number', 'SupplierName', 'SupplierReference'],
    title: (d) => `Purchase ${num(d, 'Number')}`.trim(), subtitle: (d) => [str(d.SupplierName), str(d.SupplierReference)].filter(Boolean).join(' · '),
    href: (d) => `/purchase/read/${d.uuid}`, list: '/purchases', sort: { Number: -1 } },
  { key: 'project', label: 'Projects', ns: 'REST', model: 'project', fields: ['Number', 'Name', 'Reference', 'CustomerName'],
    title: (d) => str(d.Name) || `Project ${num(d, 'Number')}`, subtitle: (d) => [num(d, 'Number') && `#${num(d, 'Number')}`, str(d.CustomerName)].filter(Boolean).join(' · '),
    href: (d) => `/project/read/${d.uuid}`, list: '/projects', sort: { Number: -1 } },
  { key: 'nominal', label: 'Nominal codes', ns: 'REST', model: 'nominal', fields: ['Code', 'Name'],
    title: (d) => [num(d, 'Code'), str(d.Name)].filter(Boolean).join(' · '), subtitle: (d) => str(d.Type),
    href: (d) => `/nominal/read/${d.uuid}`, list: '/nominals', sort: { Code: 1 } },
  { key: 'vehicle', label: 'Vehicles', ns: 'INTERNAL', model: 'vehicle', fields: ['registrationNumber', 'make', 'model', 'vin'],
    title: (d) => str(d.registrationNumber) || 'Vehicle', subtitle: (d) => [str(d.make), str(d.model)].filter(Boolean).join(' '),
    href: (d) => `/vehicle/read/${d.uuid}`, list: '/vehicles', sort: { registrationNumber: 1 } },
  { key: 'task', label: 'Tasks', ns: 'INTERNAL', model: 'task', fields: ['title', 'description'],
    title: (d) => str(d.title) || 'Task', subtitle: (d) => str(d.priority),
    href: (d) => `/task/read/${d.uuid}`, list: '/tasks', sort: { createdAt: -1 } },
  { key: 'contract', label: 'Contracts', ns: 'INTERNAL', model: 'contract', fields: ['title', 'location'],
    title: (d) => str(d.title) || 'Contract', subtitle: (d) => [str(d.location), str(d.status)].filter(Boolean).join(' · '),
    href: (d) => `/contract/read/${d.uuid}`, list: '/contracts', sort: { createdAt: -1 } },
  { key: 'assignment', label: 'Assignments', ns: 'INTERNAL', model: 'assignment', fields: ['title'],
    title: (d) => str(d.title) || 'Assignment', subtitle: (d) => str(d.status),
    href: (d) => `/assignment/read/${d.uuid}`, list: '/assignments', sort: { createdAt: -1 } },
  { key: 'location', label: 'Locations', ns: 'INTERNAL', model: 'location', fields: ['name', 'address', 'city', 'postalCode'],
    title: (d) => str(d.name) || 'Location', subtitle: (d) => [str(d.city), str(d.postalCode)].filter(Boolean).join(' '),
    href: (d) => `/location/read/${d.uuid}`, list: '/locations', sort: { name: 1 } },
  { key: 'user', label: 'Users', ns: 'INTERNAL', model: 'user', fields: ['username', 'email'],
    title: (d) => str(d.username) || 'User', subtitle: (d) => [str(d.email), str(d.role)].filter(Boolean).join(' · '),
    href: (d) => `/user/read/${d.uuid}`, list: '/users', sort: { username: 1 } },
  { key: 'document', label: 'Documents', ns: 'PAPERLESS', model: 'OcrDocument', rbacModel: 'OcrDocument', gate: { department: 'documents' },
    fields: ['title', 'correspondent.name', 'originalFileName', 'kashflowPurchaseNumber'],
    title: (d) => str(d.title) || str(d.originalFileName) || 'Document', subtitle: (d) => [str(d.correspondent && d.correspondent.name), str(d.documentType && d.documentType.name)].filter(Boolean).join(' · '),
    href: (d) => `/paperless/ocr/${d.paperlessId}`, list: '/paperless/ocr', sort: { paperlessId: -1 } },
];

/** Escape a typed term for use inside a RegExp. */
export function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The list pages' type-aware filter: regex on string/mixed/unknown fields,
 * numeric equality on number fields when the term parses as a number.
 * Returns null when no field can match the term.
 */
export function buildFilter(model, fields, term) {
  const regex = new RegExp(escapeRegex(term), 'i');
  const n = Number(term);
  const or = [];
  for (const f of fields) {
    const pathInfo = model && model.schema && typeof model.schema.path === 'function' ? model.schema.path(f) : null;
    const instance = pathInfo ? pathInfo.instance : null;
    if (instance === 'Number') {
      if (term !== '' && !Number.isNaN(n)) or.push({ [f]: n });
    } else if (instance === 'String' || instance === 'Mixed' || !instance) {
      or.push({ [f]: regex });
    }
  }
  return or.length ? { $or: or } : null;
}

/**
 * Whether a role passes a CRUD route's middleware list, mirroring the
 * strings CRUDRoutes resolves ('ensureRole:admin', 'ensureRoles:a,b', …).
 * Entries that do not name roles (ensureAuthenticated, ensureDepartment:x) are
 * not judged here: the department ones are handled by `gate`.
 */
export function routeAllows(role, middlewares) {
  if (!Array.isArray(middlewares) || !middlewares.length) return role === 'admin';
  for (const entry of middlewares) {
    const [fn, ...rest] = String(entry).split(':');
    const arg = rest.join(':');
    if (fn === 'ensureRole') {
      if (arg && arg !== role) return false;
    } else if (fn === 'ensureRoles') {
      const roles = arg.split(',').map((r) => r.trim()).filter(Boolean);
      if (roles.length && !roles.includes(role)) return false;
    }
  }
  return true;
}

/** The read-route middleware for a model, as CRUDRoutes merges it. */
function readMiddleware(modelKey) {
  const merged = { ...(listControllerConfig[modelKey] || {}), ...(CRUDControllerConfig[modelKey] || {}) };
  return (merged.middleware && merged.middleware.read)
    || (CRUDControllerConfig.default && CRUDControllerConfig.default.middleware && CRUDControllerConfig.default.middleware.read)
    || ['ensureRole:admin'];
}

/** Normalise a raw ?q= value: trimmed, single-spaced, length-capped. */
export function normaliseQuery(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_LENGTH);
}

/**
 * Build a search function over injectable dependencies (tests swap them).
 */
export function createSearch({
  db = mdb,
  access = rbac,
  scopeQuery = realScopeQuery,
  logger = realLogger,
  entities = ENTITIES,
  middlewareFor = readMiddleware,
} = {}) {
  /**
   * Which entities this request may search, with their ownership filters.
   * Resolved per request: role, custom permissions and ownership links differ.
   */
  async function allowedEntities(req) {
    const role = req.user && req.user.role;
    if (!role) return [];
    const customPerms = (req.user && req.user.customPermissions) || {};
    const out = [];
    for (const e of entities) {
      const rbacModel = e.rbacModel || e.model;
      const model = db[e.ns] && db[e.ns][e.model];
      if (!model || typeof model.find !== 'function') continue;
      if (e.gate && e.gate.department && !access.canAccessDepartment(role, e.gate.department, customPerms)) continue;
      if (!e.gate && role !== 'admin' && !routeAllows(role, middlewareFor(e.model))) continue;
      const { allowed } = access.canAccess(role, rbacModel, 'l', customPerms);
      if (!allowed) continue;
      let scope;
      try { scope = await scopeQuery(req, rbacModel, 'r'); } catch (err) {
        logger.warn(`[search] scope for ${e.key} failed: ${err.message}`);
        continue;
      }
      if (scope === null) continue;
      out.push({ entity: e, model, scope: scope || {} });
    }
    return out;
  }

  /**
   * Run the search. Returns { q, groups } where each group holds up to
   * `limit` hits and `more` when the entity has further matches.
   * `type` narrows to one entity (the "show all" page) with a larger limit.
   */
  async function search(req, rawQuery, { type = null, limit = DEFAULT_LIMIT } = {}) {
    const q = normaliseQuery(rawQuery);
    if (q.length < MIN_QUERY_LENGTH) return { q, groups: [], tooShort: q.length > 0 };
    let targets = await allowedEntities(req);
    if (type) targets = targets.filter((t) => t.entity.key === type);

    const results = await Promise.allSettled(targets.map(async ({ entity, model, scope }) => {
      const match = buildFilter(model, entity.fields, q);
      if (!match) return null;
      const filter = Object.keys(scope).length ? { $and: [scope, match] } : match;
      let cursor = model.find(filter).sort(entity.sort || { _id: -1 }).limit(limit + 1).lean();
      if (typeof cursor.maxTimeMS === 'function') cursor = cursor.maxTimeMS(QUERY_TIMEOUT_MS);
      const docs = await cursor;
      if (!docs.length) return null;
      const items = docs.slice(0, limit).map((d) => ({
        title: entity.title(d),
        subtitle: entity.subtitle ? entity.subtitle(d) : '',
        href: entity.href(d),
      }));
      return { key: entity.key, label: entity.label, list: entity.list, items, more: docs.length > limit };
    }));

    const groups = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') { if (r.value) groups.push(r.value); return; }
      logger.warn(`[search] ${targets[i].entity.key} failed: ${r.reason && r.reason.message}`);
    });
    return { q, groups, tooShort: false };
  }

  return { search, allowedEntities };
}

const instance = createSearch();
export const search = instance.search;
export const allowedEntities = instance.allowedEntities;

export default { search, allowedEntities, createSearch, ENTITIES, buildFilter, routeAllows, normaliseQuery, escapeRegex, MIN_QUERY_LENGTH, MAX_QUERY_LENGTH, DEFAULT_LIMIT, TYPE_LIMIT };
