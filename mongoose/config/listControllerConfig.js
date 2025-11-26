const { create } = require("connect-mongo");

module.exports = {
  assignment: {
    title: 'Assignments',
    linkField: 'title',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid'],
    sortField: 'createdAt',
    sortOrder: -1,
    department: ['management'],
    labelOverrides: {
      contractId: 'Contract'
    },
    fieldOrder: ['title', 'contractId', 'weekStart', 'status', 'estimatedHours', 'assignedEmployees', 'assignedSubcontractors'],
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
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid'],
    fieldOrder: ['date', 'type', 'employeeId', 'subcontractorId', 'hoursWorked', 'dayRate', 'payRate', 'locationId', 'projectId'],
    sortField: 'date',
    sortOrder: 1,
    department: ['management'],
    // Add tabs for common attendance categories with an 'All' option
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
      projectId: 'Project'
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
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid'],
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
    linkField: 'Name',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid', 'Website'],
    fieldOrder: ['Name', 'Code', 'DisplayName', 'Note', 'CreatedDate', 'LastUpdatedDate', 'FirstInvoiceDate', 'LastInvoiceDate', 'InvoiceCount', 'InvoicedNetAmount', 'InvoicedVATAmount', 'OutstandingBalance', 'TotalPaidAmount', 'DiscountRate', 'DefaultNominalCode', 'DefaultCustomerReference', 'VATNumber', 'IsRegisteredInEC', 'IsRegisteredOutsideEC', 'IsArchived', 'ReceivesWholesalePricing', 'ApplyWHT', 'WHTRate', 'PaymentTerms', 'Currency', 'Contacts', 'Addresses', 'DeliveryAddresses', 'CustomCheckBoxes', 'CustomTextBoxes', 'Email', 'EmailTemplateNumber', 'FaxNumber', 'MobileNumber'],
    sortField: 'Name',
    sortOrder: 1,
    department: ['kashflow'],
    deny: ['c', 'u', 'd'],
  },
  employee: {
    title: 'Employees',
    linkField: 'name',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid'],
    fieldOrder: ['name', 'email', 'phoneNumber', 'position', 'status', 'type', 'dailyRate', 'hourlyRate', 'hireDate', 'managerId'],
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
      managerId: 'Manager'
    },
    fieldTransforms: {
      managerId: {
        fromModel: 'employee',
        matchField: '_id',
        returnField: 'name',
        linkTo: (matched) => `/employee/read/${matched.uuid}`
      }
    },
  },
  holiday: {
    title: ' Government Holidays',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid'],
    fieldOrder: ['title', 'date', 'bunting', 'notes'],
    linkField: 'title',
    sortField: 'title',
    sortOrder: 1,
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
    fieldOrder: ['Number', 'CustomerId', 'CustomerName', 'CustomerReference', 'Currency', 'NetAmount', 'GrossAmount', 'VATAmount', 'AmountPaid', 'TotalPaidAmount', 'Paid', 'IssuedDate', 'DueDate', 'PaidDate', 'LastPaymentDate', 'Status', 'LineItems', 'PaymentLines', 'DeliveryAddress', 'Address', 'UseCustomDeliveryAddress', 'Permalink', 'PackingSlipPermalink', 'ReminderLetters', 'PreviousNumber', 'NextNumber', 'OverdueDays', 'AutomaticCreditControlEnabled', 'CustomerDiscount', 'EmailCount', 'InvoiceInECMemberState', 'InvoiceOutsideECMemberState', 'SuppressNumber', 'UpdateCustomerAddress'],
    title: 'Invoices',
    linkField: 'Number',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid', 'DeliveryAddress', 'UseCustomDeliveryAddress', 'Paid'],
    sortField: 'Number',
    sortOrder: 1,
    department: ['kashflow'],
    deny: ['c', 'd'],
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
    fieldOrder: ['Number', 'Id', 'Name', 'Description', 'Reference', 'CustomerCode', 'Status', 'Note'],
    title: 'Projects',
    linkField: 'Number',
    sortField: 'Number',
    sortOrder: 1,
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid', 'deletedAt', 'lastSeenRun'],
    department: ['kashflow'],
    deny: ['c', 'u', 'd'],
    handlesDocuments: true,
    labelOverrides: {
      CustomerCode: 'Customer',
      Number: 'Job Ref',
    },
    fieldTransforms: {
      CustomerCode: {
        fromModel: 'customer',
        matchField: 'Code',
        returnField: 'Name',
        linkTo: (matched) => `/customer/read/${matched.uuid}`,
      }
    },
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
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid'],
    fieldOrder: ['Number', 'CustomerId', 'CustomerName', 'Date', 'GrossAmount', 'NetAmount', 'VATAmount', 'CustomerReference', 'LineItems', 'Permalink', 'PreviousNumber', 'NextNumber', 'Status', 'Category', 'Currency', 'CustomerCode'],
    sortField: 'Number',
    sortOrder: 1,
    department: ['kashflow'],
    deny: ['c', 'u', 'd'],
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
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid', 'ReadableString','CISRCNetAmount', 'CISRCVatAmount','Permalink', 'PreviousNumber','IsCISReverseCharge','Type','SupplierCode', 'NextNumber', 'StockManagementApplicable', 'ProjectName','ProjectNumber', 'AdditionalFieldValue','SupplierId','FileCount', 'HomeCurrencyGrossAmount','IsWhtDeductionToBeApplied', 'Id', 'IsEmailSent', 'ProjectGrossAmount', 'TradeBorderType', 'VATReturnId', 'deletedAt', 'lastSeenRun', 'Currency'],
    fieldOrder: ['Number', 'SupplierName', 'SupplierReference','GrossAmount', 'NetAmount', 'VATAmount', 'Status', 'TotalPaidAmount', 'IssuedDate','DueAmount', 'DueDate'],
    sortField: 'Number',
    sortOrder: 1,
    department: ['kashflow'],
    deny: ['c', 'u', 'd'],
    labelOverrides: {
      Number: 'KashFlow Number',
      LineItems: 'Line Items',
      PaymentLines: 'Payments',
      SupplierId: 'Supplier'
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
  supplier: {
    title: 'Suppliers',
    linkField: 'Name',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'PaymentTerms'],
    fieldOrder: ['Name', 'Id', 'Code', 'Note', 'CreatedDate', 'LastUpdatedDate', 'FirstPurchaseDate', 'LastPurchaseDate', 'OutstandingBalance', 'TotalPaidAmount', 'DefaultNominalCode', 'VATNumber', 'IsRegisteredInEC', 'IsArchived', 'PaymentTerms', 'Currency', 'Contacts', 'Address', 'DeliveryAddresses', 'DefaultPdfTheme', 'PaymentMethod', 'CreateSupplierCodeIfDuplicate', 'CreateSupplierNameIfEmptyOrNull', 'UniqueEntityNumber', 'VatNumber', 'WithholdingTaxRate', 'WithholdingTaxReferences'],
    sortField: 'Name',
    sortOrder: 1,
    department: ['kashflow', 'construction-industry-scheme'],
    deny: ['c', 'u', 'd'],
    description: {
      manage: 'Manage suppliers and subcontractors.',
    },
  },
  task: {
    title: 'Tasks',
    linkField: 'title',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid', 'password'],
    sortField: 'title',
    sortOrder: 1,
    department: ['human-resources'],
  },
  user: {
    title: 'Users',
    linkField: 'username',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid', 'password', 'totpSecret', 'totpEnabled'],
    fieldOrder: ['username', 'email', 'role', 'employeeId', 'subcontractorId', 'clientId'],
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
    linkField: 'registrationNumber',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid'],
    sortField: 'registrationNumber',
    sortOrder: 1,
    department: ['management'],
  },
  holidayDismissal: {
    title: 'Dismissed Holidays',
    description: {
      manage: 'Manage company holidays'
    },
    linkField: 'uuid',
    sortField: 'dismissedAt',
    sortOrder: 1,
    department: ['human-resources'],
    deny: ['c', 'u'],
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
    sortOrder: 1,
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
  nominal: {
    title: 'Nominal Accounts',
    description: {
      manage: 'Manage nominal accounts (chart of accounts).'
    },
    linkField: 'Name',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid'],
    sortField: 'Code',
    sortOrder: 1,
    department: ['finance'],
    deny: ['c', 'u', 'd'],
  },
  note: {
    title: 'Notes',
    linkField: 'title',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid'],
    sortField: 'createdAt',
    sortOrder: -1,
    department: ['management'],
  },
};