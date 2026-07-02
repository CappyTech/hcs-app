'use strict';

/**
 * tests/readViews.test.js
 *
 * Render smoke-tests for the per-model read views (config.readView pattern).
 * Each view is rendered with EJS twice — once with representative data and
 * once with minimal/missing data — to catch template syntax errors and
 * unguarded references without needing a browser or database.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ejs = require('ejs');

const VIEWS_ROOT = path.join(__dirname, '..', 'mongoose', 'views');

// Globals normally injected by app.js res.locals middleware
const baseLocals = {
  isAuthenticated: true,
  isAdmin: true,
  canUpdate: true,
  canDelete: true,
  slimDateTime: (d) => (d ? '01/01/2025' : ''),
  formatCurrency: (n) => `£${Number(n).toFixed(2)}`,
  referenceData: {},
  actions: [],
  schema: {}
};

function render(view, locals) {
  const file = path.join(VIEWS_ROOT, 'tailwindcss', view, 'read.ejs');
  return ejs.renderFile(file, { ...baseLocals, ...locals });
}

const lineItems = [
  { Description: 'Labour', Quantity: 2, Rate: 150, VATAmount: 60, NominalCode: 5000, ProjectNumber: 12 },
  { Description: 'Materials', Quantity: 1, Rate: 80.5, VATAmount: 16.1 }
];
const paymentLines = [{ Date: '2025-05-10', Method: 'BACS', Amount: 380.5 }];

describe('per-model read views render', () => {
  it('invoice: full data', async () => {
    const html = await render('invoice', {
      title: 'Invoice Details', basePath: 'invoice', config: {},
      item: {
        uuid: 'u1', Number: 1234, Status: 'Paid', CustomerName: 'Acme Ltd', CustomerReference: 'PO-88',
        NetAmount: 500, VATAmount: 100, GrossAmount: 600, AmountPaid: 600,
        IssuedDate: '2025-05-01', DueDate: '2025-05-31', PaidDate: '2025-05-10',
        LineItems: lineItems, PaymentLines: paymentLines
      },
      relatedCustomer: { uuid: 'c1', Name: 'Acme Ltd', Code: 'ACM01' }
    });
    assert.ok(html.includes('Invoice #1234'));
    assert.ok(html.includes('/customer/read/c1'));
    assert.ok(html.includes('£600.00'));
    assert.ok(html.includes('Labour'));
    assert.ok(html.includes('BACS'));
    assert.ok(html.includes('app.kashflow.com/#invoices/1234'));
  });

  it('invoice: minimal data (no customer, no lines)', async () => {
    const html = await render('invoice', {
      title: 'Invoice Details', basePath: 'invoice', config: {},
      item: { uuid: 'u1', Number: 1, Status: 'Outstanding' }
    });
    assert.ok(html.includes('No line items'));
    assert.ok(html.includes('No payments recorded'));
  });

  it('purchase: full data with CIS supplier', async () => {
    const html = await render('purchase', {
      title: 'Purchase Details', basePath: 'purchase', config: {},
      item: {
        uuid: 'u2', Number: 555, Status: 'Outstanding', SupplierReference: 'INV-9',
        NetAmount: 1000, VATAmount: 200, GrossAmount: 1200, TotalPaidAmount: 0,
        IssuedDate: '2025-06-01', DueDate: '2025-06-30',
        LineItems: lineItems, PaymentLines: []
      },
      relatedSupplier: { uuid: 's1', Name: 'Subbie Ltd', Code: 'SUB01', WithholdingTaxRate: 20 }
    });
    assert.ok(html.includes('Purchase #555'));
    assert.ok(html.includes('/supplier/read/s1'));
    assert.ok(html.includes('CIS 20%'));
  });

  it('purchase: minimal data', async () => {
    const html = await render('purchase', {
      title: 'Purchase Details', basePath: 'purchase', config: {},
      item: { uuid: 'u2', Number: 2, Status: 'Paid' }
    });
    assert.ok(html.includes('Purchase #2'));
  });

  it('quote: full data', async () => {
    const html = await render('quote', {
      title: 'Quote Details', basePath: 'quote', config: {},
      item: {
        uuid: 'u3', Number: 77, Status: 'Accepted', Date: '2025-04-01',
        NetAmount: 900, VATAmount: 180, GrossAmount: 1080,
        Category: { Name: 'Landscaping' }, LineItems: lineItems
      },
      relatedCustomer: { uuid: 'c1', Name: 'Acme Ltd' }
    });
    assert.ok(html.includes('Quote #77'));
    assert.ok(html.includes('Landscaping'));
  });

  it('quote: minimal data', async () => {
    const html = await render('quote', {
      title: 'Quote Details', basePath: 'quote', config: {},
      item: { uuid: 'u3', Number: 3, Status: 'Draft' }
    });
    assert.ok(html.includes('Quote #3'));
  });

  it('customer: full data with related records', async () => {
    const html = await render('customer', {
      title: 'Customer Details', basePath: 'customer', config: {},
      item: {
        uuid: 'u4', Id: 42, Name: 'Acme Ltd', Code: 'ACM01', Email: 'a@acme.test',
        TelephoneNumber: '0123', IsArchived: false, OutstandingBalance: 100,
        InvoicedNetAmount: 5000, InvoicedVATAmount: 1000, TotalPaidAmount: 5900,
        InvoiceCount: 12, VATNumber: 'GB123', DiscountRate: 5, Note: 'Key account'
      },
      relatedInvoices: [{ uuid: 'i1', Number: 9, Status: 'Paid', IssuedDate: '2025-01-01', GrossAmount: 600, AmountPaid: 600 }],
      relatedQuotes: [{ uuid: 'q1', Number: 8, Status: 'Outstanding', Date: '2025-01-05', GrossAmount: 100 }],
      relatedProjects: [{ uuid: 'p1', Number: 7, Name: 'Garden', Status: 'Active', StartDate: '2025-02-01' }]
    });
    assert.ok(html.includes('Acme Ltd'));
    assert.ok(html.includes('/invoice/read/i1'));
    assert.ok(html.includes('/quote/read/q1'));
    assert.ok(html.includes('/project/read/p1'));
    assert.ok(html.includes('Key account'));
  });

  it('customer: minimal data', async () => {
    const html = await render('customer', {
      title: 'Customer Details', basePath: 'customer', config: {},
      item: { uuid: 'u4', Id: 1, Name: 'Bare Ltd' }
    });
    assert.ok(html.includes('Bare Ltd'));
    assert.ok(html.includes('No invoices found'));
  });

  it('project: full data', async () => {
    const html = await render('project', {
      title: 'Project Details', basePath: 'project', config: { handlesDocuments: true },
      item: {
        uuid: 'u5', Number: 101, Name: 'New Build', Status: 'Active', Reference: 'REF-1',
        StartDate: '2025-03-01', EndDate: '2025-09-01', AssociatedQuotesCount: 2,
        ActualSalesAmount: 20000, ActualPurchasesAmount: 8000, WorkInProgressAmount: 3000,
        TargetSalesAmount: 25000, TargetPurchasesAmount: 10000,
        Description: 'Full landscaping works', Note: 'Phased delivery',
        documents: [{ name: 'plan.pdf', url: '/x/plan.pdf' }]
      },
      relatedCustomer: { uuid: 'c1', Name: 'Acme Ltd', Code: 'ACM01' },
      relatedContracts: [{ uuid: 'k1', title: 'Phase 1', status: 'In Progress', startDate: '2025-03-01' }]
    });
    assert.ok(html.includes('New Build'));
    assert.ok(html.includes('/contract/read/k1'));
    assert.ok(html.includes('plan.pdf'));
    assert.ok(html.includes('Full landscaping works'));
  });

  it('project: minimal data', async () => {
    const html = await render('project', {
      title: 'Project Details', basePath: 'project', config: {},
      item: { uuid: 'u5', Number: 5, Status: 'Completed' }
    });
    assert.ok(html.includes('No contracts linked'));
  });

  it('employee: full data', async () => {
    const html = await render('employee', {
      title: 'Employee Details', basePath: 'employee', config: { handlesDocuments: true },
      item: {
        uuid: 'u6', _id: 'e1', name: 'Jane Doe', status: 'active', type: 'employee',
        ir35: 'inside', position: 'Site Manager', email: 'jane@test.dev', phoneNumber: '0777',
        hourlyRate: 18.5, dailyRate: { $numberDecimal: '150' }, hireDate: '2023-01-09',
        createdAt: '2023-01-01', documents: []
      },
      relatedManager: { uuid: 'm1', name: 'Boss Person' },
      relatedLinkedSupplier: { uuid: 's9', Name: 'Jane Contracting' },
      relatedVehicles: [{ uuid: 'v1', registrationNumber: 'AB12 CDE', make: 'Ford', model: 'Transit', year: 2021, availabilityStatus: 'In Use' }],
      relatedHolidayRequests: [{ uuid: 'h1', startDate: '2025-07-01', endDate: '2025-07-05', daysRequested: 5, leaveType: 'annual', status: 'approved' }],
      relatedHolidayEntitlements: [{ uuid: 'he1', periodStart: '2025-01-01', periodEnd: '2025-12-31', entitlementDays: 28, takenDays: 5, accruedDays: 14, carryOverDays: 2 }]
    });
    assert.ok(html.includes('Jane Doe'));
    assert.ok(html.includes('/employee/read/m1'));
    assert.ok(html.includes('/supplier/read/s9'));
    assert.ok(html.includes('AB12 CDE'));
    assert.ok(html.includes('£150.00'), 'Decimal128-style dailyRate should format');
    assert.ok(!html.includes('payroll'), 'payroll settings must not leak into the employee view');
  });

  it('employee: minimal data', async () => {
    const html = await render('employee', {
      title: 'Employee Details', basePath: 'employee', config: {},
      item: { uuid: 'u6', _id: 'e2', name: 'New Starter', status: 'inactive' }
    });
    assert.ok(html.includes('New Starter'));
  });

  it('supplier: CIS subcontractor with purchases and calendars', async () => {
    const html = await render('supplier', {
      title: 'Supplier Details', basePath: 'supplier', config: {},
      item: {
        uuid: 'u7', Name: 'Subbie Ltd', Code: 'SUB01', IsArchived: false,
        WithholdingTaxRate: 20, VatNumber: 'GB999', OutstandingBalance: 500,
        TotalPaidAmount: 12000, FirstPurchaseDate: '2024-05-01', LastPurchaseDate: '2026-06-01',
        Note: 'Groundworks crew',
        purchases: [
          {
            uuid: 'pp1', Number: 900, SupplierReference: 'INV-1', IssuedDate: '2025-06-15',
            Status: 'Paid', NetAmount: 1000, VATAmount: 200, GrossAmount: 1200,
            TaxYear: 2025, TaxMonth: 3,
            PaymentLines: [{ Date: '2025-06-20', Method: 'BACS', Amount: 1200 }]
          }
        ]
      }
    });
    assert.ok(html.includes('Subbie Ltd'));
    assert.ok(html.includes('CIS 20%'));
    assert.ok(html.includes('CIS Calendar — Paid'));
    assert.ok(html.includes('CIS Calendar — Issued'));
    assert.ok(html.includes('/purchase/read/pp1'));
    assert.ok(html.includes('/CIS/Dashboard/'));
    assert.ok(html.includes('Groundworks crew'));
  });

  it('supplier: plain supplier (no CIS) hides the calendars', async () => {
    const html = await render('supplier', {
      title: 'Supplier Details', basePath: 'supplier', config: {},
      item: { uuid: 'u7', Name: 'Plain Merchant', WithholdingTaxRate: null, purchases: [] }
    });
    assert.ok(html.includes('Plain Merchant'));
    assert.ok(!html.includes('CIS Calendar'));
    assert.ok(html.includes('No purchases found'));
  });

  it('vehicle: full data with logs and resolved links', async () => {
    const html = await render('vehicle', {
      title: 'Vehicle Details', basePath: 'vehicle', config: {},
      item: {
        uuid: 'u8', _id: 'v1', registrationNumber: 'AB12 CDE', make: 'Ford', model: 'Transit',
        year: 2021, color: 'White', fuelType: 'Diesel', bodyType: 'Van', transmission: 'Manual',
        engineSize: '2.0L', currentMileage: 48200, availabilityStatus: 'In Use',
        vehicleUsage: 'Site', assignedDepartment: 'Maintenance', ownershipStatus: 'Owned',
        purchaseDate: '2021-03-01', purchasePrice: 25000, insuranceProvider: 'Aviva',
        insuranceCost: 900, insuranceExpiryDate: '2026-11-01', motExpiryDate: '2026-10-15',
        roadTaxExpiryDate: '2026-08-01', roadTaxAmount: 320,
        lastServiceDate: '2026-01-10', nextServiceDueDate: '2026-07-10',
        vin: 'WF0XXX', engineNumber: 'ENG-1', motCertificateNumber: 'MOT-1',
        insurancePolicyNumber: 'POL-1', notes: 'Roof rack fitted',
        serviceHistory: [{ uuid: 'sv1', date: '2026-01-10', serviceType: 'MOT', provider: 'Kwik Fit', status: 'Completed', mileageAtService: 45000, totalCost: 54.85, passed: true }],
        fuelLogs: [{ uuid: 'fl1', date: '2026-06-01', fuelType: 'Diesel', litres: 62.4, totalCost: 92.1, mileageAtFillUp: 48000, station: 'Shell', paymentMethod: 'Fuel Card' }],
        mileageLogs: [{ uuid: 'ml1', date: '2026-06-02', tripPurpose: 'Site visit', startMileage: 48000, endMileage: 48060, distance: 60, startLocation: 'Yard', endLocation: 'Site A', claimable: true, claimAmount: 27 }]
      },
      relatedEmployee: { uuid: 'e1', name: 'Jane Doe' },
      relatedProject: { uuid: 'p1', Name: 'New Build', Number: 101 }
    });
    assert.ok(html.includes('AB12 CDE'));
    assert.ok(html.includes('/employee/read/e1'));
    assert.ok(html.includes('/project/read/p1'));
    assert.ok(html.includes('PASS'));
    assert.ok(html.includes('Shell'));
    assert.ok(html.includes('Yard → Site A'));
    assert.ok(html.includes('/vehicleFuelLog/create?vehicleId=v1'));
    assert.ok(html.includes('Roof rack fitted'));
  });

  it('vehicle: minimal data', async () => {
    const html = await render('vehicle', {
      title: 'Vehicle Details', basePath: 'vehicle', config: {},
      item: { uuid: 'u8', _id: 'v2', registrationNumber: 'XX99 YYY', availabilityStatus: 'Available' }
    });
    assert.ok(html.includes('XX99 YYY'));
    assert.ok(html.includes('No service records yet'));
    assert.ok(html.includes('No fuel logs yet'));
    assert.ok(html.includes('No mileage logs yet'));
  });
});
