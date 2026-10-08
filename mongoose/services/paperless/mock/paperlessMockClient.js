/**
 * In-memory fake of the Paperless-ngx API client, selected by PAPERLESS_URL=mock.
 *
 * Implements the same interface as makeClient() in paperlessClient.js so the
 * document-processing code can be developed and tested without touching the
 * live server (PAPERLESS-MIGRATION.md section 6a). State lives in this module,
 * is seeded from ./fixtures.js, and is shared by every client the app makes;
 * tests call resetMockPaperless() to start clean.
 *
 * Write semantics deliberately copy Paperless rather than being "nicer" — e.g.
 * PATCH custom_fields replaces the whole array — so the mock reproduces the
 * same bugs the live server would.
 */

import logger from '../../../../services/loggerService.js';
import fixtures from './fixtures.js';
import { Readable } from 'node:stream';
import { buildFixturePdf } from './fixturePdf.js';

export function isMockPaperless() {
  return process.env.PAPERLESS_URL === 'mock' || process.env.PAPERLESS_BASE_URL === 'mock';
}

const clone = (v) => (v === undefined ? v : structuredClone(v));

let state = null;
let warned = false;

/** Restore the fixture data and clear the call log. */
export function resetMockPaperless() {
  state = {
    tags: clone(fixtures.TAGS),
    documentTypes: clone(fixtures.DOCUMENT_TYPES),
    correspondents: clone(fixtures.CORRESPONDENTS),
    customFields: clone(fixtures.CUSTOM_FIELDS),
    documents: clone(fixtures.DOCUMENTS),
    calls: [],
    // Client method names whose next call should throw, e.g. to exercise a
    // fallback: state.failNext.add('setDocumentCustomFields'). Cleared once used.
    failNext: new Set(),
  };
}

/** Live view of the mock's state, for assertions in tests. */
export function mockPaperlessState() {
  if (!state) resetMockPaperless();
  return state;
}

function notFound(path) {
  const err = new Error('Request failed with status code 404');
  err.response = { status: 404, data: { detail: 'Not found.' } };
  err.config = { url: path };
  return err;
}

function paginate(items, page = 1, pageSize = 100) {
  const start = (page - 1) * pageSize;
  const results = items.slice(start, start + pageSize);
  return {
    count: items.length,
    next: start + pageSize < items.length ? `/api/?page=${page + 1}` : null,
    previous: page > 1 ? `/api/?page=${page - 1}` : null,
    results: clone(results),
  };
}

function pickFields(obj, fields) {
  if (!fields) return obj;
  const keys = (Array.isArray(fields) ? fields : String(fields).split(',')).map((s) => s.trim());
  return Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));
}

function nextId(list) {
  return list.reduce((max, x) => Math.max(max, x.id), 0) + 1;
}

export function makeMockClient() {
  if (!state) resetMockPaperless();
  if (!warned) {
    logger.warn('[paperlessClient] PAPERLESS_URL=mock — using the in-memory Paperless fake, not a real server.');
    warned = true;
  }

  const record = (method, path, body) => state.calls.push({ method, path, body: clone(body) });
  const maybeFail = (name) => {
    if (!state.failNext.has(name)) return;
    state.failNext.delete(name);
    const err = new Error('Request failed with status code 400');
    err.response = { status: 400, data: { detail: `mock: forced failure of ${name}` } };
    throw err;
  };

  const findDoc = (id) => {
    const doc = state.documents.find((d) => d.id === Number(id));
    if (!doc) throw notFound(`/documents/${id}/`);
    return doc;
  };
  const touch = (doc) => { doc.modified = new Date().toISOString(); };

  const tagAncestors = (id) => {
    const out = [];
    let t = state.tags.find((x) => x.id === id);
    while (t && t.parent != null) {
      out.push(t.parent);
      t = state.tags.find((x) => x.id === t.parent);
    }
    return out;
  };
  const tagDescendants = (id) => {
    const kids = state.tags.filter((t) => t.parent === id).map((t) => t.id);
    return kids.flatMap((k) => [k, ...tagDescendants(k)]);
  };

  // Shared by both custom-field writers: apply name→value updates to a
  // fieldId→value map, then PATCH the whole array as Paperless does.
  const applyCustomFields = (doc, existing, nameValuePairs) => {
    const idByName = new Map(state.customFields.map((f) => [f.name.trim().toLowerCase(), f.id]));
    for (const [name, value] of Object.entries(nameValuePairs || {})) {
      const key = String(name).trim().toLowerCase();
      let fid = idByName.get(key);
      if (fid == null && value != null) {
        fid = nextId(state.customFields);
        state.customFields.push({ id: fid, name, data_type: 'string' });
      }
      if (fid == null) continue;
      if (value == null) existing.delete(fid);
      else existing.set(fid, String(value));
    }
    doc.custom_fields = Array.from(existing.entries()).map(([field, value]) => ({ field, value }));
    touch(doc);
    return clone(doc);
  };

  return {
    async listDocuments({ page = 1, pageSize = 50, query = null, modified__gte = null, tagsIdAll = null, fields = null } = {}) {
      maybeFail('listDocuments');
      record('GET', '/documents/', { page, pageSize, query, modified__gte, tagsIdAll });
      let docs = [...state.documents].sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
      if (tagsIdAll != null) {
        const want = (Array.isArray(tagsIdAll) ? tagsIdAll : String(tagsIdAll).split(',')).map(Number);
        docs = docs.filter((d) => want.every((t) => d.tags.includes(t)));
      }
      if (modified__gte) docs = docs.filter((d) => new Date(d.modified) >= new Date(modified__gte));
      if (query) {
        const q = String(query).toLowerCase();
        docs = docs.filter((d) => `${d.title}\n${d.content}`.toLowerCase().includes(q));
      }
      const data = paginate(docs, page, pageSize);
      if (fields) data.results = data.results.map((d) => pickFields(d, fields));
      return data;
    },
    async getDocument(id, { fields } = {}) {
      if (!id) throw new Error('getDocument requires id');
      record('GET', `/documents/${id}/`);
      return pickFields(clone(findDoc(id)), fields);
    },
    async getDocumentFile(id) {
      if (!id) throw new Error('getDocumentFile requires id');
      record('GET', `/documents/${id}/preview/`);
      maybeFail('getDocumentFile');
      const doc = findDoc(id);
      const buf = buildFixturePdf(`${doc.title}\n\n${doc.content || ''}`);
      return { stream: Readable.from(buf), contentType: 'application/pdf', contentLength: buf.length };
    },
    async getCorrespondent(id) {
      if (!id) return null;
      const c = state.correspondents.find((x) => x.id === Number(id));
      if (!c) throw notFound(`/correspondents/${id}/`);
      return clone(c);
    },
    async listCorrespondents({ page = 1, pageSize = 100 } = {}) {
      return paginate([...state.correspondents].sort((a, b) => a.name.localeCompare(b.name)), page, pageSize);
    },
    async createCorrespondent({ name, matchingAlgorithm = 6 } = {}) {
      if (!name) throw new Error('createCorrespondent requires name');
      record('POST', '/correspondents/', { name });
      const c = { id: nextId(state.correspondents), name, matching_algorithm: matchingAlgorithm };
      state.correspondents.push(c);
      return clone(c);
    },
    async getDocumentType(id) {
      if (!id) return null;
      const t = state.documentTypes.find((x) => x.id === Number(id));
      if (!t) throw notFound(`/document_types/${id}/`);
      return clone(t);
    },
    async listDocumentTypes() {
      return clone([...state.documentTypes].sort((a, b) => a.name.localeCompare(b.name)));
    },
    async updateDocumentType(documentId, documentTypeId) {
      if (!documentId) throw new Error('updateDocumentType requires documentId');
      const doc = findDoc(documentId);
      const id = documentTypeId == null ? null : Number(documentTypeId);
      if (id != null && !state.documentTypes.some((t) => t.id === id)) throw notFound(`/document_types/${id}/`);
      record('PATCH', `/documents/${documentId}/`, { document_type: id });
      doc.document_type = id;
      touch(doc);
      return clone(doc);
    },
    async getTag(id) {
      if (!id) return null;
      const t = state.tags.find((x) => x.id === Number(id));
      if (!t) throw notFound(`/tags/${id}/`);
      return clone(t);
    },
    async listTags({ page = 1, pageSize = 100 } = {}) {
      return paginate([...state.tags].sort((a, b) => a.name.localeCompare(b.name)), page, pageSize);
    },
    async createTag({ name } = {}) {
      if (!name) throw new Error('createTag requires name');
      record('POST', '/tags/', { name });
      const t = { id: nextId(state.tags), name, parent: null };
      state.tags.push(t);
      return clone(t);
    },
    async listCustomFields({ page = 1, pageSize = 100 } = {}) {
      return paginate([...state.customFields].sort((a, b) => a.name.localeCompare(b.name)), page, pageSize);
    },
    async createCustomField({ name, data_type = 'string' } = {}) {
      if (!name) throw new Error('createCustomField requires name');
      record('POST', '/custom_fields/', { name, data_type });
      const f = { id: nextId(state.customFields), name, data_type };
      state.customFields.push(f);
      return clone(f);
    },
    async updateDocumentCustomFields(documentId, nameValuePairs) {
      if (!documentId) throw new Error('updateDocumentCustomFields requires documentId');
      // Read current fields first, as the real client does
      const current = await this.getDocument(documentId, { fields: 'id,custom_fields' });
      const doc = findDoc(documentId);
      record('PATCH', `/documents/${documentId}/`, { custom_fields: nameValuePairs });
      const existing = new Map(current.custom_fields.map((e) => [e.field, e.value]));
      return applyCustomFields(doc, existing, nameValuePairs);
    },
    async setDocumentCustomFields(documentIds, nameValuePairs) {
      const ids = (Array.isArray(documentIds) ? documentIds : [documentIds]).map(Number).filter(Number.isFinite);
      if (ids.length === 0) throw new Error('setDocumentCustomFields requires documentIds');
      maybeFail('setDocumentCustomFields');
      const idByName = new Map(state.customFields.map((f) => [f.name.trim().toLowerCase(), f.id]));
      const add = {};
      for (const [name, value] of Object.entries(nameValuePairs || {})) {
        if (value == null) continue;
        const key = String(name).trim().toLowerCase();
        let fid = idByName.get(key);
        if (fid == null) {
          fid = nextId(state.customFields);
          state.customFields.push({ id: fid, name, data_type: 'string' });
        }
        add[fid] = String(value);
      }
      if (Object.keys(add).length === 0) return null;
      record('POST', '/documents/bulk_edit/', {
        documents: ids,
        method: 'modify_custom_fields',
        parameters: { add_custom_fields: add, remove_custom_fields: [] },
      });
      // update_or_create per field; every other field is left alone
      for (const doc of state.documents.filter((d) => ids.includes(d.id))) {
        for (const [fid, value] of Object.entries(add)) {
          const entry = doc.custom_fields.find((e) => e.field === Number(fid));
          if (entry) entry.value = value;
          else doc.custom_fields.push({ field: Number(fid), value });
        }
        touch(doc);
      }
      return { result: 'OK' };
    },
    async removeDocumentCustomFields(documentIds, names) {
      const ids = (Array.isArray(documentIds) ? documentIds : [documentIds]).map(Number).filter(Number.isFinite);
      if (ids.length === 0) throw new Error('removeDocumentCustomFields requires documentIds');
      maybeFail('removeDocumentCustomFields');
      const idByName = new Map(state.customFields.map((f) => [f.name.trim().toLowerCase(), f.id]));
      const removeIds = [...new Set((names || [])
        .map((n) => idByName.get(String(n).trim().toLowerCase()))
        .filter((fid) => fid != null))];
      if (removeIds.length === 0) return null;
      record('POST', '/documents/bulk_edit/', {
        documents: ids,
        method: 'modify_custom_fields',
        parameters: { add_custom_fields: [], remove_custom_fields: removeIds },
      });
      for (const doc of state.documents.filter((d) => ids.includes(d.id))) {
        doc.custom_fields = doc.custom_fields.filter((e) => !removeIds.includes(e.field));
        touch(doc);
      }
      return { result: 'OK' };
    },
    async updateDocumentTags(documentId, tagIds) {
      if (!documentId) throw new Error('updateDocumentTags requires documentId');
      const doc = findDoc(documentId);
      const ids = (tagIds || []).map(Number).filter(Number.isFinite);
      record('PATCH', `/documents/${documentId}/`, { tags: ids });
      doc.tags = ids;
      touch(doc);
      return clone(doc);
    },
    async modifyDocumentTags(documentIds, { add = [], remove = [] } = {}) {
      const ids = (Array.isArray(documentIds) ? documentIds : [documentIds]).map(Number).filter(Number.isFinite);
      if (ids.length === 0) throw new Error('modifyDocumentTags requires documentIds');
      const body = { documents: ids, method: 'modify_tags', parameters: { add_tags: add, remove_tags: remove } };
      record('POST', '/documents/bulk_edit/', body);
      // Paperless adds with ancestors and removes with descendants
      const addSet = new Set(add.map(Number).flatMap((t) => [t, ...tagAncestors(t)]));
      const removeSet = new Set(remove.map(Number).flatMap((t) => [t, ...tagDescendants(t)]));
      for (const doc of state.documents.filter((d) => ids.includes(d.id))) {
        const tags = doc.tags.filter((t) => !removeSet.has(t));
        for (const t of addSet) if (!tags.includes(t)) tags.push(t);
        doc.tags = tags;
        touch(doc);
      }
      return { result: 'OK' };
    },
  };
}

export default { isMockPaperless, makeMockClient, resetMockPaperless, mockPaperlessState };
