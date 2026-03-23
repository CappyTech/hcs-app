const logger = require("./loggerService");

/**
 * Formats a given amount as a currency string in GBP (£).
 *
 * @param {number} amount - The amount to format.
 * @returns {string} - The formatted currency string.
 * @throws {Error} - Throws an error if the input amount is not a number.
 */
function formatCurrency(amount) {
  if (typeof amount !== "number") {
    const errorMessage = "Invalid input. Amount must be a number.";
    logger.error(errorMessage);
    throw new Error(errorMessage);
  }
  return "£" + amount.toFixed(2);
}

/**
 * Rounds a given number up or down.
 *
 * @param {number} amount - The number to round.
 * @param {boolean} up - If true, rounds the number up; otherwise, rounds the number down.
 * @returns {number} - The rounded number.
 */
function rounding(amount, up) {
  return up ? Math.ceil(amount) : Math.floor(amount);
}

module.exports = {
  formatCurrency,
  rounding,
};
