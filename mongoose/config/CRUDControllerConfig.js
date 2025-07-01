module.exports = {
  contract: {
    readOnly: ['uuid', 'createdAt'],
    validators: {
      title: value => typeof value === 'string' && value.length >= 3,
      status: value => ['active', 'completed', 'draft'].includes(value),
    },
    middleware: {
      create: ['ensureRole:admin'],
      update: ['ensureRole:admin'],
      delete: ['ensureRole:admin'],
    }
  },
  employee: {
    readOnly: ['uuid', 'createdAt'],
    validators: {
      email: value => /\S+@\S+\.\S+/.test(value),
      startDate: value => !isNaN(Date.parse(value))
    },
    middleware: {
      create: ['ensureRole:admin'],
      update: ['ensureRole:admin'],
      delete: ['ensureRole:admin'],
    }
  }
};
