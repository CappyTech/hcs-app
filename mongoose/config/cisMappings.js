'use strict';

// Default nominal codes — used as fallback if DB lookup hasn't run yet
const mappings = {
  materialsNominalCodes: [2700],
  labourNominalCodes: [5300],
  cisDeductionNominalCodes: [75600],

  // KashFlow REST API ChargeType enum IDs for purchase line items
  chargeTypes: {
    materials: 18685896,
    labour: 18685897,
    cisDeduction: 18685964,
  },
};

// Name patterns used to classify nominals into CIS categories
const patterns = {
  materials: /\bmaterial/i,
  labour: /\b(labour|labor|subcontract)/i,
  cisDeduction: /\b(cis\b.*deduct|withholding\s*tax)/i,
};

/**
 * Load nominal codes from the database and merge into the exported mappings.
 * Call once after mdb.connect(). Safe to call multiple times (idempotent).
 * @param {Model} NominalModel - mdb.REST.nominal Mongoose model
 */
async function loadFromDb(NominalModel) {
  const nominals = await NominalModel.find({}, 'Code Name').lean();
  const matCodes = new Set(mappings.materialsNominalCodes);
  const labCodes = new Set(mappings.labourNominalCodes);
  const cisCodes = new Set(mappings.cisDeductionNominalCodes);

  for (const nom of nominals) {
    if (!nom.Code || !nom.Name) continue;
    const name = nom.Name;
    if (patterns.cisDeduction.test(name)) { cisCodes.add(nom.Code); }
    else if (patterns.materials.test(name)) { matCodes.add(nom.Code); }
    else if (patterns.labour.test(name)) { labCodes.add(nom.Code); }
  }

  mappings.materialsNominalCodes = [...matCodes];
  mappings.labourNominalCodes = [...labCodes];
  mappings.cisDeductionNominalCodes = [...cisCodes];
}

mappings.loadFromDb = loadFromDb;

module.exports = mappings;
