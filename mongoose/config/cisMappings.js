'use strict';

// Minimal defaults; extend as needed to match your chart of accounts
module.exports = {
  materialsNominalCodes: [2700], // e.g., Materials Purchased
  labourNominalCodes: [5300],    // e.g., Subcontractors/Labour
  // Optional: if your CIS deduction posts to a specific nominal code, add it here
  cisDeductionNominalCodes: [75600],
};
