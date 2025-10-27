// services/paperless/paperlessClient.js
const axios = require('axios');
const tunnel = require('tunnel-ssh');

let sshServer = null;
let localPort = null;

function makeClient() {
  const useSsh = process.env.PAPERLESS_SSH_TUNNEL_ENABLED === 'true';
  let baseURL = process.env.PAPERLESS_BASE_URL
    ? 'http://' + process.env.PAPERLESS_BASE_URL + ':' + (process.env.PAPERLESS_PORT || '8000')
    : null;
  const token = process.env.PAPERLESS_TOKEN;
  const accept = process.env.PAPERLESS_ACCEPT || 'application/json; version=6';
  const verbose = process.env.PAPERLESS_VERBOSE === 'true' || process.env.DEBUG;

  if (!token) {
    throw new Error('PAPERLESS_TOKEN is required');
  }
  // If not using SSH tunnel, a baseURL must be provided
  if (!useSsh) {
    if (!baseURL) throw new Error('PAPERLESS_BASE_URL is required when PAPERLESS_SSH_TUNNEL_ENABLED is not true');
    if (!/\/api(\/|$)/.test(baseURL)) {
      baseURL = baseURL.replace(/\/+$/, '') + '/api';
    }
  }

  const ensureTunnel = async () => {
    if (!useSsh) return null;
    if (sshServer && localPort) return localPort;
    const getPort = (await import('get-port')).default;
    // pick a port in a high range to avoid mongo's 27000 range we already use
    localPort = await getPort({ port: Array.from({ length: 500 }, (_, i) => 38000 + i) });

    const sshConfig = {
      username: process.env.PAPERLESS_SSH_USER || process.env.SSH_USER,
      host: process.env.PAPERLESS_SSH_HOST || process.env.SSH_HOST,
      port: parseInt(process.env.PAPERLESS_SSH_PORT || process.env.SSH_PORT || '22', 10),
      dstHost: process.env.PAPERLESS_REMOTE_HOST || '127.0.0.1',
      dstPort: parseInt(process.env.PAPERLESS_REMOTE_PORT || '8000', 10),
      localHost: '127.0.0.1',
      localPort,
      keepAlive: true,
    };

    const keyPath = process.env.PAPERLESS_SSH_KEY_PATH?.trim() || process.env.SSH_KEY_PATH?.trim();
    const pass = process.env.PAPERLESS_SSH_PASS?.trim() || process.env.SSH_PASS?.trim();
    if (keyPath) {
      const fs = require('fs');
      try { sshConfig.privateKey = fs.readFileSync(keyPath); } catch (err) { throw new Error(`Failed to read SSH key at ${keyPath}: ${err.message}`); }
    } else if (pass) {
      sshConfig.password = pass;
    } else {
      throw new Error('No SSH auth for Paperless. Set PAPERLESS_SSH_KEY_PATH or PAPERLESS_SSH_PASS (or reuse SSH_KEY_PATH/SSH_PASS)');
    }

    await new Promise((resolve, reject) => {
      tunnel(sshConfig, (err, server) => {
        if (err) return reject(err);
        sshServer = server;
        // Swallow expected client socket resets so the app doesn't crash on network blips
        server.on('error', (e) => {
          const code = e?.code || e?.errno;
          const level = e?.level;
          if (code === 'ECONNRESET' || code === 'EPIPE' || level === 'client-socket') {
            if (verbose) console.warn('[paperlessClient] tunnel socket error ignored:', code || level);
            return;
          }
          console.error('[paperlessClient] tunnel server error:', e);
        });
        if (verbose) console.log(`[paperlessClient] 🔐 SSH tunnel established on ${sshConfig.localHost}:${localPort} → ${sshConfig.dstHost}:${sshConfig.dstPort}`);
        resolve();
      });
    });
    return localPort;
  };

  // Wrap axios instance creation to allow async tunnel setup
  const createApi = async () => {
    if (useSsh) {
      const port = await ensureTunnel();
      baseURL = `http://127.0.0.1:${port}/api`;
    } else {
      // baseURL already validated/normalized above
    }
    const api = axios.create({
      baseURL,
      timeout: 20000,
      headers: { Authorization: `Token ${token}`, Accept: accept },
    });
    if (verbose) {
      // eslint-disable-next-line no-console
      console.log(`[paperlessClient] baseURL=${baseURL} accept="${accept}"${useSsh ? ' (via SSH tunnel)' : ''}`);
    }
    return api;
  };

  return {
    async listDocuments({ page = 1, pageSize = 50, query = null, modified__gte = null } = {}) {
      const api = await createApi();
      const params = { page, page_size: pageSize, ordering: '-modified' };
      if (query) params.query = query;
      if (modified__gte) params.modified__gte = modified__gte;
      const { data } = await api.get('/documents/', { params });
      if (typeof data !== 'object' || data === null) {
        throw new Error('Unexpected response from Paperless API (non-JSON)');
      }
      return data;
    },
    async getDocument(id, { expand } = {}) {
      const api = await createApi();
      if (!id) throw new Error('getDocument requires id');
      const params = {};
      if (expand) {
        // Accept string or array of expand tokens; join with comma
        params.expand = Array.isArray(expand) ? expand.join(',') : expand;
      }
      const { data } = await api.get(`/documents/${id}/`, { params });
      return data;
    },
    async getCorrespondent(id) { if (!id) return null; const api = await createApi(); return (await api.get(`/correspondents/${id}/`)).data; },
    async getDocumentType(id) { if (!id) return null; const api = await createApi(); return (await api.get(`/document_types/${id}/`)).data; },
    async getTag(id) { if (!id) return null; const api = await createApi(); return (await api.get(`/tags/${id}/`)).data; },
    async listTags({ page = 1, pageSize = 100, ordering = 'name' } = {}) {
      const api = await createApi();
      const params = { page, page_size: pageSize, ordering };
      const { data } = await api.get('/tags/', { params });
      return data;
    },
    async createTag({ name, slug = undefined, color = undefined } = {}) {
      if (!name) throw new Error('createTag requires name');
      const api = await createApi();
      const payload = { name };
      if (slug) payload.slug = slug;
      if (color) payload.color = color;
      const { data } = await api.post('/tags/', payload);
      return data;
    },
    async listCustomFields({ page = 1, pageSize = 100, ordering = 'name' } = {}) {
      const api = await createApi();
      const params = { page, page_size: pageSize, ordering };
      const { data } = await api.get('/custom_fields/', { params });
      return data;
    },
    async createCustomField({ name, data_type = 'string', slug = undefined } = {}) {
      const api = await createApi();
      if (!name) throw new Error('createCustomField requires name');
      const payload = { name, data_type };
      if (slug) payload.slug = slug;
      const { data } = await api.post('/custom_fields/', payload);
      return data;
    },
    async updateDocumentCustomFields(documentId, nameValuePairs) {
      if (!documentId) throw new Error('updateDocumentCustomFields requires documentId');
      const api = await createApi();
      // Build a map of existing custom fields on the document
      const doc = await this.getDocument(documentId, { expand: ['custom_fields', 'custom_fields__field'] });
      const existing = new Map(); // fieldId -> value
      const existingByName = new Map(); // lower(name) -> fieldId
      const rawCf = doc && (doc.custom_fields || doc.customFields) || [];
      for (const entry of rawCf) {
        const fid = typeof entry?.field === 'object' ? entry.field?.id : (typeof entry?.field === 'number' ? entry.field : undefined);
        const fname = (typeof entry?.field === 'object' && entry.field?.name) ? String(entry.field.name) : undefined;
        if (fid != null) existing.set(Number(fid), entry?.value);
        if (fid != null && fname) existingByName.set(fname.trim().toLowerCase(), Number(fid));
      }

      // Fetch all custom field definitions to resolve names to ids
      const allDefs = await this.listCustomFields({ page: 1, pageSize: 1000, ordering: 'name' });
      const defs = Array.isArray(allDefs?.results) ? allDefs.results : [];
      const idByName = new Map();
      for (const d of defs) {
        if (d?.name && typeof d.id === 'number') idByName.set(String(d.name).trim().toLowerCase(), Number(d.id));
      }

      // Resolve names to ids; create if missing
      const resolveFieldId = async (name) => {
        const key = String(name).trim().toLowerCase();
        if (idByName.has(key)) return idByName.get(key);
        // Try to create the custom field (string type)
        try {
          const created = await this.createCustomField({ name, data_type: 'string' });
          if (created && typeof created.id === 'number') {
            idByName.set(key, Number(created.id));
            return Number(created.id);
          }
        } catch (_) {
          // Ignore create failures; we'll skip setting this field
        }
        return null;
      };

      // Merge updates into existing map
      for (const [name, value] of Object.entries(nameValuePairs || {})) {
        if (value == null) continue;
        const key = String(name).trim().toLowerCase();
        let fid = idByName.get(key) || existingByName.get(key) || null;
        if (fid == null) fid = await resolveFieldId(name);
        if (fid != null) existing.set(Number(fid), String(value));
      }

      // Build payload array
      const custom_fields = Array.from(existing.entries()).map(([fid, val]) => ({ field: Number(fid), value: val }));
      const payload = { custom_fields };
      const { data } = await api.patch(`/documents/${documentId}/`, payload);
      return data;
    },
    async updateDocumentTags(documentId, tagIds) {
      if (!documentId) throw new Error('updateDocumentTags requires documentId');
      const api = await createApi();
      const ids = (tagIds || []).map((t) => Number(t)).filter((n) => Number.isFinite(n));
      const payload = { tags: ids };
      const { data } = await api.patch(`/documents/${documentId}/`, payload);
      return data;
    },
  };
}

module.exports = { makeClient };
