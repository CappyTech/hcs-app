// get database receipts data
// get payments data and based on PayDate, update the TaxMonth and TaxYear
// update the database with new TaxMonth and TaxYear
const db = require('../services/kashflowDatabaseService');
const logger = require('../services/loggerService');
const taxService = require('../services/taxService');

async function updateTaxMonthTaxYear() {
    try {
        //logger.debug('Fetching receipts with null TaxMonth and TaxYear...');
        const receipts = await db.KF_Receipts.findAll({
            where: {
                TaxMonth: null,
                TaxYear: null,
            },
            include: {
                model: db.KF_Suppliers,
                as: 'supplier',
                where : {
                    Subcontractor: true,
                },
            }
        });

        //logger.debug(`Found ${receipts.length} receipts to update.`);

        for (const receipt of receipts) {
            // Parse Payments if it's a string
            const parsedPayments = typeof receipt.Payments === 'string' ? JSON.parse(receipt.Payments) : receipt.Payments;

            // Extract the PayDate from the Payments
            const payment = parsedPayments?.Payment?.Payment?.[0];
            if (!payment || !payment.PayDate) {
                logger.debug(`No valid payment found for receipt with InvoiceNumber: ${receipt.InvoiceNumber} | Supplier: ${receipt.supplier?.Name} | Subcontractor: ${receipt.supplier?.Subcontractor}`);
                continue;
            }

            //logger.debug(`Parsed Payments: ${JSON.stringify(parsedPayments, null, 2)}`);
            const { taxMonth, taxYear } = taxService.calculateTaxYearAndMonth(payment.PayDate);
            //logger.debug(`Calculated TaxMonth: ${taxMonth}, TaxYear: ${taxYear} for PayDate: ${payment.PayDate}`);

            // Update receipt with calculated TaxMonth and TaxYear
            await db.KF_Receipts.update(
                { TaxMonth: taxMonth, TaxYear: taxYear },
                { where: { InvoiceDBID: receipt.InvoiceDBID } }
            );
            //logger.debug(`Updated TaxMonth and TaxYear for receipt with InvoiceNumber: ${receipt.InvoiceNumber}`);
        }

        logger.info('Successfully updated tax month and year for receipts.');
    } catch (error) {
        logger.error('Failed to update tax month and year: ' + error.message);
    }
}

module.exports = updateTaxMonthTaxYear;