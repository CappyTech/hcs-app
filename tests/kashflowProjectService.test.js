'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ── Swappable stubs (replaced per-test via _impl) ─────────────────────────────

const stubs = {
  findResult: [],
  updateOneResult: {},
  putResult: {},
  putThrow: null,
  getResult: { Number: 42, Name: 'Test Project', Status: 'Active', CustomerCode: 'CUST01' },
  getThrow: null,
  withKfAuthThrow: null,
  sendMailResult: { accepted: ['test@example.com'] },
};

// Mock mongooseDatabaseService
function makeQuery(arr) {
  // Returns a mongoose-query-like object: supports .lean() and .sort().lean()
  const q = { lean: async () => arr };
  q.sort = () => q;
  q.limit = () => q;
  return q;
}
const mockProject = {
  find:      (..._)  => makeQuery(stubs.findResult),
  updateOne: async () => stubs.updateOneResult,
  aggregate: async () => [],
};
const mdbMock = { REST: { project: mockProject } };
require.cache[require.resolve('../mongoose/services/mongooseDatabaseService')] = {
  id: require.resolve('../mongoose/services/mongooseDatabaseService'),
  filename: require.resolve('../mongoose/services/mongooseDatabaseService'),
  loaded: true,
  exports: mdbMock,
};

// Mock emailService
let emailSendMailCalls = [];
const emailMock = {
  sendMail: async (opts) => {
    emailSendMailCalls.push(opts);
    return stubs.sendMailResult;
  },
};
require.cache[require.resolve('../services/emailService')] = {
  id: require.resolve('../services/emailService'),
  filename: require.resolve('../services/emailService'),
  loaded: true,
  exports: emailMock,
};

// Mock kashflowSessionService
let kfAuthCalls = [];
const kfSessionMock = {
  withKfAuth: async (fn) => {
    kfAuthCalls.push(true);
    if (stubs.withKfAuthThrow) throw stubs.withKfAuthThrow;
    return fn('fake-token');
  },
  kfAxios: null, // set after axiosMock is defined below
};
// Mock axios
let axiosPutCalls = [];
let axiosGetCalls = [];
const axiosMock = {
  get: async (url, opts) => {
    axiosGetCalls.push({ url, opts });
    if (stubs.getThrow) throw stubs.getThrow;
    return { data: stubs.getResult };
  },
  put: async (url, body, opts) => {
    axiosPutCalls.push({ url, body, opts });
    if (stubs.putThrow) throw stubs.putThrow;
    return { data: stubs.putResult };
  },
};
require.cache[require.resolve('axios')] = {
  id: require.resolve('axios'),
  filename: require.resolve('axios'),
  loaded: true,
  exports: axiosMock,
};

// Wire kfAxios now that axiosMock exists, then register session mock
kfSessionMock.kfAxios = axiosMock;
require.cache[require.resolve('../services/kashflowSessionService')] = {
  id: require.resolve('../services/kashflowSessionService'),
  filename: require.resolve('../services/kashflowSessionService'),
  loaded: true,
  exports: kfSessionMock,
};

// Mock loggerService
require.cache[require.resolve('../services/loggerService')] = {
  id: require.resolve('../services/loggerService'),
  filename: require.resolve('../services/loggerService'),
  loaded: true,
  exports: { info: () => {}, warn: () => {}, error: () => {} },
};

const {
  computeFinancials,
  checkProjectFinancials,
  markProjectComplete,
} = require('../mongoose/services/kashflowProjectService');

// ─────────────────────────────────────────────────────────────────────────────
// computeFinancials
// ─────────────────────────────────────────────────────────────────────────────

describe('computeFinancials', () => {
  it('returns zero differences when all amounts are zero', () => {
    const f = computeFinancials({});
    assert.equal(f.incomeTarget, 0);
    assert.equal(f.incomeActual, 0);
    assert.equal(f.incomeDiff, 0);
    assert.equal(f.expTarget, 0);
    assert.equal(f.expActual, 0);
    assert.equal(f.expDiff, 0);
    assert.equal(f.atRisk, false);
  });

  it('sets atRisk false when actual exactly meets target', () => {
    const f = computeFinancials({ TargetSalesAmount: 1000, ActualSalesAmount: 1000 });
    assert.equal(f.incomeDiff, 0);
    assert.equal(f.atRisk, false);
  });

  it('sets atRisk false when actual exceeds target', () => {
    const f = computeFinancials({ TargetSalesAmount: 1000, ActualSalesAmount: 1200 });
    assert.equal(f.incomeDiff, 200);
    assert.equal(f.atRisk, false);
  });

  it('sets atRisk true when actual is below target', () => {
    const f = computeFinancials({ TargetSalesAmount: 1000, ActualSalesAmount: 500 });
    assert.equal(f.incomeDiff, -500);
    assert.equal(f.atRisk, true);
  });

  it('calculates expenditure difference correctly', () => {
    const f = computeFinancials({
      TargetPurchasesAmount: 800,
      ActualPurchasesAmount: 950,
    });
    assert.equal(f.expTarget, 800);
    assert.equal(f.expActual, 950);
    assert.equal(f.expDiff, 150);
  });

  it('handles missing fields via fallback to zero — not at risk when actual is 0', () => {
    const f = computeFinancials({ TargetSalesAmount: 500 });
    assert.equal(f.incomeActual, 0);
    assert.equal(f.incomeDiff, -500);
    assert.equal(f.atRisk, false); // no income recorded yet — not flagged
  });

  it('uses ProjectsRESTExample.json figures correctly — not at risk when actual is 0', () => {
    // From docs/ProjectsRESTExample.json — actual 0 means work not yet billed, not flagged
    const f = computeFinancials({
      TargetSalesAmount: 1000,
      ActualSalesAmount: 0,
      TargetPurchasesAmount: 800,
      ActualPurchasesAmount: 1200,
    });
    assert.equal(f.incomeTarget, 1000);
    assert.equal(f.incomeActual, 0);
    assert.equal(f.incomeDiff, -1000);
    assert.equal(f.atRisk, false);
    assert.equal(f.expTarget, 800);
    assert.equal(f.expActual, 1200);
    assert.equal(f.expDiff, 400);
  });

  it('sets atRisk true when actual > 0 but below target', () => {
    const f = computeFinancials({ TargetSalesAmount: 1000, ActualSalesAmount: 1 });
    assert.equal(f.atRisk, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkProjectFinancials
// ─────────────────────────────────────────────────────────────────────────────

describe('checkProjectFinancials', () => {
  let savedNotifyEmail, savedSmtpFrom, savedSmtpUser;

  beforeEach(() => {
    emailSendMailCalls = [];
    stubs.findResult = [];
    stubs.putThrow = null;
    stubs.withKfAuthThrow = null;
    savedNotifyEmail = process.env.NOTIFY_EMAIL;
    savedSmtpFrom    = process.env.SMTP_FROM;
    savedSmtpUser    = process.env.SMTP_USER;
  });

  const restoreEnv = () => {
    if (savedNotifyEmail === undefined) delete process.env.NOTIFY_EMAIL;
    else process.env.NOTIFY_EMAIL = savedNotifyEmail;
    if (savedSmtpFrom === undefined) delete process.env.SMTP_FROM;
    else process.env.SMTP_FROM = savedSmtpFrom;
    if (savedSmtpUser === undefined) delete process.env.SMTP_USER;
    else process.env.SMTP_USER = savedSmtpUser;
  };

  it('returns checked=0 and emailSent=false when no projects', async () => {
    stubs.findResult = [];
    const result = await checkProjectFinancials();
    assert.equal(result.checked, 0);
    assert.equal(result.atRisk, 0);
    assert.equal(result.emailSent, false);
  });

  it('does not send email when no projects are at risk', async () => {
    stubs.findResult = [
      { Number: 1, Name: 'Healthy', TargetSalesAmount: 500, ActualSalesAmount: 600 },
    ];
    const result = await checkProjectFinancials();
    assert.equal(result.atRisk, 0);
    assert.equal(result.emailSent, false);
    assert.equal(emailSendMailCalls.length, 0);
  });

  it('sends email when a project is at risk and notifyEmail is provided', async () => {
    try {
      stubs.findResult = [
        { Number: 42, Name: 'At Risk Project', TargetSalesAmount: 1000, ActualSalesAmount: 200 },
      ];
      const result = await checkProjectFinancials({ notifyEmail: 'alerts@test.com' });
      assert.equal(result.atRisk, 1);
      assert.equal(result.emailSent, true);
      assert.equal(emailSendMailCalls.length, 1);
      const call = emailSendMailCalls[0];
      assert.equal(call.to, 'alerts@test.com');
      assert.ok(call.subject.includes('1'));
      assert.ok(call.html.includes('42'));
      assert.ok(call.html.includes('At Risk Project'));
    } finally { restoreEnv(); }
  });

  it('does not send email when no notifyEmail provided and no env fallbacks set', async () => {
    delete process.env.NOTIFY_EMAIL;
    delete process.env.SMTP_FROM;
    delete process.env.SMTP_USER;
    try {
      stubs.findResult = [
        { Number: 1, Name: 'At Risk', TargetSalesAmount: 1000, ActualSalesAmount: 100 },
      ];
      const result = await checkProjectFinancials();
      assert.equal(result.atRisk, 1);
      assert.equal(result.emailSent, false);
      assert.equal(emailSendMailCalls.length, 0);
    } finally { restoreEnv(); }
  });

  it('reports multiple at-risk projects correctly', async () => {
    try {
      stubs.findResult = [
        { Number: 1, Name: 'A', TargetSalesAmount: 1000, ActualSalesAmount: 100 },
        { Number: 2, Name: 'B', TargetSalesAmount: 500,  ActualSalesAmount: 600 },
        { Number: 3, Name: 'C', TargetSalesAmount: 2000, ActualSalesAmount: 500 },
      ];
      const result = await checkProjectFinancials({ notifyEmail: 'alerts@test.com' });
      assert.equal(result.checked, 3);
      assert.equal(result.atRisk, 2);
      assert.equal(result.emailSent, true);
      assert.ok(emailSendMailCalls[0].subject.includes('2'));
    } finally { restoreEnv(); }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// markProjectComplete
// ─────────────────────────────────────────────────────────────────────────────

describe('markProjectComplete', () => {
  beforeEach(() => {
    axiosPutCalls  = [];
    axiosGetCalls  = [];
    kfAuthCalls    = [];
    stubs.putThrow = null;
    stubs.getThrow = null;
    stubs.withKfAuthThrow = null;
    stubs.getResult = { Number: 42, Name: 'Test Project', Status: 'Active', CustomerCode: 'CUST01' };
  });

  it('throws when projectNumber is not provided', async () => {
    await assert.rejects(() => markProjectComplete(null), /projectNumber is required/);
  });

  it('GETs the project then PUTs with Status Completed', async () => {
    await markProjectComplete(42);
    assert.equal(kfAuthCalls.length, 1);
    assert.equal(axiosGetCalls.length, 1);
    assert.ok(axiosGetCalls[0].url.endsWith('/projects/42'));
    assert.equal(axiosPutCalls.length, 1);
    const { url, body } = axiosPutCalls[0];
    assert.ok(url.endsWith('/projects/42'));
    assert.equal(body.Status, 'Completed');
    assert.equal(body.Name, 'Test Project');
    assert.equal(body.CustomerCode, 'CUST01');
  });

  it('sends Authorization header with KfToken', async () => {
    await markProjectComplete(5);
    const { opts } = axiosPutCalls[0];
    assert.equal(opts.headers.Authorization, 'KfToken fake-token');
  });

  it('propagates KashFlow API errors', async () => {
    stubs.getThrow = new Error('API error');
    await assert.rejects(() => markProjectComplete(1), /API error/);
  });
});
