// Start-up: the attendance duplicate-prevention indexes used to be sparse,
// which on a compound index still indexes a record missing the person field
// (as null). So an employee's record landed in the subcontractor index with
// subcontractorId null, and two employees at one location on one day were
// "duplicates" (seen as E11000 on unique_subcontractor_day_location_project).
//
// The model now declares them with a partialFilterExpression. MongoDB won't
// change an index's options in place, so each old one (same name, no partial
// filter) is dropped and the model's indexes are created again. Idempotent:
// an index that already has its partial filter is left alone.
import mdb from './mongooseDatabaseService.js';
import logger from '../../services/loggerService.js';
import { UNIQUE_INDEXES } from '../models/mongoose/INTERNAL/attendance.js';

/** The names of indexes that need replacing, from a collection's index list. Pure. */
export function staleUniqueIndexes(indexes = []) {
  const wanted = new Set(UNIQUE_INDEXES.map((ix) => ix.name));
  return indexes.filter((ix) => wanted.has(ix.name) && !ix.partialFilterExpression).map((ix) => ix.name);
}

export async function fixAttendanceUniqueIndexes() {
  const Model = mdb.INTERNAL.attendance;
  if (!Model) return [];
  let indexes = [];
  try {
    indexes = await Model.collection.indexes();
  } catch (err) {
    if (err.codeName === 'NamespaceNotFound') return [];
    throw err;
  }
  const stale = staleUniqueIndexes(indexes);
  for (const name of stale) await Model.collection.dropIndex(name);
  await Model.createIndexes();
  if (stale.length) logger.info(`[migration] attendance: replaced ${stale.length} duplicate-prevention index(es) so employees and subcontractors no longer collide`);
  return stale;
}

export default { staleUniqueIndexes, fixAttendanceUniqueIndexes };
