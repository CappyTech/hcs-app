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
    readOnly: ['uuid', 'createdAt'],
    validators: {
      date: value => !isNaN(Date.parse(value)),
      type: value => ['off', 'holiday', 'sick', 'work', 'training', 'leave'].includes(value),
      hoursWorked: value => typeof value === 'number' && value >= 0,
      payRate: value => typeof value === 'number' && value >= 0,
      dayRate: value => typeof value === 'number' && value >= 0,
    },
    middleware: {
      read: ['ensureRole:admin', 'ensureAuthenticated'],
      create: ['ensureRole:admin', 'ensureAuthenticated'],
      update: ['ensureRole:admin', 'ensureAuthenticated'],
      delete: ['ensureRole:admin', 'ensureAuthenticated'],
    },
    xorGroups: [ // can only choose one.
      ['employeeId', 'subcontractorId'],
      ['locationId', 'projectId'],
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
        const statusLabel = {
          0: 'Pending',
          1: 'In Progress',
          2: 'Completed'
        }[project.Status] || 'NothingisFuckingSet';

        const projectReference = project.Number ?? 'NothingisFuckingSet';
        const projectName = project.Name ?? 'NothingisFuckingSet';
        return `#${projectReference} – ${projectName} (${statusLabel})`;
      },

      // Subcontractors: Show name, postcode, and CIS rate
      subcontractorId: (supplier) => {
        const name = supplier.Name ?? '';
        return `${name}`;
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
      registrationNumber: value => typeof value === 'string' && value.length > 0,
      make: value => typeof value === 'string' && value.length > 0,
      model: value => typeof value === 'string' && value.length > 0,
      year: value => !isNaN(value) && value > 1900 && value <= new Date().getFullYear(),
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
  }
}
