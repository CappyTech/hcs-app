// Vehicles: list-only node for now so the Employee overview can link to
// "vehicles with an employee". Gets a parent and an overview when Fleet is converted.
export default {
  id: 'vehicle',
  model: 'vehicle',
  label: { one: 'Vehicle', many: 'Vehicles' },
  parents: [],
  listPath: '/vehicles',
  figures: {
    withEmployee: {
      label: 'Vehicles with an employee',
      where: { employeeId: { $set: true }, availabilityStatus: { $ne: 'Disposed' } },
    },
  },
};
