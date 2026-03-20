const logger = require("./loggerService");

/**
 * Validates invoice data to ensure all required fields are present and correctly formatted.
 *
 * @param {Object} data - The invoice data to validate.
 * @param {string} data.invoiceNumber - The invoice number.
 * @param {string} data.kashflowNumber - The Kashflow number.
 * @param {string} data.invoiceDate - The invoice date.
 * @param {string} [data.remittanceDate] - The remittance date (optional).
 * @param {number} data.labourCost - The labour cost.
 * @param {number} data.materialCost - The material cost.
 * @param {string} [data.submissionDate] - The submission date (optional).
 * @returns {Object} - The validated and possibly modified invoice data.
 * @throws {Error} - Throws an error if any validation fails.
 */
function validateInvoiceData(data) {
  const errors = [];
  const validations = {
    invoiceNumber: (value) => value && value.trim() !== "",
    kashflowNumber: (value) => value && value.trim() !== "",
    invoiceDate: (value) => value && !isNaN(Date.parse(value)),
    remittanceDate: (value) => !value || !isNaN(Date.parse(value)),
    labourCost: (value) => !isNaN(value) && Number(value) >= 0,
    materialCost: (value) => !isNaN(value) && Number(value) >= 0,
  };

  Object.keys(validations).forEach((field) => {
    if (!validations[field](data[field])) {
      errors.push(`Invalid or missing value for ${field}`);
    }
  });

  if (data.submissionDate === "0000-00-00 00:00:00" || !data.submissionDate) {
    data.submissionDate = null;
  }

  if (data.remittanceDate === "0000-00-00 00:00:00" || !data.remittanceDate) {
    data.remittanceDate = null;
  }

  if (errors.length > 0) {
    const errorMessage = errors.join(", ");
    logger.error(`Validation errors: ${errorMessage}`);
    throw new Error(errorMessage);
  }

  return data;
}

module.exports = {
  validateInvoiceData,
};
