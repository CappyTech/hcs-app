const { migrateModel } = require('./services/databaseMigrationService');
const db = require('./services/sequelizeMigrationService');
const mdb = require('./services/mongooseDatabaseService');
const logger = require('./services/loggerService');

// USERS
const transformUser = async (record) => {
  const transformed = {
    uuid: record.id,
    username: record.username.trim(),
    email: record.email.toLowerCase(),
    password: record.password,
    role: record.role,
    permissions: record.permissions || {},
    totpSecret: record.totpSecret || null,
    totpEnabled: record.totpEnabled || false,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };

  if (record.employeeId) {
    const emp = await mdb.employee.findOne({ uuid: record.employeeId });
    if (emp) transformed.employeeId = emp._id;
  }

  if (record.subcontractorId) {
    const sub = await mdb.supplier.findOne({ uuid: record.subcontractorId });
    if (sub) transformed.subcontractorId = sub._id;
  }

  if (record.clientId) {
    const cli = await mdb.customer.findOne({ uuid: record.clientId });
    if (cli) transformed.clientId = cli._id;
  }

  return transformed;
};


// EMPLOYEES
const transformEmployee = async (record) => {
  const transformed = {
    uuid: record.id,
    name: record.name.trim(),
    email: record.email?.toLowerCase() || null,
    phoneNumber: record.phoneNumber || null,
    contactName: record.contactName || null,
    contactNumber: record.contactNumber || null,
    position: record.position || null,
    type: record.type,
    status: record.status,
    hireDate: record.hireDate,
    hourlyRate: record.hourlyRate,
    dailyRate: record.dailyRate,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };

  if (record.managerId) {
    const manager = await mdb.employee.findOne({ uuid: record.managerId });
    if (manager) transformed.managerId = manager._id;
  }

  return transformed;
};

// ATTENDANCES
const transformAttendance = async (record) => {
  const transformed = {
    uuid: record.id,
    date: record.date,
    type: record.type,
    hoursWorked: record.hoursWorked,
    payRate: record.payRate,
    dayRate: record.dayRate,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };

  if (record.locationId) {
    const loc = await mdb.location.findOne({ uuid: record.locationId });
    if (loc) transformed.locationId = loc._id;
  }

  if (record.projectId) {
    const proj = await mdb.project.findOne({ uuid: record.projectId });
    if (proj) transformed.projectId = proj._id;
  }

  if (record.employeeId) {
    const emp = await mdb.employee.findOne({ uuid: record.employeeId });
    if (emp) transformed.employeeId = emp._id;
  }

  if (record.subcontractorId) {
    const sub = await mdb.supplier.findOne({ uuid: record.subcontractorId });
    if (sub) transformed.subcontractorId = sub._id;
  }

  return transformed;
};

const transformLocation = (record) => ({
  uuid: record.id,
  name: record.name?.trim() || null,
  address: record.address?.trim() || null,
  city: record.city?.trim() || null,
  postalCode: record.postalCode?.trim() || null,
  country: record.country?.trim() || null,
  latitude: record.latitude ?? null,
  longitude: record.longitude ?? null,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt
});

(async () => {
  await migrateModel(db.Users, mdb.user, transformUser, 'uuid');
  await migrateModel(db.Employees, mdb.employee, transformEmployee, 'uuid');
  await migrateModel(db.Attendances, mdb.attendance, transformAttendance, 'uuid');
  await migrateModel(db.Locations, mdb.location, transformLocation, 'uuid');

  logger.info('✅ All model migrations complete.');
})();
