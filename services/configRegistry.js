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
 *   type     'text' | 'number' | 'boolean' | 'secret' | 'textarea'
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
    description: 'OCR document ingestion, and the People’s Pension API key.',
    test: 'paperless',
    // Saving new Paperless settings must drop the cached custom-field
    // definitions, or the next call resolves field ids against the old server.
    afterSave: 'paperless',
    keys: [
      { key: 'PAPERLESS_BASE_URL', label: 'Base URL', type: 'text', help: 'Hostname or full URL. `/api` is appended when missing.' },
      { key: 'PAPERLESS_TOKEN', label: 'API token', type: 'secret', help: 'Paperless API token, sent as `Authorization: Token …`.' },
      { key: 'PAPERLESS_PORT', label: 'Port', type: 'number', help: 'Used only when the base URL is a bare host.' },
      { key: 'PAPERLESS_ACCEPT', label: 'Accept header', type: 'text', help: 'API version to request. Paperless retires old versions — a version it no longer serves answers 406 on every call.' },
      { key: 'PAPERLESS_TIMEOUT_MS', label: 'Timeout (ms)', type: 'number', help: 'Per-request timeout. Default 60000.' },
      { key: 'PAPERLESS_PAGE_SIZE', label: 'Page size', type: 'number', help: 'Documents fetched per page during a grab.' },
      { key: 'PAPERLESS_CONCURRENCY', label: 'Concurrency', type: 'number', help: 'Documents processed in parallel during a grab.' },
      { key: 'PAPERLESS_CF_CACHE_MS', label: 'Custom-field cache (ms)', type: 'number', restart: true, help: 'How long custom-field definitions are cached. Read once at import.' },
      { key: 'PAPERLESS_SSH_TUNNEL_ENABLED', label: 'Use SSH tunnel', type: 'boolean', help: 'Reach Paperless through an SSH tunnel instead of directly.' },
      { key: 'PAPERLESS_VERBOSE', label: 'Verbose logging', type: 'boolean', help: 'Log every Paperless request and response body snippet.' },
      { key: 'PEOPLES_PENSION_API_KEY', label: 'People’s Pension API key', type: 'secret', help: 'Unrelated to Paperless; kept here as it has no page of its own.' },
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
    keys: [
      { key: 'SMTP_HOST', label: 'Host', type: 'text', help: 'SMTP server hostname.' },
      { key: 'SMTP_PORT', label: 'Port', type: 'number', help: '587 for STARTTLS, 465 for implicit TLS.' },
      { key: 'SMTP_USER', label: 'Username', type: 'text', help: 'SMTP login.' },
      { key: 'SMTP_PASS', label: 'Password', type: 'secret', help: 'SMTP password.' },
      { key: 'SMTP_FROM', label: 'From address', type: 'text', help: 'Envelope sender for all outbound mail.' },
      { key: 'BASE_URL', label: 'Public base URL', type: 'text', help: 'Used to build absolute links in emails.' },
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
