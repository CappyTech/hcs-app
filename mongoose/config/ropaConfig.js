/**
 * Records of Processing Activities (RoPA)
 * UK GDPR Art. 30 — maintained as a JS config so it is version-controlled
 * alongside the codebase and requires no file I/O at runtime.
 *
 * To update: edit this file, commit, and deploy. No restart required
 * beyond the normal deployment cycle.
 */
const ropa = {
  version: '2026-08-21',
  lastUpdated: '2026-08-21',
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
    {
      id: 'A7',
      name: 'Bank reconciliation and payment matching',
      purpose:
        'Match bank transactions to sales and purchase documents, and evidence reviewer sign-off '
        + 'of each accounting period',
      lawfulBasis: ['legal_obligation', 'legitimate_interests'],
      // Bank narrative is personal data: it carries individual payee names,
      // subcontractor payments and wage transfers, not just amounts.
      dataCategories: ['financial', 'identity', 'transaction narrative'],
      subjectCategories: ['suppliers', 'subcontractors', 'customers', 'employees'],
      systems: [
        'REST.bankAccount', 'REST.bankTransaction', 'REST.bankReconciliation',
        'INTERNAL.bankMatch', 'INTERNAL.bankSignOff',
        // Imported bank statements. A wider disclosure than the ledger:
        // a statement lists every payee and wage transfer on the account,
        // including people who appear nowhere else in the system.
        'INTERNAL.statementImport', 'INTERNAL.statementLine',
        'PAPERLESS.bankStatementDocument',
      ],
      retention: '6 years (statutory accounting records)',
      recipients: ['internal_finance'],
      crossBorderTransfer: 'None',
    },
    {
      id: 'A8',
      name: 'Inbound mail filtering decisions',
      purpose:
        'Keep an independent record of how the upstream spam filter treated mail addressed to us, '
        + 'so wrongly rejected correspondence can be identified and answered for without relying on '
        + "the provider's own support process",
      // Legitimate interests, not consent: the senders are third parties who
      // never had a relationship with us to consent through, and the interest
      // being served is knowing whether our own mail service is losing genuine
      // correspondence. Mail security is named in Recital 49 as a legitimate
      // interest in its own right.
      lawfulBasis: ['legitimate_interests'],
      // Every record names a sender and a recipient. Subject lines and the
      // other free-text headers are deliberately excluded from the syslog
      // template, so no message content is held.
      dataCategories: ['contact', 'communications metadata', 'network identifiers'],
      // Wider than any other activity in this register: it covers anyone who
      // emails the business, including people who appear nowhere else in the
      // system and never chose to deal with us.
      subjectCategories: ['any_inbound_correspondent', 'employees', 'suppliers', 'customers'],
      // Not a database. NDJSON files written by the mailsiem collector on the
      // host and read through a read-only mount; hcs-app never copies them into
      // Mongo, which is what keeps the deletion job below the single thing that
      // makes the retention true. See mailFilterLogService.js.
      systems: ['mailsiem.events (host NDJSON, read-only mount)'],
      retention: '90 days, enforced by a scheduled deletion job on the collector host',
      recipients: ['internal_admins'],
      // The filtering cluster is operated by the mail provider; its egress
      // region has not been confirmed, and the syslog transport it offers has
      // no TLS option. That is why the template carries no message content.
      crossBorderTransfer: 'Not assessed — filtering cluster region unconfirmed',
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
    {
      name: 'SpamExperts / StrikeMail (via mail provider)',
      service: 'inbound_mail_filtering',
      dpaStatus: 'pending_evidence',
      transferAssessment: 'pending',
    },
  ],
};

export default ropa;
