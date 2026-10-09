// Policies: company policies and individual employee documents. The list and
// edit pages are custom (/company-docs/policies), guarded by their route.
const COMPANY = { employee: null };

export default {
  id: 'policyDocument',
  model: 'policyDocument',
  label: { one: 'Policy', many: 'Policies' },
  icon: 'bi-journal-text',
  description: 'Company policies: published or draft, and which are due for review.',
  parents: ['policies'],
  overviewPath: '/overview/policyDocument',
  listPath: '/company-docs/policies',
  listRoute: '/company-docs/policies',
  readPath: '/company-docs/policies/:uuid/edit',
  actions: [{ label: 'New policy', href: '/company-docs/policies/create', route: '/company-docs/policies/create' }],
  figures: {
    published: { label: 'Published policies', where: { ...COMPANY, isPublished: true } },
    drafts: { label: 'Drafts', where: { ...COMPANY, isPublished: false } },
    reviewOverdue: { label: 'Past their review date', severity: 'critical', where: { ...COMPANY, isPublished: true, reviewDate: { $beforeNow: true } } },
    reviewDue: { label: 'Review due in 30 days', severity: 'warning', where: { ...COMPANY, isPublished: true, reviewDate: { $withinNextDays: 30 } } },
    employeeDocs: { label: 'Individual employee documents', where: { employee: { $set: true } } },
  },
  summary: ['published', 'reviewOverdue', 'reviewDue'],
  overview: {
    figures: ['published', 'drafts', 'reviewOverdue', 'reviewDue', 'employeeDocs'],
    breakdowns: [{ label: 'Company policies by category', by: 'category', where: COMPANY }],
    lists: [
      { figure: 'reviewOverdue', sort: { reviewDate: 1 }, limit: 10,
        columns: [{ field: 'title', label: 'Policy' }, { field: 'version', label: 'Version' }, { field: 'reviewDate', label: 'Review was due', format: 'date' }] },
      { figure: 'reviewDue', sort: { reviewDate: 1 }, limit: 10,
        columns: [{ field: 'title', label: 'Policy' }, { field: 'version', label: 'Version' }, { field: 'reviewDate', label: 'Review due', format: 'date' }] },
      { figure: 'drafts', sort: { updatedAt: -1 }, limit: 10,
        columns: [{ field: 'title', label: 'Policy' }, { field: 'category', label: 'Category' }, { field: 'updatedAt', label: 'Last edited', format: 'date' }] },
    ],
  },
};
