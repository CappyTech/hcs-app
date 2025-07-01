const { totp } = require("speakeasy");
const attendance = require("../models/mongoose/attendance");

module.exports = {
  contract: {
    title: 'Contracts',
    linkField: 'title',
    labelOverrides: {
      uuid: 'Contract ID',
      title: 'Title',
      location: 'Site Location',
      status: 'Current Status',
      startDate: 'Start Date',
      endDate: 'End Date',
    },
    hideFields: ['__v', '_id','createdAt', 'updatedAt','uuid'],
    sortField: 'createdAt',
    sortOrder: -1
  },

  employee: {
    title: 'Employees',
    linkField: 'name',
    hideFields: ['__v', '_id','createdAt', 'updatedAt','uuid'],
    fieldOrder: ['name', 'email', 'phoneNumber', 'position', 'status', 'type','dailyRate', 'hourlyRate', 'hireDate', 'managerId'],
  },
  attendance: {
    title: 'Attendances',
    linkField: 'date',
    hideFields: ['__v', '_id','createdAt', 'updatedAt','uuid'],
    fieldOrder: ['date', 'type', 'employeeId', 'subcontractorId', 'hoursWorked', 'payRate', 'dayRate', 'locationId', 'projectId'],
  },
  supplier: {
    title: 'Suppliers',
    linkField: 'Name',
    hideFields: ['__v', '_id','createdAt', 'updatedAt','uuid', 'Created', 'Updated'],
    fieldOrder: ['Name', 'Email', 'Mobile', 'Address1', 'Address2', 'Address3', 'Address4', 'PostCode', 'Telephone', 'Website', 'Contact', 'Mobile', 'Fax', 'CurrencyID', 'PaymentTerms', 'ContactTitle', 'ContactFirstName', 'ContactLastName', 'TradeBorderType', 'IsSubcontractor', 'Subcontractor', 'CISRate', 'CISNumber'],
  },
  user: {
    title: 'Users',
    linkField: 'username',
    hideFields: ['__v', '_id','createdAt', 'updatedAt','uuid', 'password', 'totpSecret', 'totpEnabled'],
    fieldOrder: ['username', 'email', 'role', 'status', 'lastLogin'],
  },
};