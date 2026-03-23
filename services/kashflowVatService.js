"use strict";

const logger = require("./loggerService");
const mdb = require("../mongoose/services/mongooseDatabaseService");

let _cached = {
  fetchedAt: 0,
  countryCode: null,
  vatLevels: null,
};

function guessCountryCode() {
  const cc = (
    process.env.KASHFLOW_VAT_COUNTRY_CODE ||
    process.env.KASHFLOW_COUNTRY_CODE ||
    "GB"
  ).trim();
  return cc || "GB";
}

/**
 * Read VAT rates from the REST namespace (synced by hcs-sync).
 * Returns a sorted array of unique numeric rate values, e.g. [0, 5, 20].
 */
async function getVatLevels(opts = {}) {
  const countryCode = String(
    opts.countryCode || guessCountryCode(),
  ).toUpperCase();
  const ttlMs = Number.isFinite(+opts.ttlMs)
    ? +opts.ttlMs
    : 24 * 60 * 60 * 1000; // 24h

  const fresh =
    _cached.vatLevels &&
    _cached.countryCode === countryCode &&
    Date.now() - _cached.fetchedAt < ttlMs;
  if (fresh) return _cached.vatLevels;

  const VATRate = mdb.REST?.vatrate;
  if (!VATRate) {
    logger.warn("[vatService] VATRate model not available — database may not be connected yet");
    return _cached.vatLevels || [];
  }

  const docs = await VATRate.find({ CountryCode: countryCode }).lean();
  const levels = Array.from(
    new Set(
      docs
        .map((d) => d.VATRate ?? d.Rate)
        .filter((n) => typeof n === "number" && Number.isFinite(n)),
    ),
  );
  levels.sort((a, b) => a - b);

  if (levels.length === 0) {
    logger.warn(`[vatService] No VAT rates found in MongoDB for country=${countryCode}`);
  } else {
    logger.info(`[vatService] Loaded VAT rates from MongoDB for country=${countryCode}: ${levels.join(", ")}`);
  }

  _cached = { fetchedAt: Date.now(), countryCode, vatLevels: levels };
  return levels;
}

module.exports = {
  getVatLevels,
};
