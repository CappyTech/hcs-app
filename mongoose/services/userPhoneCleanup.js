// Start-up: users used to be saved with phoneNumber: null (the schema's old
// default). The phoneNumber index is sparse + unique, and a sparse index only
// skips documents *without* the field, so a null is indexed: once one user had
// no number, creating a second gave E11000 "dup key: { phoneNumber: null }".
//
// The schema now stores a blank number as no field. This removes the nulls
// (and blank strings) already stored. Idempotent.
import mdb from './mongooseDatabaseService.js';
import logger from '../../services/loggerService.js';

/**
 * Users whose phoneNumber is stored but empty. `$in: [null]` alone would also
 * match users with no field; `$exists` keeps it to stored ones.
 */
export const BLANK_PHONE_FILTER = { $and: [{ phoneNumber: { $exists: true } }, { phoneNumber: { $in: [null, ''] } }] };

export async function unsetBlankPhoneNumbers() {
  const Model = mdb.INTERNAL.user;
  if (!Model) return 0;
  const { modifiedCount = 0 } = await Model.collection.updateMany(BLANK_PHONE_FILTER, { $unset: { phoneNumber: '' } });
  if (modifiedCount) logger.info(`[migration] users: removed an empty phone number from ${modifiedCount} user(s) so new users without one can be created`);
  return modifiedCount;
}

export default { unsetBlankPhoneNumbers };
