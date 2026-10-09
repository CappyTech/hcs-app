// Finance area: KashFlow sales and purchase ledgers (REST, written by hcs-sync).
// Money figures are sums over the same rows each figure's link opens.
const LIVE = { IsArchived: { $ne: true } };
const INVOICE_UNPAID = { ...LIVE, Status: { $nin: ['Paid', 'Credited', 'Cancelled'] } };
const PURCHASE_UNPAID = { Status: { $nin: ['Paid', 'Cancelled'] } };
const money = (field, label) => ({ field, label, format: 'money' });
// KashFlow's DueAmount isn't filled in by the sync (it reads £0.00 on unpaid
// invoices and purchases), so "still owed" is gross minus what's been paid.
const STILL_OWED = { $subtract: [{ $ifNull: ['$GrossAmount', 0] }, { $ifNull: ['$TotalPaidAmount', 0] }] };
const owedCol = (label) => ({ field: 'GrossAmount', minus: 'TotalPaidAmount', label, format: 'money' });

export default [
  {
    id: 'invoice',
    model: 'invoice',
    label: { one: 'Invoice', many: 'Invoices' },
    icon: 'bi-receipt',
    description: 'Sales invoices: what customers owe, what is late, and what came in.',
    parents: ['finance'],
    overviewPath: '/overview/invoice',
    listPath: '/invoices',
    figures: {
      owed: { label: 'Owed to us', sum: STILL_OWED, format: 'money', where: INVOICE_UNPAID },
      unpaid: { label: 'Unpaid invoices', where: INVOICE_UNPAID },
      overdue: { label: 'Overdue invoices', severity: 'critical', where: { ...INVOICE_UNPAID, DueDate: { $beforeNow: true } } },
      overdueValue: { label: 'Overdue value', sum: STILL_OWED, format: 'money', where: { ...INVOICE_UNPAID, DueDate: { $beforeNow: true } } },
      issued30: { label: 'Invoiced, last 30 days', sum: 'GrossAmount', format: 'money', where: { ...LIVE, IssuedDate: { $withinPastDays: 30 } } },
      paid30: { label: 'Paid to us, last 30 days', sum: 'GrossAmount', format: 'money', where: { ...LIVE, Status: 'Paid', PaidDate: { $withinPastDays: 30 } } },
    },
    summary: ['owed', 'overdue', 'overdueValue'],
    overview: {
      figures: ['owed', 'unpaid', 'overdue', 'overdueValue', 'issued30', 'paid30'],
      breakdowns: [{ label: 'By status', by: 'Status', where: LIVE }],
      lists: [
        { figure: 'overdue', sort: { DueDate: 1 }, limit: 10,
          columns: [{ field: 'Number', label: 'Invoice' }, { field: 'CustomerName', label: 'Customer' }, { field: 'DueDate', label: 'Was due', format: 'date' }, owedCol('Owed')] },
        { figure: 'issued30', sort: { IssuedDate: -1 }, limit: 10,
          columns: [{ field: 'Number', label: 'Invoice' }, { field: 'CustomerName', label: 'Customer' }, { field: 'IssuedDate', label: 'Issued', format: 'date' }, money('GrossAmount', 'Gross')] },
      ],
      related: ['customer.owing'],
    },
  },
  {
    id: 'purchase',
    model: 'purchase',
    label: { one: 'Purchase', many: 'Purchases' },
    icon: 'bi-bag',
    description: 'Purchase invoices: what we owe suppliers, and what is late.',
    parents: ['finance'],
    overviewPath: '/overview/purchase',
    listPath: '/purchases',
    figures: {
      owing: { label: 'We owe', sum: STILL_OWED, format: 'money', where: PURCHASE_UNPAID },
      unpaid: { label: 'Unpaid purchases', where: PURCHASE_UNPAID },
      overdue: { label: 'Overdue purchases', severity: 'critical', where: { ...PURCHASE_UNPAID, DueDate: { $beforeNow: true } } },
      overdueValue: { label: 'Overdue value', sum: STILL_OWED, format: 'money', where: { ...PURCHASE_UNPAID, DueDate: { $beforeNow: true } } },
      dueWeek: { label: 'Due in the next 7 days', severity: 'warning', where: { ...PURCHASE_UNPAID, DueDate: { $withinNextDays: 7 } } },
      received30: { label: 'Purchases, last 30 days', sum: 'GrossAmount', format: 'money', where: { IssuedDate: { $withinPastDays: 30 } } },
    },
    summary: ['owing', 'overdue', 'dueWeek'],
    overview: {
      figures: ['owing', 'unpaid', 'overdue', 'overdueValue', 'dueWeek', 'received30'],
      breakdowns: [{ label: 'By status', by: 'Status' }],
      lists: [
        { figure: 'overdue', sort: { DueDate: 1 }, limit: 10,
          columns: [{ field: 'Number', label: 'Purchase' }, { field: 'SupplierName', label: 'Supplier' }, { field: 'DueDate', label: 'Was due', format: 'date' }, owedCol('Owed')] },
        { figure: 'dueWeek', sort: { DueDate: 1 }, limit: 10,
          columns: [{ field: 'Number', label: 'Purchase' }, { field: 'SupplierName', label: 'Supplier' }, { field: 'DueDate', label: 'Due', format: 'date' }, owedCol('Owed')] },
      ],
      related: ['supplier.owed', 'subcontractor.owed'],
    },
  },
  {
    id: 'customer',
    model: 'customer',
    label: { one: 'Customer', many: 'Customers' },
    icon: 'bi-person-vcard',
    description: 'Who we invoice, who owes us, and how quickly they pay.',
    parents: ['finance'],
    overviewPath: '/overview/customer',
    listPath: '/customers',
    figures: {
      active: { label: 'Active customers', where: LIVE },
      owing: { label: 'Customers owing us', where: { ...LIVE, OutstandingBalance: { $gt: 0 } } },
      slowPayers: { label: 'Take over 60 days to pay', hint: 'Average days to pay over 60', severity: 'warning', where: { ...LIVE, AverageDaysToPay: { $gt: 60 } } },
      new90: { label: 'New in the last 90 days', where: { ...LIVE, CreatedDate: { $withinPastDays: 90 } } },
    },
    summary: ['active', 'owing'],
    overview: {
      figures: ['active', 'owing', 'slowPayers', 'new90'],
      lists: [
        { figure: 'owing', sort: { OutstandingBalance: -1 }, limit: 10,
          columns: [{ field: 'Name', label: 'Customer' }, money('OutstandingBalance', 'Owes us'), { field: 'AverageDaysToPay', label: 'Avg days to pay' }] },
        { figure: 'slowPayers', sort: { AverageDaysToPay: -1 }, limit: 10,
          columns: [{ field: 'Name', label: 'Customer' }, { field: 'AverageDaysToPay', label: 'Avg days to pay' }, money('OutstandingBalance', 'Owes us')] },
      ],
      related: ['invoice.overdue', 'quote.outstanding'],
    },
  },
  {
    id: 'supplier',
    model: 'supplier',
    label: { one: 'Supplier', many: 'Suppliers' },
    icon: 'bi-building',
    description: 'Everyone we buy from, including subcontractors.',
    parents: ['finance'],
    overviewPath: '/overview/supplier',
    listPath: '/suppliers',
    figures: {
      active: { label: 'Active suppliers', where: LIVE },
      owed: { label: 'Suppliers we owe', where: { ...LIVE, OutstandingBalance: { $gt: 0 } } },
      owedValue: { label: 'Owed to suppliers', sum: 'OutstandingBalance', format: 'money', where: { ...LIVE, OutstandingBalance: { $gt: 0 } } },
      dormant: { label: 'No purchase in a year', where: { ...LIVE, LastPurchaseDate: { $notAfterDays: -365 } } },
    },
    summary: ['active', 'owed', 'owedValue'],
    overview: {
      figures: ['active', 'owed', 'owedValue', 'dormant'],
      lists: [
        { figure: 'owed', sort: { OutstandingBalance: -1 }, limit: 10,
          columns: [{ field: 'Name', label: 'Supplier' }, { field: 'Code', label: 'Code' }, money('OutstandingBalance', 'We owe')] },
      ],
      related: ['subcontractor.active', 'purchase.overdue'],
    },
  },
  {
    id: 'quote',
    model: 'quote',
    label: { one: 'Quote', many: 'Quotes' },
    icon: 'bi-file-earmark-text',
    description: 'Quotes sent: waiting on an answer, accepted, declined.',
    parents: ['finance'],
    overviewPath: '/overview/quote',
    listPath: '/quotes',
    figures: {
      outstanding: { label: 'Waiting on an answer', where: { Status: 'Outstanding' } },
      outstandingValue: { label: 'Value waiting on an answer', sum: 'GrossAmount', format: 'money', where: { Status: 'Outstanding' } },
      stale: { label: 'Waiting over 30 days', severity: 'warning', where: { Status: 'Outstanding', Date: { $notAfterDays: -30 } } },
      accepted90: { label: 'Accepted, last 90 days', where: { Status: 'Accepted', Date: { $withinPastDays: 90 } } },
    },
    summary: ['outstanding', 'outstandingValue'],
    overview: {
      figures: ['outstanding', 'outstandingValue', 'stale', 'accepted90'],
      breakdowns: [{ label: 'Last year by status', by: 'Status', where: { Date: { $withinPastDays: 365 } } }],
      lists: [
        { figure: 'stale', sort: { Date: 1 }, limit: 10,
          columns: [{ field: 'Number', label: 'Quote' }, { field: 'CustomerName', label: 'Customer' }, { field: 'Date', label: 'Sent', format: 'date' }, money('GrossAmount', 'Gross')] },
      ],
    },
  },
];
