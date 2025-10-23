// services/paperless/paperlessClient.js
const axios = require('axios');
const tunnel = require('tunnel-ssh');

let sshServer = null;
let localPort = null;

function makeClient() {
  let baseURL = process.env.PAPERLESS_BASE_URL; // e.g. http://host:8000/api
  const token = process.env.PAPERLESS_TOKEN;
  const accept = process.env.PAPERLESS_ACCEPT || 'application/json; version=6';
  const verbose = process.env.PAPERLESS_VERBOSE === 'true' || process.env.DEBUG;

  if (!baseURL || !token) {
    throw new Error('PAPERLESS_BASE_URL and PAPERLESS_TOKEN are required');
  }

  // Ensure baseURL includes /api to hit the Paperless REST endpoints
  if (!/\/api(\/|$)/.test(baseURL)) {
    baseURL = baseURL.replace(/\/+$/, '') + '/api';
  }

  const useSsh = process.env.PAPERLESS_SSH_TUNNEL_ENABLED === 'true';

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
    async listCustomFields({ page = 1, pageSize = 100, ordering = 'name' } = {}) {
      const api = await createApi();
      const params = { page, page_size: pageSize, ordering };
      const { data } = await api.get('/custom_fields/', { params });
      return data;
    },
  };
}

module.exports = { makeClient };
