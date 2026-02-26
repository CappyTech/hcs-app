const note = require("../models/mongoose/REST/note");
const { OcrDocument } = require("./listControllerConfig");

module.exports = {
  default: {
    middleware: {
      read: ['ensureRole:admin', 'ensureAuthenticated'],
      create: ['ensureRole:admin', 'ensureAuthenticated'],
      update: ['ensureRole:admin', 'ensureAuthenticated'],
      delete: ['ensureRole:admin', 'ensureAuthenticated'],
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
      read: ['ensureRole:admin', 'ensureAuthenticated'],
      create: ['ensureRole:admin', 'ensureAuthenticated'],
      update: ['ensureRole:admin', 'ensureAuthenticated'],
      delete: ['ensureRole:admin', 'ensureAuthenticated'],
    },
    xorGroups: [
      ['employeeId', 'subcontractorId'],
      ['hoursWorked', 'dayRate']
    ],
    referenceFilters: {
      subcontractorId: { IsSubcontractor: true },
      employeeId: { status: 'active' },
      projectId: { $or: [{ Status: 0 }, { Status: 2 }] }
    },
    referenceLabelFormat: {
      // Projects: Show number, name, and status label
      projectId: (project) => {
        const statusMap = { 0: 'Pending', 1: 'In Progress', 2: 'Completed' };
        const statusLabel = statusMap[project.Status] || 'Unknown';
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
      status: value => ['active', 'completed', 'draft'].includes(value),
    },
    middleware: {
      read: ['ensureRole:admin', 'ensureAuthenticated'],
      create: ['ensureRole:admin', 'ensureAuthenticated'],
      update: ['ensureRole:admin', 'ensureAuthenticated'],
      delete: ['ensureRole:admin', 'ensureAuthenticated'],
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
      read: ['ensureRole:admin', 'ensureAuthenticated'],
      create: ['ensureRole:admin', 'ensureAuthenticated'],
      update: ['ensureRole:admin', 'ensureAuthenticated'],
      delete: ['ensureRole:admin', 'ensureAuthenticated'],
    }
  },
  employee: {
    readOnly: ['uuid', 'createdAt'],
    validators: {
      email: value => /\S+@\S+\.\S+/.test(value),
      startDate: value => !isNaN(Date.parse(value))
    },
    middleware: {
      read: ['ensureRole:admin', 'ensureAuthenticated'],
      create: ['ensureRole:admin', 'ensureAuthenticated'],
      update: ['ensureRole:admin', 'ensureAuthenticated'],
      delete: ['ensureRole:admin', 'ensureAuthenticated'],
    }
  },
  customer: {
    readOnly: ['uuid', 'createdAt'],
    middleware: {
      read: ['ensureRole:admin', 'ensureAuthenticated'],
      create: ['ensureRole:admin', 'ensureAuthenticated'],
      update: ['ensureRole:admin', 'ensureAuthenticated'],
      delete: ['ensureRole:admin', 'ensureAuthenticated'],
    }
  },
  holiday: {
    readOnly: ['uuid', 'createdAt'],
    validators: {
      date: value => !isNaN(Date.parse(value)),
      description: value => typeof value === 'string' && value.length > 0,
    },
    middleware: {
      read: ['ensureRole:admin', 'ensureAuthenticated'],
      create: ['ensureRole:admin', 'ensureAuthenticated'],
      update: ['ensureRole:admin', 'ensureAuthenticated'],
      delete: ['ensureRole:admin', 'ensureAuthenticated'],
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
      read: ['ensureRole:admin', 'ensureAuthenticated'],
      create: ['ensureRole:admin', 'ensureAuthenticated'],
      update: ['ensureRole:admin', 'ensureAuthenticated'],
      delete: ['ensureRole:admin', 'ensureAuthenticated'],
    }
  },
  location: {
    readOnly: ['uuid', 'createdAt'],
    validators: {
      name: value => typeof value === 'string' && value.length > 0,
      address: value => typeof value === 'string' && value.length > 0,
    },
    middleware: {
      read: ['ensureRole:admin', 'ensureAuthenticated'],
      create: ['ensureRole:admin', 'ensureAuthenticated'],
      update: ['ensureRole:admin', 'ensureAuthenticated'],
      delete: ['ensureRole:admin', 'ensureAuthenticated'],
    }
  },
  meta: {
    readOnly: ['uuid', 'createdAt'],
    validators: {
      key: value => typeof value === 'string' && value.length > 0,
      value: value => typeof value === 'string' && value.length > 0,
    },
    middleware: {
      read: ['ensureRole:admin', 'ensureAuthenticated'],
      create: ['ensureRole:admin', 'ensureAuthenticated'],
      update: ['ensureRole:admin', 'ensureAuthenticated'],
      delete: ['ensureRole:admin', 'ensureAuthenticated'],
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
      read: ['ensureRole:admin', 'ensureAuthenticated'],
      create: ['ensureRole:admin', 'ensureAuthenticated'],
      update: ['ensureRole:admin', 'ensureAuthenticated'],
      delete: ['ensureRole:admin', 'ensureAuthenticated'],
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
      read: ['ensureRole:admin', 'ensureAuthenticated'],
      create: ['ensureRole:admin', 'ensureAuthenticated'],
      update: ['ensureRole:admin', 'ensureAuthenticated'],
      delete: ['ensureRole:admin', 'ensureAuthenticated'],
    }
  },
  session: {
    readOnly: ['id', 'createdAt'],
    validators: {
      userId: value => typeof value === 'string' && value.length > 0,
      expiresAt: value => !isNaN(Date.parse(value)),
    },
    middleware: {
      read: ['ensureRole:admin', 'ensureAuthenticated'],
      create: ['ensureRole:admin', 'ensureAuthenticated'],
      update: ['ensureRole:admin', 'ensureAuthenticated'],
      delete: ['ensureRole:admin', 'ensureAuthenticated'],
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
      read: ['ensureRole:admin', 'ensureAuthenticated'],
      create: ['ensureRole:admin', 'ensureAuthenticated'],
      update: ['ensureRole:admin', 'ensureAuthenticated'],
      delete: ['ensureRole:admin', 'ensureAuthenticated'],
    }
  },
  task: {
    readOnly: ['uuid', 'createdAt'],
    validators: {
      title: value => typeof value === 'string' && value.length > 0,
      description: value => typeof value === 'string' && value.length > 0,
      dueDate: value => !isNaN(Date.parse(value)),
    },
    middleware: {
      read: ['ensureRole:admin', 'ensureAuthenticated'],
      create: ['ensureRole:admin', 'ensureAuthenticated'],
      update: ['ensureRole:admin', 'ensureAuthenticated'],
      delete: ['ensureRole:admin', 'ensureAuthenticated'],
    }
  },
  user: {
    readOnly: ['uuid', 'createdAt'],
    validators: {
      email: value => /\S+@\S+\.\S+/.test(value),
      password: value => typeof value === 'string' && value.length >= 6,
      name: value => typeof value === 'string' && value.length > 0,
    },
    middleware: {
      read: ['ensureRole:admin', 'ensureAuthenticated'],
      create: ['ensureRole:admin', 'ensureAuthenticated'],
      update: ['ensureRole:admin', 'ensureAuthenticated'],
      delete: ['ensureRole:admin', 'ensureAuthenticated'],
    }
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
      read: ['ensureRole:admin', 'ensureAuthenticated'],
      create: ['ensureRole:admin', 'ensureAuthenticated'],
      update: ['ensureRole:admin', 'ensureAuthenticated'],
      delete: ['ensureRole:admin', 'ensureAuthenticated'],
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
      subcontractorId: { IsSubcontractor: true },
      projectId: { $or: [{ Status: 0 }, { Status: 2 }] }
    },
    middleware: {
      read: ['ensureRole:admin', 'ensureAuthenticated'],
      create: ['ensureRole:admin', 'ensureAuthenticated'],
      update: ['ensureRole:admin', 'ensureAuthenticated'],
      delete: ['ensureRole:admin', 'ensureAuthenticated'],
    }
  },
  OcrDocument: {
    readOnly: ['uuid', 'createdAt', 'paperlessId', 'ocrText', 'fetchedAt', 'error'],
    middleware: {
      read: ['ensureRole:admin', 'ensureAuthenticated'],
    }
  },
  nominal: {
    readOnly: ['uuid', 'createdAt'],
    middleware: {
      read: ['ensureRole:admin', 'ensureAuthenticated'],
    }
  },
  note: { 
    readOnly: ['uuid', 'createdAt'],
    middleware: {
      read: ['ensureRole:admin', 'ensureAuthenticated'],
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
      subcontractorId: { IsSubcontractor: true }
    },
    middleware: {
      read: ['ensureRole:admin', 'ensureAuthenticated'],
      create: ['ensureRole:admin', 'ensureAuthenticated'],
      update: ['ensureRole:admin', 'ensureAuthenticated'],
      delete: ['ensureRole:admin', 'ensureAuthenticated'],
    }
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
      subcontractorId: { IsSubcontractor: true },
      projectId: { $or: [{ Status: 0 }, { Status: 2 }] }
    },
    middleware: {
      read: ['ensureRole:admin', 'ensureAuthenticated'],
      create: ['ensureRole:admin', 'ensureAuthenticated'],
      update: ['ensureRole:admin', 'ensureAuthenticated'],
      delete: ['ensureRole:admin', 'ensureAuthenticated'],
    }
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
      read: ['ensureRole:admin', 'ensureAuthenticated'],
      create: ['ensureRole:admin', 'ensureAuthenticated'],
      update: ['ensureRole:admin', 'ensureAuthenticated'],
      delete: ['ensureRole:admin', 'ensureAuthenticated'],
    }
  }
}
