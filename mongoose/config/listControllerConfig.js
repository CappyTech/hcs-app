/**
 * listControllerConfig.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Drives the auto-generated list views produced by listController.js.
 *
 * Each key maps to a Mongoose model name (case-insensitive, singular or plural).
 * Alias configs (aliasOf) point to an existing model but apply a baseFilter so
 * the same collection can be surfaced as a different route (e.g. subcontractor
 * is the supplier collection filtered to CIS-registered suppliers).
 *
 * Key options:
 *   layout        – 'table' (default) or 'rows' (card-per-record layout)
 *   hideFields    – fields suppressed from the list view entirely
 *   fieldOrder    – explicit column/field ordering (extras appended after)
 *   strictOrder   – if true, only fieldOrder fields are shown (no extras)
 *   labelOverrides – human-readable column headers
 *   sortField/sortOrder – default sort (-1 = desc, 1 = asc)
 *   deny          – array of CRUD operations to block: 'c','r','u','d','l'
 *   department    – restricts route to users whose department matches
 *   filters       – per-model filter panel definitions (see applyFilterParams)
 *   fieldTransforms – resolve ObjectId references to display names + links
 *   referenceFilters – scopes the options available in reference dropdowns
 *   tabsby        – field to build tab navigation from
 *   tabsValues    – explicit tab definitions (or tabsDynamic: true for auto)
 *   headerActions – extra action buttons rendered in the list header
 *   baseFilter    – static Mongoose query merged into every list query (aliases)
 * ─────────────────────────────────────────────────────────────────────────────
 */

module.exports = {
  assignment: {
    title: 'Assignments',
    layout: 'rows',
    linkField: 'title',
    // description is a long free-text field — shown on the detail view, too verbose for a list row
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid', 'description'],
    sortField: 'createdAt',
    sortOrder: -1,
    department: ['management'],
    // Quick-filter by workflow stage — Planned/In Progress/Done mirrors the enum
    tabsby: 'status',
    tabsValues: [
      { value: 'all', label: 'All' },
      { value: 'Planned', label: 'Planned' },
      { value: 'In Progress', label: 'In Progress' },
      { value: 'Done', label: 'Done' },
    ],
    labelOverrides: {
      contractId: 'Contract'
    },
    fieldOrder: ['title', 'contractId', 'weekStart', 'status', 'estimatedHours', 'assignedEmployees', 'assignedSubcontractors'],
    referenceFilters: {
      // Scope the subcontractor dropdown to only suppliers who have a WHT rate set,
      // which is the defining characteristic of a CIS-registered subcontractor.
      // Avoids polluting the picker with ordinary trade suppliers.
      assignedSubcontractors: { WithholdingTaxRate: { $gte: 0 } },
    },
    fieldTransforms: {
      // These resolve MongoDB ObjectId references stored in the assignment document
      // into display names + hyperlinks. The list view shows names, not raw IDs.
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
      // assignedSubcontractors are stored as supplier _ids (subcontractors live in the
      // supplier collection) — resolved to Name for display.
      assignedSubcontractors: {
        fromModel: 'supplier',
        matchField: '_id',
        returnField: 'Name',
        linkTo: (matched) => `/supplier/read/${matched.uuid}`
      }
    },
    // Streamlined detail view (replaces the generic invoice-style form-read, whose
    // empty Items/Payments sidebar wastes space for assignments).
    readView: require('path').join('tailwindcss', 'assignment', 'read'),
    // Resolve ObjectId refs to display name + uuid so the custom view stays simple.
    readLocals: async (item) => {
      const mdb = require('../services/mongooseDatabaseService');
      const pick = (ref) =>
        mdb.REST?.[ref] || mdb.INTERNAL?.[ref] || mdb.PAPERLESS?.[ref] || mdb[ref];
      const Contract = pick('contract');
      const Employee = pick('employee');
      const Supplier = pick('supplier');

      const contractDoc = item.contractId && Contract
        ? await Contract.findById(item.contractId).select('title uuid').lean()
        : null;

      const empIds = Array.isArray(item.assignedEmployees) ? item.assignedEmployees : [];
      const empDocs = empIds.length && Employee
        ? await Employee.find({ _id: { $in: empIds } }).select('name uuid').lean()
        : [];

      const subIds = Array.isArray(item.assignedSubcontractors) ? item.assignedSubcontractors : [];
      const subDocs = subIds.length && Supplier
        ? await Supplier.find({ _id: { $in: subIds } }).select('Name uuid').lean()
        : [];

      return {
        contract: contractDoc ? { name: contractDoc.title, uuid: contractDoc.uuid } : null,
        employees: empDocs.map((e) => ({ name: e.name, uuid: e.uuid })),
        subcontractors: subDocs.map((s) => ({ name: s.Name, uuid: s.uuid })),
      };
    },
  },
  attendance: {
    title: 'Attendances',
    linkField: 'date',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid',
      // contractAssignmentId — internal join key linking the attendance record to a
      // specific assignment; the resolved projectId/locationId are shown instead
      'contractAssignmentId',
      // overtimeRate & breakMinutes — payroll-detail fields surfaced in payroll
      // summary reports; cluttering the attendance list with them adds noise
      'overtimeRate', 'breakMinutes'],
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
    // Quick-filter by workflow stage — Planned/In Progress/Completed mirrors the enum
    tabsby: 'status',
    tabsValues: [
      { value: 'all', label: 'All' },
      { value: 'Planned', label: 'Planned' },
      { value: 'In Progress', label: 'In Progress' },
      { value: 'Completed', label: 'Completed' },
    ],
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
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid',
      // quoteId — the originating KashFlow quote that generated this contract;
      // accessible via the contract detail view, not needed in the list
      'quoteId'],
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
    },
    // Streamlined detail view (replaces the generic stacked form-read) with a compact
    // header/meta grid plus a table of the assignments that belong to this contract.
    readView: require('path').join('tailwindcss', 'contract', 'read'),
    readLocals: async (item) => {
      const mdb = require('../services/mongooseDatabaseService');
      const pick = (ref) =>
        mdb.REST?.[ref] || mdb.INTERNAL?.[ref] || mdb.PAPERLESS?.[ref] || mdb[ref];
      const Project = pick('project');
      const Location = pick('location');
      const Quote = pick('quote');
      const Assignment = pick('assignment');

      const projectDoc = item.projectId && Project
        ? await Project.findById(item.projectId).select('Name name uuid').lean()
        : null;
      const locationDoc = item.locationId && Location
        ? await Location.findById(item.locationId).select('name uuid').lean()
        : null;
      const quoteDoc = item.quoteId && Quote
        ? await Quote.findById(item.quoteId).select('Number Reference uuid').lean()
        : null;

      const assignmentDocs = item._id && Assignment
        ? await Assignment.find({ contractId: item._id })
            .select('uuid title weekStart status assignedEmployees assignedSubcontractors')
            .sort({ weekStart: -1 })
            .lean()
        : [];

      return {
        project: projectDoc ? { name: projectDoc.Name || projectDoc.name, uuid: projectDoc.uuid } : null,
        location: locationDoc ? { name: locationDoc.name, uuid: locationDoc.uuid } : null,
        quote: quoteDoc ? { label: quoteDoc.Number || quoteDoc.Reference || 'Quote', uuid: quoteDoc.uuid } : null,
        assignments: assignmentDocs.map((a) => ({
          uuid: a.uuid,
          title: a.title,
          weekStart: a.weekStart,
          status: a.status,
          empCount: Array.isArray(a.assignedEmployees) ? a.assignedEmployees.length : 0,
          subCount: Array.isArray(a.assignedSubcontractors) ? a.assignedSubcontractors.length : 0,
        })),
      };
    },
  },
  customer: {
    title: 'Customers',
    layout: 'rows',
    linkField: 'Name',
    // Customers are synced read-only from KashFlow — deny all writes from the app.
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid',
      // Nested arrays / objects — too complex to render in a list row
      'Contacts', 'Addresses', 'DeliveryAddresses', 'CustomCheckBoxes', 'CustomTextBoxes',
      'PaymentTerms', 'Currency', 'WHTReferences',
      // Internal KashFlow IDs / system keys not meaningful to users
      'Id', 'Key', 'Source',
      // KashFlow UI / print-layout flags — only relevant in KashFlow itself
      'AutoIncludeVATNumber', 'ShowDiscount', 'InvoiceFileFormat', 'OverrideInvoiceFileFormat',
      'EnvelopeUrl', 'PDFThemeId', 'CreateCustomerCodeIfDuplicate', 'CreateCustomerNameIfEmptyOrNull',
      // Account-level settings shown on the customer detail view, not the list
      'AverageDaysToPay', 'UseCustomDeliveryAddress', 'AutomaticCreditControlEnabled',
      'IsGoCardlessMandateSet',
      // Contact channels — TelephoneNumber surfaced on detail; Fax/Mobile rarely populated
      'TelephoneNumber', 'UniqueEntityNumber', 'FaxNumber', 'MobileNumber', 'Website',
      // Fields already expressed more clearly elsewhere in fieldOrder
      'DefaultNominalCode', 'EmailTemplateNumber', 'ReceivesWholesalePricing', 'ApplyWHT'],
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
    department: ['finance'],
    deny: ['c', 'u', 'd'],
    // IsArchived is Boolean — controller casts 'true'/'false' strings to boolean for the query
    tabsby: 'IsArchived',
    tabsValues: [
      { value: 'all', label: 'All' },
      { value: 'false', label: 'Active' },
      { value: 'true', label: 'Archived' },
    ],
    filters: [
      { field: 'IsArchived', label: 'Status', type: 'boolean', falseLabel: 'Active', trueLabel: 'Archived' },
      { field: 'OutstandingBalance', label: 'Outstanding', type: 'numberrange' },
      { field: 'InvoicedNetAmount', label: 'Net Invoiced', type: 'numberrange' },
    ],
    readView: require('path').join('tailwindcss', 'customer', 'read'),
    readLocals: async (item) => {
      const mdb = require('../services/mongooseDatabaseService');
      const [relatedInvoices, relatedQuotes, relatedProjects] = await Promise.all([
        mdb.REST?.invoice?.find({ CustomerId: item.Id }).select('uuid Number Status IssuedDate GrossAmount AmountPaid').sort({ Number: -1 }).limit(50).lean() ?? [],
        mdb.REST?.quote?.find({ CustomerId: item.Id }).select('uuid Number Status Date GrossAmount').sort({ Number: -1 }).limit(50).lean() ?? [],
        mdb.REST?.project?.find({ CustomerCode: item.Code }).select('uuid Number Name Status StartDate EndDate').sort({ Number: -1 }).limit(50).lean() ?? [],
      ]);
      return { relatedInvoices, relatedQuotes, relatedProjects };
    },
  },
  employee: {
    title: 'Employees',
    layout: 'rows',
    linkField: 'name',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid',
      // contactName / contactNumber — legacy emergency-contact fields, superseded
      // by the linked user account; retained in the schema for existing data
      'contactName', 'contactNumber',
      // contract / holidayPolicy — embedded sub-documents with their own detail views;
      // showing them inline in the list would produce unreadable nested JSON
      'contract', 'holidayPolicy'],
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
    readView: require('path').join('tailwindcss', 'employee', 'read'),
    readLocals: async (item) => {
      const mdb = require('../services/mongooseDatabaseService');
      const [relatedVehicles, relatedHolidayRequests, relatedHolidayEntitlements, relatedManager, relatedLinkedSupplier] = await Promise.all([
        mdb.INTERNAL?.vehicle?.find({ employeeId: item._id }).select('uuid registrationNumber make model year availabilityStatus').sort({ registrationNumber: 1 }).lean() ?? [],
        mdb.INTERNAL?.holidayRequest?.find({ employeeId: item._id }).select('uuid startDate endDate daysRequested leaveType status').sort({ startDate: -1 }).limit(20).lean() ?? [],
        mdb.INTERNAL?.employeeHoliday?.find({ employeeId: item._id }).select('uuid periodStart periodEnd entitlementDays takenDays accruedDays carryOverDays').sort({ periodStart: -1 }).lean() ?? [],
        item.managerId && mdb.INTERNAL?.employee
          ? mdb.INTERNAL.employee.findOne({ _id: item.managerId }).select('uuid name').lean()
          : null,
        item.subcontractorSupplierId && mdb.REST?.supplier
          ? mdb.REST.supplier.findOne({ _id: item.subcontractorSupplierId }).select('uuid Name').lean()
          : null,
      ]);
      return { relatedVehicles, relatedHolidayRequests, relatedHolidayEntitlements, relatedManager, relatedLinkedSupplier };
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
    // Invoices are synced read-only from KashFlow — deny all writes from the app.
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid',
      // Arrays / objects — line items and payment detail live on the invoice detail view
      'LineItems', 'PaymentLines', 'Address', 'DeliveryAddress', 'ReminderLetters',
      // Internal KashFlow IDs — Id is the KashFlow DB primary key; CustomerKey is an
      // opaque account reference; CustomerCode duplicates CustomerName in this context
      'Id', 'CustomerKey', 'CustomerCode',
      // Redundant amount fields: Paid is a raw 0/1 flag; HomeCurrency* are exchange-rate
      // conversions not relevant for GBP-only accounts; DueAmount / FormattedDueAmount
      // duplicate GrossAmount minus payments
      'Paid', 'HomeCurrencyGrossAmount', 'HomeCurrencyVATAmount', 'DueAmount', 'FormattedDueAmount',
      // Navigation / print-layout fields — PreviousNumber/NextNumber are invoice chain links
      // used in KashFlow's UI; Permalink is the KashFlow-hosted PDF URL;
      // SuppressNumber hides the invoice number on printed output;
      // PayOnlinePaymentProcessor is a KashFlow payment gateway enum
      'PreviousNumber', 'NextNumber', 'ProjectNumber', 'ProjectName', 'ProjectGrossAmount',
      'Permalink', 'PackingSlipPermalink', 'SuppressNumber', 'PayOnlinePaymentProcessor',
      // Customer contact snapshot — KashFlow copies contact details at invoice time;
      // the live customer record is linked via CustomerId/CustomerName
      'CustomerContactName', 'CustomerContactFirstName', 'CustomerContactLastName',
      // Flags only relevant in CIS-reverse-charge or VAT return workflows;
      // CISRCNet/Vat amounts surface on the CIS returns pages instead
      'CreatedDate', 'Type', 'FileCount', 'IsArchived', 'IsCISReverseCharge', 'IsWhtDeductionToBeApplied',
      'CISRCNetAmount', 'CISRCVatAmount', 'TradeBorderType',
      // Address-update flags — KashFlow UI options to sync delivery/billing address back;
      // not meaningful in a read-only list
      'UpdateCustomerDeliveryAddress', 'UseCustomDeliveryAddress', 'VATNumber', 'VATReturnId'],
    fieldOrder: ['Number', 'CustomerId', 'CustomerName', 'CustomerReference', 'Currency',
      'NetAmount', 'GrossAmount', 'VATAmount', 'AmountPaid', 'TotalPaidAmount',
      'IssuedDate', 'DueDate', 'PaidDate', 'LastPaymentDate',
      'Status', 'OverdueDays', 'AutomaticCreditControlEnabled', 'CustomerDiscount',
      'EmailCount', 'InvoiceInECMemberState', 'InvoiceOutsideECMemberState', 'UpdateCustomerAddress'],
    sortField: 'Number',
    sortOrder: -1,
    department: ['finance'],
    deny: ['c', 'u', 'd'],
    // Tabs give one-click access to the most common status filters
    tabsby: 'Status',
    tabsValues: [
      { value: 'all', label: 'All' },
      { value: 'Outstanding', label: 'Outstanding' },
      { value: 'Paid', label: 'Paid' },
      { value: 'Overdue', label: 'Overdue' },
      { value: 'Credited', label: 'Credited' },
      { value: 'Cancelled', label: 'Cancelled' },
    ],
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
    readView: require('path').join('tailwindcss', 'invoice', 'read'),
    readLocals: async (item) => {
      const mdb = require('../services/mongooseDatabaseService');
      const customer = item.CustomerId && mdb.REST?.customer
        ? await mdb.REST.customer.findOne({ Id: item.CustomerId }).select('uuid Name Code').lean()
        : null;
      return { relatedCustomer: customer };
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
    // meta stores internal app configuration (e.g. sync run IDs, feature flags).
    // It must never be exposed through any list, read, or edit route.
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
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid',
      // hcs-sync tracking fields — deleted projects are soft-deleted; lastSeenRun
      // records which sync run last touched the document
      'deletedAt', 'lastSeenRun',
      // Id — KashFlow's internal DB primary key; Number is the user-facing job reference
      'Id',
      // ExcludeVAT — KashFlow billing flag, not relevant to project progress tracking
      // ActualSalesVATAmount / ActualPurchasesVATAmount — VAT breakdowns of the totals
      // already shown via ActualSalesAmount / ActualPurchasesAmount
      // ActualJournalsAmount — manual journal adjustments, rarely used; shown on detail
      'ExcludeVAT', 'ActualSalesVATAmount', 'ActualPurchasesVATAmount', 'ActualJournalsAmount'],
    department: ['finance'],
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
    readView: require('path').join('tailwindcss', 'project', 'read'),
    readLocals: async (item) => {
      const mdb = require('../services/mongooseDatabaseService');
      const [relatedCustomer, relatedContracts] = await Promise.all([
        item.CustomerCode && mdb.REST?.customer
          ? mdb.REST.customer.findOne({ Code: item.CustomerCode }).select('uuid Name Code').lean()
          : null,
        mdb.INTERNAL?.contract?.find({ projectId: item._id }).select('uuid title status startDate endDate').sort({ startDate: -1 }).lean() ?? [],
      ]);
      return { relatedCustomer, relatedContracts };
    },
  },
  quote: {
    title: 'Quotes',
    linkField: 'Number',
    // Quotes are synced read-only from KashFlow — deny all writes from the app.
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid',
      // Arrays / objects — line item and address detail shown on the quote detail view
      'LineItems', 'Addresses', 'DeliveryAddresses', 'UseCustomDeliveryAddress',
      // Id — KashFlow DB primary key; Number is the user-facing quote reference
      // HomeCurrencyGrossAmount — exchange-rate conversion, not needed for GBP accounts
      // FileCount — attachment count, shown on detail view
      // IsEmailSent — KashFlow emailing flag, not relevant in the app
      // SuppressAmount — print-layout flag to hide amounts on the printed quote
      'Id', 'HomeCurrencyGrossAmount', 'FileCount', 'IsEmailSent', 'SuppressAmount',
      // ProjectNumber/Name — duplicated from KashFlow; the project list is the source of truth
      // Permalink — KashFlow-hosted quote PDF URL
      // PreviousNumber/NextNumber — quote revision chain links used in KashFlow's UI
      'ProjectNumber', 'ProjectName', 'Permalink', 'PreviousNumber', 'NextNumber'],
    fieldOrder: ['Number', 'CustomerId', 'CustomerName', 'CustomerCode', 'CustomerReference',
      'Date', 'GrossAmount', 'NetAmount', 'VATAmount',
      'Status', 'Category', 'Currency'],
    sortField: 'Number',
    sortOrder: -1,
    department: ['finance'],
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
    readView: require('path').join('tailwindcss', 'quote', 'read'),
    readLocals: async (item) => {
      const mdb = require('../services/mongooseDatabaseService');
      const customer = item.CustomerId && mdb.REST?.customer
        ? await mdb.REST.customer.findOne({ Id: item.CustomerId }).select('uuid Name Code').lean()
        : null;
      return { relatedCustomer: customer };
    },
  },
  purchase: {
    title: 'Purchases',
    linkField: 'Number',
    // Purchases are synced read-only from KashFlow — deny all writes from the app.
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid',
      // Arrays / objects — line item breakdown shown on purchase detail view
      'LineItems',
      // ReadableString — KashFlow-generated human summary, superseded by our own rendering
      // CISRCNet/Vat — CIS reverse charge sub-totals, shown on the CIS returns pages
      'ReadableString', 'CISRCNetAmount', 'CISRCVatAmount',
      // Navigation / print fields (same pattern as invoice)
      'Permalink', 'PreviousNumber', 'NextNumber',
      // IsCISReverseCharge — boolean flag; the CIS module reads this separately
      // Type — always 'Purchase' for this collection, no value in showing it
      // SupplierCode — internal KashFlow code; SupplierName is shown in the list
      'IsCISReverseCharge', 'Type', 'SupplierCode',
      // StockManagementApplicable — KashFlow inventory flag, not used in this workflow
      // ProjectName/Number — available via the project list; duplicated here by KashFlow
      // AdditionalFieldValue — custom field placeholder, always empty in practice
      'StockManagementApplicable', 'ProjectName', 'ProjectNumber', 'AdditionalFieldValue',
      // SupplierId — KashFlow integer FK; SupplierName is the display value
      // FileCount — attachment count, shown on detail view
      // HomeCurrencyGrossAmount — exchange-rate conversion, not relevant for GBP accounts
      'SupplierId', 'FileCount', 'HomeCurrencyGrossAmount',
      // IsWhtDeductionToBeApplied — WHT flag handled by CIS module, not the purchase list
      // Id — KashFlow DB primary key, Number is the user-facing reference
      // IsEmailSent — KashFlow emailing flag, irrelevant in the app
      'IsWhtDeductionToBeApplied', 'Id', 'IsEmailSent',
      // ProjectGrossAmount — project-level roll-up, shown on project detail not purchase list
      // TradeBorderType — EC trade classification, not relevant for UK domestic purchases
      // VATReturnId — links to KashFlow VAT return; the VAT module handles this separately
      'ProjectGrossAmount', 'TradeBorderType', 'VATReturnId',
      // hcs-sync tracking fields — internal to the sync process, not user-facing
      'deletedAt', 'lastSeenRun', 'createdByRunId',
      // Currency — object type (Mixed), always GBP; OverdueDays — computed nightly by KashFlow
      // number — lowercase duplicate of Number (data quality issue in older syncs)
      // SubmissionDate/TaxMonth/TaxYear — CIS submission fields, shown on the CIS returns pages
      // PurchaseInECMemberState — EC VAT flag, not relevant for CIS/domestic workflow
      'Currency', 'number', 'OverdueDays', 'SubmissionDate', 'TaxMonth', 'TaxYear',
      'PurchaseInECMemberState'],
    fieldOrder: ['Number', 'SupplierName', 'SupplierReference', 'GrossAmount', 'NetAmount', 'VATAmount', 'Status', 'TotalPaidAmount', 'IssuedDate', 'DueAmount', 'DueDate', 'PaidDate'],
    strictOrder: true,
    searchFields: ['Number', 'SupplierReference'],
    sortField: 'Number',
    sortOrder: -1,
    department: ['finance'],
    deny: ['c', 'u', 'd'],
    // Tabs give one-click access to the most common status filters
    tabsby: 'Status',
    tabsValues: [
      { value: 'all', label: 'All' },
      { value: 'Outstanding', label: 'Outstanding' },
      { value: 'Paid', label: 'Paid' },
      { value: 'Overdue', label: 'Overdue' },
      { value: 'Cancelled', label: 'Cancelled' },
    ],
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
    readView: require('path').join('tailwindcss', 'purchase', 'read'),
    readLocals: async (item, req) => {
      const mdb = require('../services/mongooseDatabaseService');
      const supplier = item.SupplierId && mdb.REST?.supplier
        ? await mdb.REST.supplier.findOne({ Id: item.SupplierId }).select('uuid Name Code WithholdingTaxRate').lean()
        : null;
      // Paperless document that was sent to KashFlow as this purchase (PICP linkage).
      // The /paperless/ocr detail view is admin-only, so only surface the link to admins.
      let paperlessDoc = null;
      if (req?.user?.role === 'admin' && mdb.PAPERLESS?.OcrDocument) {
        const or = [];
        if (item.Id != null) or.push({ kashflowPurchaseId: item.Id });
        if (item.Number != null) or.push({ kashflowPurchaseNumber: item.Number });
        if (or.length) {
          paperlessDoc = await mdb.PAPERLESS.OcrDocument.findOne({ $or: or, deletedInPaperlessAt: null })
            .select('paperlessId title').lean();
        }
      }
      // Resolve line-item ProjectNumber / NominalCode references to their names so
      // the items table can show "Project name" / "Nominal name" instead of bare codes.
      const projectNumbers = [...new Set((item.LineItems || []).map(li => li.ProjectNumber).filter(n => n != null && n !== 0))];
      const nominalCodes   = [...new Set((item.LineItems || []).map(li => li.NominalCode).filter(n => n != null))];
      const lineItemProjects = {};
      const lineItemNominals = {};
      if (projectNumbers.length && mdb.REST?.project) {
        // Subcontractors can read their own purchases but have no project access —
        // give them the name without a link that would 403.
        const canReadProjects = ['admin', 'accountant'].includes(req?.user?.role);
        const projects = await mdb.REST.project.find({ Number: { $in: projectNumbers } }).select('uuid Number Name').lean();
        for (const p of projects) lineItemProjects[p.Number] = { uuid: canReadProjects ? p.uuid : null, name: p.Name };
      }
      if (nominalCodes.length && mdb.REST?.nominal) {
        const nominals = await mdb.REST.nominal.find({ Code: { $in: nominalCodes.map(Number).filter(Number.isFinite) } }).select('Code Name').lean();
        for (const n of nominals) lineItemNominals[n.Code] = n.Name;
      }
      return { relatedSupplier: supplier, paperlessDoc, lineItemProjects, lineItemNominals };
    },
  },
  session: {
    // Raw Express session documents — contain auth tokens, CSRF state and TOTP
    // session data. Must never be exposed through any route under any circumstance.
    deny: ['c', 'r', 'u', 'd', 'l'],
  },
  subcontractor: {
    // Alias of the supplier collection — subcontractors are suppliers that have a
    // WithholdingTaxRate set (i.e. are registered under the Construction Industry Scheme).
    // Using an alias means we avoid a separate collection while still giving CIS users
    // a focused view with CIS-relevant fields prominently shown.
    aliasOf: 'supplier',
    layout: 'rows',
    basePath: 'supplier',
    // baseFilter was previously { Subcontractor: true } but the Subcontractor boolean flag
    // was unreliable — KashFlow doesn't always set it. WithholdingTaxRate >= 0 is the
    // definitive indicator: only CIS-registered suppliers have this field populated.
    baseFilter: { WithholdingTaxRate: { $gte: 0 } },
    title: 'Subcontractors',
    linkField: 'Name',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid',
      // Nested objects / arrays — too complex for a list row
      'PaymentTerms', 'Currency', 'Contacts', 'Address', 'DeliveryAddresses',
      'BankAccount', 'WithholdingTaxReferences',
      // KashFlow UI / print-layout flags not relevant in the CIS context
      'Website', 'DefaultPdfTheme', 'PaymentMethod', 'SourceName', 'TradeBorderType',
      'UsesDefaultPdftTheme', 'CreateSupplierCodeIfDuplicate', 'CreateSupplierNameIfEmptyOrNull',
      // VAT / billing fields — subcontractors are managed under CIS, not standard VAT billing
      'ApplyWithholdingTax', 'BilledNetAmount', 'BilledVatAmount', 'DefaultVatRate',
      'DoesSupplierHasTransactionsInVATReturn', 'IsCISReverseCharge', 'IsVatRateEnabled', 'VatExempt',
      // Id — KashFlow DB primary key, Code is the user-facing identifier
      // IsRegisteredInEC — EC VAT flag, not relevant for CIS domestic subcontractors
      // IsArchived — subcontractor list always shows active; filtered via baseFilter
      'Id', 'IsRegisteredInEC', 'IsArchived',
      // Subcontractor / IsSubcontractor — legacy boolean flags replaced by WithholdingTaxRate
      // CISRate / CISNumber — hcs-app-managed CIS detail, shown on the subcontractor detail
      // view and the CIS dashboard; not needed in the summary list
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
    // WithholdingTaxRate is a Number — tab values are cast to numbers by the controller
    tabsby: 'WithholdingTaxRate',
    tabsValues: [
      { value: 'all', label: 'All' },
      { value: '0', label: '0%' },
      { value: '20', label: '20%' },
      { value: '30', label: '30%' },
    ],
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
    // Suppliers are synced read-only from KashFlow — deny all writes from the app.
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid',
      // Nested objects / arrays — address and contact detail is on the supplier detail view
      'PaymentTerms', 'Currency', 'Contacts', 'Address', 'DeliveryAddresses',
      'WithholdingTaxReferences', 'BankAccount',
      // KashFlow UI / print-layout flags — only meaningful inside KashFlow
      'Website', 'DefaultPdfTheme', 'PaymentMethod', 'SourceName', 'TradeBorderType',
      'UsesDefaultPdftTheme', 'CreateSupplierCodeIfDuplicate', 'CreateSupplierNameIfEmptyOrNull',
      // Billing / VAT sub-fields — BilledNet/Vat are KashFlow-computed totals that duplicate
      // OutstandingBalance; DefaultVatRate and IsVatRateEnabled are supplier-level VAT overrides
      // that are only relevant when raising purchases in KashFlow, not when reviewing them here
      'ApplyWithholdingTax', 'BilledNetAmount', 'BilledVatAmount', 'DefaultVatRate',
      'DoesSupplierHasTransactionsInVATReturn', 'IsCISReverseCharge', 'IsVatRateEnabled', 'VatExempt',
      // Id — KashFlow DB primary key; Code is the user-facing supplier reference
      'Id',
      // CIS-specific fields shown on the subcontractor alias view instead;
      // showing them here would confuse non-CIS suppliers
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
    department: ['finance', 'construction-industry-scheme'],
    deny: ['c', 'u', 'd'],
    // IsArchived is Boolean — controller casts 'true'/'false' strings to boolean for the query
    tabsby: 'IsArchived',
    tabsValues: [
      { value: 'all', label: 'All' },
      { value: 'false', label: 'Active' },
      { value: 'true', label: 'Archived' },
    ],
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
    // Also serves the subcontractor alias (basePath 'supplier').
    readView: require('path').join('tailwindcss', 'supplier', 'read'),
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
    // completed is Boolean — controller casts 'true'/'false' strings to boolean for the query
    tabsby: 'completed',
    tabsValues: [
      { value: 'all', label: 'All' },
      { value: 'false', label: 'Pending' },
      { value: 'true', label: 'Done' },
    ],
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
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid',
      // Security-sensitive fields — must never appear in any list or table output
      'password',          // bcrypt hash
      'totpSecret',        // AES-256-CBC encrypted TOTP seed
      'totpEnabled',       // 2FA status — shown on the user detail view only
      'emailVerificationToken', 'emailVerificationExpires',  // short-lived tokens
      // customPermissions — complex per-user RBAC overrides; managed via the admin UI
      'customPermissions'],
    fieldOrder: ['username', 'email', 'emailVerified', 'role', 'employeeId', 'subcontractorId', 'clientId'],
    sortField: 'username',
    sortOrder: 1,
    department: ['human-resources'],
    // Filter by role — useful for quickly seeing all admins, employees, subcontractors etc.
    tabsby: 'role',
    tabsValues: [
      { value: 'all', label: 'All' },
      { value: 'admin', label: 'Admin' },
      { value: 'accountant', label: 'Accountant' },
      { value: 'employee', label: 'Employee' },
      { value: 'subcontractor', label: 'Subcontractor' },
      { value: 'client', label: 'Client' },
      { value: 'hmrc', label: 'HMRC' },
      { value: 'none', label: 'None' },
    ],
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
  holidayRequest: {
    title: 'Holiday Requests',
    linkField: 'startDate',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid'],
    fieldOrder: [
      'employeeId', 'startDate', 'endDate', 'daysRequested',
      'leaveType', 'status', 'reason', 'reviewedBy', 'reviewedAt', 'reviewNotes',
    ],
    sortField: 'startDate',
    sortOrder: -1,
    department: ['human-resources', 'management'],
    labelOverrides: {
      employeeId: 'Employee',
      startDate: 'From',
      endDate: 'To',
      daysRequested: 'Days',
      leaveType: 'Type',
      reviewedBy: 'Reviewed By',
      reviewedAt: 'Reviewed At',
      reviewNotes: 'Review Notes',
    },
    fieldTransforms: {
      employeeId: {
        fromModel: 'employee',
        matchField: '_id',
        returnField: 'name',
        linkTo: (matched) => `/employee/read/${matched.uuid}`
      },
      reviewedBy: {
        fromModel: 'user',
        matchField: '_id',
        returnField: 'username',
      },
    },
    tabsby: 'status',
    tabsValues: [
      { value: 'all', label: 'All' },
      { value: 'pending', label: 'Pending' },
      { value: 'approved', label: 'Approved' },
      { value: 'rejected', label: 'Rejected' },
      { value: 'cancelled', label: 'Cancelled' },
    ],
    description: {
      create: 'Submit a holiday request for approval.',
      manage: 'Review, approve and reject employee holiday requests.',
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
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid',
      // Chassis / mechanical identifiers — important for records but too granular for
      // the fleet overview list; shown on the vehicle detail view
      'vin', 'engineNumber',
      // Certificate/policy numbers — reference data kept in the detail view
      'motCertificateNumber', 'insurancePolicyNumber',
      // Financial detail — cost fields are on the vehicle detail / finance reports
      'insuranceCost', 'purchasePrice', 'leaseMonthlyCost', 'leaseProvider',
      // Load specification — only relevant for HGV compliance, not the fleet summary
      'grossWeight', 'payload',
      // Service mileage thresholds — the vehicleComplianceService checks these
      // automatically; they are shown on the vehicle detail and service history
      'lastServiceMileage', 'nextServiceDueMileage', 'lastMileageUpdate',
      // notes — free-text field, shown on the detail view
      'notes'],
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
    readView: require('path').join('tailwindcss', 'vehicle', 'read'),
    readLocals: async (item) => {
      const mdb = require('../services/mongooseDatabaseService');
      const [relatedEmployee, relatedSubcontractor, relatedProject] = await Promise.all([
        item.employeeId && mdb.INTERNAL?.employee
          ? mdb.INTERNAL.employee.findOne({ _id: item.employeeId }).select('uuid name').lean()
          : null,
        item.subcontractorId && mdb.REST?.supplier
          ? mdb.REST.supplier.findOne({ _id: item.subcontractorId }).select('uuid Name').lean()
          : null,
        // projectId may hold a Mongo ObjectId or a KashFlow numeric Id
        item.projectId && mdb.REST?.project
          ? (/^[0-9a-fA-F]{24}$/.test(String(item.projectId))
              ? mdb.REST.project.findOne({ _id: item.projectId }).select('uuid Name Number').lean()
              : mdb.REST.project.findOne({ Id: Number(item.projectId) }).select('uuid Name Number').lean())
          : null,
      ]);
      return { relatedEmployee, relatedSubcontractor, relatedProject };
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
    department: ['documents'],
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
    department: ['documents'],
    deny: ['c', 'u', 'd'],
  },
  nominal: {
    title: 'Nominal Accounts',
    description: {
      manage: 'Manage nominal accounts (chart of accounts).'
    },
    linkField: 'Name',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid',
      // KashFlow product / stock fields — nominals double as product catalogue entries
      // in KashFlow's inventory module, which is not used here
      'DefaultProduct', 'AutoFillLineItem', 'IsProduct',
      'WholeSalePrice', 'StockWarningQuantity', 'ManageStockLevel', 'QuantityInStock',
      // IRIS / accounting software mapping fields — only relevant if exporting to IRIS
      'IRISCoAName', 'IsIRISCoA',
      // KashFlow internal classification codes used for P&L / balance sheet layout;
      // PlOption and BsOption are enum integers that map to KashFlow report sections
      'PlOption', 'BsOption', 'NomType',
      // Sa103Code — HMRC Self Assessment (SA103) nominal mapping, not used in this workflow
      // Special — KashFlow internal flag marking system-reserved nominal accounts
      // AllowDelete — KashFlow guard flag, not meaningful outside KashFlow
      'Sa103Code', 'Special', 'AllowDelete',
      // DigitalService — EC digital services VAT flag, not relevant for construction
      // ComplianceCode — HMRC Making Tax Digital classification code
      // ControlAccountClassification — KashFlow debtors/creditors control account type
      'DigitalService', 'ComplianceCode', 'ControlAccountClassification'],
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
    // ObjectNumber is the KashFlow reference of the entity the note is attached to
    // (e.g. an invoice number, project number). Used as the link target because notes
    // don't have their own meaningful primary display field — Text is the content itself.
    linkField: 'ObjectNumber',
    hideFields: ['_id', 'createdAt', 'updatedAt', 'uuid',
      // Permalink — KashFlow-hosted URL to the parent entity; not useful in the app
      'Permalink'],
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