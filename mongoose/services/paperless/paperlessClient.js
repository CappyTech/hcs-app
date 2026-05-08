// services/paperless/paperlessClient.js
const axios = require("axios");
const tunnel = require("tunnel-ssh");
const logger = require("../../../services/loggerService");

let sshServer = null;
let localPort = null;

function makeClient() {
  const useSsh = process.env.PAPERLESS_SSH_TUNNEL_ENABLED === "true";
  // Build a robust baseURL that accepts either a hostname/IP (with optional port)
  // OR a full http(s) URL (with or without trailing /api)
  const buildBaseURL = () => {
    const raw = (process.env.PAPERLESS_BASE_URL || "").trim();
    if (!raw) return null;
    let url = raw;
    if (!/^https?:\/\//i.test(url)) {
      // Treat as host or host:port; compose with scheme and optional env port
      const noPort = String(process.env.NO_PORT || "").toLowerCase() === "true";
      const scheme = (
        process.env.PAPERLESS_SCHEME ||
        process.env.PAPERLESS_PROTOCOL ||
        (noPort ? "https" : "http")
      ).toString();
      const hasExplicitPort = /:[0-9]+$/.test(url);
      const port = (process.env.PAPERLESS_PORT || "8000").toString();
      url = `${scheme}://${url}${noPort || hasExplicitPort ? "" : `:${port}`}`;
    }
    // If NO_PORT is true, strip any explicit port from the URL (use standard 80/443 via reverse proxy)
    const noPort = String(process.env.NO_PORT || "").toLowerCase() === "true";
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
  };
  let baseURL = buildBaseURL();
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
      const fs = require("fs");
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
    // Attach response interceptor to provide better diagnostics for 400-series errors
    api.interceptors.response.use(
      (resp) => resp,
      async (error) => {
        const status = error?.response?.status;
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
        if (
          status === 400 &&
          error?.config &&
          !error.config.__acceptFallbackTried
        ) {
          // Some Paperless installs reject versioned Accept header; retry once without version
          const cfg = {
            ...error.config,
            headers: { ...(error.config.headers || {}) },
          };
          delete cfg.headers.Accept;
          cfg.__acceptFallbackTried = true;
          if (process.env.PAPERLESS_VERBOSE === "true" || process.env.DEBUG) {
            logger.warn(
              "[paperlessClient] 400 received; retrying without Accept header for %s",
              cfg.url || cfg.baseURL,
            );
          }
          try {
            return await axios(cfg);
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
      },
    );

    return api;
  };

  return {
    async listDocuments({
      page = 1,
      pageSize = 50,
      query = null,
      modified__gte = null,
    } = {}) {
      const api = await createApi();
      const params = { page, page_size: pageSize, ordering: "-modified" };
      if (query) params.query = query;
      if (modified__gte) params.modified__gte = modified__gte;
      const { data } = await api.get("/documents/", { params });
      if (typeof data !== "object" || data === null) {
        throw new Error("Unexpected response from Paperless API (non-JSON)");
      }
      return data;
    },
    async getDocument(id, { expand } = {}) {
      const api = await createApi();
      if (!id) throw new Error("getDocument requires id");
      const params = {};
      if (expand) {
        // Accept string or array of expand tokens; join with comma
        params.expand = Array.isArray(expand) ? expand.join(",") : expand;
      }
      const { data } = await api.get(`/documents/${id}/`, { params });
      return data;
    },
    async getCorrespondent(id) {
      if (!id) return null;
      const api = await createApi();
      return (await api.get(`/correspondents/${id}/`)).data;
    },
    async getDocumentType(id) {
      if (!id) return null;
      const api = await createApi();
      return (await api.get(`/document_types/${id}/`)).data;
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
      // Build a map of existing custom fields on the document
      const doc = await this.getDocument(documentId, {
        expand: ["custom_fields", "custom_fields__field"],
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

      // Paginate through all custom field definitions (avoids silent truncation beyond 1000)
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
      const idByName = new Map();
      for (const d of defs) {
        if (d?.name && typeof d.id === "number")
          idByName.set(String(d.name).trim().toLowerCase(), Number(d.id));
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
  };
}

module.exports = { makeClient };
