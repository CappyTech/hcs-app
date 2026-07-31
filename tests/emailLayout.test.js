import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import emailLayout from '../services/emailLayout.js';
import emailService from '../services/emailService.js';

const { renderDocument, isDocument, button, buttonRow, dataTable, note, link, escapeHtml, safeUrl } = emailLayout;

const doc = (opts = {}) => renderDocument({ contentHtml: '<p>Hello</p>', ...opts });

describe('emailLayout — responsive document', () => {
  it('emits a complete document, not a fragment', () => {
    const html = doc();
    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /<html[^>]*lang="en"/);
    assert.match(html, /<head>[\s\S]*<\/head>/);
    assert.match(html, /<body[\s\S]*<\/body>/);
    assert.match(html, /<\/html>\s*$/);
  });

  it('declares the viewport, without which mobile clients pick their own scale', () => {
    assert.match(doc(), /<meta name="viewport" content="width=device-width,initial-scale=1">/);
  });

  it('carries a stylesheet with a mobile breakpoint — the whole point of having a <head>', () => {
    const html = doc();
    assert.match(html, /<style>[\s\S]*<\/style>/);
    assert.match(html, /@media only screen and \(max-width: 600px\)/);
    // The container must go fluid, or the breakpoint achieves nothing.
    assert.match(html, /\.email-container \{ width: 100% !important/);
  });

  it('stacks buttons to full width on small screens', () => {
    assert.match(doc(), /\.email-btn, \.email-btn a \{ display: block !important; width: 100% !important/);
  });

  it('supports dark mode in both directions', () => {
    const html = doc();
    assert.match(html, /<meta name="color-scheme" content="light dark">/);
    assert.match(html, /@media \(prefers-color-scheme: dark\)/);
  });

  it('centres with a table plus an MSO conditional, because Outlook ignores max-width', () => {
    const html = doc();
    // Word-based Outlook honours the fixed-width table inside the conditional;
    // everything else honours max-width on the real container.
    assert.match(html, /<!--\[if mso\]><table role="presentation" width="600"/);
    assert.match(html, /<!--\[if mso\]><\/td><\/tr><\/table><!\[endif\]-->/);
    assert.match(html, /max-width:600px/);
  });

  it('keeps every style inline as well as in the stylesheet', () => {
    // Clients that strip <style> must still get the desktop rendering; the
    // classes only override for small screens.
    const html = doc();
    const card = html.slice(html.indexOf('class="email-card'));
    assert.match(card.slice(0, 400), /style="padding:32px;background-color:#ffffff/);
  });

  it('places content in the card and afterHtml below it', () => {
    const html = renderDocument({ contentHtml: '<p>BODY</p>', afterHtml: '<p>FOOT</p>' });
    const card = html.indexOf('email-card');
    assert.ok(html.indexOf('BODY') > card, 'content belongs inside the card');
    assert.ok(html.indexOf('FOOT') > html.indexOf('BODY'), 'afterHtml belongs below it');
  });

  it('balances its tables', () => {
    const html = renderDocument({ contentHtml: dataTable(['A'], [['1']]), afterHtml: note('<p>x</p>') });
    assert.equal((html.match(/<table/g) || []).length, (html.match(/<\/table>/g) || []).length);
  });

  describe('preheader', () => {
    it('hides the inbox preview line from the body', () => {
      const html = doc({ preheader: 'Short summary' });
      assert.match(html, /display:none;font-size:1px[^"]*mso-hide:all/);
      assert.match(html, /Short summary/);
    });

    it('is omitted entirely when not supplied', () => {
      assert.ok(!doc().includes('mso-hide:all'));
    });

    it('is escaped', () => {
      assert.match(doc({ preheader: '<script>x</script>' }), /&lt;script&gt;/);
    });
  });

  it('escapes the title', () => {
    assert.match(doc({ title: 'A & B <tag>' }), /<title>A &amp; B &lt;tag&gt;<\/title>/);
  });
});

describe('emailLayout — isDocument', () => {
  for (const html of ['<!doctype html><html></html>', '  <!DOCTYPE HTML>\n<html>', '<html lang="en">']) {
    it(`recognises a full document: ${html.slice(0, 24)}…`, () => {
      assert.equal(isDocument(html), true);
    });
  }

  for (const html of ['<p>hi</p>', '<div style="max-width:600px">x</div>', '', null]) {
    it(`treats ${JSON.stringify(String(html).slice(0, 24))} as a fragment`, () => {
      assert.equal(isDocument(html), false);
    });
  }

  it('lets renderDocument output round-trip without double wrapping', () => {
    assert.equal(isDocument(doc()), true);
  });
});

describe('emailLayout — button', () => {
  it('puts the background on the td and the padding on the a', () => {
    // Outlook ignores both on an inline <a>, which is how the old buttons
    // collapsed to bare underlined text.
    const html = button('Go', 'https://example.com/x');
    assert.match(html, /<td[^>]*bgcolor="#15803d"/);
    assert.match(html, /<a href="https:\/\/example\.com\/x"[^>]*padding:13px 30px/);
  });

  it('escapes the label and the href', () => {
    const html = button('A & B', 'https://e.com/?a=1&b=2');
    assert.match(html, /A &amp; B/);
    assert.match(html, /a=1&amp;b=2/);
  });

  it('neutralises dangerous schemes', () => {
    assert.match(button('x', 'javascript:alert(1)'), /href="#"/);
    assert.match(button('x', 'data:text/html,<script>'), /href="#"/);
  });

  it('allows http(s), mailto, tel and app-relative paths', () => {
    for (const url of ['https://a.b', 'http://a.b', 'mailto:a@b.c', 'tel:+441512345678', '/tasks']) {
      assert.equal(safeUrl(url), url);
    }
  });

  it('renders nothing for an empty action list', () => {
    assert.equal(buttonRow([]), '');
    assert.equal(buttonRow(), '');
  });

  it('accepts either text or label, and drops incomplete actions', () => {
    const html = buttonRow([
      { text: 'One', url: '/a' },
      { label: 'Two', url: '/b' },
      { text: 'No url' },
      { url: '/no-text' },
    ]);
    assert.match(html, />One</);
    assert.match(html, />Two</);
    assert.ok(!html.includes('No url'));
    assert.equal((html.match(/<a href=/g) || []).length, 2);
  });
});

describe('emailLayout — dataTable', () => {
  const html = dataTable(
    ['Project', 'Customer', 'Shortfall'],
    [[{ html: '<b>P1</b>' }, { text: 'Acme & Co' }, { text: '£10.00', align: 'right' }]],
  );

  it('labels every cell so the stacked mobile layout stays readable', () => {
    // Below 600px the media query turns cells into blocks and reveals these;
    // without them a stacked row is a column of unexplained numbers.
    assert.match(html, /<span class="email-label" style="display:none;">Project: <\/span>/);
    assert.match(html, /<span class="email-label" style="display:none;">Customer: <\/span>/);
    assert.match(html, /<span class="email-label" style="display:none;">Shortfall: <\/span>/);
  });

  it('hides the header row and stacks the cells on small screens', () => {
    const wrapped = renderDocument({ contentHtml: html });
    assert.match(wrapped, /\.email-table thead \{ display: none !important/);
    assert.match(wrapped, /\.email-table td \{ display: block !important/);
  });

  it('escapes text cells but passes html cells through', () => {
    assert.match(html, /Acme &amp; Co/);
    assert.match(html, /<b>P1<\/b>/);
  });

  it('honours per-cell alignment and style', () => {
    assert.match(html, /<td align="right"[^>]*>/);
  });
});

describe('emailLayout — note and link', () => {
  it('draws a separating rule only when asked', () => {
    assert.match(note('<p>x</p>', { rule: true }), /border-top:1px solid/);
    assert.ok(!note('<p>x</p>').includes('border-top'));
  });

  it('escapes link text and sanitises the href', () => {
    assert.match(link('A & B', 'javascript:alert(1)'), /href="#"/);
    assert.match(link('A & B', '/x'), /A &amp; B/);
  });
});

describe('escapeHtml', () => {
  it('escapes the four characters that break an attribute or a tag', () => {
    assert.equal(escapeHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  });

  it('renders null and undefined as empty', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
  });
});

describe('emailService transactional templates', () => {
  const html = emailService.buildActionEmail({
    heading: 'Reset Your Password',
    intro: 'Use the button below.',
    actionText: 'Reset Password',
    actionUrl: 'https://app.heroncs.co.uk/user/reset-password?token=abc',
    expiry: 'This link expires in 1 hour.',
  });

  it('offers the raw URL as well as the button', () => {
    // Some clients strip the button table; the link must survive on its own.
    assert.match(html, /Or copy this link into your browser/);
    assert.match(html, /word-break:break-all/);
    assert.equal((html.match(/reset-password\?token=abc/g) || []).length >= 2, true);
  });

  it('is a fragment, so sendMail supplies the document', () => {
    assert.equal(isDocument(html), false);
  });

  it('wraps cleanly', () => {
    const wrapped = renderDocument({ contentHtml: html, title: 'Reset your password' });
    assert.match(wrapped, /@media only screen/);
    assert.match(wrapped, /Reset Password/);
  });
});
