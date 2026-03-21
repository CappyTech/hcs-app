/**
 * Calculate invoice amounts based on labour cost, material cost, CIS deduction rate, and other factors.
 *
 * @param {number} labourCost - The cost of labour.
 * @param {number} materialCost - The cost of materials.
 * @param {number} deduction - The withholding tax rate from supplier.WithholdingTaxRate. Accepts both REST (0, 20, 30) and legacy decimal (0, 0.2, 0.3) formats.
 * @param {string} cisNumber - DEPRECATED (was SOAP CISNumber). Kept for backward compat but unused in rate logic.
 * @param {boolean} isGross - Whether the contractor is under the gross payment status (WithholdingTaxRate === 0).
 * @param {boolean} isReverseCharge - Whether the reverse charge mechanism applies.
 * @returns {Object} - An object containing calculated amounts:
 *   - cisRate: The withholding tax rate applied.
 *   - grossAmount: The total gross amount (labour + material).
 *   - cisAmount: The CIS amount deducted.
 *   - netAmount: The net amount after CIS deduction.
 *   - reverseCharge: The reverse charge amount.
 *   - cisAmountZero: The CIS amount if the rate is 0%.
 *   - cisAmountTwo: The CIS amount if the rate is 20%.
 *   - cisAmountThree: The CIS amount if the rate is 30%.
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
  cisNumber,
  isGross,
  isReverseCharge,
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

module.exports = {
  calculateInvoiceAmounts,
  normalizeWhtRate,
  whtRateLabel,
};
