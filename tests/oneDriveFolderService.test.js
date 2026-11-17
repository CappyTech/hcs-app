import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * OneDrive job folders. Nothing here reaches Microsoft: global fetch is
 * replaced by an in-memory drive that answers the Graph calls the service
 * makes (token, item by path, children, create, item by id, move).
 */

const KEYS = [
  'ONEDRIVE_FOLDERS_ENABLED', 'ONEDRIVE_TENANT_ID', 'ONEDRIVE_CLIENT_ID', 'ONEDRIVE_CLIENT_SECRET',
  'ONEDRIVE_OWNER', 'ONEDRIVE_ROOT_FOLDER', 'ONEDRIVE_QUOTES_FOLDER', 'ONEDRIVE_LIVE_FOLDER', 'ONEDRIVE_COMPLETED_FOLDER',
];
for (const k of KEYS) delete process.env[k];

const svc = await import('../services/oneDriveFolderService.js');
const registry = (await import('../services/configRegistry.js')).default;
const { testConnection: testConnectionRoute } = await import('../mongoose/controllers/connectionSettingsController.js');

const OWNER = 'admin@example.test';
const SECRET = 'super-secret-value';

function configure(extra = {}) {
  Object.assign(process.env, {
    ONEDRIVE_FOLDERS_ENABLED: 'true',
    ONEDRIVE_TENANT_ID: 'tenant-1',
    ONEDRIVE_CLIENT_ID: 'client-1',
    ONEDRIVE_CLIENT_SECRET: SECRET,
    ONEDRIVE_OWNER: OWNER,
    ...extra,
  });
}

// ── Fake drive ──────────────────────────────────────────────────────────────

function fakeDrive() {
  let seq = 0;
  const items = new Map([['root', { id: 'root', name: 'root', parentId: null, folder: true }]]);
  const calls = [];
  const fail = []; // [{ match: (method, url) => bool, status, code, message }]
  let tokenCalls = 0;
  let expiresIn = 3600;

  const childrenOf = (id) => [...items.values()].filter((i) => i.parentId === id);
  const pathOf = (id) => {
    const parts = [];
    for (let cur = items.get(id); cur && cur.id !== 'root'; cur = items.get(cur.parentId)) parts.unshift(cur.name);
    return parts.join('/');
  };
  const resolve = (path) => {
    let cur = items.get('root');
    for (const seg of path.split('/').filter(Boolean)) {
      cur = childrenOf(cur.id).find((c) => c.name.toLowerCase() === seg.toLowerCase());
      if (!cur) return null;
    }
    return cur;
  };
  const view = (i) => ({
    id: i.id,
    name: i.name,
    webUrl: `https://example-my.sharepoint.test/${encodeURIComponent(pathOf(i.id))}`,
    ...(i.folder ? { folder: { childCount: childrenOf(i.id).length } } : { file: {} }),
    parentReference: { id: i.parentId, path: `/drive/root:${i.parentId === 'root' ? '' : '/' + encodeURI(pathOf(i.parentId))}` },
  });
  const add = (path) => {
    let parent = items.get('root');
    for (const seg of path.split('/').filter(Boolean)) {
      let next = childrenOf(parent.id).find((c) => c.name === seg);
      if (!next) {
        next = { id: `item-${++seq}`, name: seg, parentId: parent.id, folder: true };
        items.set(next.id, next);
      }
      parent = next;
    }
    return parent;
  };
  const json = (status, body) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const notFound = () => json(404, { error: { code: 'itemNotFound', message: 'The resource could not be found.' } });

  async function fetch(url, opts = {}) {
    const method = opts.method || 'GET';
    calls.push({ method, url, body: opts.body, headers: opts.headers || {} });
    if (url.startsWith('https://login.microsoftonline.com/')) {
      tokenCalls += 1;
      return json(200, { access_token: `token-${tokenCalls}`, expires_in: expiresIn });
    }
    const f = fail.find((x) => x.match(method, url));
    if (f) {
      if (f.once) fail.splice(fail.indexOf(f), 1);
      return json(f.status, { error: { code: f.code, message: f.message } });
    }
    const u = new URL(url);
    const prefix = `/v1.0/users/${encodeURIComponent(OWNER)}/drive`;
    assert.ok(u.pathname.startsWith(prefix), `unexpected URL ${url}`);
    const rest = u.pathname.slice(prefix.length);

    let m;
    if ((m = /^\/items\/([^/]+)$/.exec(rest))) {
      const item = items.get(decodeURIComponent(m[1]));
      if (!item) return notFound();
      if (method === 'GET') return json(200, view(item));
      if (method === 'PATCH') {
        const body = JSON.parse(opts.body);
        const parentId = body.parentReference?.id ?? item.parentId;
        const name = body.name ?? item.name;
        if (childrenOf(parentId).some((c) => c.id !== item.id && c.name.toLowerCase() === name.toLowerCase())) {
          return json(409, { error: { code: 'nameAlreadyExists', message: 'Name already exists' } });
        }
        Object.assign(item, { parentId, name });
        return json(200, view(item));
      }
    }
    let path = null;
    let children = false;
    if (rest === '/root') path = '';
    else if (rest === '/root/children') { path = ''; children = true; }
    else if ((m = /^\/root:\/(.+?)(:\/children)?$/.exec(rest))) {
      path = decodeURIComponent(m[1]);
      children = Boolean(m[2]);
    }
    assert.notEqual(path, null, `unhandled ${method} ${url}`);
    const target = resolve(path);
    if (!target) return notFound();
    if (!children && method === 'GET') return json(200, view(target));
    if (children && method === 'GET') return json(200, { value: childrenOf(target.id).map(view) });
    if (children && method === 'POST') {
      const body = JSON.parse(opts.body);
      assert.equal(body['@microsoft.graph.conflictBehavior'], 'fail');
      if (childrenOf(target.id).some((c) => c.name.toLowerCase() === body.name.toLowerCase())) {
        return json(409, { error: { code: 'nameAlreadyExists', message: 'Name already exists' } });
      }
      const item = { id: `item-${++seq}`, name: body.name, parentId: target.id, folder: true };
      items.set(item.id, item);
      return json(201, view(item));
    }
    throw new Error(`unhandled ${method} ${url}`);
  }

  return {
    fetch, calls, fail, add, resolve, pathOf,
    get tokenCalls() { return tokenCalls; },
    set expiresIn(v) { expiresIn = v; },
    graphCalls: () => calls.filter((c) => !c.url.startsWith('https://login.')),
    writes: () => calls.filter((c) => c.method !== 'GET' && !c.url.startsWith('https://login.')),
  };
}

let drive;
let realFetch;
beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  svc.resetToken();
  drive = fakeDrive();
  realFetch = globalThis.fetch;
  globalThis.fetch = drive.fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of KEYS) delete process.env[k];
});

// ── Pure helpers ────────────────────────────────────────────────────────────

describe('folder names', () => {
  it('keeps the site up to the first comma', () => {
    assert.equal(svc.siteForFolder('3 Centre Court, Alsager'), '3 Centre Court');
    assert.equal(svc.siteForFolder('3 Centre Court, Alsager, ST7 2AB'), '3 Centre Court');
    assert.equal(svc.siteForFolder('  Unit 4  '), 'Unit 4');
    assert.equal(svc.siteForFolder(null), '');
  });

  it('drops the characters OneDrive refuses, and trailing dots and spaces', () => {
    assert.equal(svc.siteForFolder('Flat 2/3 "The Mill": Rear?*<>|\\'), 'Flat 23 The Mill Rear');
    assert.equal(svc.siteForFolder('Smith & Sons Ltd. . '), 'Smith & Sons Ltd');
    assert.equal(svc.siteForFolder('St. John\'s...'), 'St. John\'s');
    assert.equal(svc.cleanName('a\tb\nc'), 'abc');
  });

  it('names a folder "<number> <site>"', () => {
    assert.equal(svc.folderName(51761, '3 Centre Court, Alsager'), '51761 3 Centre Court');
    assert.equal(svc.folderName('41296', '3 Centre Court'), '41296 3 Centre Court');
    assert.equal(svc.folderName(41296, ''), '41296');
    assert.throws(() => svc.folderName('', 'x'), /number is needed/);
  });
});

describe('year folders', () => {
  it('fills {year} from the calendar year of the date', () => {
    assert.equal(svc.yearFolder('3. QUOTES {year}', new Date('2026-06-01')), '3. QUOTES 2026');
    assert.equal(svc.yearFolder('1.1 LIVE JOBS {year}', '2025-12-31'), '1.1 LIVE JOBS 2025');
    assert.equal(svc.yearFolder('1.1 LIVE JOBS {year}', '2026-01-01T00:00:00Z'), '1.1 LIVE JOBS 2026');
    assert.equal(svc.yearFolder('Q {year}', 2024), 'Q 2024');
  });

  it('uses the UK calendar year around midnight', () => {
    // 23:30 UTC on 31 Dec is still 31 Dec in London (GMT in winter)
    assert.equal(svc.yearOf('2025-12-31T23:30:00Z'), 2025);
  });

  it('refuses a missing or bad date', () => {
    assert.throws(() => svc.yearOf(undefined), /not a usable date/);
    assert.throws(() => svc.yearOf('nonsense'), /not a usable date/);
  });
});

describe('paths', () => {
  it('joins segments and drops stray slashes', () => {
    assert.equal(svc.joinPath('Jobs & Quotes/', '/3. QUOTES 2026', '', '51761 x'), 'Jobs & Quotes/3. QUOTES 2026/51761 x');
  });

  it('encodes spaces and & per segment', () => {
    assert.equal(svc.encodePath('Jobs & Quotes/3. QUOTES 2026'), 'Jobs%20%26%20Quotes/3.%20QUOTES%202026');
    assert.equal(
      svc.itemUrl('admin@example.test', 'Jobs & Quotes', 'children'),
      'https://graph.microsoft.com/v1.0/users/admin%40example.test/drive/root:/Jobs%20%26%20Quotes:/children',
    );
    assert.equal(svc.itemUrl('a@b.test', ''), 'https://graph.microsoft.com/v1.0/users/a%40b.test/drive/root');
  });

  it('reads the parent path back from Graph', () => {
    assert.equal(svc.parentPathOf({ parentReference: { path: '/drive/root:/Jobs%20%26%20Quotes/1.1%20LIVE%20JOBS%202026' } }), 'Jobs & Quotes/1.1 LIVE JOBS 2026');
    assert.equal(svc.parentPathOf({ parentReference: { path: '/drive/root:' } }), '');
    assert.equal(svc.parentPathOf({}), null);
  });
});

// ── Disabled ────────────────────────────────────────────────────────────────

describe('when off or incomplete', () => {
  it('skips every function without calling anything', async () => {
    const all = async () => [
      await svc.ensureQuoteFolder({ quoteNumber: 1, site: 'x', quoteDate: '2026-01-01' }),
      await svc.moveToLive({ quoteNumber: 1, projectNumber: 2, site: 'x', quoteDate: '2026-01-01', wonDate: '2026-02-01' }),
      await svc.moveToCompleted({ projectNumber: 2, site: 'x', wonDate: '2026-02-01' }),
      await svc.findJobFolder({ projectNumber: 2 }),
    ];
    for (const r of await all()) assert.deepEqual(r, { skipped: 'not configured' });

    configure({ ONEDRIVE_FOLDERS_ENABLED: 'false' });
    for (const r of await all()) assert.deepEqual(r, { skipped: 'not configured' });

    configure({ ONEDRIVE_OWNER: '' });
    process.env.ONEDRIVE_OWNER = '';
    for (const r of await all()) assert.deepEqual(r, { skipped: 'not configured' });

    assert.equal(drive.calls.length, 0);
  });
});

// ── Token ───────────────────────────────────────────────────────────────────

describe('the access token', () => {
  it('is fetched once and reused until it nears expiry', async () => {
    configure();
    drive.add('Jobs & Quotes');
    await svc.findJobFolder({ projectNumber: 1 });
    await svc.findJobFolder({ projectNumber: 2 });
    assert.equal(drive.tokenCalls, 1);
    const tokenReq = drive.calls.find((c) => c.url.startsWith('https://login.'));
    assert.equal(tokenReq.url, 'https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token');
    assert.match(tokenReq.body, /grant_type=client_credentials/);
    assert.match(tokenReq.body, /scope=https%3A%2F%2Fgraph\.microsoft\.com%2F\.default/);
    assert.ok(drive.graphCalls().every((c) => c.headers.Authorization === 'Bearer token-1'));

    // A token inside its last minute is never reused: every call gets a new one
    svc.resetToken();
    drive.expiresIn = 30;
    const before = drive.graphCalls().length;
    await svc.findJobFolder({ projectNumber: 1 });
    const made = drive.graphCalls().length - before;
    assert.ok(made > 1);
    assert.equal(drive.tokenCalls, 1 + made);
  });

  it('is fetched again when the credentials change', async () => {
    configure();
    drive.add('Jobs & Quotes');
    await svc.findJobFolder({ projectNumber: 1 });
    process.env.ONEDRIVE_CLIENT_SECRET = 'another-secret';
    await svc.findJobFolder({ projectNumber: 1 });
    assert.equal(drive.tokenCalls, 2);
  });

  it('reports a refused token request', async () => {
    configure();
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.\r\nTrace ID: x' }), { status: 401 });
    await assert.rejects(svc.findJobFolder({ projectNumber: 1 }), /OneDrive token request failed: AADSTS7000215: Invalid client secret provided\.$/);
  });
});

// ── ensureQuoteFolder ───────────────────────────────────────────────────────

describe('ensureQuoteFolder', () => {
  beforeEach(() => { configure(); drive.add('Jobs & Quotes'); });

  it('creates the year folder and the quote folder', async () => {
    const r = await svc.ensureQuoteFolder({ quoteNumber: 51761, site: '3 Centre Court, Alsager', quoteDate: '2026-03-04' });
    assert.equal(r.name, '51761 3 Centre Court');
    assert.equal(r.path, 'Jobs & Quotes/3. QUOTES 2026/51761 3 Centre Court');
    assert.equal(r.created, true);
    assert.ok(r.id && r.webUrl);
    assert.ok(drive.resolve('Jobs & Quotes/3. QUOTES 2026/51761 3 Centre Court'));
    // Paths are encoded on the wire
    assert.ok(drive.calls.some((c) => c.url.includes('/root:/Jobs%20%26%20Quotes/3.%20QUOTES%202026:/children')));
  });

  it('reuses a folder already starting with the quote number', async () => {
    drive.add('Jobs & Quotes/3. QUOTES 2026/51761 3 Centre Ct');
    const r = await svc.ensureQuoteFolder({ quoteNumber: 51761, site: '3 Centre Court', quoteDate: '2026-03-04' });
    assert.equal(r.name, '51761 3 Centre Ct');
    assert.equal(r.created, false);
    assert.equal(drive.writes().length, 0);
  });

  it('treats a 409 on create as already there', async () => {
    // Someone else creates it between our listing and our create: the listing
    // comes back empty, the create gets a 409 from the drive.
    drive.add('Jobs & Quotes/3. QUOTES 2026/51761 3 Centre Court');
    globalThis.fetch = async (url, opts = {}) => {
      if ((opts.method || 'GET') === 'GET' && url.includes('3.%20QUOTES%202026:/children')) {
        return new Response(JSON.stringify({ value: [] }), { status: 200 });
      }
      return drive.fetch(url, opts);
    };
    const r =await svc.ensureQuoteFolder({ quoteNumber: 51761, site: '3 Centre Court', quoteDate: '2026-03-04' });
    assert.equal(r.path, 'Jobs & Quotes/3. QUOTES 2026/51761 3 Centre Court');
    assert.equal(r.created, false);
  });

  it('says when the top folder is missing, and passes on Graph errors', async () => {
    process.env.ONEDRIVE_ROOT_FOLDER = 'Nope';
    await assert.rejects(svc.ensureQuoteFolder({ quoteNumber: 1, site: 'x', quoteDate: '2026-01-01' }), /top folder "Nope" was not found in admin@example\.test's OneDrive/);
    delete process.env.ONEDRIVE_ROOT_FOLDER;
    drive.fail.push({ match: (m) => m === 'POST', status: 403, code: 'accessDenied', message: 'Access denied' });
    await assert.rejects(svc.ensureQuoteFolder({ quoteNumber: 1, site: 'x', quoteDate: '2026-01-01' }), /OneDrive: creating "Jobs & Quotes\/3\. QUOTES 2026" failed \(HTTP 403 accessDenied\): Access denied/);
  });

  it('uses the configured names', async () => {
    drive.add('Shared/Work');
    configure({ ONEDRIVE_ROOT_FOLDER: 'Shared/Work', ONEDRIVE_QUOTES_FOLDER: 'Quotes {year}' });
    const r = await svc.ensureQuoteFolder({ quoteNumber: 7, site: 'A', quoteDate: '2027-05-05' });
    assert.equal(r.path, 'Shared/Work/Quotes 2027/7 A');
  });
});

// ── moveToLive ──────────────────────────────────────────────────────────────

describe('moveToLive', () => {
  beforeEach(() => { configure(); drive.add('Jobs & Quotes'); });
  const args = { quoteNumber: 51761, projectNumber: 41296, site: '3 Centre Court, Alsager', quoteDate: '2026-03-04', wonDate: '2026-05-06' };

  it('moves and renames the quote folder found by name', async () => {
    const q = drive.add('Jobs & Quotes/3. QUOTES 2026/51761 3 Centre Court');
    const r = await svc.moveToLive(args);
    assert.equal(r.path, 'Jobs & Quotes/1.1 LIVE JOBS 2026/41296 3 Centre Court');
    assert.equal(r.id, q.id);
    assert.equal(r.moved, true);
    assert.equal(r.from, 'Jobs & Quotes/3. QUOTES 2026/51761 3 Centre Court');
    assert.equal(drive.pathOf(q.id), 'Jobs & Quotes/1.1 LIVE JOBS 2026/41296 3 Centre Court');
    const patch = drive.calls.find((c) => c.method === 'PATCH');
    assert.deepEqual(Object.keys(JSON.parse(patch.body)).sort(), ['name', 'parentReference']);
  });

  it('finds the quote folder by stored id, and in the year before', async () => {
    const q = drive.add('Jobs & Quotes/3. QUOTES 2025/51761 Old name');
    const byId = await svc.moveToLive({ ...args, folderId: q.id });
    assert.equal(byId.from, 'Jobs & Quotes/3. QUOTES 2025/51761 Old name');

    const q2 = drive.add('Jobs & Quotes/3. QUOTES 2025/51800 Elsewhere');
    const r = await svc.moveToLive({ ...args, quoteNumber: 51800, projectNumber: 41300, site: 'Elsewhere', folderId: 'gone' });
    assert.equal(r.id, q2.id);
    assert.equal(r.path, 'Jobs & Quotes/1.1 LIVE JOBS 2026/41300 Elsewhere');
  });

  it('creates the live folder when there is no quote folder, and says so', async () => {
    const r = await svc.moveToLive(args);
    assert.equal(r.created, true);
    assert.equal(r.moved, false);
    assert.match(r.note, /No folder for quote 51761 was found/);
    assert.ok(drive.resolve('Jobs & Quotes/1.1 LIVE JOBS 2026/41296 3 Centre Court'));
  });

  it('leaves a job already in live jobs alone', async () => {
    drive.add('Jobs & Quotes/1.1 LIVE JOBS 2026/41296 3 Centre Court');
    const r = await svc.moveToLive(args);
    assert.equal(r.moved, false);
    assert.equal(drive.writes().length, 0);
  });

  it('explains a name clash on the move', async () => {
    drive.add('Jobs & Quotes/3. QUOTES 2026/51761 3 Centre Court');
    drive.add('Jobs & Quotes/1.1 LIVE JOBS 2026');
    drive.fail.push({ match: (m) => m === 'PATCH', status: 409, code: 'nameAlreadyExists', message: 'exists' });
    await assert.rejects(svc.moveToLive(args), /a folder named "41296 3 Centre Court" is already there/);
  });
});

// ── moveToCompleted ─────────────────────────────────────────────────────────

describe('moveToCompleted', () => {
  beforeEach(() => { configure(); drive.add('Jobs & Quotes'); });

  it('moves the job folder into Completed Jobs, keeping its name', async () => {
    const j = drive.add('Jobs & Quotes/1.1 LIVE JOBS 2026/41296 3 Centre Court');
    const r = await svc.moveToCompleted({ projectNumber: 41296, site: '3 Centre Court', wonDate: '2026-05-06' });
    assert.equal(r.path, 'Jobs & Quotes/1.1 LIVE JOBS 2026/Completed Jobs/41296 3 Centre Court');
    assert.equal(r.moved, true);
    assert.equal(drive.pathOf(j.id), r.path);
    const patch = drive.calls.find((c) => c.method === 'PATCH');
    assert.deepEqual(Object.keys(JSON.parse(patch.body)), ['parentReference']);
  });

  it('uses the live folder the job is actually in, found by id', async () => {
    const j = drive.add('Jobs & Quotes/1.1 LIVE JOBS 2024/41000 Old Job');
    drive.add('Jobs & Quotes/1.1 LIVE JOBS 2024/Completed Jobs');
    const r = await svc.moveToCompleted({ projectNumber: 41000, wonDate: '2026-01-01', folderId: j.id });
    assert.equal(r.path, 'Jobs & Quotes/1.1 LIVE JOBS 2024/Completed Jobs/41000 Old Job');
    // Completed Jobs already existed, so only the move was a write
    assert.equal(drive.writes().length, 1);
  });

  it('leaves an already completed job alone', async () => {
    drive.add('Jobs & Quotes/1.1 LIVE JOBS 2026/Completed Jobs/41296 3 Centre Court');
    const r = await svc.moveToCompleted({ projectNumber: 41296, wonDate: '2026-05-06' });
    assert.equal(r.moved, false);
    assert.equal(drive.writes().length, 0);
  });

  it('throws when there is no job folder', async () => {
    await assert.rejects(svc.moveToCompleted({ projectNumber: 9, site: 'Nowhere, Town', wonDate: '2026-05-06' }), /no folder for job 9 \(Nowhere\) was found in "1\.1 LIVE JOBS 2026"/);
  });
});

// ── findJobFolder ───────────────────────────────────────────────────────────

describe('findJobFolder', () => {
  beforeEach(() => { configure(); drive.add('Jobs & Quotes'); });

  it('looks through live jobs (and Completed Jobs) newest first, then quotes', async () => {
    drive.add('Jobs & Quotes/1.1 LIVE JOBS 2025/Completed Jobs/41296 Done');
    drive.add('Jobs & Quotes/3. QUOTES 2026/51761 Quote');
    drive.add('Jobs & Quotes/Archive/41296 Not this');
    assert.equal((await svc.findJobFolder({ projectNumber: 41296 })).path, 'Jobs & Quotes/1.1 LIVE JOBS 2025/Completed Jobs/41296 Done');
    assert.equal((await svc.findJobFolder({ quoteNumber: 51761, projectNumber: 1 })).path, 'Jobs & Quotes/3. QUOTES 2026/51761 Quote');
    assert.equal(await svc.findJobFolder({ quoteNumber: 5176 }), null);
    assert.equal(drive.writes().length, 0);
  });

  it('passes on Graph errors', async () => {
    drive.fail.push({ match: (m, u) => u.includes(':/children'), status: 500, code: 'generalException', message: 'Boom' });
    await assert.rejects(svc.findJobFolder({ projectNumber: 1 }), /HTTP 500 generalException\): Boom/);
  });
});

// ── Config and Test connection ──────────────────────────────────────────────

describe('the OneDrive config group', () => {
  it('has the settings, a secret, and a test', () => {
    const g = registry.findGroup('onedrive');
    assert.equal(g.label, 'OneDrive (job folders)');
    assert.equal(g.test, 'onedrive');
    assert.deepEqual(g.keys.map((k) => k.key), KEYS);
    assert.equal(registry.isSecret('ONEDRIVE_CLIENT_SECRET'), true);
    assert.equal(registry.findKey('ONEDRIVE_FOLDERS_ENABLED').type, 'boolean');
    assert.match(g.description, /Files\.ReadWrite\.All/);
    assert.match(g.description, /admin consent/);
    // The dashboard tile link stays where it was
    assert.equal(registry.findKey('ONEDRIVE_URL').group, 'organisation');
  });

  const run = async () => {
    const flashed = [];
    const req = { params: { service: 'onedrive' }, get: () => '/admin/config/onedrive', flash: (type, msg) => flashed.push([type, msg]) };
    await testConnectionRoute(req, { redirect: () => {} });
    return flashed;
  };

  it('Test connection reads the top folder only, even while switched off', async () => {
    configure({ ONEDRIVE_FOLDERS_ENABLED: 'false' });
    drive.add('Jobs & Quotes/3. QUOTES 2026');
    const flashed = await run();
    assert.equal(flashed[0][0], 'success');
    assert.match(flashed[0][1], /^Found "Jobs & Quotes" in admin@example\.test's OneDrive \(1 item inside\)\. Job folder management is still switched off\.$/);
    assert.ok(drive.calls.every((c) => c.method === 'GET' || c.url.startsWith('https://login.')));
    assert.ok(!flashed[0][1].includes(SECRET));
  });

  it('Test connection reports what is missing and Graph errors', async () => {
    assert.deepEqual(await run(), [['error', 'onedrive test failed: OneDrive tenant / client ID / client secret / owner not configured.']]);
    assert.equal(drive.calls.length, 0);

    configure();
    let flashed = await run();
    assert.match(flashed[0][1], /^onedrive test failed: Signed in, but the top folder "Jobs & Quotes" was not found/);

    drive.fail.push({ match: () => true, status: 403, code: 'accessDenied', message: 'Either scp or roles claim need to be present in the token.' });
    flashed = await run();
    assert.match(flashed[0][1], /HTTP 403 accessDenied\): Either scp or roles claim.*Files\.ReadWrite\.All with admin consent\.$/);
  });
});
