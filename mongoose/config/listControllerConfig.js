module.exports = {
  assignment: {
    title: 'Assignments',
    linkField: 'title',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid'],
    sortField: 'createdAt',
    sortOrder: -1,
    department: ['management'],
  },
  attendance: {
    title: 'Attendances',
    linkField: 'date',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid'],
    fieldOrder: ['date', 'type', 'employeeId', 'subcontractorId', 'hoursWorked', 'dayRate', 'payRate', 'locationId', 'projectId'],
    sortField: 'date',
    sortOrder: 1,
    department: ['management'],
    fieldTransforms: {
      employeeId: {
        fromModel: 'employee',
        matchField: '_id',
        returnField: 'name',
        linkTo: (matched) => `/employee/read/${matched.uuid}`
      },
      projectId: {
        fromModel: 'project',
        matchField: '_id',
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
    },
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid'],
    sortField: 'createdAt',
    sortOrder: -1,
    department: ['management'],
  },
  customer: {
    title: 'Customers',
    linkField: 'Name',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid', 'Discount', 'CountryName', 'Created', 'Updated', 'Website', 'Notes', 'CustomerID', 'Code'],
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
      { value: 'active', label: 'Active' },
      { value: 'inactive', label: 'Inactive' },
    ],
    labelOverrides: {
      phoneNumber: 'Number',
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
      { value: 'scotland', label: 'Scotland' },
      { value: 'england-and-wales', label: 'England and Wales' },
      { value: 'northern-ireland', label: 'Northern Ireland' }
    ],
  },
  invoice: {
    fieldOrder: ['Number', 'CustomerId', 'CustomerName', 'CustomerReference', 'Currency', 'NetAmount', 'GrossAmount', 'VATAmount', 'AmountPaid', 'TotalPaidAmount', 'Paid', 'IssuedDate', 'DueDate', 'PaidDate', 'LastPaymentDate', 'Status', 'LineItems', 'PaymentLines', 'DeliveryAddress', 'Address', 'UseCustomDeliveryAddress', 'Permalink', 'PackingSlipPermalink', 'ReminderLetters', 'PreviousNumber', 'NextNumber', 'OverdueDays', 'AutomaticCreditControlEnabled', 'CustomerDiscount', 'EmailCount', 'InvoiceInECMemberState', 'InvoiceOutsideECMemberState', 'SuppressNumber', 'UpdateCustomerAddress'],
    title: 'Invoices',
    linkField: 'Number',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid', 'InvoiceDBID', 'DeliveryAddress', 'CurrencyCode', 'ExchangeRate', 'PermaLink', 'UseCustomDeliveryAddress', 'ReadableString', 'EstimateCategory', 'CustomerID', 'Paid', 'CISRCNetAmount', 'CISRCVatAmount', 'IsCISReverseCharge', 'Customer', 'SuppressTotal'],
    sortField: 'Number',
    sortOrder: 1,
    department: ['kashflow'],
    deny: ['c', 'd'],
    labelOverrides: {
      InvoiceNumber: 'KashFlow Number',
    },
  },
  location: {
    title: 'Locations',
    linkField: 'name',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid'],
    sortField: 'name',
    sortOrder: 1,
    department: ['management'],
  },
  meta: {
    deny: ['c', 'r', 'u', 'd', 'l'],
  },
  project: {
    fieldOrder: ['Number', 'Id', 'Name', 'Description', 'Reference', 'CustomerCode', 'CustomerName', 'StartDate', 'EndDate', 'Status', 'StatusName', 'Note', 'ActualJournalsAmount', 'ActualPurchasesAmount', 'ActualSalesAmount', 'TargetPurchasesAmount', 'TargetSalesAmount', 'ActualPurchasesVATAmount', 'ActualSalesVATAmount', 'WorkInProgressAmount', 'ExcludeVAT', 'AssociatedQuotesCount'],
    title: 'Projects',
    linkField: 'Number',
    sortField: 'Number',
    sortOrder: 1,
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid', 'ID', 'Date1', 'Date2', 'FieldLinks'],
    department: ['kashflow'],
    deny: ['c', 'u', 'd'],
    handlesDocuments: true,
    labelOverrides: {
      CustomerID: 'Customer Name',
      Number: 'Job Ref',
    },
    fieldTransforms: {
      CustomerID: {
        fromModel: 'customer',
        matchField: 'CustomerID',
        returnField: 'Name',
        linkTo: (row) => `/customer/${row.CustomerID}`,
      }
    },
    tabsby: 'Status',
    tabsValues: [
      { value: '0', label: 'Pending' },
      { value: '1', label: 'In Progress' },
      { value: '2', label: 'Completed' }
    ],
    description: {
      manage: 'Manage projects and their documents.',
    },
  },
  quote: {
    title: 'Quotes',
    linkField: 'Number',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid', 'InvoiceDBID', 'SuppressTotal', 'DueDate', 'DeliveryAddress', 'CurrencyCode', 'ExchangeRate', 'PermaLink', 'UseCustomDeliveryAddress', 'ReadableString', 'EstimateCategory', 'CustomerID', 'Paid', 'CISRCNetAmount', 'CISRCVatAmount', 'IsCISReverseCharge', 'Customer'],
    fieldOrder: ['Number', 'CustomerId', 'CustomerName', 'Date', 'GrossAmount', 'NetAmount', 'VATAmount', 'CustomerReference', 'LineItems', 'Permalink', 'PreviousNumber', 'NextNumber', 'Status', 'Category', 'Currency', 'CustomerCode'],
    sortField: 'Number',
    sortOrder: 1,
    department: ['kashflow'],
    deny: ['c', 'u', 'd'],
    labelOverrides: {
      InvoiceNumber: 'Quote Ref',
    },
  },
  purchase: {
    title: 'Purchases',
    linkField: 'Number',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid', 'InvoiceDBID', 'DeliveryAddress', 'CurrencyCode', 'ExchangeRate', 'PermaLink', 'UseCustomDeliveryAddress', 'ReadableString', 'EstimateCategory', 'CustomerID', 'Paid', 'CISRCNetAmount', 'CISRCVatAmount', 'IsCISReverseCharge', 'Customer'],
    fieldOrder: ['Number', 'SupplierId', 'SupplierCode', 'SupplierName', 'SupplierReference', 'Currency', 'DueDate', 'GrossAmount', 'HomeCurrencyGrossAmount', 'IssuedDate', 'FileCount', 'LineItems', 'NetAmount', 'NextNumber', 'OverdueDays', 'PaidDate', 'PaymentLines', 'Permalink', 'PreviousNumber', 'PurchaseInECMemberState', 'Status', 'StockManagementApplicable', 'TotalPaidAmount', 'VATAmount', 'AdditionalFieldValue', 'IsWhtDeductionToBeApplied', 'ReadableString', 'SubmissionDate', 'TaxMonth', 'TaxYear'],
    sortField: 'Number',
    sortOrder: 1,
    department: ['kashflow'],
    deny: ['c', 'u', 'd'],
    labelOverrides: {
      InvoiceNumber: 'KashFlow Number',
    },
  },
  session: {
    deny: ['c', 'r', 'u', 'd', 'l'],
  },
  supplier: {
    title: 'Suppliers',
    linkField: 'Name',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'Created', 'Updated', 'SupplierID', 'EC', 'TradeBorderType', 'Contact', 'ContactTitle', 'ContactFirstName', 'ContactLastName', 'Telephone', 'Fax', 'Mobile', 'Website', 'CurrencyID', 'PaymentTerms'],
    fieldOrder: ['Name', 'Id', 'Code', 'Note', 'CreatedDate', 'LastUpdatedDate', 'FirstPurchaseDate', 'LastPurchaseDate', 'OutstandingBalance', 'TotalPaidAmount', 'DefaultNominalCode', 'VATNumber', 'IsRegisteredInEC', 'IsArchived', 'PaymentTerms', 'Currency', 'Contacts', 'Address', 'DeliveryAddresses', 'DefaultPdfTheme', 'PaymentMethod', 'CreateSupplierCodeIfDuplicate', 'CreateSupplierNameIfEmptyOrNull', 'UniqueEntityNumber', 'VatNumber', 'WithholdingTaxRate', 'WithholdingTaxReferences'],
    sortField: 'Name',
    sortOrder: 1,
    department: ['kashflow', 'construction-industry-scheme'],
    deny: ['c', 'u', 'd'],
    actions: [
      {
        label: 'Change',
        class: 'warning',
        href: row => `/supplier/change/${row.uuid}`,
        icon: 'bi-pencil-square'
      }
    ],
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
    fieldOrder: ['username', 'email', 'role', 'status', 'lastLogin'],
    sortField: 'username',
    sortOrder: 1,
    department: ['human-resources'],
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
  }
};