const { create } = require("connect-mongo");

module.exports = {
  assignment: {
    title: 'Assignments',
    layout: 'rows',
    linkField: 'title',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid', 'description'],
    sortField: 'createdAt',
    sortOrder: -1,
    department: ['management'],
    labelOverrides: {
      contractId: 'Contract'
    },
    fieldOrder: ['title', 'contractId', 'weekStart', 'status', 'estimatedHours', 'assignedEmployees', 'assignedSubcontractors'],
    referenceFilters: {
      assignedSubcontractors: { WithholdingTaxRate: { $gte: 0 } },
    },
    fieldTransforms: {
      contractId: {
        fromModel: 'contract',
        matchField: '_id',
        returnField: 'title',
        linkTo: (matched) => `/contract/read/${matched.uuid}`
      },
      assignedEmployees: {
        fromModel: 'employee',
        matchField: '_id',
        returnField: 'name',
        linkTo: (matched) => `/employee/read/${matched.uuid}`
      },
      assignedSubcontractors: {
        fromModel: 'supplier',
        matchField: '_id',
        returnField: 'Name',
        linkTo: (matched) => `/supplier/read/${matched.uuid}`
      }
    }
  },
  attendance: {
    title: 'Attendances',
    linkField: 'date',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid', 'contractAssignmentId', 'overtimeRate', 'breakMinutes'],
    fieldOrder: ['date', 'type', 'status', 'employeeId', 'subcontractorId', 'hoursWorked', 'overtimeHours', 'dayRate', 'payRate', 'locationId', 'projectId', 'notes'],
    sortField: 'date',
    sortOrder: -1,
    department: ['management'],
    tabsby: 'type',
    tabsValues: [
      { value: 'all', label: 'All' },
      { value: 'work', label: 'Work' },
      { value: 'off', label: 'Off' },
      { value: 'holiday', label: 'Holiday' },
      { value: 'sick', label: 'Sick' },
      { value: 'training', label: 'Training' },
      { value: 'leave', label: 'Leave' }
    ],
    labelOverrides: {
      employeeId: 'Employee',
      subcontractorId: 'Subcontractor',
      locationId: 'Location',
      projectId: 'Project',
      overtimeHours: 'OT Hours',
      overtimeRate: 'OT Rate',
      breakMinutes: 'Break (mins)'
    },
    fieldTransforms: {
      employeeId: {
        fromModel: 'employee',
        matchField: '_id',
        returnField: 'name',
        linkTo: (matched) => `/employee/read/${matched.uuid}`
      },
      subcontractorId: {
        fromModel: 'supplier',
        matchField: '_id',
        returnField: 'Name',
        linkTo: (matched) => `/supplier/read/${matched.uuid}`
      },
      locationId: {
        fromModel: 'location',
        matchField: '_id',
        returnField: 'name',
        linkTo: (matched) => `/location/read/${matched.uuid}`
      },
      projectId: {
        fromModel: 'project',
        matchField: ['_id', 'Id'],
        returnField: 'Name',
        linkTo: (matched) => `/project/read/${matched.uuid}`
      }
    }
  },
  contract: {
    title: 'Contracts',
    layout: 'rows',
    linkField: 'title',
    labelOverrides: {
      uuid: 'Contract ID',
      title: 'Name',
      location: 'Site Location',
      status: 'Current Status',
      startDate: 'Start Date',
      endDate: 'End Date',
      projectId: 'Project',
      locationId: 'Location'
    },
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid', 'quoteId'],
    fieldOrder: ['title', 'status', 'startDate', 'endDate', 'location', 'projectId', 'locationId', 'notes'],
    sortField: 'createdAt',
    sortOrder: -1,
    department: ['management'],
    fieldTransforms: {
      projectId: {
        fromModel: 'project',
        matchField: ['_id', 'Id'],
        returnField: 'Name',
        linkTo: (matched) => `/project/read/${matched.uuid}`
      },
      locationId: {
        fromModel: 'location',
        matchField: '_id',
        returnField: 'name',
        linkTo: (matched) => `/location/read/${matched.uuid}`
      }
    }
  },
  customer: {
    title: 'Customers',
    layout: 'rows',
    linkField: 'Name',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid', 'Website',
      'Contacts', 'Addresses', 'DeliveryAddresses', 'CustomCheckBoxes', 'CustomTextBoxes', 'PaymentTerms', 'Currency',
      'Id', 'WHTReferences', 'AutoIncludeVATNumber', 'AverageDaysToPay', 'UseCustomDeliveryAddress',
      'AutomaticCreditControlEnabled', 'IsGoCardlessMandateSet', 'Key', 'Source',
      'ShowDiscount', 'CreateCustomerCodeIfDuplicate', 'CreateCustomerNameIfEmptyOrNull',
      'InvoiceFileFormat', 'OverrideInvoiceFileFormat', 'EnvelopeUrl', 'PDFThemeId', 'TelephoneNumber', 'UniqueEntityNumber',
      'DefaultNominalCode', 'EmailTemplateNumber', 'FaxNumber', 'MobileNumber', 'ReceivesWholesalePricing', 'ApplyWHT'],
    fieldOrder: [
      'Name', 'Code', 'Note',
      'OutstandingBalance', 'InvoicedNetAmount', 'TotalPaidAmount', 'InvoicedVATAmount',
      'IsArchived', 'InvoiceCount', 'DiscountRate', 'WHTRate',
      'CreatedDate', 'FirstInvoiceDate', 'LastInvoiceDate', 'LastUpdatedDate',
      'DisplayName', 'DefaultCustomerReference', 'VATNumber',
      'IsRegisteredInEC', 'IsRegisteredOutsideEC', 'Email',
    ],
    labelOverrides: {
      OutstandingBalance: 'Outstanding',
      InvoicedNetAmount: 'Net Invoiced',
      InvoicedVATAmount: 'VAT',
      TotalPaidAmount: 'Total Paid',
      InvoiceCount: 'Invoices',
      DiscountRate: 'Discount',
      WHTRate: 'WHT Rate',
      DefaultCustomerReference: 'Ref',
    },
    sortField: 'Name',
    sortOrder: 1,
    department: ['kashflow'],
    deny: ['c', 'u', 'd'],
    filters: [
      { field: 'IsArchived', label: 'Status', type: 'boolean', falseLabel: 'Active', trueLabel: 'Archived' },
      { field: 'OutstandingBalance', label: 'Outstanding', type: 'numberrange' },
      { field: 'InvoicedNetAmount', label: 'Net Invoiced', type: 'numberrange' },
    ],
  },
  employee: {
    title: 'Employees',
    layout: 'rows',
    linkField: 'name',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid', 'contactName', 'contactNumber', 'contract', 'holidayPolicy'],
    fieldOrder: ['name', 'email', 'phoneNumber', 'position', 'status', 'type', 'ir35', 'definedRate', 'dailyRate', 'weeklyRate', 'monthlyRate', 'yearlyRate', 'hourlyRate', 'hireDate', 'managerId', 'subcontractorSupplierId'],
    sortField: 'name',
    sortOrder: 1,
    department: ['payroll', 'human-resources'],
    handlesDocuments: true,
    tabsby: 'status',
    tabsValues: [
      { value: 'all', label: 'All' },
      { value: 'active', label: 'Active' },
      { value: 'inactive', label: 'Inactive' },
    ],
    labelOverrides: {
      phoneNumber: 'Number',
      managerId: 'Manager',
      ir35: 'IR35',
      subcontractorSupplierId: 'Linked Supplier'
    },
    filters: [
      { field: 'status', label: 'Status', type: 'select', options: [
        { label: 'Active', value: 'active' },
        { label: 'Inactive', value: 'inactive' },
      ]},
      { field: 'type', label: 'Type', type: 'select', options: [
        { label: 'Employee', value: 'employee' },
        { label: 'Subcontractor', value: 'subcontractor' },
      ]},
      { field: 'ir35', label: 'IR35', type: 'select', options: [
        { label: 'Inside', value: 'inside' },
        { label: 'Outside', value: 'outside' },
      ]},
    ],
    fieldTransforms: {
      managerId: {
        fromModel: 'employee',
        matchField: '_id',
        returnField: 'name',
        linkTo: (matched) => `/employee/read/${matched.uuid}`
      },
      subcontractorSupplierId: {
        fromModel: 'supplier',
        matchField: '_id',
        returnField: 'Name',
        linkTo: (matched) => `/supplier/read/${matched.uuid}`
      }
    },
  },
  holiday: {
    title: ' Government Holidays',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid'],
    fieldOrder: ['title', 'date', 'division', 'bunting', 'notes'],
    linkField: 'title',
    sortField: 'title',
    sortOrder: -1,
    department: ['human-resources'],
    deny: ['c', 'u', 'd'],
    description: {
      manage: 'Read government holidays.',
    },
    tabsby: 'division',
    tabsValues: [
      { value: 'all', label: 'All' },
      { value: 'scotland', label: 'Scotland' },
      { value: 'england-and-wales', label: 'England and Wales' },
      { value: 'northern-ireland', label: 'Northern Ireland' }
    ],
  },
  invoice: {
    title: 'Invoices',
    linkField: 'Number',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid',
      // Arrays / objects — not useful in a list view
      'LineItems', 'PaymentLines', 'Address', 'DeliveryAddress', 'ReminderLetters',
      // Internal KashFlow IDs / keys
      'Id', 'CustomerKey', 'CustomerCode',
      // Duplicate / redundant amount fields
      'Paid', 'HomeCurrencyGrossAmount', 'HomeCurrencyVATAmount', 'DueAmount', 'FormattedDueAmount',
      // Linking / navigation fields
      'PreviousNumber', 'NextNumber', 'ProjectNumber', 'ProjectName', 'ProjectGrossAmount',
      'Permalink', 'PackingSlipPermalink', 'SuppressNumber', 'PayOnlinePaymentProcessor',
      // Customer contact detail (too granular)
      'CustomerContactName', 'CustomerContactFirstName', 'CustomerContactLastName',
      // Misc flags not needed in list
      'CreatedDate', 'Type', 'FileCount', 'IsArchived', 'IsCISReverseCharge', 'IsWhtDeductionToBeApplied',
      'CISRCNetAmount', 'CISRCVatAmount', 'TradeBorderType',
      'UpdateCustomerDeliveryAddress', 'UseCustomDeliveryAddress', 'VATNumber', 'VATReturnId'],
    fieldOrder: ['Number', 'CustomerId', 'CustomerName', 'CustomerReference', 'Currency',
      'NetAmount', 'GrossAmount', 'VATAmount', 'AmountPaid', 'TotalPaidAmount',
      'IssuedDate', 'DueDate', 'PaidDate', 'LastPaymentDate',
      'Status', 'OverdueDays', 'AutomaticCreditControlEnabled', 'CustomerDiscount',
      'EmailCount', 'InvoiceInECMemberState', 'InvoiceOutsideECMemberState', 'UpdateCustomerAddress'],
    sortField: 'Number',
    sortOrder: -1,
    department: ['kashflow'],
    deny: ['c', 'u', 'd'],
    filters: [
      { field: 'Status', label: 'Status', type: 'select', options: [
        { label: 'Outstanding', value: 'Outstanding' },
        { label: 'Paid', value: 'Paid' },
        { label: 'Overdue', value: 'Overdue' },
        { label: 'Credited', value: 'Credited' },
        { label: 'Cancelled', value: 'Cancelled' },
      ]},
      { field: 'IssuedDate', label: 'Issued Date', type: 'daterange' },
      { field: 'GrossAmount', label: 'Gross Amount', type: 'numberrange' },
    ],
    labelOverrides: {
      Number: 'KashFlow Number',
      CustomerId: 'Customer'
    },
    fieldTransforms: {
      CustomerId: {
        fromModel: 'customer',
        matchField: 'Id',
        returnField: 'Name',
        linkTo: (matched) => `/customer/read/${matched.uuid}`
      },
      Number: {
        fromModel: 'invoice',
        matchField: 'Number',
        returnField: 'Number',
        linkTo: (matched) => `/invoice/read/${matched.uuid}`
      },
    },
  },
  location: {
    title: 'Locations',
    layout: 'rows',
    linkField: 'name',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid'],
    fieldOrder: ['name', 'address', 'city', 'postalCode', 'country', 'latitude', 'longitude'],
    sortField: 'name',
    sortOrder: 1,
    department: ['management'],
  },
  meta: {
    deny: ['c', 'r', 'u', 'd', 'l'],
  },
  project: {
    fieldOrder: [
      'Number', 'Name', 'Status', 'CustomerCode', 'CustomerName',
      'Reference', 'Description', 'Note',
      'StartDate', 'EndDate',
      'ActualSalesAmount', 'ActualPurchasesAmount', 'WorkInProgressAmount',
      'TargetSalesAmount', 'TargetPurchasesAmount', 'AssociatedQuotesCount',
    ],
    title: 'Projects',
    layout: 'rows',
    linkField: 'Number',
    sortField: 'Number',
    sortOrder: -1,
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid', 'deletedAt', 'lastSeenRun',
      // Internal KashFlow ID (Number is the public job ref)
      'Id',
      // VAT sub-amounts — too granular for list view
      'ExcludeVAT', 'ActualSalesVATAmount', 'ActualPurchasesVATAmount', 'ActualJournalsAmount'],
    department: ['kashflow'],
    deny: ['c', 'u', 'd'],
    handlesDocuments: true,
    labelOverrides: {
      CustomerCode: 'Customer',
      CustomerName: 'Customer Name',
      Number: 'Job Ref',
      StartDate: 'Start',
      EndDate: 'End',
      ActualSalesAmount: 'Actual Sales',
      ActualPurchasesAmount: 'Actual Purchases',
      WorkInProgressAmount: 'WIP',
      TargetSalesAmount: 'Target Sales',
      TargetPurchasesAmount: 'Target Purchases',
      AssociatedQuotesCount: 'Quotes',
    },
    fieldTransforms: {
      CustomerCode: {
        fromModel: 'customer',
        matchField: 'Code',
        returnField: 'Name',
        linkTo: (matched) => `/customer/read/${matched.uuid}`,
      }
    },
    filters: [
      { field: 'Status', label: 'Status', type: 'select', options: [
        { label: 'Active', value: 'Active' },
        { label: 'Archived', value: 'Archived' },
        { label: 'Completed', value: 'Completed' },
      ]},
      { field: 'StartDate', label: 'Start Date', type: 'daterange' },
      { field: 'ActualSalesAmount', label: 'Actual Sales', type: 'numberrange' },
    ],
    tabsby: 'Status',
    tabsValues: [
      { value: 'all', label: 'All' },
      { value: 'Active', label: 'Active' },
      { value: 'Archived', label: 'Archived' },
      { value: 'Completed', label: 'Completed' }
    ],
    description: {
      manage: 'Manage projects and their documents.',
    },
  },
  quote: {
    title: 'Quotes',
    linkField: 'Number',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid',
      // Arrays / objects
      'LineItems', 'Addresses', 'DeliveryAddresses', 'UseCustomDeliveryAddress',
      // Internal / redundant
      'Id', 'HomeCurrencyGrossAmount', 'FileCount', 'IsEmailSent', 'SuppressAmount',
      'ProjectNumber', 'ProjectName', 'Permalink', 'PreviousNumber', 'NextNumber'],
    fieldOrder: ['Number', 'CustomerId', 'CustomerName', 'CustomerCode', 'CustomerReference',
      'Date', 'GrossAmount', 'NetAmount', 'VATAmount',
      'Status', 'Category', 'Currency'],
    sortField: 'Number',
    sortOrder: -1,
    department: ['kashflow'],
    deny: ['c', 'u', 'd'],
    filters: [
      { field: 'Status', label: 'Status', type: 'select', options: [
        { label: 'Outstanding', value: 'Outstanding' },
        { label: 'Accepted', value: 'Accepted' },
        { label: 'Declined', value: 'Declined' },
        { label: 'Draft', value: 'Draft' },
        { label: 'Cancelled', value: 'Cancelled' },
      ]},
      { field: 'Date', label: 'Date', type: 'daterange' },
      { field: 'GrossAmount', label: 'Gross Amount', type: 'numberrange' },
    ],
    tabsby: 'Category.Name',
    tabsDynamic: true,
    labelOverrides: {
      Number: 'Quote Ref',
      CustomerId: 'Customer'
    },
    fieldTransforms: {
      CustomerId: {
        fromModel: 'customer',
        matchField: 'Id',
        returnField: 'Name',
        linkTo: (matched) => `/customer/read/${matched.uuid}`
      }
    },
  },
  purchase: {
    title: 'Purchases',
    linkField: 'Number',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid',
      // Arrays / objects
      'LineItems',
      // Internal / redundant fields
      'ReadableString', 'CISRCNetAmount', 'CISRCVatAmount', 'Permalink', 'PreviousNumber',
      'IsCISReverseCharge', 'Type', 'SupplierCode', 'NextNumber', 'StockManagementApplicable',
      'ProjectName', 'ProjectNumber', 'AdditionalFieldValue', 'SupplierId', 'FileCount',
      'HomeCurrencyGrossAmount', 'IsWhtDeductionToBeApplied', 'Id', 'IsEmailSent',
      'ProjectGrossAmount', 'TradeBorderType', 'VATReturnId', 'deletedAt', 'lastSeenRun',
      'Currency', 'number', 'OverdueDays', 'SubmissionDate', 'TaxMonth', 'TaxYear',
      'PurchaseInECMemberState', 'createdByRunId'],
    fieldOrder: ['Number', 'SupplierName', 'SupplierReference', 'GrossAmount', 'NetAmount', 'VATAmount', 'Status', 'TotalPaidAmount', 'IssuedDate', 'DueAmount', 'DueDate', 'PaidDate'],
    strictOrder: true,
    searchFields: ['Number'],
    sortField: 'Number',
    sortOrder: -1,
    department: ['kashflow'],
    deny: ['c', 'u', 'd'],
    filters: [
      { field: 'Status', label: 'Status', type: 'select', options: [
        { label: 'Outstanding', value: 'Outstanding' },
        { label: 'Paid', value: 'Paid' },
        { label: 'Overdue', value: 'Overdue' },
        { label: 'Cancelled', value: 'Cancelled' },
      ]},
      { field: 'IssuedDate', label: 'Issued Date', type: 'daterange' },
      { field: 'GrossAmount', label: 'Gross Amount', type: 'numberrange' },
    ],
    labelOverrides: {
      Number: 'KashFlow Number',
      PaymentLines: 'Payments',
      SupplierId: 'Supplier',
      syncedAt: 'Last Synced',
      detailSyncedAt: 'Detail Last Synced',
    },
    fieldTransforms: {
      SupplierId: {
        fromModel: 'supplier',
        matchField: 'Id',
        returnField: 'Name',
        linkTo: (matched) => `/supplier/read/${matched.uuid}`
      }
    },
  },
  session: {
    deny: ['c', 'r', 'u', 'd', 'l'],
  },
  subcontractor: {
    aliasOf: 'supplier',
    layout: 'rows',
    basePath: 'supplier',
    // OLD: baseFilter: { Subcontractor: true },
    baseFilter: { WithholdingTaxRate: { $gte: 0 } },
    title: 'Subcontractors',
    linkField: 'Name',
    // OLD: hideFields included 'Subcontractor', 'IsSubcontractor' and hid 'WithholdingTaxRate', 'WithholdingTaxReferences'
    hideFields: ['_id', 'createdAt', 'updatedAt', 'PaymentTerms', 'uuid', 'Website', 'Currency', 'DefaultPdfTheme', 'PaymentMethod', 'Id', 'IsRegisteredInEC', 'IsArchived', 'CreateSupplierCodeIfDuplicate', 'CreateSupplierNameIfEmptyOrNull',
      'WithholdingTaxReferences', 'Contacts', 'Address', 'DeliveryAddresses', 'BankAccount',
      'ApplyWithholdingTax', 'BilledNetAmount', 'BilledVatAmount', 'DefaultVatRate',
      'DoesSupplierHasTransactionsInVATReturn', 'IsCISReverseCharge', 'IsVatRateEnabled',
      'SourceName', 'TradeBorderType', 'UsesDefaultPdftTheme', 'VatExempt',
      'Subcontractor', 'IsSubcontractor', 'CISRate', 'CISNumber'],
    fieldOrder: ['Name', 'Code', 'WithholdingTaxRate', 'Note', 'OutstandingBalance', 'TotalPaidAmount', 'VatNumber'],
    labelOverrides: {
      WithholdingTaxRate: 'WHT Rate',
      OutstandingBalance: 'Outstanding',
      TotalPaidAmount: 'Total Paid',
      VatNumber: 'VAT No.',
    },
    searchFields: ['Name', 'Code'],
    sortField: 'Name',
    sortOrder: 1,
    department: ['construction-industry-scheme'],
    deny: ['c', 'u', 'd'],
    filters: [
      { field: 'WithholdingTaxRate', label: 'WHT Rate', type: 'select', options: [
        { label: '0%', value: 0 },
        { label: '20%', value: 20 },
        { label: '30%', value: 30 },
      ]},
      { field: 'OutstandingBalance', label: 'Outstanding', type: 'numberrange' },
    ],
    headerActions: [
      { label: 'Edit CIS Details', href: '/subcontractor/assign', icon: 'bi bi-pencil-square', class: 'bg-green-600 hover:bg-green-700' },
    ],
    description: {
      manage: 'Manage subcontractors (suppliers with WithholdingTaxRate set).',
    },
  },
  supplier: {
    title: 'Suppliers',
    layout: 'rows',
    linkField: 'Name',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'PaymentTerms', 'uuid', 'Website', 'Currency', 'DefaultPdfTheme', 'PaymentMethod', 'Id',
      'Contacts', 'Address', 'DeliveryAddresses', 'WithholdingTaxReferences', 'BankAccount',
      'ApplyWithholdingTax', 'BilledNetAmount', 'BilledVatAmount', 'DefaultVatRate',
      'DoesSupplierHasTransactionsInVATReturn', 'IsCISReverseCharge', 'IsVatRateEnabled',
      'SourceName', 'TradeBorderType', 'UsesDefaultPdftTheme', 'VatExempt',
      'Subcontractor', 'IsSubcontractor', 'CISRate', 'CISNumber'],
    fieldOrder: [
      'Name', 'Code', 'Note',
      'OutstandingBalance', 'TotalPaidAmount',
      'WithholdingTaxRate', 'IsArchived',
      'VatNumber', 'CreatedDate', 'FirstPurchaseDate', 'LastPurchaseDate', 'LastUpdatedDate',
      'DefaultNominalCode', 'IsRegisteredInEC', 'CreateSupplierCodeIfDuplicate', 'CreateSupplierNameIfEmptyOrNull', 'UniqueEntityNumber',
    ],
    labelOverrides: {
      OutstandingBalance: 'Outstanding',
      TotalPaidAmount: 'Total Paid',
      WithholdingTaxRate: 'WHT Rate',
      VatNumber: 'VAT No.',
      DefaultNominalCode: 'Nominal',
    },
    sortField: 'Name',
    sortOrder: 1,
    department: ['kashflow', 'construction-industry-scheme'],
    deny: ['c', 'u', 'd'],
    filters: [
      { field: 'IsArchived', label: 'Status', type: 'boolean', falseLabel: 'Active', trueLabel: 'Archived' },
      { field: 'WithholdingTaxRate', label: 'WHT Rate', type: 'select', options: [
        { label: 'None', value: '' },
        { label: '0%', value: 0 },
        { label: '20%', value: 20 },
        { label: '30%', value: 30 },
      ]},
      { field: 'OutstandingBalance', label: 'Outstanding', type: 'numberrange' },
    ],
    description: {
      manage: 'Manage suppliers and subcontractors.',
    },
  },
  task: {
    title: 'Tasks',
    layout: 'rows',
    linkField: 'title',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid'],
    fieldOrder: ['title', 'description', 'dueDate', 'recurrence', 'completed', 'userId', 'contractId'],
    sortField: 'title',
    sortOrder: -1,
    department: ['human-resources'],
    labelOverrides: {
      userId: 'User',
      contractId: 'Contract',
      dueDate: 'Due Date'
    },
    fieldTransforms: {
      userId: {
        fromModel: 'user',
        matchField: '_id',
        returnField: 'username',
        linkTo: (matched) => `/user/read/${matched.uuid}`
      },
      contractId: {
        fromModel: 'contract',
        matchField: '_id',
        returnField: 'title',
        linkTo: (matched) => `/contract/read/${matched.uuid}`
      }
    }
  },
  user: {
    title: 'Users',
    linkField: 'username',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid', 'password', 'totpSecret', 'totpEnabled', 'emailVerificationToken', 'emailVerificationExpires', 'customPermissions'],
    fieldOrder: ['username', 'email', 'emailVerified', 'role', 'employeeId', 'subcontractorId', 'clientId'],
    sortField: 'username',
    sortOrder: 1,
    department: ['human-resources'],
    labelOverrides: {
      employeeId: 'Employee',
      subcontractorId: 'Subcontractor',
      clientId: 'Client'
    },
    fieldTransforms: {
      employeeId: {
        fromModel: 'employee',
        matchField: '_id',
        returnField: 'name',
        linkTo: (matched) => `/employee/read/${matched.uuid}`
      },
      subcontractorId: {
        fromModel: 'supplier',
        matchField: '_id',
        returnField: 'Name',
        linkTo: (matched) => `/supplier/read/${matched.uuid}`
      },
      clientId: {
        fromModel: 'customer',
        matchField: '_id',
        returnField: 'Name',
        linkTo: (matched) => `/customer/read/${matched.uuid}`
      }
    }
  },
  employeeHoliday: {
    title: 'Employee Holiday',
    // Show periodStart as the clickable link into the record
    linkField: 'periodStart',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid'],
    fieldOrder: [
      'employeeId',
      'periodStart', 'periodEnd',
      'entitlementType', 'entitlementDays', 'entitlementHours',
      'carryOverDays', 'carryOverHours',
      'accrualMethod', 'accrualPercent',
      'accruedDays', 'accruedHours',
      'takenDays', 'takenHours',
      'bankHolidaysCounted',
      'notes'
    ],
    sortField: 'periodStart',
    sortOrder: -1,
    department: ['human-resources', 'payroll'],
    labelOverrides: {
      employeeId: 'Employee',
      entitlementDays: 'Entitlement (Days)',
      entitlementHours: 'Entitlement (Hours)',
      carryOverDays: 'Carry Over (Days)',
      carryOverHours: 'Carry Over (Hours)',
      accrualMethod: 'Accrual Method',
      accrualPercent: 'Accrual %',
      accruedDays: 'Accrued (Days)',
      accruedHours: 'Accrued (Hours)',
      takenDays: 'Taken (Days)',
      takenHours: 'Taken (Hours)',
      bankHolidaysCounted: 'Includes Bank Holidays'
    },
    fieldTransforms: {
      employeeId: {
        fromModel: 'employee',
        matchField: '_id',
        returnField: 'name',
        linkTo: (matched) => `/employee/read/${matched.uuid}`
      }
    },
    description: {
      create: 'Create a new employee holiday entitlement/accrual record.',
      manage: 'Manage employee holiday entitlement and accrual records.',
    },
  },
  vehicle: {
    title: 'Vehicles',
    layout: 'rows',
    description: {
      create: 'Register a new vehicle in the fleet.',
      manage: 'Manage company fleet vehicles, compliance dates and assignments.',
    },
    linkField: 'registrationNumber',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid', 'vin', 'engineNumber',
      'motCertificateNumber', 'insuranceCost', 'purchasePrice', 'leaseMonthlyCost',
      'leaseProvider', 'grossWeight', 'payload', 'lastServiceMileage', 'nextServiceDueMileage',
      'lastMileageUpdate', 'insurancePolicyNumber', 'notes'],
    fieldOrder: [
      'registrationNumber', 'make', 'model', 'year', 'color',
      'fuelType', 'bodyType', 'transmission', 'engineSize',
      'currentMileage', 'availabilityStatus', 'vehicleUsage',
      'employeeId', 'subcontractorId', 'projectId', 'assignedDepartment',
      'ownershipStatus', 'purchaseDate', 'leaseExpiryDate',
      'insuranceProvider', 'insuranceExpiryDate',
      'motExpiryDate', 'roadTaxExpiryDate', 'roadTaxAmount',
      'lastServiceDate', 'nextServiceDueDate'
    ],
    sortField: 'registrationNumber',
    sortOrder: 1,
    department: ['maintenance'],
    tabsby: 'availabilityStatus',
    tabsValues: [
      { value: 'all', label: 'All' },
      { value: 'Available', label: 'Available' },
      { value: 'In Use', label: 'In Use' },
      { value: 'Under Maintenance', label: 'Maintenance' },
      { value: 'Out of Service', label: 'Out of Service' },
      { value: 'Disposed', label: 'Disposed' }
    ],
    labelOverrides: {
      registrationNumber: 'Reg',
      employeeId: 'Assigned Employee',
      subcontractorId: 'Assigned Subcontractor',
      projectId: 'Project',
      currentMileage: 'Mileage',
      availabilityStatus: 'Status',
      vehicleUsage: 'Usage',
      ownershipStatus: 'Ownership',
      motExpiryDate: 'MOT Expiry',
      insuranceExpiryDate: 'Insurance Expiry',
      roadTaxExpiryDate: 'Tax Expiry',
      roadTaxAmount: 'Tax Cost',
      insuranceCost: 'Insurance Cost',
      lastServiceDate: 'Last Service',
      nextServiceDueDate: 'Next Service Due',
      assignedDepartment: 'Department'
    },
    fieldTransforms: {
      employeeId: {
        fromModel: 'employee',
        matchField: '_id',
        returnField: 'name',
        linkTo: (matched) => `/employee/read/${matched.uuid}`
      },
      subcontractorId: {
        fromModel: 'supplier',
        matchField: '_id',
        returnField: 'Name',
        linkTo: (matched) => `/supplier/read/${matched.uuid}`
      },
      projectId: {
        fromModel: 'project',
        matchField: ['_id', 'Id'],
        returnField: 'Name',
        linkTo: (matched) => `/project/read/${matched.uuid}`
      }
    },
  },
  holidayDismissal: {
    title: 'Dismissed Holidays',
    description: {
      manage: 'Manage company holidays'
    },
    linkField: 'uuid',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid'],
    fieldOrder: ['userId', 'holidayId', 'dismissedAt'],
    sortField: 'dismissedAt',
    sortOrder: -1,
    department: ['human-resources'],
    deny: ['c', 'u'],
    labelOverrides: {
      userId: 'User',
      holidayId: 'Holiday',
      dismissedAt: 'Dismissed'
    },
    fieldTransforms: {
      userId: {
        fromModel: 'user',
        matchField: '_id',
        returnField: 'username',
        linkTo: (matched) => `/user/read/${matched.uuid}`
      },
      holidayId: {
        fromModel: 'holiday',
        matchField: '_id',
        returnField: 'title',
        linkTo: (matched) => `/holiday/read/${matched.uuid}`
      }
    }
  },
  holidayCustom: {
    title: 'Company Holidays',
    description: {
      create: 'Create a company holiday',
      manage: 'Manage company holidays'
    },
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid'],
    linkField: 'title',
    sortField: 'title',
    sortOrder: -1,
    department: ['human-resources'],
  },
  OcrDocument: {
    title: 'OCR Documents',
    description: {
      manage: 'Manage OCR documents imported from Paperless-ngx.'
    },
    pathOverride: '/paperless',
    linkField: 'title',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid', 'contentHash', 'fetchedAt', 'error', 'paperlessId', 'archivedFileName', 'originalFileName','ocrText'],
    fieldOrder: ['title', 'documentType','modified', 'fetchedAt', 'error'],
    sortField: 'modified',
    sortOrder: -1,
    department: ['paperless'],
    deny: ['c', 'u', 'd'],
  },
  OcrDocumentIngest: {
    title: 'OCR Ingest Log',
    description: {
      manage: 'Paperless-ngx document ingest status and sync tracking.'
    },
    linkField: 'paperlessId',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'lastContentHash'],
    fieldOrder: ['paperlessId', 'status', 'lastModified', 'lastFetchedAt', 'error'],
    sortField: 'lastFetchedAt',
    sortOrder: -1,
    department: ['paperless'],
    deny: ['c', 'u', 'd'],
  },
  nominal: {
    title: 'Nominal Accounts',
    description: {
      manage: 'Manage nominal accounts (chart of accounts).'
    },
    linkField: 'Name',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid',
      // Internal / low-value fields
      'DefaultProduct', 'PlOption', 'BsOption', 'IRISCoAName', 'IsIRISCoA',
      'Sa103Code', 'NomType', 'Special', 'AllowDelete', 'AutoFillLineItem',
      'WholeSalePrice', 'StockWarningQuantity', 'ManageStockLevel', 'QuantityInStock',
      'DigitalService', 'ComplianceCode', 'ControlAccountClassification', 'IsProduct'],
    fieldOrder: ['Code', 'Name', 'Type', 'Description', 'Classification', 'VATRate', 'VATExempt', 'Price', 'Disallowed', 'Archived'],
    labelOverrides: {
      VATRate: 'VAT Rate',
      VATExempt: 'VAT Exempt',
    },
    sortField: 'Code',
    sortOrder: 1,
    department: ['finance'],
    deny: ['c', 'u', 'd'],
    tabsby: 'Type',
    tabsDynamic: true,
    filters: [
      { field: 'Archived', label: 'Status', type: 'boolean', falseLabel: 'Active', trueLabel: 'Archived' },
      { field: 'Disallowed', label: 'Disallowed', type: 'boolean', falseLabel: 'Allowed', trueLabel: 'Disallowed' },
    ],
  },
  note: {
    title: 'Notes',
    linkField: 'ObjectNumber',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid', 'Permalink'],
    fieldOrder: ['ObjectType', 'ObjectNumber', 'Number', 'Author', 'Date', 'Text', 'LastModifiedBy', 'CreatedDate', 'LastUpdatedDate'],
    labelOverrides: {
      ObjectType: 'Type',
      ObjectNumber: 'Object Ref',
      LastModifiedBy: 'Modified By',
      CreatedDate: 'Created',
      LastUpdatedDate: 'Last Updated',
    },
    sortField: 'CreatedDate',
    sortOrder: -1,
    department: ['management'],
    deny: ['c', 'u', 'd'],
    tabsby: 'ObjectType',
    tabsDynamic: true,
    filters: [
      { field: 'ObjectType', label: 'Type', type: 'select', options: [
        { label: 'Customer', value: 'Customer' },
        { label: 'Supplier', value: 'Supplier' },
        { label: 'Invoice', value: 'Invoice' },
        { label: 'Purchase', value: 'Purchase' },
        { label: 'Project', value: 'Project' },
      ]},
      { field: 'Date', label: 'Date', type: 'daterange' },
    ],
  },
  vatrate: {
    title: 'VAT Rates',
    description: {
      manage: 'KashFlow VAT rate definitions synced from the API.'
    },
    linkField: 'VATText',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid'],
    fieldOrder: ['VATId', 'VATRate', 'VATText', 'Rate', 'CountryCode'],
    sortField: 'VATId',
    sortOrder: 1,
    department: ['finance'],
    deny: ['c', 'u', 'd'],
  },
  vehicleFuelLog: {
    title: 'Fuel Logs',
    description: {
      create: 'Record a fuel fill-up for a vehicle.',
      manage: 'Track fuel receipts, costs and consumption across the fleet.',
    },
    linkField: 'date',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid', 'notes'],
    fieldOrder: [
      'date', 'vehicleId', 'fuelType', 'litres', 'costPerLitre', 'totalCost',
      'fullTank', 'mileageAtFillUp', 'station', 'location',
      'employeeId', 'subcontractorId', 'paymentMethod', 'receiptReference'
    ],
    sortField: 'date',
    sortOrder: -1,
    department: ['maintenance'],
    labelOverrides: {
      vehicleId: 'Vehicle',
      employeeId: 'Driver (Employee)',
      subcontractorId: 'Driver (Subcontractor)',
      litres: 'Litres',
      costPerLitre: 'Cost/Litre',
      totalCost: 'Total Cost',
      fullTank: 'Full Tank?',
      mileageAtFillUp: 'Mileage',
      paymentMethod: 'Payment',
      receiptReference: 'Receipt Ref'
    },
    fieldTransforms: {
      vehicleId: {
        fromModel: 'vehicle',
        matchField: '_id',
        returnField: 'registrationNumber',
        linkTo: (matched) => `/vehicle/read/${matched.uuid}`
      },
      employeeId: {
        fromModel: 'employee',
        matchField: '_id',
        returnField: 'name',
        linkTo: (matched) => `/employee/read/${matched.uuid}`
      },
      subcontractorId: {
        fromModel: 'supplier',
        matchField: '_id',
        returnField: 'Name',
        linkTo: (matched) => `/supplier/read/${matched.uuid}`
      }
    },
    tabsby: 'fuelType',
    tabsValues: [
      { value: 'all', label: 'All' },
      { value: 'Petrol', label: 'Petrol' },
      { value: 'Diesel', label: 'Diesel' },
      { value: 'Electric', label: 'Electric' },
      { value: 'AdBlue', label: 'AdBlue' }
    ],
  },
  vehicleMileageLog: {
    title: 'Mileage Logs',
    description: {
      create: 'Record a trip / odometer reading for a vehicle.',
      manage: 'Track mileage, trips and HMRC mileage claims.',
    },
    linkField: 'date',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid', 'notes', 'hmrcRate'],
    fieldOrder: [
      'date', 'vehicleId', 'employeeId', 'subcontractorId',
      'startLocation', 'endLocation', 'startMileage', 'endMileage', 'distance',
      'tripPurpose', 'description', 'projectId',
      'claimable', 'claimAmount'
    ],
    sortField: 'date',
    sortOrder: -1,
    department: ['maintenance'],
    labelOverrides: {
      vehicleId: 'Vehicle',
      employeeId: 'Driver (Employee)',
      subcontractorId: 'Driver (Subcontractor)',
      projectId: 'Project',
      startMileage: 'Start Miles',
      endMileage: 'End Miles',
      startLocation: 'From',
      endLocation: 'To',
      tripPurpose: 'Purpose',
      claimable: 'Claimable?',
      claimAmount: 'Claim (£)'
    },
    fieldTransforms: {
      vehicleId: {
        fromModel: 'vehicle',
        matchField: '_id',
        returnField: 'registrationNumber',
        linkTo: (matched) => `/vehicle/read/${matched.uuid}`
      },
      employeeId: {
        fromModel: 'employee',
        matchField: '_id',
        returnField: 'name',
        linkTo: (matched) => `/employee/read/${matched.uuid}`
      },
      subcontractorId: {
        fromModel: 'supplier',
        matchField: '_id',
        returnField: 'Name',
        linkTo: (matched) => `/supplier/read/${matched.uuid}`
      },
      projectId: {
        fromModel: 'project',
        matchField: ['_id', 'Id'],
        returnField: 'Name',
        linkTo: (matched) => `/project/read/${matched.uuid}`
      }
    },
    tabsby: 'tripPurpose',
    tabsValues: [
      { value: 'all', label: 'All' },
      { value: 'Business', label: 'Business' },
      { value: 'Site Visit', label: 'Site Visit' },
      { value: 'Delivery', label: 'Delivery' },
      { value: 'Client Meeting', label: 'Client Meeting' },
      { value: 'Commute', label: 'Commute' }
    ],
  },
  vehicleService: {
    title: 'Service History',
    description: {
      create: 'Record a service, MOT or repair for a vehicle.',
      manage: 'View and manage vehicle service history and costs.',
    },
    linkField: 'date',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid', 'notes', 'description',
      'providerContact', 'providerReference', 'invoiceReference',
      'partsReplaced', 'advisories'],
    fieldOrder: [
      'date', 'vehicleId', 'serviceType', 'status', 'provider',
      'mileageAtService', 'labourCost', 'partsCost', 'vatAmount', 'totalCost',
      'passed', 'paymentMethod',
      'nextServiceDueDate', 'nextServiceDueMileage'
    ],
    sortField: 'date',
    sortOrder: -1,
    department: ['maintenance'],
    labelOverrides: {
      vehicleId: 'Vehicle',
      serviceType: 'Type',
      mileageAtService: 'Mileage',
      labourCost: 'Labour',
      partsCost: 'Parts',
      vatAmount: 'VAT',
      totalCost: 'Total',
      passed: 'Passed?',
      paymentMethod: 'Payment',
      nextServiceDueDate: 'Next Due',
      nextServiceDueMileage: 'Next Due Miles'
    },
    fieldTransforms: {
      vehicleId: {
        fromModel: 'vehicle',
        matchField: '_id',
        returnField: 'registrationNumber',
        linkTo: (matched) => `/vehicle/read/${matched.uuid}`
      }
    },
    tabsby: 'serviceType',
    tabsValues: [
      { value: 'all', label: 'All' },
      { value: 'Full Service', label: 'Full Service' },
      { value: 'MOT', label: 'MOT' },
      { value: 'Tyre Replacement', label: 'Tyres' },
      { value: 'Brake Service', label: 'Brakes' },
      { value: 'Oil Change', label: 'Oil Change' },
      { value: 'Other', label: 'Other' }
    ],
  },
};