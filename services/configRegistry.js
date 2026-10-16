/**
 * configRegistry — the single list of what is configurable, and how.
 *
 * Before this existed, the settings UI was driven by four hand-maintained
 * `*_KEYS` arrays in connectionSettingsController.js. They covered 24 of the
 * 122 environment variables the code actually reads, and nothing connected the
 * two: a new `process.env` read simply never appeared in the UI, and no one
 * found out. The UI, the adoption flow and the tests are all generated from
 * this file, so adding a key here is what makes it manageable.
 *
 * Per key:
 *   key      env var name, which is also the store key
 *   label    human name
 *   help     one line on what it does — this is what an admin reads
 *   type     'text' | 'number' | 'boolean' | 'secret' | 'textarea' | 'select'
 *   options  (select only) [{ value, label }]; saving any other value is refused
 *   type 'email' renders a dropdown of every user's email plus "Other…" for
 *            any address; whatever is saved must be a valid email address
 *   restart  true when the value is read at import time, so a save cannot take
 *            effect until the container restarts. Silently doing nothing is the
 *            failure this flag exists to prevent.
 *   test     (group level) id understood by the connection tester
 */

/**
 * Keys that can never move into the store, because they are needed before
 * there is a database or a session to authenticate an admin against — and, for
 * ENCRYPTION_KEY, because it is what encrypts the store's own secrets. They are
 * rendered read-only so the UI shows the whole picture rather than implying
 * these are unset.
 *
 * None of them has to be set by a human any more: ENCRYPTION_KEY is generated
 * into a key file on the storage volume and SESSION_SECRET into Mongo when the
 * environment is silent (bootstrapSecretsService), and the database wizard
 * saves MONGO_* to the same volume. The environment still wins when set.
 */
export const BOOTSTRAP_KEYS = [
  'NODE_ENV',
  'HOST',
  'PORT',
  'MONGO_URI',
  'MONGO_HOST',
  'MONGO_PORT',
  'MONGO_USER',
  'MONGO_PASS',
  'MONGO_AUTH_SOURCE',
  'MONGO_DBNAME_INTERNAL',
  'MONGO_DBNAME_REST',
  'MONGO_DBNAME_PAPERLESS',
  'MONGO_DBNAME_WEB',
  'SESSION_SECRET',
  'ENCRYPTION_KEY',
  'ENCRYPTION_SALT',
  'FILE_STORAGE_DIR',
  'TRUST_PROXY',
];

export const GROUPS = [
  {
    id: 'organisation',
    label: 'Organisation',
    icon: 'bi-building-fill',
    description: 'The company name, address, contact details and website. Everything user-facing that names the company reads these; nothing is hard-coded.',
    keys: [
      { key: 'COMPANY_NAME', label: 'Company name', type: 'text', help: 'Full legal name, as it appears on CIS statements, legal pages and the footer.' },
      { key: 'COMPANY_SHORT_NAME', label: 'Short name', type: 'text', help: 'Everyday name for email subjects, SMS, the authenticator app and sender names. Blank uses the full name.' },
      { key: 'COMPANY_ADDRESS', label: 'Postal address', type: 'text', help: 'One line, e.g. "1 Example Street, Town, AB1 2CD". Printed on CIS statements and in email notices.' },
      { key: 'SUPPORTEMAIL', label: 'Contact email', type: 'email', help: 'Shown on the maintenance page, CIS print footers and automated email notices.' },
      { key: 'COMPANY_WEBSITE_URL', label: 'Website', type: 'text', help: 'The public website, e.g. https://www.example.com. Used for the footer link and the Website area\'s public URLs.' },
      { key: 'ONEDRIVE_URL', label: 'OneDrive URL', type: 'text', help: 'Where the Microsoft OneDrive dashboard tile links to. Blank hides the tile.' },
      { key: 'COMPANY_NUMBER', label: 'Company registration number', type: 'text', help: 'Companies House number. Shown in the footer (linked to the Companies House register) and the privacy policy. Blank hides it.' },
      { key: 'COMPANY_VAT_NUMBER', label: 'VAT registration number', type: 'text', help: 'Shown in the footer and the privacy policy. Blank hides it.' },
      { key: 'ICO_NUMBER', label: 'ICO registration number', type: 'text', help: 'Shown in the privacy policy.' },
      { key: 'INCORPORATION_YEAR', label: 'Incorporation year', type: 'number', help: 'First year of the copyright range in the footer.' },
      { key: 'BASE_URL', label: 'This app\'s public URL', type: 'text', help: 'Where users reach this app, e.g. https://app.example.com. Absolute links in emails and the Content-Security-Policy\'s own-origin entries derive from it. Seeded from the first-run page, or from the first signed-in request when blank.' },
    ],
  },
  {
    id: 'maintenance',
    label: 'Maintenance',
    icon: 'bi-cone-striped',
    description: 'Runtime maintenance mode and the notice banner. Also controlled from Admin → Maintenance.',
    keys: [
      { key: 'MAINTENANCE', label: 'Maintenance mode', type: 'boolean', help: 'When on, non-admin users see a 503 maintenance page. Admins can still use the app.' },
      { key: 'MAINTENANCE_NOTICE', label: 'Notice banner', type: 'text', help: 'A short notice shown to all users, e.g. an upcoming maintenance window. Blank hides the banner.' },
    ],
  },
  {
    id: 'appearance',
    label: 'Appearance',
    icon: 'bi-layout-text-window-reverse',
    description: 'How the app looks for everyone. Each person can override the navigation style on their Account Settings page.',
    keys: [
      {
        key: 'NAV_STYLE_DEFAULT', label: 'Navigation style', type: 'select',
        options: [
          { value: 'tabs', label: 'Icon tabs: the classic centred row of icon-over-label tabs' },
          { value: 'grouped', label: 'Grouped menus: People, Money, Work and System dropdowns' },
          { value: 'two-tier', label: 'Two-tier: a utility bar above a row of area tabs' },
          { value: 'command', label: 'Command rail: pinned chips, a More menu and Jump to (Ctrl+K)' },
          { value: 'sidebar', label: 'Sidebar: a slim header with a grouped left sidebar' },
        ],
        help: 'The header layout people see until they pick their own on Account Settings. Unset means Icon tabs.',
      },
    ],
  },
  {
    id: 'paperless',
    label: 'Paperless-ngx',
    icon: 'bi-file-earmark-text-fill',
    description: 'OCR document ingestion, the Document added webhook, and the ingest reconciliation job.',
    test: 'paperless',
    // Saving new Paperless settings must drop the cached custom-field
    // definitions, or the next call resolves field ids against the old server.
    afterSave: 'paperless',
    keys: [
      // Connection
      { key: 'PAPERLESS_BASE_URL', label: 'Base URL', type: 'text', help: 'Hostname or full URL. `/api` is appended when missing.' },
      { key: 'PAPERLESS_TOKEN', label: 'API token', type: 'secret', help: 'Paperless API token, sent as `Authorization: Token …`.' },
      { key: 'PAPERLESS_PORT', label: 'Port', type: 'number', help: 'Used only when the base URL is a bare host.' },
      { key: 'PAPERLESS_ACCEPT', label: 'Accept header', type: 'text', help: 'API version to request. Default `application/json; version=6`. Paperless retires old versions — a version it no longer serves answers 406 on every call.' },
      { key: 'PAPERLESS_TIMEOUT_MS', label: 'Timeout (ms)', type: 'number', help: 'Per-request timeout. Default 60000.' },
      { key: 'PAPERLESS_UI_URL', label: 'Web UI URL', type: 'text', help: 'Where "open in Paperless" links point, e.g. `https://docs.example.com`. Blank uses the base URL without `/api`, which is wrong when that is an internal address.' },
      // SSH tunnel (only when the toggle is on). The tunnel stays open once made.
      { key: 'PAPERLESS_SSH_TUNNEL_ENABLED', label: 'Use SSH tunnel', type: 'boolean', help: 'Reach Paperless through an SSH tunnel instead of directly. Needs the SSH fields below.' },
      { key: 'PAPERLESS_SSH_HOST', label: 'SSH host', type: 'text', restart: true, help: 'Tunnel host. Falls back to `SSH_HOST`. An open tunnel keeps its settings until the app restarts.' },
      { key: 'PAPERLESS_SSH_PORT', label: 'SSH port', type: 'number', restart: true, help: 'Default 22, or `SSH_PORT`.' },
      { key: 'PAPERLESS_SSH_USER', label: 'SSH user', type: 'text', restart: true, help: 'Falls back to `SSH_USER`.' },
      { key: 'PAPERLESS_SSH_KEY_PATH', label: 'SSH key path', type: 'text', restart: true, help: 'Private key file inside the container. Either this or the password is required.' },
      { key: 'PAPERLESS_SSH_PASS', label: 'SSH password', type: 'secret', restart: true, help: 'Used when no key path is set.' },
      { key: 'PAPERLESS_REMOTE_HOST', label: 'Paperless host (from SSH box)', type: 'text', restart: true, help: 'Where Paperless listens as seen from the SSH host. Default `127.0.0.1`.' },
      { key: 'PAPERLESS_REMOTE_PORT', label: 'Paperless port (from SSH box)', type: 'number', restart: true, help: 'Default 8000.' },
      // Ingest
      { key: 'PAPERLESS_WEBHOOK_SECRET', label: 'Webhook secret', type: 'secret', help: 'Shared secret the Paperless "Document added" workflow sends to `POST /api/paperless/webhook`, as `Authorization: Bearer …` or `X-Webhook-Secret`. Unset turns the webhook off (503).' },
      { key: 'PAPERLESS_FOLLOW_TAGS', label: 'Follow Paperless tags', type: 'boolean', help: 'Until cutover, move a document forward when its Paperless tags say it has progressed (data entry done, added, credit note, statement emailed). Default on. Turn off at cutover (H8).' },
      { key: 'PAPERLESS_RECONCILE_LOOKBACK_HOURS', label: 'Reconcile lookback (hours)', type: 'number', help: 'How far back the ingest reconciliation job looks for documents a webhook may have missed. Default 48.' },
      { key: 'PAPERLESS_PAGE_SIZE', label: 'Page size', type: 'number', help: 'Documents fetched per page during a grab. Default 50.' },
      { key: 'PAPERLESS_CONCURRENCY', label: 'Concurrency', type: 'number', help: 'Documents processed in parallel during a grab. Default 5.' },
      { key: 'PAPERLESS_AUTOINGEST_DEBOUNCE_MS', label: 'List-page grab debounce (ms)', type: 'number', help: 'Opening the OCR list only triggers a grab if the last one finished longer ago than this. Default 600000 (10 minutes).' },
      { key: 'PAPERLESS_CF_CACHE_MS', label: 'Custom-field cache (ms)', type: 'number', restart: true, help: 'How long custom-field definitions are cached. Read once at import.' },
      // Diagnostics
      { key: 'PAPERLESS_VERBOSE', label: 'Verbose logging', type: 'boolean', help: 'Log every Paperless request and response body snippet.' },
    ],
  },
  {
    id: 'document-notifications',
    label: 'Document notifications',
    icon: 'bi-bell-fill',
    description: 'The emails and Discord posts for Paperless documents (migration H6). Shadow mode records what would be sent without sending.',
    keys: [
      {
        key: 'NOTIFY_MODE', label: 'Mode', type: 'select',
        options: [
          { value: 'shadow', label: 'Shadow: record only, send nothing' },
          { value: 'live', label: 'Live: send emails and Discord posts' },
        ],
        help: 'Shadow (the default when unset) records what would be sent while Paperless keeps sending. Switch to Live at cutover (H8), the same hour Paperless WF2, 3, 4, 5, 8 and 9 are disabled.',
      },
      { key: 'NOTIFY_INVOICE_EMAIL', label: 'Purchase invoice email', type: 'email', help: 'Gets each purchase invoice, PDF attached, once its data entry is complete, and again on every Resend.' },
      { key: 'NOTIFY_STATEMENT_EMAIL', label: 'Supplier statement email', type: 'email', help: 'Gets each supplier statement, PDF attached, the first time it is marked reviewed.' },
      { key: 'NOTIFY_CREDIT_NOTE_EMAIL', label: 'Credit note email', type: 'email', help: 'Gets each credit note, PDF attached, the first time an invoice is marked as a credit note.' },
      { key: 'DISCORD_WEBHOOK_URL', label: 'Discord webhook URL', type: 'secret', help: 'Where document posts go. Unset: posts are skipped and logged.' },
      { key: 'NOTIFY_SENDER_NAME', label: 'Sender name', type: 'text', help: 'Display name on the document emails and the Discord posts. Blank uses "<short company name> | Documents".' },
      { key: 'NOTIFY_INVOICE_RECIPIENT_NAME', label: 'Invoice recipient name', type: 'text', help: 'How the Discord post names who got the invoice: "Emailed invoice to <name>". Blank uses the invoice email address.' },
      { key: 'NOTIFY_STATEMENT_RECIPIENT_NAME', label: 'Statement recipient name', type: 'text', help: 'As above, for "Emailed statement to <name>".' },
      { key: 'NOTIFY_CREDIT_NOTE_RECIPIENT_NAME', label: 'Credit note recipient name', type: 'text', help: 'As above, for "Emailed credit note to <name>".' },
    ],
  },
  {
    id: 'pensions',
    label: 'Pensions',
    icon: 'bi-piggy-bank-fill',
    description: 'The workplace pension provider’s API. Provider name and employer reference are on the payroll settings page.',
    keys: [
      { key: 'PEOPLES_PENSION_API_KEY', label: 'People’s Pension API key', type: 'secret', help: 'For submitting contributions straight to People’s Pension. The API upload isn’t built yet, so payroll uses the CSV download whether or not this is set.' },
    ],
  },
  {
    id: 'kashflow',
    label: 'KashFlow',
    icon: 'bi-cash-coin',
    description: 'Credentials hcs-app uses for its own KashFlow calls. Data sync is hcs-sync’s job.',
    test: 'kashflow',
    keys: [
      { key: 'KASHFLOW_API_BASE_URL', label: 'API base URL', type: 'text', help: 'KashFlow REST API root.' },
      { key: 'KASHFLOW_API_USERNAME', label: 'Username', type: 'text', help: 'KashFlow account username.' },
      { key: 'KASHFLOW_API_PASSWORD', label: 'Password', type: 'secret', help: 'KashFlow account password.' },
      { key: 'KASHFLOW_MEMORABLE', label: 'Memorable word', type: 'secret', help: 'Memorable word for the session challenge.' },
      { key: 'KASHFLOW_SESSION_TOKEN', label: 'Session token', type: 'secret', help: 'Cached session token. Normally obtained automatically.' },
      { key: 'KASHFLOW_DEBUG_SESSION', label: 'Debug session', type: 'boolean', help: 'Log the session handshake in detail.' },
      { key: 'KASHFLOW_DEFER_DEFAULTS', label: 'Defer defaults', type: 'boolean', help: 'Skip applying default values on create.' },
      { key: 'NOTIFY_EMAIL', label: 'Project alert email', type: 'email', help: 'Gets the "projects below income target" alert from the KashFlow project check. Blank sends it to the SMTP From address.' },
    ],
  },
  {
    id: 'smtp',
    label: 'Email (SMTP)',
    icon: 'bi-envelope-fill',
    description: 'Outbound mail for notifications, password resets and payroll documents.',
    test: 'smtp',
    // Reset the cached mail clients after a save so new settings take effect
    // immediately, without a restart.
    afterSave: 'mail',
    keys: [
      { key: 'SMTP_HOST', label: 'Host', type: 'text', help: 'SMTP server hostname (e.g. smtp.office365.com).' },
      { key: 'SMTP_PORT', label: 'Port', type: 'number', help: '587 for STARTTLS, 465 for implicit TLS.' },
      { key: 'SMTP_SECURE', label: 'Implicit TLS', type: 'text', help: 'true / false, or blank to auto-detect (true only when port is 465). Use false for 587 STARTTLS.' },
      { key: 'SMTP_USER', label: 'Username', type: 'text', help: 'SMTP login (the mailbox address).' },
      { key: 'SMTP_PASS', label: 'Password', type: 'secret', help: 'SMTP password or app password.' },
      { key: 'SMTP_FROM', label: 'From address', type: 'text', help: 'Envelope sender for all outbound mail (must be the authenticated mailbox or an allowed alias).' },
      { key: 'UNSUBSCRIBE_ROTATION_ENABLED', label: 'Rotate unsubscribe links', type: 'boolean', help: 'Automatically rotate every user\'s unsubscribe token on the schedule. Default on. Also controlled from Admin → Emails.' },
    ],
  },
  {
    id: 'graph',
    label: 'Email (Microsoft Graph)',
    icon: 'bi-microsoft',
    description: 'App-only sending via Microsoft Graph — no password or SMTP AUTH, and it works with Microsoft 365 shared mailboxes (e.g. noreply@). Turn on "Use Microsoft Graph" to use this instead of SMTP. See Help → Administration → Sending Email via Microsoft Graph for setup.',
    test: 'graph',
    afterSave: 'mail',
    keys: [
      { key: 'USE_GRAPH', label: 'Use Microsoft Graph', type: 'boolean', help: 'When on, outbound mail is sent via Microsoft Graph instead of SMTP. Falls back to SMTP if Graph is not fully configured.' },
      { key: 'GRAPH_TENANT_ID', label: 'Tenant ID', type: 'text', help: 'Entra directory (tenant) ID of the app registration.' },
      { key: 'GRAPH_CLIENT_ID', label: 'Client ID', type: 'text', help: 'Application (client) ID of the Entra app registration.' },
      { key: 'GRAPH_CLIENT_SECRET', label: 'Client secret', type: 'secret', help: 'A client secret value from the app registration.' },
      { key: 'GRAPH_MAIL_SENDER', label: 'Sender mailbox', type: 'text', help: 'The mailbox to send as, e.g. noreply@example.com. The app needs Mail.Send scoped to this mailbox via an Application Access Policy.' },
    ],
  },
  {
    id: 'sms',
    label: 'SMS (Twilio)',
    icon: 'bi-chat-dots-fill',
    description: 'Outbound text messages.',
    test: 'sms',
    // The Twilio client is cached with its credentials baked in.
    afterSave: 'sms',
    keys: [
      { key: 'TWILIO_ACCOUNT_SID', label: 'Account SID', type: 'text', help: 'Twilio account identifier.' },
      { key: 'TWILIO_AUTH_TOKEN', label: 'Auth token', type: 'secret', help: 'Twilio auth token.' },
      { key: 'TWILIO_FROM_NUMBER', label: 'From number', type: 'text', help: 'Sending number in E.164 format.' },
    ],
  },
  {
    id: 'security',
    label: 'Security',
    icon: 'bi-shield-lock-fill',
    description: 'Transport, cookie and brute-force settings. Several are read at startup.',
    keys: [
      { key: 'TURNSTILE_SITE_KEY', label: 'Turnstile site key', type: 'text', help: 'Cloudflare Turnstile public key for the login and registration forms. The CAPTCHA is enforced only when both Turnstile keys are set; blank means no CAPTCHA.' },
      { key: 'TURNSTILE_SECRET_KEY', label: 'Turnstile secret key', type: 'secret', help: 'Cloudflare Turnstile secret used to verify tokens server-side.' },
      { key: 'TRUST_EDGE_TLS', label: 'TLS terminates upstream', type: 'boolean', help: 'Treat requests as HTTPS when a reverse proxy terminates TLS and forwards over plain HTTP. Do not set where the app is reachable directly over HTTP.' },
      { key: 'ENABLE_HSTS', label: 'Enable HSTS', type: 'boolean', restart: true, help: 'Send Strict-Transport-Security. Read once when helmet is configured.' },
      { key: 'COOKIE_SECURE', label: 'Secure cookies', type: 'text', restart: true, help: 'true / false, or blank for auto (secure only when the request is HTTPS). Read once when the session middleware is built.' },
      { key: 'STRICT_MODE', label: 'Strict CSRF', type: 'boolean', help: 'Strict CSRF enforcement. Default on; turn off only while migrating legacy forms.' },
      { key: 'CSRF_EXEMPT_PATHS', label: 'CSRF exempt paths', type: 'text', help: 'Comma-separated paths that skip CSRF, e.g. a webhook.' },
      { key: 'BCRYPT_ROUNDS', label: 'bcrypt rounds', type: 'number', help: 'Password hashing cost. Default 12.' },
      { key: 'LOGIN_MAX_ATTEMPTS', label: 'Max login attempts', type: 'number', help: 'Failed logins before lockout. Default 5.' },
      { key: 'LOGIN_LOCKOUT_MS', label: 'Lockout (ms)', type: 'number', help: 'How long a locked account stays locked. Default 900000.' },
      { key: 'BLOCKED_IPS', label: 'Blocked IPs', type: 'text', restart: true, help: 'Comma-separated permanent blocks. Read once at import.' },
      { key: 'BLOCK_HIT_THRESHOLD', label: 'Auto-block threshold', type: 'number', restart: true, help: 'Hits within the window before an IP is blocked. Read once at import.' },
      { key: 'BLOCK_HIT_WINDOW_MS', label: 'Auto-block window (ms)', type: 'number', restart: true, help: 'Window the threshold is counted over. Read once at import.' },
      { key: 'BLOCK_BAN_TTL_MS', label: 'Auto-block duration (ms)', type: 'number', restart: true, help: 'How long an auto-block lasts. Read once at import.' },
    ],
  },
  {
    id: 'microsoft-sso',
    label: 'Microsoft Sign-in (SSO)',
    icon: 'bi-microsoft',
    description: 'Let existing users sign in with their Microsoft 365 account (OpenID Connect). Sign-in only — a Microsoft login is matched to an existing hcs-app account by email and refused if there is none; no accounts are created. See Help → Administration → Signing in with Microsoft. Needs a separate Entra app registration with a Redirect URI and delegated openid/profile/email scopes.',
    test: 'microsoft-sso',
    keys: [
      { key: 'MS_SSO_ENABLED', label: 'Enable Microsoft sign-in', type: 'boolean', help: 'When on (and the fields below are set), a "Sign in with Microsoft" button appears on the login page.' },
      { key: 'MS_SSO_TENANT_ID', label: 'Tenant ID', type: 'text', help: 'Entra directory (tenant) ID.' },
      { key: 'MS_SSO_CLIENT_ID', label: 'Client ID', type: 'text', help: 'Application (client) ID of the sign-in app registration.' },
      { key: 'MS_SSO_CLIENT_SECRET', label: 'Client secret', type: 'secret', help: 'A client secret value from the sign-in app registration.' },
      { key: 'MS_SSO_REDIRECT_URI', label: 'Redirect URI', type: 'text', help: 'Must match a Redirect URI on the app registration. Blank = derive from the public base URL, i.e. <base>/auth/microsoft/callback.' },
    ],
  },
  {
    id: 'sso',
    label: 'Sessions & SSO',
    icon: 'bi-box-arrow-in-right',
    description: 'Session cookie scope, and the trust relationship with hcs-sync.',
    keys: [
      { key: 'SESSION_COOKIE_DOMAIN', label: 'Session cookie domain', type: 'text', restart: true, help: 'Share the session across subdomains, e.g. .example.com. Read once when the session middleware is built.' },
      { key: 'HCS_SSO_JWT_SECRET', label: 'SSO JWT secret', type: 'secret', help: 'Signs the SSO cookie. Must match hcs-sync.' },
      { key: 'HCS_SYNC_API_KEY', label: 'hcs-sync API key', type: 'secret', help: 'Shared key for POST /api/sso/token and POST /api/pull. Must match hcs-sync.' },
      { key: 'HCS_SYNC_BASE_URL', label: 'hcs-sync base URL', type: 'text', help: 'Where per-item re-sync requests are sent.' },
      { key: 'HCS_SYNC_TIMEOUT_MS', label: 'hcs-sync timeout (ms)', type: 'number', help: 'Timeout for calls to hcs-sync. Default 20000.' },
      { key: 'HCS_SYNC_PULL_DELAY_MS', label: 'Re-pull delay (ms)', type: 'number', help: 'Grace period before asking hcs-sync to re-pull a just-created supplier.' },
      { key: 'HCS_SSO_RETURN_HOSTS', label: 'Allowed return hosts', type: 'text', help: 'Comma-separated hosts /sso/hcs-sync may redirect back to.' },
      { key: 'HCS_SSO_ALLOW_HTTP', label: 'Allow http return', type: 'boolean', help: 'Permit plain-http return URLs. Not recommended in production.' },
      { key: 'HCS_SSO_TTL_SECONDS', label: 'SSO token TTL (s)', type: 'number', help: 'Lifetime of an issued SSO token. Default 3600.' },
      { key: 'HCS_SYNC_SSO_ROLES', label: 'Roles allowed SSO', type: 'text', help: 'Comma-separated roles that may receive an hcs-sync token.' },
      { key: 'HCS_SSO_COOKIE_DOMAIN', label: 'SSO cookie domain', type: 'text', help: 'Cookie domain for cross-subdomain SSO.' },
    ],
  },
  {
    id: 'audit',
    label: 'Audit trail',
    icon: 'bi-journal-text',
    description: 'What the audit log records and how long it keeps it. All read at startup.',
    keys: [
      { key: 'AUDIT_SENSITIVE_MODELS', label: 'Sensitive models', type: 'text', restart: true, help: 'Comma-separated models whose single-record reads are logged for subject-access accountability.' },
      { key: 'AUDIT_EXCLUDE_MODELS', label: 'Excluded models', type: 'text', restart: true, help: 'Comma-separated INTERNAL models not audited at all.' },
      { key: 'AUDIT_TTL_DAYS', label: 'Retention (days)', type: 'number', restart: true, help: 'Auto-expire audit entries after N days. Blank keeps them indefinitely.' },
    ],
  },
];

const KEY_INDEX = new Map();
for (const group of GROUPS) {
  for (const entry of group.keys) {
    if (KEY_INDEX.has(entry.key)) {
      throw new Error(`configRegistry: duplicate key ${entry.key}`);
    }
    if (BOOTSTRAP_KEYS.includes(entry.key)) {
      throw new Error(`configRegistry: ${entry.key} is a bootstrap key and cannot be managed`);
    }
    KEY_INDEX.set(entry.key, { ...entry, group: group.id });
  }
}

export function findKey(key) {
  return KEY_INDEX.get(key) || null;
}

export function findGroup(id) {
  return GROUPS.find((g) => g.id === id) || null;
}

export function isManaged(key) {
  return KEY_INDEX.has(key);
}

export function isSecret(key) {
  return Boolean(KEY_INDEX.get(key)?.secret || KEY_INDEX.get(key)?.type === 'secret');
}

export function managedKeys() {
  return Array.from(KEY_INDEX.keys());
}

export default { GROUPS, BOOTSTRAP_KEYS, findKey, findGroup, isManaged, isSecret, managedKeys };
