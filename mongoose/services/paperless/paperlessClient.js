// services/paperless/paperlessClient.js
const axios = require('axios');

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

  const api = axios.create({
    baseURL,
    timeout: 20000,
    headers: { Authorization: `Token ${token}`, Accept: accept },
  });

  if (verbose) {
    // eslint-disable-next-line no-console
    console.log(`[paperlessClient] baseURL=${baseURL} accept="${accept}"`);
  }

  return {
    async listDocuments({ page = 1, pageSize = 50, query = null, modified__gte = null } = {}) {
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
      if (!id) throw new Error('getDocument requires id');
      const params = {};
      if (expand) {
        // Accept string or array of expand tokens; join with comma
        params.expand = Array.isArray(expand) ? expand.join(',') : expand;
      }
      const { data } = await api.get(`/documents/${id}/`, { params });
      return data;
    },
    async getCorrespondent(id) { if (!id) return null; return (await api.get(`/correspondents/${id}/`)).data; },
    async getDocumentType(id) { if (!id) return null; return (await api.get(`/document_types/${id}/`)).data; },
    async getTag(id) { if (!id) return null; return (await api.get(`/tags/${id}/`)).data; },
    async listCustomFields({ page = 1, pageSize = 100, ordering = 'name' } = {}) {
      const params = { page, page_size: pageSize, ordering };
      const { data } = await api.get('/custom_fields/', { params });
      return data;
    },
  };
}

module.exports = { makeClient };
