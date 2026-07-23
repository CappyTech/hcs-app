/*
  Migration: Coerce PaymentLines.Date and PaymentLines.PayDate from strings to Date objects
  Usage (PowerShell):
    node scripts/migrate-paymentlines-dates.js
*/
import mongoose from 'mongoose';
import __purchase from '../mongoose/models/mongoose/REST/purchase.js';
const { schema, modelName } = __purchase;

async function run() {
  const mongoUri = process.env.MONGODB_URI || process.env.DB_URI || 'mongodb://localhost:27017/hcs-app';
  await mongoose.connect(mongoUri, { autoIndex: false });

  const Purchase = mongoose.model(modelName, schema, 'purchases');
  const cursor = Purchase.find({ PaymentLines: { $exists: true, $ne: [] } }).cursor();

  let updated = 0, scanned = 0;
  for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
    scanned++;
    let changed = false;
    const lines = Array.isArray(doc.PaymentLines) ? doc.PaymentLines : [];
    lines.forEach((pl) => {
      if (pl && typeof pl === 'object') {
        // PayDate
        if (pl.PayDate && typeof pl.PayDate === 'string') {
          const d = new Date(pl.PayDate);
          if (!isNaN(d)) { pl.PayDate = d; changed = true; }
        }
        // Date
        if (pl.Date && typeof pl.Date === 'string') {
          const d2 = new Date(pl.Date);
          if (!isNaN(d2)) { pl.Date = d2; changed = true; }
        }
      }
    });
    if (changed) {
      await doc.save();
      updated++;
    }
  }

  console.log(`Scanned ${scanned} purchases. Updated ${updated} with coerced PaymentLines dates.`);
  await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });
