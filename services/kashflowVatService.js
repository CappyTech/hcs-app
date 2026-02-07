'use strict';

const axios = require('axios');
const logger = require('./loggerService');
const kfSession = require('./kashflowSessionService');

let _cached = {
  fetchedAt: 0,
  countryCode: null,
  baseUrl: null,
  vatLevels: null,
};

function normBaseUrl(url) {
  return String(url || 'https://api.kashflow.com/v2').replace(/\/\/+$/, '');
}

function guessCountryCode() {
  const cc = (process.env.KASHFLOW_VAT_COUNTRY_CODE || process.env.KASHFLOW_COUNTRY_CODE || 'GB').trim();
  return cc || 'GB';
}

function extractRateNumber(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const candidates = [
    obj.Rate,
    obj.VatRate,
    obj.VATRate,
    obj.Percentage,
    obj.Percent,
    obj.Value,
  ];
  for (const c of candidates) {
    const n = typeof c === 'number' ? c : (typeof c === 'string' ? parseFloat(c) : NaN);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function extractCountryCode(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const candidates = [
    obj.CountryCode,
    obj.Country,
    obj.Code,
    obj.ISO,
    obj.IsoCode,
    obj.Iso,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim().toUpperCase();
  }
  return null;
}

function uniqSorted(nums) {
  const arr = Array.from(new Set((nums || []).filter(n => typeof n === 'number' && Number.isFinite(n))));
  arr.sort((a, b) => a - b);
  return arr;
}

async function fetchVatLevelsFromApi(baseUrl, countryCode) {
  const url = `${normBaseUrl(baseUrl)}/countries/vatrates`;

  // Prefer authenticated call (some deployments require it), but fall back to unauth.
  const attempt = async (token) => {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `KfToken ${token}`;
    return axios.get(url, { headers, timeout: 15000 });
  };

  let resp;
  try {
    resp = await kfSession.withKfAuth((token) => attempt(token));
  } catch (e) {
    // Try without auth
    resp = await attempt(null);
  }

  const data = resp && resp.data;
  const rows = Array.isArray(data) ? data : (Array.isArray(data?.Data) ? data.Data : (Array.isArray(data?.Items) ? data.Items : []));

  const levels = [];
  for (const row of rows) {
    const cc = extractCountryCode(row);
    if (cc && countryCode && cc !== countryCode) continue;
    const rate = extractRateNumber(row);
    if (rate == null) continue;
    // VATLevel in our payload is a numeric percentage (e.g. 20). Keep with up to 4dp.
    levels.push(+Number(rate).toFixed(4));
  }

  return uniqSorted(levels);
}

async function getVatLevels(opts = {}) {
  const baseUrl = normBaseUrl(opts.baseUrl || process.env.KASHFLOW_API_BASE_URL || 'https://api.kashflow.com/v2');
  const countryCode = String(opts.countryCode || guessCountryCode()).toUpperCase();
  const ttlMs = Number.isFinite(+opts.ttlMs) ? +opts.ttlMs : 24 * 60 * 60 * 1000; // 24h

  const fresh = _cached.vatLevels && _cached.baseUrl === baseUrl && _cached.countryCode === countryCode && (Date.now() - _cached.fetchedAt) < ttlMs;
  if (fresh) return _cached.vatLevels;

  const levels = await fetchVatLevelsFromApi(baseUrl, countryCode);
  if (!levels || levels.length === 0) {
    logger.warn(`[kashflow] No VAT rates returned from ${baseUrl}/countries/vatrates for country=${countryCode}`);
  } else {
    logger.info(`[kashflow] Loaded VAT rates from KashFlow for country=${countryCode}: ${levels.join(', ')}`);
  }

  _cached = { fetchedAt: Date.now(), baseUrl, countryCode, vatLevels: levels };
  return levels;
}

module.exports = {
  getVatLevels,
};
