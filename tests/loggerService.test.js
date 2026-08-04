import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Transport from 'winston-transport';
import logger, { sanitize } from '../services/loggerService.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Transport that records every info object it receives. */
class CaptureTransport extends Transport {
  constructor() {
    super();
    this.records = [];
  }

  log(info, callback) {
    this.records.push(info);
    callback();
  }
}

/**
 * Run `fn` with a capture transport attached to the shared logger and return
 * the messages it saw. The logger-level format (which is where splat() lives)
 * runs before any transport, so `info.message` here is post-interpolation.
 */
function capture(fn) {
  const capture = new CaptureTransport();
  logger.add(capture);
  try {
    fn();
  } finally {
    logger.remove(capture);
  }
  return capture.records.map((r) => r.message);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('loggerService printf-style interpolation', () => {
  it('interpolates a single %s argument', () => {
    const [message] = capture(() => {
      logger.info('[sso] /api/sso/token: invalid credentials for "%s"', 'jack.oldfield');
    });

    assert.equal(message, '[sso] /api/sso/token: invalid credentials for "jack.oldfield"');
    assert.ok(!message.includes('%s'), 'placeholder must not survive into the message');
  });

  it('interpolates multiple placeholders of mixed type', () => {
    const [message] = capture(() => {
      logger.warn('[login] Unexpected status %d from %s', 503, 'hcs-app');
    });

    assert.equal(message, '[login] Unexpected status 503 from hcs-app');
  });

  it('leaves a message without placeholders untouched when meta is passed', () => {
    const [message] = capture(() => {
      logger.info('plain message', { userId: 42 });
    });

    assert.equal(message, 'plain message');
  });
});

describe('loggerService sanitize', () => {
  it('strips newlines so a forged log line cannot be injected', () => {
    const forged = 'attacker"\n01-01-2026 info: [sso] issued token for user "admin';
    const [message] = capture(() => {
      logger.info('[sso] invalid credentials for "%s"', sanitize(forged));
    });

    assert.ok(!message.includes('\n'), 'newlines must not reach the log message');
    assert.ok(!message.includes('\r'), 'carriage returns must not reach the log message');
    assert.equal(message.split('\n').length, 1, 'must remain a single line');
  });

  it('strips control characters and truncates to the length cap', () => {
    assert.equal(sanitize('a\tb\x00c'), 'a b c');
    assert.equal(sanitize('x'.repeat(500)).length, 200);
    assert.equal(sanitize('x'.repeat(500), 10).length, 10);
  });

  it('renders nullish input as a literal rather than throwing', () => {
    assert.equal(sanitize(null), 'null');
    assert.equal(sanitize(undefined), 'null');
  });

  it('is reachable as a property of the default export', () => {
    assert.equal(typeof logger.sanitize, 'function');
    assert.equal(logger.sanitize('a\nb'), 'a b');
  });
});
