// CIS returns: the monthly CIS300 return, one per tax month. There's no model
// for a return (the CIS dashboard works each month out from purchases), so this
// is a group: its figures are borrowed from subcontractors (only those verified
// with HMRC go on a return) and the months come from the cisReturnMonths panel.
export default {
  id: 'cisReturn',
  label: { one: 'CIS return', many: 'CIS returns' },
  icon: 'bi-file-earmark-text',
  description: 'Monthly returns to HMRC: this tax month, when each return is due, and the months before.',
  parents: ['subcontractors'],
  overviewPath: '/overview/cisReturn',
  actions: [
    { label: 'CIS dashboard', href: '/CIS/Dashboard/', route: '/CIS/Dashboard', icon: 'bi-speedometer2' },
    { label: 'Returns reports', href: '/CIS/returns/form', route: '/CIS/returns', icon: 'bi-file-earmark-text' },
  ],
  summary: ['subcontractor.verified', 'subcontractor.unverified'],
  overview: {
    figures: ['subcontractor.verified', 'subcontractor.unverified', 'subcontractor.rate30'],
    panels: ['cisReturnMonths'],
    related: ['subcontractor.owed'],
  },
};
