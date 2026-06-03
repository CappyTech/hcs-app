/**
 * Calculate invoice amounts based on labour cost, material cost and CIS deduction rate.
 *
 * @param {number} labourCost - The cost of labour.
 * @param {number} materialCost - The cost of materials.
 * @param {number} deduction - The withholding tax rate from supplier.WithholdingTaxRate. Accepts both REST (0, 20, 30) and legacy decimal (0, 0.2, 0.3) formats.
 * @returns {Object} Calculated amounts (cisRate, grossAmount, cisAmount, netAmount, reverseCharge, cisAmountZero/Two/Three).
 */
/**
 * Normalise a WithholdingTaxRate value to a decimal fraction.
 * The KashFlow REST API stores rates as whole-number percentages (0, 20, 30)
 * while legacy SOAP data used decimals (0, 0.2, 0.3).
 * Returns the decimal form (0, 0.2, 0.3) or null/-1 unchanged.
 */
function normalizeWhtRate(rate) {
  if (rate == null || rate === '' || rate === -1) return rate;
  const n = Number(rate);
  if (!Number.isFinite(n)) return null;
  // Whole-number percentages: 20 → 0.2, 30 → 0.3
  if (n > 1) return n / 100;
  return n;
}

/**
 * Return a display label for a WithholdingTaxRate value.
 * Accepts both REST (20, 30) and SOAP (0.2, 0.3) formats.
 */
function whtRateLabel(rate) {
  const n = normalizeWhtRate(rate);
  if (n === 0)   return '0% (Gross)';
  if (n === 0.2) return '20%';
  if (n === 0.3) return '30%';
  return null;
}

function calculateInvoiceAmounts(
  labourCost,
  materialCost,
  deduction,
) {
  labourCost = parseFloat(labourCost);
  materialCost = parseFloat(materialCost);

  const grossAmount = labourCost + materialCost;
  let cisRate, reverseCharge;

  // Normalise deduction so both 20/30 and 0.2/0.3 work
  const normDed = normalizeWhtRate(deduction);
  if (normDed === 0) {
    cisRate = 0.0;
  } else if (normDed === 0.2) {
    cisRate = 0.2;
  } else {
    cisRate = 0.3;
  }

  const cisAmount = labourCost * cisRate;
  const cisAmountZero = labourCost * 0.0;
  const cisAmountTwo = labourCost * 0.2;
  const cisAmountThree = labourCost * 0.3;
  const netAmount = grossAmount - cisAmount;
  reverseCharge = labourCost * 0.2;

  return {
    cisRate,
    grossAmount: grossAmount.toFixed(2),
    cisAmount: cisAmount.toFixed(2),
    netAmount: netAmount.toFixed(2),
    reverseCharge: reverseCharge.toFixed(2),
    cisAmountZero: cisAmountZero.toFixed(2),
    cisAmountTwo: cisAmountTwo.toFixed(2),
    cisAmountThree: cisAmountThree.toFixed(2),
  };
}

/**
 * Return a Mongoose query filter that matches any supplier identifiable as a
 * CIS subcontractor via any of the known indicator fields.
 */
function cisSupplierQuery() {
  return {
    $or: [
      { ApplyWithholdingTax: true },
      { CISRate: { $ne: null } },
      { WithholdingTaxReferences: { $exists: true, $not: { $size: 0 } } },
    ],
  };
}

/**
 * In-memory predicate — mirrors cisSupplierQuery() for use on already-fetched docs.
 * @param {object} s - A lean supplier document.
 * @returns {boolean}
 */
function isCisSupplier(s) {
  return (
    s.ApplyWithholdingTax === true ||
    s.CISRate != null ||
    (Array.isArray(s.WithholdingTaxReferences) && s.WithholdingTaxReferences.length > 0)
  );
}

/**
 * Regex matching a valid HMRC CIS verification number (e.g. V1234567 or V12345678/AB).
 */
const HMRC_VERIFICATION_REGEX = /^V\d{7,10}(\/[A-Z]{1,2})?$/;

/**
 * Mongoose query filter: supplier has been verified by HMRC
 * (WithholdingTaxReferences contains a matching Verification Number).
 */
function cisVerifiedQuery() {
  return {
    WithholdingTaxReferences: {
      $elemMatch: {
        Name: 'Verification Number',
        Value: { $regex: HMRC_VERIFICATION_REGEX },
      },
    },
  };
}

/**
 * In-memory predicate — mirrors cisVerifiedQuery().
 * @param {object} s - A lean supplier document.
 * @returns {boolean}
 */
function isHmrcVerified(s) {
  return Array.isArray(s.WithholdingTaxReferences) &&
    s.WithholdingTaxReferences.some(
      r => r.Name === 'Verification Number' && HMRC_VERIFICATION_REGEX.test(r.Value)
    );
}

module.exports = {
  calculateInvoiceAmounts,
  normalizeWhtRate,
  whtRateLabel,
  cisSupplierQuery,
  isCisSupplier,
  HMRC_VERIFICATION_REGEX,
  cisVerifiedQuery,
  isHmrcVerified,
};
