/**
 * An accreditation logo and its registration details. Mirrors hcs-web's
 * services/accreditationsData.js.
 *
 * membershipNumber and the validity dates are the fields procurement teams
 * actually ask for, and every one of them is currently [TO SUPPLY] on the live
 * site. They are optional here so a record can be created before the number is
 * found, rather than blocking the whole entry on it.
 */
import mongoose from 'mongoose';
import { publishableFields, imageRef } from '../../webContentFields.js';

const accreditationSchema = new mongoose.Schema({
  ...publishableFields(),
  slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
  name: { type: String, required: true, trim: true },
  logo: { ...imageRef() },
  description: { type: String, trim: true, default: '' },
  membershipNumber: { type: String, trim: true, default: '' },
  validFrom: { type: Date, default: null },
  validTo: { type: Date, default: null },
  certificateUrl: { type: String, trim: true, default: '' },
}, { timestamps: true });

export default { modelName: 'webAccreditation', schema: accreditationSchema };
