// Users: list-only node for now (Admin area not converted yet).
export default {
  id: 'user',
  model: 'user',
  label: { one: 'User', many: 'Users' },
  parents: [],
  listPath: '/users',
  figures: {
    subcontractorPortal: { label: 'Subcontractor portal users', where: { role: 'subcontractor' } },
  },
};
