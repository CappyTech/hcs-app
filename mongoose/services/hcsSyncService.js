'use strict';

const axios = require('axios');
const logger = require('../../services/loggerService');

const SYNC_BASE = (
  process.env.HCS_SYNC_BASE_URL || 'https://sync.heroncs.co.uk'
).replace(/\/+$/, '');

/**
 * Ask hcs-sync to re-pull a single entity from KashFlow into the shared REST
 * namespace. This is the machine-to-machine equivalent of the "Pull & Sync"
 * button on hcs-sync's /debug page, authenticated with the shared
 * HCS_SYNC_API_KEY secret (the same key used for the SSO token handshake).
 *
 * @param {string} entityType - One of: purchase, invoice, quote, customer, supplier, project
 * @param {string|number} entityId - The KashFlow Number (or Code) to refresh
 * @returns {Promise<object>} The sync result ({ ok, action, ... })
 */
async function pullEntity(entityType, entityId) {
  const apiKey = String(process.env.HCS_SYNC_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('HCS_SYNC_API_KEY is not configured — cannot reach hcs-sync');
  }

  const timeoutMs = Number(process.env.HCS_SYNC_TIMEOUT_MS) || 20000;

  const { data } = await axios.post(
    `${SYNC_BASE}/api/pull`,
    { entityType, entityId },
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Sync-Api-Key': apiKey,
      },
      timeout: timeoutMs,
    },
  );

  logger.info(
    `[hcsSyncService] Pulled ${entityType} ${entityId} via hcs-sync — ${data?.action || 'synced'}`,
  );
  return data;
}

module.exports = { pullEntity };
