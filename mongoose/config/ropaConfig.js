/**
 * Records of Processing Activities (RoPA)
 * UK GDPR Art. 30 — maintained as a JS config so it is version-controlled
 * alongside the codebase and requires no file I/O at runtime.
 *
 * To update: edit this file, commit, and deploy. No restart required
 * beyond the normal deployment cycle.
 */
const ropa = {
  version: '2026-05-26',
  lastUpdated: '2026-05-26',
  controller: {
    name: 'Heron Constructive Solutions LTD',
    system: 'hcs-app',
  },

  activities: [
    {
      id: 'A1',
      name: 'User account and authentication',
      purpose: 'Authenticate users and control access to the platform',
      lawfulBasis: ['contract', 'legitimate_interests'],
      dataCategories: ['identity', 'contact', 'security credentials'],
      subjectCategories: ['employees', 'subcontractors', 'clients', 'admins'],
      systems: ['INTERNAL.user', 'INTERNAL.session'],
      retention: 'Active account lifetime + 12 months post-closure',
      recipients: ['internal_admins'],
      crossBorderTransfer: 'None',
    },
    {
      id: 'A2',
      name: 'Attendance and payroll operations',
      purpose: 'Track attendance, calculate pay, and meet HMRC reporting obligations',
      lawfulBasis: ['contract', 'legal_obligation'],
      dataCategories: ['employment', 'financial', 'operational'],
      subjectCategories: ['employees', 'subcontractors'],
      systems: ['INTERNAL.attendance', 'INTERNAL.employee', 'INTERNAL.payrollEntry', 'REST.purchase'],
      retention: '6 years (PAYE/CIS statutory minimum)',
      recipients: ['internal_payroll', 'hmrc'],
      crossBorderTransfer: 'None',
    },
    {
      id: 'A3',
      name: 'CIS (Construction Industry Scheme) processing',
      purpose: 'Calculate and report CIS deductions to HMRC on behalf of subcontractors',
      lawfulBasis: ['legal_obligation'],
      dataCategories: ['financial', 'tax', 'identity'],
      subjectCategories: ['subcontractors'],
      systems: ['REST.supplier', 'REST.purchase', 'REST.nominal'],
      retention: '6 years (statutory)',
      recipients: ['hmrc'],
      crossBorderTransfer: 'None',
    },
    {
      id: 'A4',
      name: 'Document ingestion and OCR linking',
      purpose: 'Capture, classify, and link purchase documents via Paperless-ngx',
      lawfulBasis: ['contract', 'legitimate_interests'],
      dataCategories: ['document_content', 'supplier_contact', 'financial'],
      subjectCategories: ['suppliers', 'employees'],
      systems: ['PAPERLESS.OcrDocument', 'PAPERLESS.OcrDocumentIngest'],
      retention: 'Operational lifecycle; legal hold exceptions apply',
      recipients: ['internal_finance'],
      crossBorderTransfer: 'None',
    },
    {
      id: 'A5',
      name: 'Fleet and vehicle management',
      purpose: 'Track vehicle assignments, mileage, fuel, and compliance (MOT/insurance)',
      lawfulBasis: ['contract', 'legitimate_interests'],
      dataCategories: ['operational', 'location'],
      subjectCategories: ['employees', 'subcontractors'],
      systems: ['INTERNAL.vehicle', 'INTERNAL.vehicleMileageLog', 'INTERNAL.vehicleFuelLog'],
      retention: '3 years post-vehicle disposal',
      recipients: ['internal_admins'],
      crossBorderTransfer: 'None',
    },
    {
      id: 'A6',
      name: 'Email and SMS communications',
      purpose: 'Send account verification, password reset, and operational notifications',
      lawfulBasis: ['contract', 'legitimate_interests'],
      dataCategories: ['contact', 'security'],
      subjectCategories: ['all_users'],
      systems: ['services/emailService', 'services/smsService'],
      retention: 'Not stored — transient delivery only; SMTP logs per provider policy',
      recipients: ['smtp_provider', 'twilio'],
      crossBorderTransfer: 'Dependent on SMTP/Twilio provider region',
    },
  ],

  processors: [
    {
      name: 'MongoDB hosting provider',
      service: 'database',
      dpaStatus: 'pending_evidence',
      transferAssessment: 'pending',
    },
    {
      name: 'SMTP provider',
      service: 'email_delivery',
      dpaStatus: 'pending_evidence',
      transferAssessment: 'pending',
    },
    {
      name: 'Twilio',
      service: 'sms_delivery',
      dpaStatus: 'pending_evidence',
      transferAssessment: 'pending',
    },
    {
      name: 'Paperless-ngx host',
      service: 'document_processing',
      dpaStatus: 'pending_evidence',
      transferAssessment: 'pending',
    },
  ],
};

export default ropa;
