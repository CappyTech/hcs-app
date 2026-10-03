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
      { key: 'PAPERLESS_UI_URL', label: 'Web UI URL', type: 'text', help: 'Where "open in Paperless" links point, e.g. `https://docs.heroncs.co.uk`. Blank uses the base URL without `/api`, which is wrong when that is an internal address.' },
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
      { key: 'NOTIFY_INVOICE_EMAIL', label: 'Purchase invoice email', type: 'text', help: 'Gets each purchase invoice, PDF attached, once its data entry is complete, and again on every Resend.' },
      { key: 'NOTIFY_STATEMENT_EMAIL', label: 'Supplier statement email', type: 'text', help: 'Gets each supplier statement, PDF attached, the first time it is marked reviewed.' },
      { key: 'NOTIFY_CREDIT_NOTE_EMAIL', label: 'Credit note email', type: 'text', help: 'Gets each credit note, PDF attached, the first time an invoice is marked as a credit note.' },
      { key: 'DISCORD_WEBHOOK_URL', label: 'Discord webhook URL', type: 'secret', help: 'Where document posts go. Unset: posts are skipped and logged.' },
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
      { key: 'BASE_URL', label: 'Public base URL', type: 'text', help: 'Used to build absolute links in emails.' },
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
      { key: 'GRAPH_MAIL_SENDER', label: 'Sender mailbox', type: 'text', help: 'The mailbox to send as, e.g. noreply@heroncs.co.uk. The app needs Mail.Send scoped to this mailbox via an Application Access Policy.' },
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
      { key: 'SESSION_COOKIE_DOMAIN', label: 'Session cookie domain', type: 'text', restart: true, help: 'Share the session across subdomains, e.g. .heroncs.co.uk. Read once when the session middleware is built.' },
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
