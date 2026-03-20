/**
 * Calculate invoice amounts based on labour cost, material cost, CIS deduction rate, and other factors.
 *
 * @param {number} labourCost - The cost of labour.
 * @param {number} materialCost - The cost of materials.
 * @param {number} deduction - The CIS deduction rate (0, 0.2, or 0.3).
 * @param {string} cisNumber - The CIS number of the contractor.
 * @param {boolean} isGross - Whether the contractor is under the gross payment status.
 * @param {boolean} isReverseCharge - Whether the reverse charge mechanism applies.
 * @returns {Object} - An object containing calculated amounts:
 *   - cisRate: The CIS rate applied.
 *   - grossAmount: The total gross amount (labour + material).
 *   - cisAmount: The CIS amount deducted.
 *   - netAmount: The net amount after CIS deduction.
 *   - reverseCharge: The reverse charge amount.
 *   - cisAmountZero: The CIS amount if the rate is 0%.
 *   - cisAmountTwo: The CIS amount if the rate is 20%.
 *   - cisAmountThree: The CIS amount if the rate is 30%.
 */
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

  if (deduction === 0) {
    cisRate = 0.0;
  } else if (cisNumber && deduction === 0.2) {
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
};
