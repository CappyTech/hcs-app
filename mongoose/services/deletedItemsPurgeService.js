'use strict';

const mdb = require('./mongooseDatabaseService');
const configService = require('../../services/configService');
const logger = require('../../services/loggerService');

/**
 * Scheduled purge of soft-deleted REST records.
 *
 * OFF BY DEFAULT. These are synced accounting records (KashFlow via hcs-sync)
 * and recoverable from /admin/deleted-items, so hard-deleting them is a
 * deliberate retention decision: set DELETED_ITEMS_RETENTION_DAYS (>= 30) to
 * enable. Records whose deletedAt/DeletedAt is older than the retention
 * period are permanently removed.
 */

const MODELS = ['purchase', 'invoice', 'customer', 'supplier', 'project', 'quote', 'nominal', 'note'];
const MIN_RETENTION_DAYS = 30;

function getRetentionDays() {
  const raw = configService.get('DELETED_ITEMS_RETENTION_DAYS');
  if (!raw) return null;
  const days = parseInt(raw, 10);
  if (!Number.isFinite(days) || days < MIN_RETENTION_DAYS) {
    logger.warn(`[deletedItemsPurge] DELETED_ITEMS_RETENTION_DAYS=${raw} invalid (minimum ${MIN_RETENTION_DAYS}) — purge disabled`);
    return null;
  }
  return days;
}

async function purgeOnce() {
  const retentionDays = getRetentionDays();
  if (!retentionDays) return { enabled: false, purged: 0 };

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  let purged = 0;
  const byModel = {};

  for (const modelName of MODELS) {
    const model = mdb.REST?.[modelName];
    if (!model) continue;
    const result = await model.deleteMany({
      $or: [
        { deletedAt: { $type: 'date', $lte: cutoff } },
        { DeletedAt: { $type: 'date', $lte: cutoff } },
      ],
    });
    if (result.deletedCount) {
      byModel[modelName] = result.deletedCount;
      purged += result.deletedCount;
    }
  }

  if (purged > 0) {
    logger.info(`[deletedItemsPurge] Purged ${purged} soft-deleted record(s) older than ${retentionDays} days`, byModel);
  }
  return { enabled: true, retentionDays, purged, byModel };
}

module.exports = { purgeOnce, getRetentionDays };
