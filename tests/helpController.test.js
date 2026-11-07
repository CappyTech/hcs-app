import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The help articles are one large hand-edited object; a stray quote breaks the
// whole app at startup, and nothing else imports this file in the tests.
const mod = await import('../mongoose/controllers/helpController.js');

function articleIds(user) {
  let locals;
  mod.getHelp({ user }, { render: (_view, l) => { locals = l; } });
  return locals.helpContent.flatMap((c) => c.articles.map((a) => a.id));
}

describe('helpController', () => {
  it('loads', () => {
    assert.ok(mod.default || Object.keys(mod).length);
  });

  it('every article id is unique', () => {
    const ids = articleIds({ role: 'admin' });
    assert.equal(new Set(ids).size, ids.length);
  });

  it('opens group-tagged articles to job roles holding the group', () => {
    const plain = articleIds({ role: 'employee' });
    assert.ok(!plain.includes('payroll-runs'));
    assert.ok(!plain.includes('entry-screen'));

    const payroll = articleIds({ role: 'employee', roles: ['payrollHr'] });
    assert.ok(payroll.includes('payroll-runs'));

    const office = articleIds({ role: 'employee', roles: ['officeManager'] });
    assert.ok(office.includes('entry-screen'));
    // Sending to KashFlow is manage level: never opened by a job role
    assert.ok(!office.includes('paperless-kashflow-draft'));
  });
});
