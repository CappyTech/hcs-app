"use strict";

/**
 * kashflowSessionService.js
 *
 * Manages authentication sessions with the KashFlow accounting API (v2).
 *
 * OVERVIEW
 * --------
 * KashFlow requires a session token ("KfToken") for every authenticated API
 * call.  This module obtains, caches, refreshes and invalidates that token
 * so that consumers never have to deal with auth plumbing directly.
 *
 * AUTHENTICATION STRATEGIES (checked in priority order)
 * 1. External token exchange  – KASHFLOW_EXTERNAL_TOKEN env var present.
 *    GET /sessiontoken?externalToken=…&uid=…  →  SessionToken
 * 2. Two-step username/password + memorable word – KASHFLOW_API_USERNAME,
 *    KASHFLOW_API_PASSWORD, KASHFLOW_MEMORABLE env vars present.
 *    POST /sessiontoken (credentials) → TemporaryToken + character positions
 *    PUT  /sessiontoken (temp token + characters) → SessionToken
 * 3. Pre-set session token – KASHFLOW_SESSION_TOKEN env var used as-is.
 *
 * CONSUMERS (as of Feb 2026)
 * - services/kashflowVatService.js       – VAT submission / retrieval
 * - mongoose/controllers/paperlessController.js – paperless document sync
 * Both call `withKfAuth(fn)` which is the main public interface.
 *
 * ENV VARS (see compose.env.example for full docs)
 * - KASHFLOW_API_BASE_URL        – API root (default https://api.kashflow.com/v2)
 * - KASHFLOW_API_USERNAME / KFUSERNAME
 * - KASHFLOW_API_PASSWORD / KFPASSWORD
 * - KASHFLOW_MEMORABLE    / KFMEMORABLE
 * - KASHFLOW_EXTERNAL_TOKEN
 * - KASHFLOW_EXTERNAL_UID / KFEXTERNALUID
 * - KASHFLOW_SESSION_TOKEN / KFSESSIONTOKEN
 * - KASHFLOW_DEBUG_SESSION=1     – logs redacted step-1 payloads on failure
 */

const axios = require("axios");
const logger = require("./loggerService");
const kfApiLog = require("./kashflowApiLogService");

// ── Shared axios instance for all KashFlow API calls ─────────────────────────
// Authorization headers are stripped before logging to avoid storing credentials.
const kfAxios = axios.create();

kfAxios.interceptors.request.use((config) => {
  config.metadata = { startTime: Date.now() };
  const { Authorization, authorization, ...safeHeaders } = config.headers || {};
  kfApiLog.logRequest({
    method: config.method,
    url: config.url,
    data: config.data || null,
  });
  logger.info(`[KashFlow] --> ${(config.method || 'GET').toUpperCase()} ${config.url}`);
  return config;
}, (err) => {
  logger.error(`[KashFlow] Request setup error: ${err.message}`);
  return Promise.reject(err);
});

kfAxios.interceptors.response.use((response) => {
  const durationMs = response.config?.metadata ? Date.now() - response.config.metadata.startTime : undefined;
  kfApiLog.logResponse({
    method: response.config?.method,
    url: response.config?.url,
    status: response.status,
    data: response.data,
    durationMs,
  });
  logger.info(`[KashFlow] <-- ${response.status} ${response.config?.method?.toUpperCase() || ''} ${response.config?.url}${durationMs !== undefined ? ` (${durationMs}ms)` : ''}`);
  return response;
}, (err) => {
  const resp = err.response;
  const cfg  = err.config || {};
  const durationMs = cfg.metadata ? Date.now() - cfg.metadata.startTime : undefined;
  const status = resp?.status;
  kfApiLog.logError({
    method: cfg.method,
    url: cfg.url,
    status,
    message: err.message,
    durationMs,
  });
  logger.error(`[KashFlow] <-- ${status || 'ERR'} ${(cfg.method || '').toUpperCase()} ${cfg.url || ''}: ${err.message}`);
  return Promise.reject(err);
});

// ---------------------------------------------------------------------------
// In-memory token cache (process-wide singleton – shared across all requests)
// ---------------------------------------------------------------------------
let _sessionToken = null; // The current KashFlow session token string
let _tokenAcquiredAt = 0; // Timestamp (ms) when token was last obtained
let _tokenTTLms = 0; // TTL from the API in ms; 0 = unknown (rely on 401 to refresh)

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns the KashFlow API base URL with any trailing slashes stripped. */
function baseUrl() {
  return (
    process.env.KASHFLOW_API_BASE_URL || "https://api.kashflow.com/v2"
  ).replace(/\/+$/, "");
}

/** Shorthand for Date.now(). */
function now() {
  return Date.now();
}

/**
 * Checks whether the cached token should be considered expired.
 * - If no token exists → expired.
 * - If the API provided a TTL → expire 30 s early to avoid mid-request expiry.
 * - If TTL is unknown (0) → assume valid; a 401 response will trigger refresh.
 */
function isExpired() {
  if (!_sessionToken) return true;
  if (_tokenTTLms > 0) {
    return now() - _tokenAcquiredAt > _tokenTTLms - 30_000; // refresh 30s early
  }
  return false; // unknown TTL -> treat as valid until 401
}

/**
 * Reads KashFlow credentials from environment variables.
 *
 * Supports two naming conventions (long-form and short aliases):
 *   KASHFLOW_API_USERNAME / KFUSERNAME
 *   KASHFLOW_API_PASSWORD / KFPASSWORD
 *   KASHFLOW_MEMORABLE    / KFMEMORABLE
 *
 * Edge case: if the long-form var's value literally equals the short alias
 * name (e.g. KASHFLOW_API_USERNAME="KFUSERNAME"), it resolves the alias
 * instead — this guards against copy-paste mistakes in .env files.
 *
 * @returns {{ user: string, pass: string, memorable: string, externalToken: string, externalUid: string }}
 */
function getCreds() {
  const aliasOrSelf = (val, aliasEnvName) => {
    const s = val == null ? "" : String(val).trim();
    if (!s) return process.env[aliasEnvName] || "";
    // If the value IS the alias name itself, treat it as an alias reference
    if (s.toUpperCase() === aliasEnvName.toUpperCase())
      return process.env[aliasEnvName] || "";
    return s;
  };
  const user =
    aliasOrSelf(process.env.KASHFLOW_API_USERNAME, "KFUSERNAME") ||
    process.env.KFUSERNAME ||
    "";
  const pass =
    aliasOrSelf(process.env.KASHFLOW_API_PASSWORD, "KFPASSWORD") ||
    process.env.KFPASSWORD ||
    "";
  const memorable =
    aliasOrSelf(process.env.KASHFLOW_MEMORABLE, "KFMEMORABLE") ||
    process.env.KFMEMORABLE ||
    "";
  const externalToken = process.env.KASHFLOW_EXTERNAL_TOKEN || "";
  const externalUid =
    process.env.KASHFLOW_EXTERNAL_UID || process.env.KFEXTERNALUID || "";
  return { user, pass, memorable, externalToken, externalUid };
}

/**
 * Extracts the 3 character-position indices from a step-1 API response.
 *
 * The KashFlow API has historically used many different response shapes for
 * the memorable-word challenge, so this function defensively tries every
 * known variant before giving up.  The search order is:
 *
 *   1. Top-level arrays:  CharacterPositions, Positions,
 *      RequiredCharacterPositions, RequiredCharacters
 *   2. Nested objects:    MemorableWord.Positions, Memorable.Positions, etc.
 *   3. Individual keys:   Position1 / Character1 / Char1 (1-3)
 *   4. CSV strings:       PositionsCSV, PositionsString  ("3,4,6")
 *   5. Deep recursive scan of the entire payload for any key whose name
 *      contains "position" or "character" with numeric values.
 *
 * @param {object} data  – the parsed JSON response from step-1
 * @returns {number[]|null}  array of 3 one-based position indices, or null
 */
function pickPositions(data) {
  if (!data || typeof data !== "object") return null;

  /** Returns `arr` (filtered to finite numbers, max 3) if it has ≥ 3 entries. */
  const tryArray = (arr) =>
    Array.isArray(arr) && arr.filter(Number.isFinite).length >= 3
      ? arr.filter(Number.isFinite).slice(0, 3)
      : null;

  // --- Strategy 1: direct top-level arrays ---
  let pos =
    tryArray(data.CharacterPositions) ||
    tryArray(data.Positions) ||
    tryArray(data.RequiredCharacterPositions) ||
    tryArray(data.RequiredCharacters) ||
    null;
  if (pos) return pos;

  // --- Strategy 2: nested objects (e.g., { MemorableWord: { Positions: [1,4,6] } }) ---
  const nestedKeys = ["MemorableWord", "Memorable", "Password", "Auth"];
  for (const k of nestedKeys) {
    const obj = data[k];
    if (obj && typeof obj === "object") {
      pos = tryArray(obj.Positions) || tryArray(obj.CharacterPositions) || null;
      if (pos) return pos;
    }
  }

  // --- Strategy 3: individual numbered keys (Position1, Character2, Char3…) ---
  const candidates = [];
  const rx = /^(?:Position|Character|Char)\s*([123])$/i;
  for (const [k, v] of Object.entries(data)) {
    const m = k.match(rx);
    if (m && Number.isFinite(+v)) candidates[Number(m[1]) - 1] = +v;
  }
  if (candidates.filter(Number.isFinite).length >= 3)
    return candidates.slice(0, 3);

  // --- Strategy 4: comma-separated string values ---
  const strKeys = ["PositionsCSV", "PositionsString"];
  for (const k of strKeys) {
    const s = data[k];
    if (typeof s === "string") {
      const arr = s
        .split(/\s*,\s*/)
        .map((n) => parseInt(n, 10))
        .filter(Number.isFinite);
      if (arr.length >= 3) return arr.slice(0, 3);
    }
  }

  // --- Strategy 5 (last resort): recursive deep scan ---
  const out = [];
  const scan = (obj) => {
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      obj.forEach(scan);
      return;
    }
    for (const [k, v] of Object.entries(obj)) {
      const kl = String(k).toLowerCase();
      if (
        Array.isArray(v) &&
        (kl.includes("position") ||
          kl.includes("character") ||
          kl.includes("char"))
      ) {
        v.filter(Number.isFinite).forEach((n) => out.push(Number(n)));
      } else if (
        Number.isFinite(v) &&
        (kl.includes("position") ||
          kl.includes("character") ||
          kl.includes("char"))
      ) {
        out.push(Number(v));
      } else if (typeof v === "object") {
        scan(v);
      }
    }
  };
  scan(data);
  const uniq = Array.from(new Set(out.filter(Number.isFinite)));
  if (uniq.length >= 3) return uniq.slice(0, 3);
  return null;
}

/**
 * Given the user's memorable word and the requested 1-based character
 * positions, returns the individual characters needed for step-2.
 *
 * Example: deriveChars('butterfly', [2, 5, 8]) → ['u', 'e', 'l']
 *
 * @param {string} memorable  – the full memorable word
 * @param {number[]} positions – 1-based indices requested by the API
 * @returns {string[]|null}   – array of single characters, or null on bad input
 */
function deriveChars(memorable, positions) {
  if (!memorable || !positions) return null;
  const s = String(memorable);
  const chars = positions.map((p) => {
    const idx = (Number(p) || 0) - 1; // convert 1-based → 0-based
    return idx >= 0 && idx < s.length ? s[idx] : "";
  });
  return chars;
}

// ---------------------------------------------------------------------------
// Authentication strategy 1: External token exchange
// ---------------------------------------------------------------------------

/**
 * Exchanges a pre-issued external token for a KashFlow session token.
 * Used when KASHFLOW_EXTERNAL_TOKEN is set (e.g. server-to-server trust).
 *
 * GET /v2/sessiontoken?externalToken=…&uid=…
 *
 * @param {string} externalToken – the external token value
 * @returns {Promise<string>} the session token
 */
async function getWithExternalToken(externalToken) {
  const url = `${baseUrl()}/sessiontoken`;
  try {
    const { externalUid } = getCreds();
    const params = externalUid
      ? { externalToken, uid: externalUid }
      : { externalToken };
    const resp = await axios.get(url, {
      params,
      headers: { Accept: "application/json" },
      timeout: 15000,
    });
    // Tolerate multiple response key names for the session token
    const token =
      resp?.data?.SessionToken ||
      resp?.data?.Token ||
      resp?.data?.sessionToken ||
      null;
    if (!token) throw new Error("No SessionToken in external-token response");
    _sessionToken = token;
    _tokenAcquiredAt = now();
    // Store TTL if the API provides one (seconds → ms)
    const ttlSec = resp?.data?.ExpiresInSeconds || resp?.data?.TTL || null;
    _tokenTTLms = Number.isFinite(ttlSec) ? ttlSec * 1000 : 0;
    logger.info("[kashflow] Obtained session token via external token");
    return _sessionToken;
  } catch (err) {
    logger.error(`[kashflow] External token exchange failed: ${err.message}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Authentication strategy 2: Two-step login (username/password + memorable)
// ---------------------------------------------------------------------------

/**
 * Performs the full two-step KashFlow authentication flow:
 *
 * STEP 1 – POST /sessiontoken with username + password.
 *   The API responds with a TemporaryToken and a list of 3 character
 *   positions from the user's memorable word that must be provided.
 *   (If the API returns a SessionToken directly, step 2 is skipped.)
 *
 *   Three request formats are tried in order because the API has accepted
 *   different key casings and content types across versions:
 *     Attempt 1: JSON   { UserName, Password }           (documented)
 *     Attempt 2: JSON   { username, password }            (camelCase)
 *     Attempt 3: form   username=…&password=…             (URL-encoded)
 *
 * STEP 2 – PUT /sessiontoken with the TemporaryToken and the 3 characters.
 *   Two body formats are tried:
 *     - Documented: { TemporaryToken, MemorableWordList: [{ Position, Value }] }
 *     - Legacy:     { TemporaryToken, Positions, Characters, Character1/2/3 }
 *
 * @param {string} user      – KashFlow username
 * @param {string} pass      – KashFlow password
 * @param {string} memorable – the user's memorable word (full string)
 * @returns {Promise<string>} the session token
 */
async function twoStepLogin(user, pass, memorable) {
  const url = `${baseUrl()}/sessiontoken`;

  // === STEP 1: POST username + password ===
  let step1;
  try {
    // Attempt 1: JSON with documented PascalCase keys
    const resp = await axios.post(
      url,
      { UserName: user, Password: pass },
      {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        timeout: 15000,
      },
    );
    step1 = resp?.data || {};
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    const invalid =
      status === 400 &&
      (data?.Error === "InvalidCredentials" ||
        /invalid username|password/i.test(data?.Message || ""));
    if (!invalid) {
      logger.error(
        `[kashflow] Step1 (username/password) failed: ${err.message}`,
      );
      throw err;
    }
    // Attempt 2: JSON with camelCase keys — some API versions require this
    try {
      const resp2 = await axios.post(
        url,
        { username: user, password: pass },
        {
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          timeout: 15000,
        },
      );
      step1 = resp2?.data || {};
    } catch (err2) {
      const status2 = err2?.response?.status;
      const data2 = err2?.response?.data;
      const invalid2 =
        status2 === 400 &&
        (data2?.Error === "InvalidCredentials" ||
          /invalid username|password/i.test(data2?.Message || ""));
      if (!invalid2) {
        logger.error(
          `[kashflow] Step1 retry (camelCase) failed: ${err2.message}`,
        );
        throw err2;
      }
      // Attempt 3: URL-encoded form — oldest API fallback
      try {
        const params = new URLSearchParams({ username: user, password: pass });
        const resp3 = await axios.post(url, params.toString(), {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          timeout: 15000,
        });
        step1 = resp3?.data || {};
      } catch (err3) {
        logger.error(
          `[kashflow] Step1 retry (form-encoded) failed: ${err3.message}`,
        );
        throw err3;
      }
    }
  }
  // Some deployments return a SessionToken directly in step 1 (no memorable challenge)
  const directToken =
    step1?.SessionToken || step1?.Token || step1?.sessionToken;
  if (directToken) {
    _sessionToken = directToken;
    _tokenAcquiredAt = now();
    const ttl1 = step1?.ExpiresInSeconds || step1?.TTL;
    _tokenTTLms = Number.isFinite(ttl1) ? ttl1 * 1000 : 0;
    logger.info(
      "[kashflow] Step1 returned a SessionToken; skipping memorable-word step",
    );
    return _sessionToken;
  }

  // --- Parse character positions from the step-1 response ---
  // Prefer exact order from MemorableWordList (documented modern format)
  let positions = null;
  if (Array.isArray(step1?.MemorableWordList)) {
    const list = step1.MemorableWordList.map((x) => Number(x?.Position)).filter(
      Number.isFinite,
    );
    if (list.length >= 3) positions = list.slice(0, 3);
  }
  // Fall back to the generic pickPositions() extractor for other formats
  if (!positions) positions = pickPositions(step1);
  if (!positions || positions.length < 3) {
    const keys = Object.keys(step1 || {})
      .slice(0, 20)
      .join(", ");
    if (process.env.KASHFLOW_DEBUG_SESSION === "1") {
      try {
        const redacted = JSON.stringify(step1, (k, v) =>
          /token/i.test(k) ? "[REDACTED]" : v,
        );
        logger.error(
          `[kashflow] Step1 payload (redacted): ${redacted.substring(0, 4000)}`,
        );
      } catch {}
    } else {
      logger.error(
        `[kashflow] Step1 payload missing character positions. Keys: ${keys}`,
      );
    }
    throw new Error("KashFlow step1 did not return character positions");
  }
  // Look up the requested characters from the memorable word
  const chars = deriveChars(memorable, positions);
  if (!chars || chars.length < 3 || chars.some((c) => !c)) {
    throw new Error("Memorable word characters missing for required positions");
  }

  // === STEP 2: PUT temporary token + memorable-word characters ===
  try {
    const tmpToken =
      step1.TemporaryToken || step1.TempToken || step1.Token || null;
    if (!tmpToken) throw new Error("Missing TemporaryToken from step1");
    // Documented format: MemorableWordList array of { Position, Value }
    const putBodyDoc = {
      TemporaryToken: tmpToken,
      MemorableWordList: positions.map((p, i) => ({
        Position: p,
        Value: String(chars[i] || "").toString(),
      })),
    };
    let resp;
    try {
      resp = await axios.put(url, putBodyDoc, {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        timeout: 15000,
      });
    } catch (errPutDoc) {
      // Legacy fallback: flat arrays + individual Character1/2/3 keys
      const putBodyLegacy = {
        TemporaryToken: tmpToken,
        Positions: positions,
        Characters: chars,
        Character1: chars[0],
        Character2: chars[1],
        Character3: chars[2],
      };
      resp = await axios.put(url, putBodyLegacy, {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        timeout: 15000,
      });
    }
    const data = resp?.data || {};
    const token = data.SessionToken || data.Token || data.sessionToken || null;
    if (!token) throw new Error("No SessionToken in step2 response");
    _sessionToken = token;
    _tokenAcquiredAt = now();
    const ttlSec = data.ExpiresInSeconds || data.TTL || null;
    _tokenTTLms = Number.isFinite(ttlSec) ? ttlSec * 1000 : 0;
    logger.info("[kashflow] Session token acquired via two-step login");
    return _sessionToken;
  } catch (err) {
    logger.error(
      `[kashflow] Step2 (temporary->session) failed: ${err.message}`,
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns a valid KashFlow session token, obtaining/refreshing one if needed.
 *
 * Resolution order:
 *   1. Return cached token if still valid.
 *   2. External token exchange   (KASHFLOW_EXTERNAL_TOKEN)
 *   3. Two-step login            (username + password + memorable)
 *   4. Pre-set token from env    (KASHFLOW_SESSION_TOKEN / KFSESSIONTOKEN)
 *   5. Throw – no credentials available.
 *
 * @returns {Promise<string>} a valid session token
 * @throws {Error} if no credentials are configured
 */
async function ensureSessionToken() {
  if (!isExpired()) return _sessionToken;
  const { user, pass, memorable, externalToken } = getCreds();
  if (externalToken) return getWithExternalToken(externalToken);
  if (user && pass && memorable) return twoStepLogin(user, pass, memorable);
  // Strategy 3: accept a pre-provided session token from env
  const preset =
    process.env.KASHFLOW_SESSION_TOKEN || process.env.KFSESSIONTOKEN || "";
  if (preset) {
    _sessionToken = preset;
    _tokenAcquiredAt = now();
    _tokenTTLms = 0;
    logger.warn("[kashflow] Using pre-configured session token from env");
    return _sessionToken;
  }
  throw new Error(
    "No KashFlow credentials or external token configured to obtain a session token",
  );
}

/**
 * Invalidates the current session token on the KashFlow server (DELETE) and
 * clears the local cache.  Errors are silently ignored — this is intentional
 * so that callers can always proceed to re-authenticate afterwards.
 */
async function invalidateSession() {
  if (!_sessionToken) return;
  const url = `${baseUrl()}/sessiontoken`;
  try {
    await axios.delete(url, {
      headers: { Authorization: `KfToken ${_sessionToken}` },
      timeout: 10000,
    });
  } catch (err) {
    // Silently ignore – we're tearing down the session anyway
  } finally {
    _sessionToken = null;
    _tokenAcquiredAt = 0;
    _tokenTTLms = 0;
  }
}

/**
 * Primary consumer-facing helper.  Executes `fn(token)` with a valid KashFlow
 * session token.  If the call fails with HTTP 401 or 403 (expired / revoked
 * token), the session is invalidated, a fresh token is obtained, and `fn` is
 * retried exactly once.
 *
 * Usage example (from kashflowVatService.js):
 *
 *   const data = await kfSession.withKfAuth(async (token) => {
 *     const resp = await axios.get(url, {
 *       headers: { Authorization: `KfToken ${token}` },
 *     });
 *     return resp.data;
 *   });
 *
 * @param {(token: string) => Promise<T>} fn – async function receiving the token
 * @returns {Promise<T>} the return value of `fn`
 */
async function withKfAuth(fn) {
  let token = await ensureSessionToken();
  try {
    return await fn(token);
  } catch (err) {
    const status = err?.response?.status;
    if (status === 401 || status === 403) {
      // Token expired or revoked – refresh and retry once
      await invalidateSession();
      token = await ensureSessionToken();
      return await fn(token);
    }
    throw err;
  }
}

module.exports = {
  ensureSessionToken,
  invalidateSession,
  withKfAuth,
  kfAxios,
};
