// services/paperless/paperlessClient.js
import axios from 'axios';
import tunnel from 'tunnel-ssh';
import logger from '../../../services/loggerService.js';
import paperlessApiLog from '../../../services/paperlessApiLogService.js';
import fs from 'fs';
import { isMockPaperless, makeMockClient } from './mock/paperlessMockClient.js';

let sshServer = null;
let localPort = null;

// Module-level cache for custom field definitions (id-by-name map).
// Shared across all makeClient() calls to avoid re-paginating on every document
// during bulk operations like repairDrift. Expires after PAPERLESS_CF_CACHE_MS (default 5 min).
const CF_CACHE_TTL_MS = parseInt(process.env.PAPERLESS_CF_CACHE_MS, 10) || 5 * 60 * 1000;
let _cfCacheMap = null;   // Map<string, number> lowercased-name -> fieldId
let _cfCacheAt  = 0;      // epoch ms when cache was last populated

function _isCfCacheValid() {
  return _cfCacheMap !== null && (Date.now() - _cfCacheAt) < CF_CACHE_TTL_MS;
}
function _invalidateCfCache() {
  _cfCacheMap = null;
  _cfCacheAt  = 0;
}

/**
 * The Paperless API address the client uses. Accepts a hostname/IP (with
 * optional port) or a full http(s) URL, with or without a trailing /api.
 * Exported so the connection test proves the same address the app uses.
 * @returns {string|null}
 */
export function buildPaperlessBaseURL(env = process.env) {
  const raw = (env.PAPERLESS_BASE_URL || "").trim();
  if (!raw) return null;
  let url = raw;
  if (!/^https?:\/\//i.test(url)) {
    // Treat as host or host:port; compose with scheme and optional env port
    const noPort = String(env.NO_PORT || "").toLowerCase() === "true";
    const scheme = (
      env.PAPERLESS_SCHEME ||
      env.PAPERLESS_PROTOCOL ||
      (noPort ? "https" : "http")
    ).toString();
    const hasExplicitPort = /:[0-9]+$/.test(url);
    const port = (env.PAPERLESS_PORT || "8000").toString();
    url = `${scheme}://${url}${noPort || hasExplicitPort ? "" : `:${port}`}`;
  }
  // If NO_PORT is true, strip any explicit port from the URL (use standard 80/443 via reverse proxy)
  const noPort = String(env.NO_PORT || "").toLowerCase() === "true";
  if (noPort) {
    try {
      const u = new URL(url);
      u.port = "";
      url = u.origin + u.pathname + u.search + u.hash;
    } catch (_) {
      /* ignore parse issues; keep url as-is */
    }
  }
  // Ensure trailing /api
  if (!/\/api(\/|$)/i.test(url)) url = url.replace(/\/+$/, "") + "/api";
  return url;
}

function makeClient() {
  // PAPERLESS_URL=mock swaps in the in-memory fake (development and tests only)
  if (isMockPaperless()) return makeMockClient();

  const useSsh = process.env.PAPERLESS_SSH_TUNNEL_ENABLED === "true";
  let baseURL = buildPaperlessBaseURL();
  const token = process.env.PAPERLESS_TOKEN;
  const accept = process.env.PAPERLESS_ACCEPT || "application/json; version=6";
  const verbose = process.env.PAPERLESS_VERBOSE === "true" || process.env.DEBUG;

  if (!token) {
    throw new Error("PAPERLESS_TOKEN is required");
  }
  // If not using SSH tunnel, a baseURL must be provided
  if (!useSsh) {
    if (!baseURL)
      throw new Error(
        "PAPERLESS_BASE_URL is required when PAPERLESS_SSH_TUNNEL_ENABLED is not true",
      );
  }

  const ensureTunnel = async () => {
    if (!useSsh) return null;
    if (sshServer && localPort) return localPort;
    const getPort = (await import("get-port")).default;
    // pick a port in a high range to avoid mongo's 27000 range we already use
    localPort = await getPort({
      port: Array.from({ length: 500 }, (_, i) => 38000 + i),
    });

    const sshConfig = {
      username: process.env.PAPERLESS_SSH_USER || process.env.SSH_USER,
      host: process.env.PAPERLESS_SSH_HOST || process.env.SSH_HOST,
      port: parseInt(
        process.env.PAPERLESS_SSH_PORT || process.env.SSH_PORT || "22",
        10,
      ),
      dstHost: process.env.PAPERLESS_REMOTE_HOST || "127.0.0.1",
      dstPort: parseInt(process.env.PAPERLESS_REMOTE_PORT || "8000", 10),
      localHost: "127.0.0.1",
      localPort,
      keepAlive: true,
    };

    const keyPath =
      process.env.PAPERLESS_SSH_KEY_PATH?.trim() ||
      process.env.SSH_KEY_PATH?.trim();
    const pass =
      process.env.PAPERLESS_SSH_PASS?.trim() || process.env.SSH_PASS?.trim();
    if (keyPath) {
      try {
        sshConfig.privateKey = fs.readFileSync(keyPath);
      } catch (err) {
        throw new Error(`Failed to read SSH key at ${keyPath}: ${err.message}`);
      }
    } else if (pass) {
      sshConfig.password = pass;
    } else {
      throw new Error(
        "No SSH auth for Paperless. Set PAPERLESS_SSH_KEY_PATH or PAPERLESS_SSH_PASS (or reuse SSH_KEY_PATH/SSH_PASS)",
      );
    }

    await new Promise((resolve, reject) => {
      tunnel(sshConfig, (err, server) => {
        if (err) return reject(err);
        sshServer = server;
        // Swallow expected client socket resets so the app doesn't crash on network blips
        server.on("error", (e) => {
          const code = e?.code || e?.errno;
          const level = e?.level;
          if (
            code === "ECONNRESET" ||
            code === "EPIPE" ||
            level === "client-socket"
          ) {
            if (verbose)
              logger.warn(
                "[paperlessClient] tunnel socket error ignored: %s",
                code || level,
              );
            return;
          }
          logger.error("[paperlessClient] tunnel server error: %s", e?.message || e);
        });
        server.on("close", () => {
          logger.warn("[paperlessClient] SSH tunnel closed — will reconnect on next request.");
          sshServer = null;
          localPort = null;
        });
        if (verbose)
          logger.info(
            `[paperlessClient] 🔐 SSH tunnel established on ${sshConfig.localHost}:${localPort} → ${sshConfig.dstHost}:${sshConfig.dstPort}`,
          );
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
    } // else: baseURL already validated/normalized above
    const timeoutMs = parseInt(process.env.PAPERLESS_TIMEOUT_MS, 10) || 60000;
    const api = axios.create({
      baseURL,
      timeout: timeoutMs,
      headers: { Authorization: `Token ${token}`, Accept: accept },
    });
    if (verbose) {
      logger.info(
        `[paperlessClient] baseURL=${baseURL} accept="${accept}"${useSsh ? " (via SSH tunnel)" : ""}`,
      );
    }

    // ── Request logging ──────────────────────────────────────────────────────
    api.interceptors.request.use((config) => {
      config.metadata = { startTime: Date.now() };
      // Authorization header is never stored
      const { Authorization, authorization, ...safeHeaders } = config.headers || {};
      paperlessApiLog.logRequest({ method: config.method, url: config.url, data: config.data || null });
      logger.info(`[Paperless] --> ${(config.method || 'GET').toUpperCase()} ${config.url}`);
      return config;
    }, (err) => {
      logger.error(`[Paperless] Request setup error: ${err.message}`);
      return Promise.reject(err);
    });

    // ── Response logging (success) ────────────────────────────────────────────
    api.interceptors.response.use((resp) => {
      const durationMs = resp.config?.metadata ? Date.now() - resp.config.metadata.startTime : undefined;
      paperlessApiLog.logResponse({
        method: resp.config?.method,
        url: resp.config?.url,
        status: resp.status,
        data: resp.data,
        durationMs,
      });
      logger.info(`[Paperless] <-- ${resp.status} ${(resp.config?.method || '').toUpperCase()} ${resp.config?.url}${durationMs !== undefined ? ` (${durationMs}ms)` : ''}`);
      return resp;
    }, async (error) => {
      const cfg = error?.config || {};
      const status = error?.response?.status;
      const durationMs = cfg.metadata ? Date.now() - cfg.metadata.startTime : undefined;
      paperlessApiLog.logError({ method: cfg.method, url: cfg.url, status, message: error.message, durationMs });
      logger.error(`[Paperless] <-- ${status || 'ERR'} ${(cfg.method || '').toUpperCase()} ${cfg.url || ''}: ${error.message}`);

      const dataSnippet = (() => {
        try {
          const d = error?.response?.data;
          if (!d) return "";
          if (typeof d === "string") return ` body="${d.slice(0, 200)}"`;
          return ` body=${JSON.stringify(d).slice(0, 200)}`;
        } catch {
          return "";
        }
      })();
      if (
        (process.env.PAPERLESS_VERBOSE === "true" || process.env.DEBUG) &&
        status
      ) {
        logger.warn(
          `[paperlessClient] HTTP ${status} on ${error?.config?.method?.toUpperCase?.() || ""} ${error?.config?.url || ""}${dataSnippet}`,
        );
      }
      // A versioned Accept header that the server will not serve is reported two
      // different ways: some installs answer 400, and DRF's AcceptHeaderVersioning
      // answers **406 Not Acceptable** ({"detail":"Invalid version in \"Accept\"
      // header."}) once the requested version leaves ALLOWED_VERSIONS. Paperless-ngx
      // 3.0.5 retired API versions 1-8, which turned this client's default
      // `version=6` into a 406 on *every* call at once. Retry without the header so
      // the server falls back to its own default version, and say so at warn level:
      // the only symptom otherwise is that everything Paperless-shaped stops working.
      if (
        (status === 400 || status === 406) &&
        error?.config &&
        !error.config.__acceptFallbackTried
      ) {
        const retryCfg = {
          ...error.config,
          headers: { ...(error.config.headers || {}) },
        };
        const requestedAccept =
          retryCfg.headers.Accept || retryCfg.headers.accept || "";
        delete retryCfg.headers.Accept;
        delete retryCfg.headers.accept;
        retryCfg.__acceptFallbackTried = true;
        logger.warn(
          `[paperlessClient] HTTP ${status} with Accept "${requestedAccept}"; retrying without it for ${retryCfg.url || retryCfg.baseURL}. Set PAPERLESS_ACCEPT to a version this Paperless still serves.`,
        );
        try {
          return await axios(retryCfg);
        } catch (e) {
          throw e;
        }
      }
      // Retry on rate-limit (429) and transient server errors (502/503/504) with back-off
      if (
        (status === 429 || status === 502 || status === 503 || status === 504) &&
        error?.config
      ) {
        error.config.__retryCount = (error.config.__retryCount || 0) + 1;
        if (error.config.__retryCount <= 3) {
          const retryAfterMs =
            status === 429
              ? parseInt(error.response?.headers?.['retry-after'] || '5', 10) * 1000
              : error.config.__retryCount * 2000;
          const delay = Math.min(retryAfterMs, 30000);
          if (verbose)
            logger.warn(
              `[paperlessClient] HTTP ${status}; retry ${error.config.__retryCount}/3 after ${delay}ms`,
            );
          await new Promise((r) => setTimeout(r, delay));
          return axios(error.config);
        }
      }
      return Promise.reject(error);
    });

    return api;
  };

  return {
    async listDocuments({
      page = 1,
      pageSize = 50,
      query = null,
      modified__gte = null,
      // Filter by tag ID rather than a `tag:name` search string. Names drift —
      // there is already a `statements` tag holding supplier statements of
      // account, which is a different document that shares a word — and an id
      // cannot be renamed into matching the wrong thing.
      tagsIdAll = null,
      fields = null,
    } = {}) {
      const api = await createApi();
      const params = { page, page_size: pageSize, ordering: "-modified" };
      if (query) params.query = query;
      if (modified__gte) params.modified__gte = modified__gte;
      if (tagsIdAll != null) {
        params.tags__id__all = Array.isArray(tagsIdAll) ? tagsIdAll.join(",") : tagsIdAll;
      }
      if (fields) params.fields = Array.isArray(fields) ? fields.join(",") : fields;
      const { data } = await api.get("/documents/", { params });
      if (typeof data !== "object" || data === null) {
        throw new Error("Unexpected response from Paperless API (non-JSON)");
      }
      return data;
    },
    async getDocument(id, { fields } = {}) {
      const api = await createApi();
      if (!id) throw new Error("getDocument requires id");
      const params = {};
      if (fields) {
        params.fields = Array.isArray(fields) ? fields.join(",") : fields;
      }
      const { data } = await api.get(`/documents/${id}/`, { params });
      return data;
    },
    /**
     * Stream a document's PDF: /preview/ serves the archived (OCR'd) version
     * when there is one, otherwise the original (PAPERLESS-MIGRATION.md H5).
     * @returns {Promise<{stream: import('stream').Readable, contentType: string, contentLength: number|null}>}
     */
    async getDocumentFile(id) {
      if (!id) throw new Error("getDocumentFile requires id");
      const api = await createApi();
      const res = await api.get(`/documents/${id}/preview/`, {
        responseType: "stream",
        headers: { Accept: "application/pdf,*/*" },
      });
      const len = Number(res.headers?.["content-length"]);
      return {
        stream: res.data,
        contentType: String(res.headers?.["content-type"] || "application/pdf"),
        contentLength: Number.isFinite(len) ? len : null,
      };
    },
    async getCorrespondent(id) {
      if (!id) return null;
      const api = await createApi();
      return (await api.get(`/correspondents/${id}/`)).data;
    },
    async listCorrespondents({ page = 1, pageSize = 100, ordering = "name" } = {}) {
      const api = await createApi();
      const params = { page, page_size: pageSize, ordering };
      const { data } = await api.get("/correspondents/", { params });
      return data;
    },
    // matchingAlgorithm follows Paperless's MatchingModel constants:
    // 0=None, 1=Any, 2=All, 3=Literal, 4=Regex, 5=Fuzzy, 6=Auto. Defaults to
    // Auto so a synced supplier's correspondent starts learning from the
    // documents filed against it, rather than Paperless's own default (Any with
    // an empty match, which never auto-assigns).
    async createCorrespondent({ name, matchingAlgorithm = 6 } = {}) {
      if (!name) throw new Error("createCorrespondent requires name");
      const api = await createApi();
      const payload = { name };
      if (matchingAlgorithm != null) payload.matching_algorithm = matchingAlgorithm;
      const { data } = await api.post("/correspondents/", payload);
      return data;
    },
    async getDocumentType(id) {
      if (!id) return null;
      const api = await createApi();
      return (await api.get(`/document_types/${id}/`)).data;
    },
    /** Every document type, by name. */
    async listDocumentTypes() {
      const api = await createApi();
      const out = [];
      for (let page = 1; page <= 20; page++) {
        const { data } = await api.get('/document_types/', { params: { page, page_size: 100, ordering: 'name' } });
        out.push(...(data.results || []));
        if (!data.next) break;
      }
      return out;
    },
    /** Set a document's type. */
    async updateDocumentType(documentId, documentTypeId) {
      if (!documentId) throw new Error('updateDocumentType requires documentId');
      const api = await createApi();
      const { data } = await api.patch(`/documents/${documentId}/`, { document_type: documentTypeId == null ? null : Number(documentTypeId) });
      return data;
    },
    async getTag(id) {
      if (!id) return null;
      const api = await createApi();
      return (await api.get(`/tags/${id}/`)).data;
    },
    async listTags({ page = 1, pageSize = 100, ordering = "name" } = {}) {
      const api = await createApi();
      const params = { page, page_size: pageSize, ordering };
      const { data } = await api.get("/tags/", { params });
      return data;
    },
    async createTag({ name, slug = undefined, color = undefined } = {}) {
      if (!name) throw new Error("createTag requires name");
      const api = await createApi();
      const payload = { name };
      if (slug) payload.slug = slug;
      if (color) payload.color = color;
      const { data } = await api.post("/tags/", payload);
      return data;
    },
    async listCustomFields({
      page = 1,
      pageSize = 100,
      ordering = "name",
    } = {}) {
      const api = await createApi();
      const params = { page, page_size: pageSize, ordering };
      const { data } = await api.get("/custom_fields/", { params });
      return data;
    },
    async createCustomField({
      name,
      data_type = "string",
      slug = undefined,
    } = {}) {
      const api = await createApi();
      if (!name) throw new Error("createCustomField requires name");
      const payload = { name, data_type };
      if (slug) payload.slug = slug;
      const { data } = await api.post("/custom_fields/", payload);
      return data;
    },
    async updateDocumentCustomFields(documentId, nameValuePairs) {
      if (!documentId)
        throw new Error("updateDocumentCustomFields requires documentId");
      const api = await createApi();
      // Use ?fields= to limit response to custom_fields only (v2 API).
      // In v2, field entries return { field: <int id>, value: ... } — no expand needed.
      const doc = await this.getDocument(documentId, {
        fields: "id,custom_fields",
      });
      const existing = new Map(); // fieldId -> value
      const existingByName = new Map(); // lower(name) -> fieldId
      const rawCf = (doc && (doc.custom_fields || doc.customFields)) || [];
      for (const entry of rawCf) {
        const fid =
          typeof entry?.field === "object"
            ? entry.field?.id
            : typeof entry?.field === "number"
              ? entry.field
              : undefined;
        const fname =
          typeof entry?.field === "object" && entry.field?.name
            ? String(entry.field.name)
            : undefined;
        if (fid != null) existing.set(Number(fid), entry?.value);
        if (fid != null && fname)
          existingByName.set(fname.trim().toLowerCase(), Number(fid));
      }

      // Paginate through all custom field definitions (avoids silent truncation beyond 1000).
      // Results are cached at module level for CF_CACHE_TTL_MS to avoid repeated listings
      // during bulk operations (e.g. repairDrift processes N docs sequentially).
      let idByName;
      if (_isCfCacheValid()) {
        idByName = _cfCacheMap;
      } else {
        const defs = [];
        {
          let cfPage = 1;
          while (true) {
            const chunk = await this.listCustomFields({ page: cfPage, pageSize: 100, ordering: "name" });
            const results = Array.isArray(chunk?.results) ? chunk.results : [];
            defs.push(...results);
            if (!chunk?.next || results.length === 0) break;
            cfPage++;
          }
        }
        idByName = new Map();
        for (const d of defs) {
          if (d?.name && typeof d.id === "number")
            idByName.set(String(d.name).trim().toLowerCase(), Number(d.id));
        }
        _cfCacheMap = idByName;
        _cfCacheAt  = Date.now();
      }

      const resolveFieldId = async (name) => {
        const key = String(name).trim().toLowerCase();
        if (idByName.has(key)) return idByName.get(key);
        logger.warn(`[paperlessClient] Custom field "${name}" not found — creating it. Verify spelling to avoid duplicate fields.`);
        // Try to create the custom field (string type)
        try {
          const created = await this.createCustomField({
            name,
            data_type: "string",
          });
          if (created && typeof created.id === "number") {
            idByName.set(key, Number(created.id));
            // Keep the module-level cache consistent with the newly created field
            if (_cfCacheMap) _cfCacheMap.set(key, Number(created.id));
            return Number(created.id);
          }
        } catch (_) {
          // Ignore create failures; we'll skip setting this field
        }
        return null;
      };

      // Merge updates into existing map; null value removes the field (clears it)
      for (const [name, value] of Object.entries(nameValuePairs || {})) {
        const key = String(name).trim().toLowerCase();
        let fid = idByName.get(key) || existingByName.get(key) || null;
        if (fid == null && value != null) fid = await resolveFieldId(name);
        if (fid == null) continue;
        if (value == null) {
          existing.delete(Number(fid));
        } else {
          existing.set(Number(fid), String(value));
        }
      }

      // Build payload array
      const custom_fields = Array.from(existing.entries()).map(
        ([fid, val]) => ({ field: Number(fid), value: val }),
      );
      const payload = { custom_fields };
      const { data } = await api.patch(`/documents/${documentId}/`, payload);
      return data;
    },

    async updateDocumentTags(documentId, tagIds) {
      if (!documentId)
        throw new Error("updateDocumentTags requires documentId");
      const api = await createApi();
      const ids = (tagIds || [])
        .map((t) => Number(t))
        .filter((n) => Number.isFinite(n));
      const payload = { tags: ids };
      const { data } = await api.patch(`/documents/${documentId}/`, payload);
      return data;
    },
    /** lower(name) -> field id, from the module-level cache or a full listing. */
    async customFieldIdsByName() {
      if (_isCfCacheValid()) return _cfCacheMap;
      const defs = [];
      let cfPage = 1;
      while (true) {
        const chunk = await this.listCustomFields({ page: cfPage, pageSize: 100, ordering: "name" });
        const results = Array.isArray(chunk?.results) ? chunk.results : [];
        defs.push(...results);
        if (!chunk?.next || results.length === 0) break;
        cfPage++;
      }
      const idByName = new Map();
      for (const d of defs) {
        if (d?.name && typeof d.id === "number")
          idByName.set(String(d.name).trim().toLowerCase(), Number(d.id));
      }
      _cfCacheMap = idByName;
      _cfCacheAt = Date.now();
      return idByName;
    },
    /**
     * Remove named custom fields atomically via POST /documents/bulk_edit/
     * (modify_custom_fields), leaving every other field untouched. Names with
     * no field definition are skipped — Paperless rejects unknown ids.
     *
     * @param {number|number[]} documentIds
     * @param {string[]} names
     */
    async removeDocumentCustomFields(documentIds, names) {
      const ids = (Array.isArray(documentIds) ? documentIds : [documentIds])
        .map(Number)
        .filter(Number.isFinite);
      if (ids.length === 0) throw new Error("removeDocumentCustomFields requires documentIds");

      const idByName = await this.customFieldIdsByName();
      const removeIds = Array.from(new Set(
        (names || [])
          .map((n) => idByName.get(String(n).trim().toLowerCase()))
          .filter((fid) => fid != null),
      ));
      if (removeIds.length === 0) return null;

      const api = await createApi();
      const { data } = await api.post("/documents/bulk_edit/", {
        documents: ids,
        method: "modify_custom_fields",
        parameters: { add_custom_fields: [], remove_custom_fields: removeIds },
      });
      return data;
    },
    /**
     * Set named custom fields atomically via POST /documents/bulk_edit/
     * (modify_custom_fields). Paperless update_or_creates each named field and
     * leaves every other field on the document untouched — unlike PATCHing
     * custom_fields, which replaces the whole array. Missing field definitions
     * are created (string type), as updateDocumentCustomFields does.
     *
     * @param {number|number[]} documentIds
     * @param {object} nameValuePairs - { [fieldName]: value } (nulls are skipped)
     */
    async setDocumentCustomFields(documentIds, nameValuePairs) {
      const ids = (Array.isArray(documentIds) ? documentIds : [documentIds])
        .map(Number)
        .filter(Number.isFinite);
      if (ids.length === 0) throw new Error("setDocumentCustomFields requires documentIds");

      const idByName = await this.customFieldIdsByName();
      const addCustomFields = {};
      for (const [name, value] of Object.entries(nameValuePairs || {})) {
        if (value == null) continue;
        const key = String(name).trim().toLowerCase();
        let fid = idByName.get(key);
        if (fid == null) {
          logger.warn(`[paperlessClient] Custom field "${name}" not found — creating it.`);
          const created = await this.createCustomField({ name, data_type: "string" });
          if (!created || typeof created.id !== "number") continue;
          fid = Number(created.id);
          idByName.set(key, fid);
        }
        addCustomFields[fid] = String(value);
      }
      if (Object.keys(addCustomFields).length === 0) return null;

      const api = await createApi();
      const { data } = await api.post("/documents/bulk_edit/", {
        documents: ids,
        method: "modify_custom_fields",
        parameters: { add_custom_fields: addCustomFields, remove_custom_fields: [] },
      });
      return data;
    },
    /**
     * Add/remove tags atomically via POST /documents/bulk_edit/ (modify_tags).
     * Tags not named are left untouched.
     */
    /**
     * Run documents through Paperless's consumer again (OCR included) via
     * POST /documents/bulk_edit/ (reprocess). For PDFs with no text layer.
     */
    async reprocessDocuments(documentIds) {
      const ids = (Array.isArray(documentIds) ? documentIds : [documentIds])
        .map(Number)
        .filter(Number.isFinite);
      if (ids.length === 0) throw new Error("reprocessDocuments requires documentIds");
      const api = await createApi();
      const { data } = await api.post("/documents/bulk_edit/", {
        documents: ids,
        method: "reprocess",
        parameters: {},
      });
      return data;
    },
    async modifyDocumentTags(documentIds, { add = [], remove = [] } = {}) {
      const ids = (Array.isArray(documentIds) ? documentIds : [documentIds])
        .map(Number)
        .filter(Number.isFinite);
      if (ids.length === 0) throw new Error("modifyDocumentTags requires documentIds");
      const api = await createApi();
      const { data } = await api.post("/documents/bulk_edit/", {
        documents: ids,
        method: "modify_tags",
        parameters: {
          add_tags: add.map(Number).filter(Number.isFinite),
          remove_tags: remove.map(Number).filter(Number.isFinite),
        },
      });
      return data;
    },
  };
}

// Pre-populate the module-level CF definitions cache. Call once before a bulk operation
// (e.g. repairDrift) so every document update hits the cache and never re-fetches /custom_fields/.
// When Paperless is unavailable, falls back to MongoDB's stored customFields to reconstruct
// the fieldName→fieldId map from previously-ingested documents.
async function warmCfCache(OcrDocument = null) {
  if (_isCfCacheValid()) return; // already warm

  // Primary: fetch definitions from Paperless
  try {
    const client = makeClient();
    const defs = [];
    let page = 1;
    while (true) {
      const chunk = await client.listCustomFields({ page, pageSize: 100, ordering: 'name' });
      const results = Array.isArray(chunk?.results) ? chunk.results : [];
      defs.push(...results);
      if (!chunk?.next || results.length === 0) break;
      page++;
    }
    const map = new Map();
    for (const d of defs) {
      if (d?.name && typeof d.id === 'number')
        map.set(String(d.name).trim().toLowerCase(), Number(d.id));
    }
    _cfCacheMap = map;
    _cfCacheAt  = Date.now();
    logger.info(`[paperlessClient] CF cache warmed from Paperless: ${map.size} field definitions`);
    return;
  } catch (paperlessErr) {
    logger.warn(`[paperlessClient] CF Paperless fetch failed (${paperlessErr.message}) — trying MongoDB fallback`);
  }

  // Fallback: reconstruct from MongoDB's stored customFields arrays.
  // OcrDocument stores { fieldId, fieldName, value } so we can recover the name→id mapping.
  if (!OcrDocument) {
    throw new Error('Paperless /custom_fields/ unavailable and no OcrDocument model provided for fallback');
  }
  const docs = await OcrDocument
    .find({ 'customFields.0': { $exists: true } })
    .select('customFields')
    .limit(100)
    .lean();
  const map = new Map();
  for (const doc of docs) {
    for (const cf of (doc.customFields || [])) {
      if (typeof cf.fieldId === 'number' && cf.fieldName) {
        map.set(String(cf.fieldName).trim().toLowerCase(), cf.fieldId);
      }
    }
  }
  if (map.size === 0) {
    throw new Error('Paperless /custom_fields/ unavailable and no fieldId/fieldName pairs found in MongoDB');
  }
  _cfCacheMap = map;
  _cfCacheAt  = Date.now();
  logger.info(`[paperlessClient] CF cache warmed from MongoDB fallback: ${map.size} field definitions`);
}

export default { makeClient, buildPaperlessBaseURL, invalidateCfCache: _invalidateCfCache, warmCfCache };
