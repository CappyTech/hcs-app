const express = require('express');
const router = express.Router();
const logger = require('../services/loggerService');
const path = require('path');
const kf = require('../services/kashflowDatabaseService');
const authService = require('../services/authService');
const ChargeTypes = require('./CRUD/kashflow/chargeTypes.json');
const { normalizeLines, normalizePayments } = require('../services/kashflowNormalizer');
const slimDateTime = require('../services/dateService').slimDateTime;

const renderKFYearlyReturns = async (req, res, next) => {
    try {
        const { year, uuid } = req.params;

        if (!year || !uuid) {
            logger.warn("Year and Subcontractor UUID are required.");
            return res.status(400).send("Year and Subcontractor UUID are required.");
        }

        // Extract page break months from query
        const pageBreakMonths = req.query.page
            ? req.query.page.split(',').map(Number)
            : [];

        // Fetch the supplier using UUID
        const supplier = await kf.KF_Suppliers.findOne({ where: { uuid } });
        if (!supplier) {
            logger.warn(`Supplier with UUID ${uuid} not found.`);
            return res.status(404).send("Supplier not found.");
        }

        // Fetch receipts for the given year
        const receipts = await kf.KF_Receipts.findAll({
            where: { CustomerID: supplier.SupplierID, TaxYear: year },
            order: [['InvoiceNumber', 'ASC']]
        });

        // Process receipts to extract details
        const receiptsByMonth = {};
        receipts.forEach(receipt => {
            const month = receipt.TaxMonth || moment.tz(receipt.InvoiceDate, 'Europe/London').month() + 1; // Ensure TaxMonth is used // ensure .tz

            // Ensure the month key exists
            if (!receiptsByMonth[month]) {
                receiptsByMonth[month] = [];
            }

            const ParentType = identifyParentType(receipt.CustomerID);
            // Normalize with parent type awareness
            const normalizedLines = normalizeLines(receipt.Lines, receipt.InvoiceNumber, receipt.CustomerID, ParentType);
            const normalizedPayments = normalizePayments(receipt.Payments, receipt.InvoiceNumber, receipt.CustomerID, ParentType);

            // Extract values from Lines
            const labourCost = normalizedLines.filter(line => line.ChargeType === 18685897).reduce((sum, line) => sum + (line.Rate * line.Quantity), 0);
            const materialCost = normalizedLines.filter(line => line.ChargeType === 18685896).reduce((sum, line) => sum + (line.Rate * line.Quantity), 0);
            const cisAmount = Math.abs(normalizedLines.filter(line => line.ChargeType === 18685964).reduce((sum, line) => sum + (line.Rate * line.Quantity), 0));
            const grossAmount = labourCost + materialCost;
            const netAmount = grossAmount - cisAmount;

            // Extract first PayDate if available
            const payDates = normalizedPayments?.Payment?.Payment?.map(p => p.PayDate) || [];
            const payDate = payDates.length > 0 ? payDates[0] : 'N/A';

            // Add to receiptsByMonth
            receiptsByMonth[month].push({
                InvoiceNumber: receipt.CustomerReference,
                KashflowNumber: receipt.InvoiceNumber,
                InvoiceDate: receipt.InvoiceDate,
                PayDates: payDates,
                PayDate: payDate,
                GrossAmount: grossAmount,
                LabourCost: labourCost,
                MaterialCost: materialCost,
                CISAmount: cisAmount,
                NetAmount: netAmount,
                SubmissionDate: receipt.SubmissionDate
            });
        });

        res.render(path.join('kashflow', 'yearlyReturns'), {
            title: 'Subcontractor Yearly Returns',
            year,
            supplier,
            receiptsByMonth,
            monthNames: [
                'April', 'May', 'June', 'July', 'August', 'September',
                'October', 'November', 'December', 'January', 'February', 'March'
            ],
            pageBreakMonths
        });
    } catch (error) {
        logger.error(`Error rendering monthly returns for one subcontractor: ${error.message}`, { stack: error.stack });
        next(error);
    }
};

const puppeteer = require('puppeteer');

// Handle PDF download
router.post('/download-pdf', async (req, res, next) => {
    try {
        const {
            format,
            width,
            height,
            landscape,
            printBackground,
            scale,
            pageRanges,
            preferCSSPageSize,
            displayHeaderFooter,
            headerTemplate,
            footerTemplate,
            marginTop,
            marginBottom,
            marginLeft,
            marginRight,
            year,
            uuid,
            pageBreakMonths,
            filename
        } = req.body;

        if (!year || !uuid) {
            return res.status(400).send("Missing year or UUID for PDF generation.");
        }

        const queryString = pageBreakMonths ? `?page=${pageBreakMonths}` : '';
        const fullUrl = `${req.protocol}://${req.get('host')}/kashflow/yearly/returns/${year}/${uuid}${queryString}`;

        const browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'] // Required on some Linux servers
        });
        const page = await browser.newPage();

        const cookies = req.headers.cookie;

        if (cookies) {
            const cookieArray = cookies.split(';').map(cookieStr => {
                const [name, ...val] = cookieStr.trim().split('=');
                return {
                    name,
                    value: val.join('='),
                    domain: 'localhost', // or your production domain
                    path: '/',
                    httpOnly: true,
                    secure: req.secure || req.headers['x-forwarded-proto'] === 'https'
                };
            });

            await page.browserContext().setCookie(...cookieArray);

        }

        await page.goto(fullUrl, { waitUntil: 'networkidle0' });



        const options = {
            landscape: !!parseInt(landscape), // "1" = true, "0" = false
            printBackground: printBackground === 'off',
            scale: parseFloat(scale) || 1,
            pageRanges: pageRanges || undefined,
            preferCSSPageSize: preferCSSPageSize === 'off',
            displayHeaderFooter: displayHeaderFooter === 'off',
            headerTemplate: headerTemplate || '',
            footerTemplate: footerTemplate || '',
            margin: {
                top: marginTop || '20mm',
                bottom: marginBottom || '20mm',
                left: marginLeft || '15mm',
                right: marginRight || '15mm'
            }
        };

        // Only add format or custom size if provided
        if (format) {
            options.format = format;
        } else {
            if (width) options.width = width;
            if (height) options.height = height;
        }

        const pdfBuffer = await page.pdf(options);

        await browser.close();

        let safeFilename = filename.replace(/[^\w\-\.]+/g, '_');

        if (!safeFilename.endsWith('.pdf')) {
            safeFilename += '.pdf';
        }

        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="${safeFilename}"`,
            'Content-Length': pdfBuffer.length,
        });

        res.send(pdfBuffer);
    } catch (error) {
        logger.error('[PDF Generation Error]' + error);
        next(error);
    }
});

const { Parser } = require('json2csv');

router.post('/download-csv', async (req, res) => {
    try {
        const { year, uuid, filename } = req.body;

        if (!year || !uuid) {
            return res.status(400).send("Missing year or UUID for CSV export.");
        }

        const supplier = await kf.KF_Suppliers.findOne({ where: { uuid } });
        if (!supplier) {
            return res.status(404).send("Supplier not found.");
        }

        const receipts = await kf.KF_Receipts.findAll({
            where: { CustomerID: supplier.SupplierID, TaxYear: year },
            order: [['InvoiceNumber', 'ASC']]
        });

        const monthNames = ['April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', 'January', 'February', 'March'];
        const receiptsByMonth = {};

        receipts.forEach(receipt => {
            const month = receipt.TaxMonth || new Date(receipt.InvoiceDate).getUTCMonth() + 1;
            if (!receiptsByMonth[month]) receiptsByMonth[month] = [];

            const ParentType = identifyParentType(receipt.CustomerID);
            // Normalize with parent type awareness
            const normalizedLines = normalizeLines(receipt.Lines, receipt.InvoiceNumber, receipt.CustomerID, ParentType);
            const normalizedPayments = normalizePayments(receipt.Payments, receipt.InvoiceNumber, receipt.CustomerID, ParentType);

            const labourCost = normalizedLines.filter(line => line.ChargeType === 18685897).reduce((sum, line) => sum + line.Rate * line.Quantity, 0);
            const materialCost = normalizedLines.filter(line => line.ChargeType === 18685896).reduce((sum, line) => sum + line.Rate * line.Quantity, 0);
            const cisAmount = Math.abs(normalizedLines.filter(line => line.ChargeType === 18685964).reduce((sum, line) => sum + line.Rate * line.Quantity, 0));
            const grossAmount = labourCost + materialCost;
            const netAmount = grossAmount - cisAmount;

            const payDates = normalizedPayments?.Payment?.Payment?.map(p => p.PayDate) || [];

            receiptsByMonth[month].push({
                InvoiceNumber: receipt.CustomerReference,
                KashflowNumber: receipt.InvoiceNumber,
                InvoiceDate: slimDateTime(receipt.InvoiceDate),
                PayDate: payDates[0] || 'N/A',
                Gross: grossAmount,
                Labour: labourCost,
                Material: materialCost,
                CIS: cisAmount,
                Net: netAmount,
                Submission: slimDateTime(receipt.SubmissionDate || '')
            });
        });

        const safeFilename = (filename || `${supplier.Name}-${year}-CIS-Returns.csv`)
            .replace(/[^\w\-.]+/g, '_')
            .replace(/\.csv$/i, '') + '.csv';

        let csvRows = [];

        const header = `${supplier.Name} | Heron Constructive Solutions LTD | ${year}-${String(Number(year) + 1).slice(-2)} CIS Returns`;
        csvRows.push([header], [],
            ['Subcontractor', supplier.Name],
            ['', [supplier.Address1, supplier.Address2, supplier.Address3, supplier.Address4, supplier.PostCode].filter(Boolean).join(', ')],
            ['Contractor', 'Heron Constructive Solutions LTD'],
            ['', '103 Herondale Road, Mossley Hill, Liverpool, Merseyside, L18 1JZ'],
            []);

        for (let monthIndex = 1; monthIndex <= 12; monthIndex++) {
            const monthKey = monthIndex.toString();
            const monthName = monthNames[monthIndex - 1];
            const entries = receiptsByMonth[monthIndex] || [];
            if (!entries.length) continue;

            csvRows.push([`Month ${monthIndex} (${monthName} ${year})`]);
            csvRows.push(['Invoice', 'Kashflow', 'Invoiced', 'Paid', 'Gross', 'Labour', 'Material', 'CIS', 'Net', 'Submission']);

            let totalGross = 0, totalLabour = 0, totalMaterial = 0, totalCIS = 0, totalNet = 0;

            for (const row of entries) {
                csvRows.push([
                    row.InvoiceNumber,
                    row.KashflowNumber,
                    row.InvoiceDate,
                    row.PayDate,
                    `£${row.Gross.toFixed(2)}`,
                    `£${row.Labour.toFixed(2)}`,
                    `£${row.Material.toFixed(2)}`,
                    `£${row.CIS.toFixed(2)}`,
                    `£${row.Net.toFixed(2)}`,
                    row.Submission
                ]);
                totalGross += row.Gross;
                totalLabour += row.Labour;
                totalMaterial += row.Material;
                totalCIS += row.CIS;
                totalNet += row.Net;
            }

            csvRows.push([
                `Total for Month ${monthIndex}:`, '', '', '',
                `£${totalGross.toFixed(2)}`,
                `£${totalLabour.toFixed(2)}`,
                `£${totalMaterial.toFixed(2)}`,
                `£${totalCIS.toFixed(2)}`,
                `£${totalNet.toFixed(2)}`,
                ''
            ]);
            csvRows.push([]);
        }

        const csvString = csvRows.map(row => row.join(',')).join('\r\n');

        res.set({
            'Content-Type': 'text/csv',
            'Content-Disposition': `attachment; filename="${safeFilename}"`,
            'Content-Length': Buffer.byteLength(csvString)
        });

        res.send(csvString);
    } catch (err) {
        console.error('CSV export failed:', err);
        res.status(500).send('Could not generate CSV');
    }
});

const ExcelJS = require('exceljs');

router.post('/download-xlsx', async (req, res) => {
    try {
        const { year, uuid, filename } = req.body;

        if (!year || !uuid) {
            return res.status(400).send("Missing year or UUID for Excel export.");
        }

        const supplier = await kf.KF_Suppliers.findOne({ where: { uuid } });
        if (!supplier) {
            return res.status(404).send("Supplier not found.");
        }

        const receipts = await kf.KF_Receipts.findAll({
            where: { CustomerID: supplier.SupplierID, TaxYear: year },
            order: [['InvoiceNumber', 'ASC']]
        });

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('CIS Returns');

        const headerText = `${supplier.Name} | Heron Constructive Solutions LTD | ${year}-${String(Number(year) + 1).slice(-2)} CIS Returns`;
        sheet.mergeCells('A1:L1');
        sheet.getCell('A1').value = headerText;
        sheet.getCell('A1').alignment = { horizontal: 'center' };
        sheet.getRow(1).font = { bold: true, size: 14 };

        sheet.getCell('K2').value = 'Subcontractor';
        sheet.getCell('L2').value = supplier.Name;
        sheet.getCell('K3').value = '';
        sheet.getCell('L3').value = [supplier.Address1, supplier.Address2, supplier.Address3, supplier.Address4, supplier.PostCode].filter(Boolean).join(', ');
        sheet.getCell('K4').value = 'Contractor';
        sheet.getCell('L4').value = 'Heron Constructive Solutions LTD';
        sheet.getCell('K5').value = '';
        sheet.getCell('L5').value = '103 Herondale Road, Mossley Hill, Liverpool, Merseyside, L18 1JZ';

        const monthNames = ['April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', 'January', 'February', 'March'];
        const receiptsByMonth = {};

        receipts.forEach(receipt => {
            const month = receipt.TaxMonth || new Date(receipt.InvoiceDate).getUTCMonth() + 1;
            if (!receiptsByMonth[month]) receiptsByMonth[month] = [];

            // Normalize with parent type awareness
            const normalizedLines = normalizeLines(receipt.Lines, receipt.InvoiceNumber, receipt.CustomerID);
            const normalizedPayments = normalizePayments(receipt.Payments, receipt.InvoiceNumber, receipt.CustomerID);

            const labourCost = normalizedLines.filter(line => line.ChargeType === 18685897).reduce((sum, line) => sum + line.Rate * line.Quantity, 0);
            const materialCost = normalizedLines.filter(line => line.ChargeType === 18685896).reduce((sum, line) => sum + line.Rate * line.Quantity, 0);
            const cisAmount = Math.abs(normalizedLines.filter(line => line.ChargeType === 18685964).reduce((sum, line) => sum + line.Rate * line.Quantity, 0));
            const grossAmount = labourCost + materialCost;
            const netAmount = grossAmount - cisAmount;

            const payDates = normalizedPayments?.Payment?.Payment?.map(p => slimDateTime(p.PayDate)) || [];

            receiptsByMonth[month].push({
                InvoiceNumber: receipt.CustomerReference,
                KashflowNumber: receipt.InvoiceNumber,
                InvoiceDate: slimDateTime(receipt.InvoiceDate),
                PayDate: payDates[0],
                Gross: grossAmount,
                Labour: labourCost,
                Material: materialCost,
                CIS: cisAmount,
                Net: netAmount,
                Submission: slimDateTime(receipt.SubmissionDate || '')
            });
        });

        for (let monthIndex = 1; monthIndex <= 12; monthIndex++) {
            const monthName = monthNames[monthIndex - 1];
            const entries = receiptsByMonth[monthIndex] || [];
            if (!entries.length) continue;

            sheet.addRow([`Month ${monthIndex} (${monthName} ${year})`]);
            sheet.addRow(['Invoice', 'Kashflow', 'Invoiced', 'Paid', 'Gross', 'Labour', 'Material', 'CIS', 'Net', 'Submission']);

            let totalGross = 0, totalLabour = 0, totalMaterial = 0, totalCIS = 0, totalNet = 0;

            for (const row of entries) {
                sheet.addRow([
                    row.InvoiceNumber,
                    row.KashflowNumber,
                    row.InvoiceDate,
                    row.PayDate,
                    row.Gross,
                    row.Labour,
                    row.Material,
                    row.CIS,
                    row.Net,
                    row.Submission
                ]);
                totalGross += row.Gross;
                totalLabour += row.Labour;
                totalMaterial += row.Material;
                totalCIS += row.CIS;
                totalNet += row.Net;
            }

            sheet.addRow([
                `Total for Month ${monthIndex}:`, '', '', '',
                totalGross,
                totalLabour,
                totalMaterial,
                totalCIS,
                totalNet,
                ''
            ]);
            sheet.addRow([]);
        }

        const safeFilename = (filename || `${supplier.Name}-${year}-CIS-Returns.xlsx`).replace(/[^\w\-.]+/g, '_');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);

        await workbook.xlsx.write(res);
        res.end();
    } catch (err) {
        console.error('Excel export failed:', err);
        res.status(500).send('Could not generate Excel file');
    }
});

router.get('/returns/:year/:uuid',  authService.ensureRole(), renderKFYearlyReturns);

module.exports = router;
