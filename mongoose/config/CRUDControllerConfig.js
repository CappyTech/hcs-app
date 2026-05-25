const { OcrDocument } = require("./listControllerConfig");
const path = require('path');

module.exports = {
  purchase: {
    middleware: {
      read: ['ensureRoles:admin,accountant,subcontractor'],
    },
    ownershipFields: {
      subcontractor: 'SupplierId',
    },
    // listControllerConfig sets strictOrder:true to limit list columns, but the read
    // view needs all fields (including LineItems and PaymentLines for the sidebar).
    strictOrder: false,
  },
  default: {
    middleware: {
      read: ['ensureRole:admin'],
      create: ['ensureRole:admin'],
      update: ['ensureRole:admin'],
      delete: ['ensureRole:admin'],
    }
  },
  attendance: {
    title: 'Attendance',
    readOnly: ['uuid', 'createdAt'],
    hideFields: ['_id', '__v'],
    fieldOrder: [
      'date', 'type', 'status',
      'employeeId', 'subcontractorId',
      'projectId', 'locationId', 'contractAssignmentId',
      'hoursWorked', 'breakMinutes', 'overtimeHours', 'overtimeRate',
      'payRate', 'dayRate',
      'notes',
      'uuid', 'createdAt', 'updatedAt'
    ],
    labelOverrides: {
      employeeId: 'Employee',
      subcontractorId: 'Subcontractor',
      projectId: 'Project',
      locationId: 'Location',
      contractAssignmentId: 'Contract Assignment',
      hoursWorked: 'Hours Worked',
      breakMinutes: 'Break (minutes)',
      overtimeHours: 'Overtime Hours',
      overtimeRate: 'Overtime Rate',
      payRate: 'Pay Rate',
      dayRate: 'Day Rate'
    },
    validators: {
      date: value => !isNaN(Date.parse(value)),
      type: value => ['off', 'holiday', 'sick', 'work', 'training', 'leave'].includes(value),
      status: value => ['pending', 'approved', 'rejected'].includes(value),
      hoursWorked: value => typeof value === 'number' && value >= 0,
      payRate: value => typeof value === 'number' && value >= 0,
      dayRate: value => typeof value === 'number' && value >= 0,
      overtimeHours: value => typeof value === 'number' && value >= 0,
      overtimeRate: value => typeof value === 'number' && value >= 0,
      breakMinutes: value => Number.isInteger(value) && value >= 0,
    },
    middleware: {
      read: ['ensureRoles:admin,employee,subcontractor'],
      create: ['ensureRoles:admin,employee,subcontractor'],
      update: ['ensureRole:admin'],
      delete: ['ensureRole:admin'],
    },
    ownershipFields: {
      employee: 'employeeId',
      subcontractor: 'subcontractorId',
    },
    xorGroups: [
      ['employeeId', 'subcontractorId'],
      ['hoursWorked', 'dayRate']
    ],
    referenceFilters: {
      // OLD: subcontractorId: { IsSubcontractor: true },
      subcontractorId: { WithholdingTaxRate: { $gte: 0 } },
      employeeId: { status: 'active' },
      projectId: { Status: { $nin: ['Archived', 'Completed'] } }
    },
    referenceLabelFormat: {
      // Projects: Show number, name, and status label
      projectId: (project) => {
        const statusLabel = project.Status || 'Unknown';
        const projectReference = project.Number ?? '';
        const projectName = project.Name ?? 'Unnamed Project';
        const prefix = projectReference ? `#${projectReference} – ` : '';
        return `${prefix}${projectName} (${statusLabel})`;
      },

      // Subcontractors: Show name
      subcontractorId: (supplier) => {
        return supplier.Name || supplier.name || 'Unnamed Subcontractor';
      },

      // Employees: Show name
      employeeId: (employee) => {
        return employee.name || employee.Name || 'Unnamed Employee';
      },

      // Locations: Show name or address
      locationId: (location) => {
        return location.name || location.Name || [location.address, location.city, location.postalCode].filter(Boolean).join(', ') || 'Unnamed Location';
      },

      // Contract Assignments: Show title or reference
      contractAssignmentId: (assignment) => {
        return assignment.title || assignment.Name || assignment.name || 'Assignment';
      }
    },
    fieldTransforms: {
      projectId: {
        linkTo: (matched) => `/project/read/${matched.uuid}`
      },
      employeeId: {
        linkTo: (matched) => `/employee/read/${matched.uuid}`
      },
      subcontractorId: {
        linkTo: (matched) => `/supplier/read/${matched.uuid}`
      },
      locationId: {
        linkTo: (matched) => `/location/read/${matched.uuid}`
      },
      contractAssignmentId: {
        linkTo: (matched) => `/contractAssignment/read/${matched.uuid}`
      }
    }
  },
  contract: {
    readOnly: ['uuid', 'createdAt'],
    validators: {
      title: value => typeof value === 'string' && value.length >= 3,
      status: value => ['Planned', 'In Progress', 'Completed'].includes(value),
    },
    middleware: {
      read: ['ensureRole:admin'],
      create: ['ensureRole:admin'],
      update: ['ensureRole:admin'],
      delete: ['ensureRole:admin'],
    }
  },
  contractAssignment: {
    readOnly: ['uuid', 'createdAt'],
    validators: {
      startDate: value => !isNaN(Date.parse(value)),
      endDate: value => !isNaN(Date.parse(value)) || value === null,
      employeeId: value => typeof value === 'string' && value.length > 0,
      contractId: value => typeof value === 'string' && value.length > 0,
    },
    middleware: {
      read: ['ensureRole:admin'],
      create: ['ensureRole:admin'],
      update: ['ensureRole:admin'],
      delete: ['ensureRole:admin'],
    }
  },
  employee: {
    readOnly: ['uuid', 'createdAt'],
    useSave: true, // use findOne+save so pre-validate rate computation hooks fire on update
    validators: {
      email: value => /\S+@\S+\.\S+/.test(value),
      startDate: value => !isNaN(Date.parse(value))
    },
    labelOverrides: {
      ir35: 'IR35',
      subcontractorSupplierId: 'Linked Supplier',
    },
    middleware: {
      read: ['ensureRoles:admin,employee'],
      create: ['ensureRole:admin'],
      update: ['ensureRole:admin'],
      delete: ['ensureRole:admin'],
    },
    ownershipFields: {
      employee: '_id',
    },
  },
  customer: {
    readOnly: ['uuid', 'createdAt'],
    middleware: {
      read: ['ensureRoles:admin,accountant,client'],
      create: ['ensureRole:admin'],
      update: ['ensureRole:admin'],
      delete: ['ensureRole:admin'],
    },
    ownershipFields: {
      client: '_id',
    },
  },
  holiday: {
    readOnly: ['uuid', 'createdAt'],
    validators: {
      date: value => !isNaN(Date.parse(value)),
      description: value => typeof value === 'string' && value.length > 0,
    },
    middleware: {
      read: ['ensureRole:admin'],
      create: ['ensureRole:admin'],
      update: ['ensureRole:admin'],
      delete: ['ensureRole:admin'],
    }
  },
  invoice: {
    readOnly: ['uuid', 'createdAt'],
    validators: {
      invoiceNumber: value => typeof value === 'string' && value.length > 0,
      amount: value => typeof value === 'number' && value >= 0,
      dueDate: value => !isNaN(Date.parse(value)),
    },
    middleware: {
      read: ['ensureRoles:admin,accountant,client'],
      create: ['ensureRole:admin'],
      update: ['ensureRole:admin'],
      delete: ['ensureRole:admin'],
    },
    ownershipFields: {
      client: 'CustomerId',
    },
  },
  location: {
    readOnly: ['uuid', 'createdAt'],
    validators: {
      name: value => typeof value === 'string' && value.length > 0,
      address: value => typeof value === 'string' && value.length > 0,
    },
    middleware: {
      read: ['ensureRole:admin'],
      create: ['ensureRole:admin'],
      update: ['ensureRole:admin'],
      delete: ['ensureRole:admin'],
    }
  },
  meta: {
    readOnly: ['uuid', 'createdAt'],
    validators: {
      key: value => typeof value === 'string' && value.length > 0,
      value: value => typeof value === 'string' && value.length > 0,
    },
    middleware: {
      read: ['ensureRole:admin'],
      create: ['ensureRole:admin'],
      update: ['ensureRole:admin'],
      delete: ['ensureRole:admin'],
    }
  },
  project: {
    readOnly: ['uuid', 'createdAt'],
    validators: {
      name: value => typeof value === 'string' && value.length > 0,
      description: value => typeof value === 'string' && value.length > 0,
      startDate: value => !isNaN(Date.parse(value)),
      endDate: value => !isNaN(Date.parse(value)) || value === null,
    },
    middleware: {
      read: ['ensureRoles:admin,accountant,client'],
      create: ['ensureRole:admin'],
      update: ['ensureRole:admin'],
      delete: ['ensureRole:admin'],
    },
    ownershipFields: {
      client: 'CustomerCode',
    },
  },
  quote: {
    readOnly: ['uuid', 'createdAt'],
    validators: {
      text: value => typeof value === 'string' && value.length > 0,
      author: value => typeof value === 'string' && value.length > 0,
      date: value => !isNaN(Date.parse(value)),
    },
    middleware: {
      read: ['ensureRoles:admin,accountant,client'],
      create: ['ensureRole:admin'],
      update: ['ensureRole:admin'],
      delete: ['ensureRole:admin'],
    },
    ownershipFields: {
      client: 'CustomerId',
    },
  },
  session: {
    readOnly: ['id', 'createdAt'],
    validators: {
      userId: value => typeof value === 'string' && value.length > 0,
      expiresAt: value => !isNaN(Date.parse(value)),
    },
    middleware: {
      read: ['ensureRole:admin'],
      create: ['ensureRole:admin'],
      update: ['ensureRole:admin'],
      delete: ['ensureRole:admin'],
    }
  },
  supplier: {
    readOnly: ['uuid', 'Created', 'Updated'],
    validators: {
      Name: value => typeof value === 'string' && value.length > 0,
      Email: value => /\S+@\S+\.\S+/.test(value),
      Mobile: value => typeof value === 'string' && value.length > 0,
      Address1: value => typeof value === 'string' && value.length > 0,
      PostCode: value => typeof value === 'string' && value.length > 0,
      Telephone: value => typeof value === 'string' && value.length > 0,
      Website: value => typeof value === 'string' && (value.length === 0 || /^https?:\/\/.+/.test(value)),
    },
    middleware: {
      read: ['ensureRoles:admin,accountant,subcontractor,hmrc'],
      create: ['ensureRole:admin'],
      update: ['ensureRole:admin'],
      delete: ['ensureRole:admin'],
    },
    ownershipFields: {
      subcontractor: '_id',
    },
  },
  task: {
    description: 'Create a new task and optionally link it to a contract.',
    readOnly: ['uuid', 'createdAt'],
    hideFields: ['uuid', 'completed'],
    fieldOrder: ['title', 'description', 'dueDate', 'recurrence', 'userId', 'contractId'],
    labelOverrides: {
      userId: 'User',
      contractId: 'Contract',
      dueDate: 'Due Date',
    },
    validators: {
      title: value => typeof value === 'string' && value.length > 0,
      description: value => !value || typeof value === 'string',
      dueDate: value => !value || !isNaN(Date.parse(value)),
    },
    middleware: {
      read: ['ensureRole:admin'],
      create: ['ensureRole:admin'],
      update: ['ensureRole:admin'],
      delete: ['ensureRole:admin'],
    }
  },
  user: {
    title: 'User',
    readOnly: ['uuid', 'createdAt'],
    hideFields: ['_id', '__v', 'password', 'totpSecret', 'totpEnabled', 'emailVerificationToken', 'emailVerificationExpires', 'passwordResetToken', 'passwordResetExpires', 'smsResetOtp', 'smsResetExpires', 'customPermissions.departments', 'customPermissions.models', 'customPermissions.routes'],
    fieldOrder: [
      'username', 'email', 'phoneNumber', 'emailVerified', 'role',
      'employeeId', 'subcontractorId', 'clientId',
      'uuid', 'createdAt', 'updatedAt',
    ],
    labelOverrides: {
      employeeId: 'Employee',
      subcontractorId: 'Subcontractor',
      clientId: 'Client',
      emailVerified: 'Email Verified',
    },
    validators: {
      email: value => /\S+@\S+\.\S+/.test(value),
      password: value => typeof value === 'string' && value.length >= 6,
      name: value => typeof value === 'string' && value.length > 0,
    },
    xorGroups: [
      ['employeeId', 'subcontractorId', 'clientId'],
    ],
    middleware: {
      read: ['ensureRole:admin'],
      create: ['ensureRole:admin'],
      update: ['ensureRole:admin'],
      delete: ['ensureRole:admin'],
    },
    beforeCreate: async (data) => {
      // Auto-generate a secure random password when admin creates a user without one
      if (!data.password) {
        const crypto = require('crypto');
        data.password = crypto.randomBytes(24).toString('base64url');
      }
    },
    updateView: path.join('tailwindcss', 'user', 'update'),
    updateLocals: async (item) => {
      const rbac = require('./rolePermissionsConfig');
      const allRoles = ['none', 'employee', 'subcontractor', 'client', 'accountant', 'hmrc', 'admin'];

      // Build a summary of what each role grants for the permissions preview
      const roleDetails = {};
      for (const r of allRoles) {
        const departments = rbac.getDepartmentsForRole(r);
        const modelAccess = rbac.roleModelAccess[r] || {};
        const models = Object.entries(modelAccess).map(([model, perms]) => {
          const ops = perms.split(',').map(e => e.trim());
          return {
            model: model.charAt(0).toUpperCase() + model.slice(1),
            operations: ops.map(op => {
              const [code, scope] = op.split(':');
              const labels = { c: 'Create', r: 'Read', u: 'Update', d: 'Delete', l: 'List' };
              return { label: labels[code] || code, ownOnly: scope === 'own' };
            }),
          };
        });
        const customRoutes = Object.entries(rbac.routeAccess)
          .filter(([, roles]) => roles === '*' || (Array.isArray(roles) && roles.includes(r)))
          .map(([route]) => route);
        roleDetails[r] = { departments, models, customRoutes };
      }

      return { roleDetails, allRoles };
    },
    readView: path.join('tailwindcss', 'user', 'read'),
    readLocals: async (item) => {
      const mdb = require('../services/mongooseDatabaseService');
      const rbac = require('./rolePermissionsConfig');

      const employee = item.employeeId ? await mdb.INTERNAL.employee.findById(item.employeeId).lean() : null;
      const subcontractor = item.subcontractorId ? await mdb.REST.supplier.findById(item.subcontractorId).lean() : null;
      const client = item.clientId ? await mdb.REST.customer.findById(item.clientId).lean() : null;

      const role = item.role || 'none';
      const departments = rbac.getDepartmentsForRole(role);
      const modelAccess = rbac.roleModelAccess[role] || {};

      const permissions = {
        role,
        departments,
        models: Object.entries(modelAccess).map(([model, perms]) => {
          const ops = perms.split(',').map(e => e.trim());
          return {
            model: model.charAt(0).toUpperCase() + model.slice(1),
            operations: ops.map(op => {
              const [code, scope] = op.split(':');
              const labels = { c: 'Create', r: 'Read', u: 'Update', d: 'Delete', l: 'List' };
              return { label: labels[code] || code, ownOnly: scope === 'own' };
            }),
          };
        }),
        customRoutes: Object.entries(rbac.routeAccess)
          .filter(([, roles]) => roles === '*' || (Array.isArray(roles) && roles.includes(role)))
          .map(([route]) => route),
      };

      let lastLoginTime = null;
      try {
        const lastSession = await mdb.INTERNAL.session.findOne({ userId: item._id.toString() }).sort({ loginTime: -1 }).lean();
        if (lastSession && lastSession.loginTime) {
          lastLoginTime = lastSession.loginTime;
        } else if (lastSession) {
          let payload = lastSession.session;
          if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (_) { payload = {}; } }
          if (payload?.user?.loginTime) lastLoginTime = new Date(payload.user.loginTime);
        }
      } catch (_) { /* ignore */ }

      return { user: item, employee, subcontractor, client, permissions, lastLoginTime };
    },
  },
  employeeHoliday: {
    readOnly: ['uuid', 'createdAt'],
    validators: {
      employeeId: v => typeof v === 'string' && v.length > 0,
      periodStart: v => !isNaN(Date.parse(v)),
      periodEnd: v => !isNaN(Date.parse(v)),
      entitlementDays: v => v == null || (typeof v === 'number' && v >= 0),
      entitlementHours: v => v == null || (typeof v === 'number' && v >= 0),
      accrualPercent: v => v == null || (typeof v === 'number' && v >= 0 && v <= 100)
    },
    middleware: {
      read: ['ensureRoles:admin,employee'],
      create: ['ensureRole:admin'],
      update: ['ensureRole:admin'],
      delete: ['ensureRole:admin'],
    },
    ownershipFields: {
      employee: 'employeeId',
    },
    referenceFilters: {
      employeeId: { status: 'active' }
    }
  },
  vehicle: {
    readOnly: ['uuid', 'createdAt'],
    validators: {
      registrationNumber: value => typeof value === 'string' && value.trim().length > 0,
      make: value => typeof value === 'string' && value.trim().length > 0,
      model: value => typeof value === 'string' && value.trim().length > 0,
      year: value => !isNaN(value) && value >= 1900 && value <= new Date().getFullYear() + 1,
      vin: value => !value || (typeof value === 'string' && value.trim().length === 17),
      engineSize: value => value == null || (typeof value === 'number' && value >= 0),
      currentMileage: value => value == null || (typeof value === 'number' && value >= 0),
      grossWeight: value => value == null || (typeof value === 'number' && value >= 0),
      payload: value => value == null || (typeof value === 'number' && value >= 0),
      insuranceExpiryDate: value => !value || !isNaN(Date.parse(value)),
      motExpiryDate: value => !value || !isNaN(Date.parse(value)),
      roadTaxExpiryDate: value => !value || !isNaN(Date.parse(value)),
      purchaseDate: value => !value || !isNaN(Date.parse(value)),
      leaseExpiryDate: value => !value || !isNaN(Date.parse(value)),
      lastServiceDate: value => !value || !isNaN(Date.parse(value)),
      nextServiceDueDate: value => !value || !isNaN(Date.parse(value)),
    },
    xorGroups: [
      ['employeeId', 'subcontractorId']
    ],
    referenceFilters: {
      employeeId: { status: 'active' },
      // OLD: subcontractorId: { IsSubcontractor: true },
      subcontractorId: { WithholdingTaxRate: { $gte: 0 } },
      projectId: { Status: { $nin: ['Archived', 'Completed'] } }
    },
    middleware: {
      read: ['ensureRoles:admin,employee,subcontractor'],
      create: ['ensureRole:admin'],
      update: ['ensureRole:admin'],
      delete: ['ensureRole:admin'],
    },
    ownershipFields: {
      employee: 'employeeId',
      subcontractor: 'subcontractorId',
    },
  },
  OcrDocument: {
    readOnly: ['uuid', 'createdAt', 'paperlessId', 'ocrText', 'fetchedAt', 'error'],
    middleware: {
      read: ['ensureRole:admin'],
    }
  },
  nominal: {
    readOnly: ['uuid', 'createdAt'],
    middleware: {
      read: ['ensureRoles:admin,accountant'],
    }
  },
  note: { 
    readOnly: ['uuid', 'createdAt'],
    middleware: {
      read: ['ensureRoles:admin,accountant'],
    }
  },
  vehicleFuelLog: {
    readOnly: ['uuid', 'createdAt'],
    validators: {
      date: value => !isNaN(Date.parse(value)),
      litres: value => !isNaN(value) && Number(value) > 0,
      totalCost: value => !isNaN(value) && Number(value) >= 0,
      costPerLitre: value => value == null || (!isNaN(value) && Number(value) >= 0),
      mileageAtFillUp: value => value == null || (!isNaN(value) && Number(value) >= 0),
    },
    xorGroups: [
      ['employeeId', 'subcontractorId']
    ],
    referenceFilters: {
      employeeId: { status: 'active' },
      // OLD: subcontractorId: { IsSubcontractor: true }
      subcontractorId: { WithholdingTaxRate: { $gte: 0 } }
    },
    middleware: {
      read: ['ensureRoles:admin,employee,subcontractor'],
      create: ['ensureRole:admin'],
      update: ['ensureRole:admin'],
      delete: ['ensureRole:admin'],
    },
    ownershipFields: {
      employee: 'employeeId',
      subcontractor: 'subcontractorId',
    },
  },
  vehicleMileageLog: {
    readOnly: ['uuid', 'createdAt', 'distance', 'claimAmount'],
    validators: {
      date: value => !isNaN(Date.parse(value)),
      startMileage: value => !isNaN(value) && Number(value) >= 0,
      endMileage: value => !isNaN(value) && Number(value) >= 0,
      hmrcRate: value => value == null || (!isNaN(value) && Number(value) >= 0),
    },
    xorGroups: [
      ['employeeId', 'subcontractorId']
    ],
    referenceFilters: {
      employeeId: { status: 'active' },
      // OLD: subcontractorId: { IsSubcontractor: true },
      subcontractorId: { WithholdingTaxRate: { $gte: 0 } },
      projectId: { Status: { $nin: ['Archived', 'Completed'] } }
    },
    middleware: {
      read: ['ensureRoles:admin,employee,subcontractor'],
      create: ['ensureRole:admin'],
      update: ['ensureRole:admin'],
      delete: ['ensureRole:admin'],
    },
    ownershipFields: {
      employee: 'employeeId',
      subcontractor: 'subcontractorId',
    },
  },
  vehicleService: {
    readOnly: ['uuid', 'createdAt'],
    validators: {
      date: value => !isNaN(Date.parse(value)),
      totalCost: value => value == null || (!isNaN(value) && Number(value) >= 0),
      labourCost: value => value == null || (!isNaN(value) && Number(value) >= 0),
      partsCost: value => value == null || (!isNaN(value) && Number(value) >= 0),
      vatAmount: value => value == null || (!isNaN(value) && Number(value) >= 0),
      mileageAtService: value => value == null || (!isNaN(value) && Number(value) >= 0),
      nextServiceDueDate: value => !value || !isNaN(Date.parse(value)),
      nextServiceDueMileage: value => value == null || (!isNaN(value) && Number(value) >= 0),
    },
    middleware: {
      read: ['ensureRole:admin'],
      create: ['ensureRole:admin'],
      update: ['ensureRole:admin'],
      delete: ['ensureRole:admin'],
    }
  }
}
