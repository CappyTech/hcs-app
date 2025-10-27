'use strict';

const axios = require('axios');
const logger = require('./loggerService');

// Simple in-memory cache; process-wide
let _sessionToken = null;
let _tokenAcquiredAt = 0;
let _tokenTTLms = 0; // optional TTL if provided by API; else refresh on 401

function baseUrl() {
  return (process.env.KASHFLOW_API_BASE_URL || 'https://api.kashflow.com/v2').replace(/\/+$/, '');
}

function now() { return Date.now(); }
function isExpired() {
  if (!_sessionToken) return true;
  if (_tokenTTLms > 0) {
    return (now() - _tokenAcquiredAt) > (_tokenTTLms - 30_000); // refresh 30s early
  }
  return false; // unknown TTL -> treat as valid until 401
}

function getCreds() {
  // Resolve possible alias placeholders in .env like KASHFLOW_API_USERNAME=KFUSERNAME
  const aliasOrSelf = (val, aliasEnvName) => {
    const s = (val == null) ? '' : String(val).trim();
    if (!s) return process.env[aliasEnvName] || '';
    if (s.toUpperCase() === aliasEnvName.toUpperCase()) return process.env[aliasEnvName] || '';
    return s;
  };
  const user = aliasOrSelf(process.env.KASHFLOW_API_USERNAME, 'KFUSERNAME') || process.env.KFUSERNAME || '';
  const pass = aliasOrSelf(process.env.KASHFLOW_API_PASSWORD, 'KFPASSWORD') || process.env.KFPASSWORD || '';
  const memorable = aliasOrSelf(process.env.KASHFLOW_MEMORABLE, 'KFMEMORABLE') || process.env.KFMEMORABLE || '';
  const externalToken = process.env.KASHFLOW_EXTERNAL_TOKEN || '';
  const externalUid = process.env.KASHFLOW_EXTERNAL_UID || process.env.KFEXTERNALUID || '';
  return { user, pass, memorable, externalToken, externalUid };
}

function pickPositions(data) {
  // Try several common and vendor variant shapes
  if (!data || typeof data !== 'object') return null;
  const tryArray = (arr) => (Array.isArray(arr) && arr.filter(Number.isFinite).length >= 3) ? arr.filter(Number.isFinite).slice(0,3) : null;
  // Direct arrays
  let pos = tryArray(data.CharacterPositions) || tryArray(data.Positions) || tryArray(data.RequiredCharacterPositions) || tryArray(data.RequiredCharacters) || null;
  if (pos) return pos;
  // Nested objects (e.g., MemorableWord: { Positions: [...] })
  const nestedKeys = ['MemorableWord','Memorable','Password','Auth'];
  for (const k of nestedKeys) {
    const obj = data[k];
    if (obj && typeof obj === 'object') {
      pos = tryArray(obj.Positions) || tryArray(obj.CharacterPositions) || null;
      if (pos) return pos;
    }
  }
  // Keyed numbers like Position1/2/3 or Character1/2/3
  const candidates = [];
  const rx = /^(?:Position|Character|Char)\s*([123])$/i;
  for (const [k,v] of Object.entries(data)) {
    const m = k.match(rx);
    if (m && Number.isFinite(+v)) candidates[Number(m[1]) - 1] = +v;
  }
  if (candidates.filter(Number.isFinite).length >= 3) return candidates.slice(0,3);
  // String CSV like "3,4,6"
  const strKeys = ['PositionsCSV','PositionsString'];
  for (const k of strKeys) {
    const s = data[k];
    if (typeof s === 'string') {
      const arr = s.split(/\s*,\s*/).map(n => parseInt(n,10)).filter(Number.isFinite);
      if (arr.length >= 3) return arr.slice(0,3);
    }
  }
  // Deep scan any nested objects for keys containing position/character with numeric values
  const out = [];
  const scan = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(scan); return; }
    for (const [k,v] of Object.entries(obj)) {
      const kl = String(k).toLowerCase();
      if (Array.isArray(v) && (kl.includes('position') || kl.includes('character') || kl.includes('char'))) {
        v.filter(Number.isFinite).forEach(n => out.push(Number(n)));
      } else if (Number.isFinite(v) && (kl.includes('position') || kl.includes('character') || kl.includes('char'))) {
        out.push(Number(v));
      } else if (typeof v === 'object') {
        scan(v);
      }
    }
  };
  scan(data);
  const uniq = Array.from(new Set(out.filter(Number.isFinite)));
  if (uniq.length >= 3) return uniq.slice(0,3);
  return null;
}

function deriveChars(memorable, positions) {
  if (!memorable || !positions) return null;
  const s = String(memorable);
  // positions are 1-based
  const chars = positions.map(p => {
    const idx = (Number(p) || 0) - 1;
    return idx >= 0 && idx < s.length ? s[idx] : '';
  });
  return chars;
}

async function getWithExternalToken(externalToken) {
  const url = `${baseUrl()}/sessiontoken`;
  try {
    const { externalUid } = getCreds();
    const params = externalUid ? { externalToken, uid: externalUid } : { externalToken };
    const resp = await axios.get(url, { params, headers: { 'Accept': 'application/json' }, timeout: 15000 });
    const token = resp?.data?.SessionToken || resp?.data?.Token || resp?.data?.sessionToken || null;
    if (!token) throw new Error('No SessionToken in external-token response');
    _sessionToken = token;
    _tokenAcquiredAt = now();
    // Optional TTL seconds field
    const ttlSec = resp?.data?.ExpiresInSeconds || resp?.data?.TTL || null;
    _tokenTTLms = Number.isFinite(ttlSec) ? ttlSec * 1000 : 0;
    logger.info('[kashflow] Obtained session token via external token');
    return _sessionToken;
  } catch (err) {
    logger.error(`[kashflow] External token exchange failed: ${err.message}`);
    throw err;
  }
}

async function twoStepLogin(user, pass, memorable) {
  const url = `${baseUrl()}/sessiontoken`;
  // Step 1: POST username + password
  let step1;
  try {
    // Attempt 1: JSON with documented keys (UserName + Password)
    const resp = await axios.post(url, { UserName: user, Password: pass }, { headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, timeout: 15000 });
    step1 = resp?.data || {};
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    const invalid = status === 400 && (data?.Error === 'InvalidCredentials' || /invalid username|password/i.test(data?.Message || ''));
    if (!invalid) {
      logger.error(`[kashflow] Step1 (username/password) failed: ${err.message}`);
      throw err;
    }
    // Attempt 2: JSON with camelCase keys (username/password)
    try {
      const resp2 = await axios.post(url, { username: user, password: pass }, { headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, timeout: 15000 });
      step1 = resp2?.data || {};
    } catch (err2) {
      const status2 = err2?.response?.status;
      const data2 = err2?.response?.data;
      const invalid2 = status2 === 400 && (data2?.Error === 'InvalidCredentials' || /invalid username|password/i.test(data2?.Message || ''));
      if (!invalid2) {
        logger.error(`[kashflow] Step1 retry (camelCase) failed: ${err2.message}`);
        throw err2;
      }
      // Attempt 3: URL-encoded form
      try {
        const params = new URLSearchParams({ username: user, password: pass });
        const resp3 = await axios.post(url, params.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' }, timeout: 15000 });
        step1 = resp3?.data || {};
      } catch (err3) {
        logger.error(`[kashflow] Step1 retry (form-encoded) failed: ${err3.message}`);
        throw err3;
      }
    }
  }
  // Some deployments may return a SessionToken directly in step1 (no memorable required)
  const directToken = step1?.SessionToken || step1?.Token || step1?.sessionToken;
  if (directToken) {
    _sessionToken = directToken;
    _tokenAcquiredAt = now();
    const ttl1 = step1?.ExpiresInSeconds || step1?.TTL;
    _tokenTTLms = Number.isFinite(ttl1) ? ttl1 * 1000 : 0;
    logger.info('[kashflow] Step1 returned a SessionToken; skipping memorable-word step');
    return _sessionToken;
  }
  // Prefer exact order from MemorableWordList if present
  let positions = null;
  if (Array.isArray(step1?.MemorableWordList)) {
    const list = step1.MemorableWordList.map(x => Number(x?.Position)).filter(Number.isFinite);
    if (list.length >= 3) positions = list.slice(0,3);
  }
  if (!positions) positions = pickPositions(step1);
  if (!positions || positions.length < 3) {
    const keys = Object.keys(step1 || {}).slice(0, 20).join(', ');
    if (process.env.KASHFLOW_DEBUG_SESSION === '1') {
      try {
        const redacted = JSON.stringify(step1, (k, v) => /token/i.test(k) ? '[REDACTED]' : v);
        logger.error(`[kashflow] Step1 payload (redacted): ${redacted.substring(0, 4000)}`);
      } catch {}
    } else {
      logger.error(`[kashflow] Step1 payload missing character positions. Keys: ${keys}`);
    }
    throw new Error('KashFlow step1 did not return character positions');
  }
  const chars = deriveChars(memorable, positions);
  if (!chars || chars.length < 3 || chars.some(c => !c)) {
    throw new Error('Memorable word characters missing for required positions');
  }

  // Step 2: PUT temporary token + provided characters
  try {
    const tmpToken = step1.TemporaryToken || step1.TempToken || step1.Token || null;
    if (!tmpToken) throw new Error('Missing TemporaryToken from step1');
    // Prefer documented body with MemorableWordList
    const putBodyDoc = {
      TemporaryToken: tmpToken,
      MemorableWordList: positions.map((p, i) => ({ Position: p, Value: String(chars[i] || '').toString() })),
    };
    let resp;
    try {
      resp = await axios.put(url, putBodyDoc, { headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, timeout: 15000 });
    } catch (errPutDoc) {
      // Fallback to older Positions/Characters format
      const putBodyLegacy = {
        TemporaryToken: tmpToken,
        Positions: positions,
        Characters: chars,
        Character1: chars[0],
        Character2: chars[1],
        Character3: chars[2],
      };
      resp = await axios.put(url, putBodyLegacy, { headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, timeout: 15000 });
    }
    const data = resp?.data || {};
    const token = data.SessionToken || data.Token || data.sessionToken || null;
    if (!token) throw new Error('No SessionToken in step2 response');
    _sessionToken = token;
    _tokenAcquiredAt = now();
    const ttlSec = data.ExpiresInSeconds || data.TTL || null;
    _tokenTTLms = Number.isFinite(ttlSec) ? ttlSec * 1000 : 0;
    logger.info('[kashflow] Session token acquired via two-step login');
    return _sessionToken;
  } catch (err) {
    logger.error(`[kashflow] Step2 (temporary->session) failed: ${err.message}`);
    throw err;
  }
}

async function ensureSessionToken() {
  if (!isExpired()) return _sessionToken;
  const { user, pass, memorable, externalToken } = getCreds();
  if (externalToken) return getWithExternalToken(externalToken);
  if (user && pass && memorable) return twoStepLogin(user, pass, memorable);
  // If we only have a pre-provided session token env, accept it
  const preset = process.env.KASHFLOW_SESSION_TOKEN || process.env.KFSESSIONTOKEN || '';
  if (preset) {
    _sessionToken = preset;
    _tokenAcquiredAt = now();
    _tokenTTLms = 0;
    logger.warn('[kashflow] Using pre-configured session token from env');
    return _sessionToken;
  }
  throw new Error('No KashFlow credentials or external token configured to obtain a session token');
}

async function invalidateSession() {
  if (!_sessionToken) return;
  const url = `${baseUrl()}/sessiontoken`;
  try {
    await axios.delete(url, { headers: { 'Authorization': `KfToken ${_sessionToken}` }, timeout: 10000 });
  } catch (err) {
    // ignore errors on invalidate
  } finally {
    _sessionToken = null; _tokenAcquiredAt = 0; _tokenTTLms = 0;
  }
}

async function withKfAuth(fn) {
  // Helper to execute an API call with KfToken; retries once on 401 after refreshing token
  let token = await ensureSessionToken();
  try {
    return await fn(token);
  } catch (err) {
    const status = err?.response?.status;
    if (status === 401 || status === 403) {
      // refresh and retry once
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
};
