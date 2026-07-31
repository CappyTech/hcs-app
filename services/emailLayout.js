/**
 * emailLayout — the responsive HTML shell every outgoing email is delivered in,
 * plus the primitives (button, section, data table) used to build the content.
 *
 * Why this exists: the emails were bare `<div style="max-width:600px">`
 * fragments with no `<html>`, `<head>` or viewport meta. That has three
 * consequences worth spelling out, because they are the whole point of this
 * module:
 *
 *   1. **No `<head>` means no `<style>`, and no `<style>` means no media
 *      queries.** Nothing could adapt to screen width at all. Everything below
 *      about the mobile layout depends on having a real document.
 *   2. **`max-width` on a `<div>` does nothing in Outlook for Windows**, which
 *      renders through Word. The body stretched to the full width of the
 *      window. Centring is done here with a table plus an MSO conditional
 *      fixed-width table, which Word does honour.
 *   3. **Without `<meta name="viewport">` mobile clients pick their own
 *      scale**, so text was rendered at a size the recipient then had to pinch
 *      to read.
 *
 * Everything is inline-styled *as well as* class-driven: Gmail's web client
 * keeps `<style>` in the head (so the media queries work) but many clients
 * strip it, so the inline styles carry the desktop rendering on their own and
 * the classes only ever *override* for small screens. Do not move a style that
 * matters into the stylesheet alone.
 *
 * `renderDocument()` is idempotent-friendly: `isDocument()` detects HTML that
 * is already a full document so `emailService.sendMail` can wrap fragments
 * without double-wrapping.
 */

// Brand palette — the emerald the app and the FileBrowser branding use.
const BRAND = '#15803d';
const BRAND_DARK = '#166534';
const TEXT = '#1f2937';
const MUTED = '#6b7280';
const FAINT = '#9ca3af';
const BORDER = '#e5e7eb';
const CANVAS = '#f3f4f6';
const SURFACE = '#ffffff';

// Dark-mode equivalents, applied via prefers-color-scheme.
const DARK_CANVAS = '#111827';
const DARK_SURFACE = '#1f2937';
const DARK_TEXT = '#f3f4f6';
const DARK_MUTED = '#9ca3af';
const DARK_BORDER = '#374151';
const DARK_BRAND = '#4ade80';

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

const CONTENT_WIDTH = 600;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Only allow link schemes that are safe inside an email. Anything else
 * (javascript:, data:, etc.) is neutralised to '#'. Relative paths are allowed.
 */
function safeUrl(url) {
  const value = String(url ?? '').trim();
  if (!value) return '#';
  if (/^(https?:|mailto:|tel:)/i.test(value)) return value;
  if (/^\//.test(value)) return value; // app-relative path
  return '#';
}

/** True when `html` already looks like a complete document rather than a fragment. */
function isDocument(html) {
  return /^\s*(<!doctype\s+html|<html[\s>])/i.test(String(html || ''));
}

/**
 * The head stylesheet. Two jobs only — overriding the inline styles below
 * 600px, and dark mode. Everything here is an enhancement; an email still
 * renders correctly in a client that drops the whole block.
 */
const STYLES = `
    /* Client resets. */
    body { margin: 0 !important; padding: 0 !important; width: 100% !important; }
    /* Stop Windows Phone / iOS resizing text of their own accord. */
    body, table, td { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    /* Word adds its own spacing around tables without these. */
    table { border-collapse: collapse !important; mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { border: 0; line-height: 100%; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic; }
    /* Stop iOS auto-linking dates/addresses and restyling them mid-sentence. */
    a[x-apple-data-detectors] { color: inherit !important; text-decoration: none !important; font-size: inherit !important; font-family: inherit !important; font-weight: inherit !important; line-height: inherit !important; }

    @media only screen and (max-width: ${CONTENT_WIDTH}px) {
      /* The fixed 600px container becomes fluid. */
      .email-container { width: 100% !important; max-width: 100% !important; }
      /* Reclaim the outer gutter — 24px each side is a lot of a 360px screen. */
      .email-gutter { padding: 8px !important; }
      .email-card { padding: 24px 20px !important; border-radius: 0 !important; }
      .email-heading { font-size: 21px !important; line-height: 28px !important; }
      /* Full-width tap targets instead of a narrow pill. */
      .email-btn, .email-btn a { display: block !important; width: 100% !important; }
      .email-btn a { padding-left: 12px !important; padding-right: 12px !important; }
      .email-btn + .email-btn { margin-top: 10px !important; }
      /* Wide data tables stack into one labelled block per row. */
      .email-table, .email-table tbody, .email-table tr, .email-table td { display: block !important; width: 100% !important; }
      .email-table thead { display: none !important; }
      .email-table tr { margin-bottom: 12px !important; border: 1px solid ${BORDER} !important; border-radius: 8px !important; overflow: hidden !important; }
      .email-table td { text-align: left !important; border: 0 !important; border-bottom: 1px solid ${BORDER} !important; padding: 8px 12px !important; }
      .email-table tr td:last-child { border-bottom: 0 !important; }
      .email-label { display: inline-block !important; min-width: 90px; color: ${MUTED}; font-weight: 600; }
    }

    @media (prefers-color-scheme: dark) {
      .email-body, .email-gutter { background: ${DARK_CANVAS} !important; }
      .email-card { background: ${DARK_SURFACE} !important; }
      .email-text, .email-text p, .email-text li { color: ${DARK_TEXT} !important; }
      .email-heading { color: ${DARK_BRAND} !important; }
      .email-muted, .email-muted p, .email-muted a { color: ${DARK_MUTED} !important; }
      .email-rule { border-color: ${DARK_BORDER} !important; }
      .email-table td, .email-table th { border-color: ${DARK_BORDER} !important; color: ${DARK_TEXT} !important; }
      .email-table thead tr { background: ${DARK_BORDER} !important; }
      .email-link { color: ${DARK_BRAND} !important; }
    }`;

/**
 * A "bulletproof" button: a table with the background on the `<td>` and the
 * padding on the `<a>`. Outlook ignores padding and background-color on an
 * inline `<a>`, which is what the old markup relied on — there the button
 * collapsed to bare underlined text.
 *
 * Wrapped in `.email-btn` so several buttons become full-width stacked blocks
 * on a phone instead of a row of narrow pills.
 */
function button(text, url) {
  const href = escapeHtml(safeUrl(url));
  return `<table role="presentation" class="email-btn" cellpadding="0" cellspacing="0" border="0" style="display:inline-block;margin:6px 4px;border-collapse:separate;">
            <tr>
              <td align="center" bgcolor="${BRAND}" style="border-radius:6px;background-color:${BRAND};">
                <a href="${href}" style="display:inline-block;padding:13px 30px;font-family:${FONT};font-size:16px;font-weight:600;line-height:20px;color:#ffffff;text-decoration:none;border-radius:6px;border:1px solid ${BRAND_DARK};">${escapeHtml(text)}</a>
              </td>
            </tr>
          </table>`;
}

/** Centred row of buttons. Returns '' for an empty list so callers can inline it. */
function buttonRow(actions = []) {
  const list = (Array.isArray(actions) ? actions : [])
    .map((a) => ({ text: a && (a.text || a.label), url: a && a.url }))
    .filter((a) => a.text && a.url);
  if (!list.length) return '';
  return `<div style="text-align:center;margin:28px 0 4px;">
        ${list.map((a) => button(a.text, a.url)).join('\n        ')}
      </div>`;
}

/**
 * A data table that survives a phone. On desktop it is an ordinary table; below
 * 600px the media query turns every cell into a block and reveals the per-cell
 * `.email-label` (inline `display:none`, flipped to inline-block by the query)
 * so each value keeps its column name. A five-column table becomes one
 * readable card per row instead of a horizontally-crushed grid.
 *
 * @param {string[]} headers
 * @param {Array<Array<{ html?: string, text?: string, align?: string, style?: string }|string>>} rows
 */
function dataTable(headers = [], rows = []) {
  const head = headers
    .map((h) => `<th align="left" style="padding:8px 10px;border:1px solid ${BORDER};font-family:${FONT};font-size:13px;font-weight:600;color:${TEXT};">${escapeHtml(h)}</th>`)
    .join('');

  const body = rows
    .map((cells) => {
      const tds = cells
        .map((cell, i) => {
          const c = typeof cell === 'string' ? { text: cell } : (cell || {});
          const content = c.html != null ? c.html : escapeHtml(c.text);
          const label = headers[i]
            ? `<span class="email-label" style="display:none;">${escapeHtml(headers[i])}: </span>`
            : '';
          return `<td align="${c.align || 'left'}" style="padding:8px 10px;border-bottom:1px solid ${BORDER};font-family:${FONT};font-size:13px;color:${TEXT};${c.style || ''}">${label}${content}</td>`;
        })
        .join('');
      return `<tr>${tds}</tr>`;
    })
    .join('');

  return `<table role="presentation" class="email-table" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;margin:8px 0 0;">
        <thead><tr style="background:${CANVAS};">${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>`;
}

/** A muted block below the card — used for the unsubscribe and automated notices. */
function note(innerHtml, { rule = false } = {}) {
  const border = rule
    ? `border-top:1px solid ${BORDER};padding-top:12px;`
    : '';
  return `<div class="email-muted email-rule" style="${border}margin:16px 0 0;font-family:${FONT};font-size:12px;line-height:18px;color:${FAINT};">${innerHtml}</div>`;
}

/** Inline link styled for both colour schemes. */
function link(text, url) {
  return `<a class="email-link" href="${escapeHtml(safeUrl(url))}" style="color:${BRAND};text-decoration:underline;">${escapeHtml(text)}</a>`;
}

/**
 * The hidden preview line most clients show next to the subject in the inbox
 * list. Without one they scrape the first visible text, which for a branded
 * email is usually the header or an image alt. The zero-width padding stops
 * body copy being pulled in after it.
 */
function preheaderBlock(preheader) {
  if (!preheader) return '';
  return `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escapeHtml(preheader)}${'&#8203;&#847; '.repeat(60)}</div>`;
}

/**
 * Wrap content in the responsive document.
 *
 * @param {object}  opts
 * @param {string}  opts.contentHtml  goes inside the white card
 * @param {string}  [opts.afterHtml]  goes below the card (footers, notices)
 * @param {string}  [opts.title]
 * @param {string}  [opts.preheader]  inbox preview line
 */
function renderDocument({ contentHtml = '', afterHtml = '', title = 'Heron CS', preheader = '' } = {}) {
  return `<!doctype html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(title)}</title>
<!--[if mso]>
<noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<![endif]-->
<style>${STYLES}
</style>
</head>
<body class="email-body" style="margin:0;padding:0;width:100%;background-color:${CANVAS};">
${preheaderBlock(preheader)}
<table role="presentation" class="email-body" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:${CANVAS};">
  <tr>
    <td class="email-gutter" align="center" style="padding:24px 12px;background-color:${CANVAS};">
      <!--[if mso]><table role="presentation" width="${CONTENT_WIDTH}" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
      <table role="presentation" class="email-container" width="${CONTENT_WIDTH}" cellpadding="0" cellspacing="0" border="0" align="center" style="width:100%;max-width:${CONTENT_WIDTH}px;margin:0 auto;">
        <tr>
          <td class="email-card email-text" style="padding:32px;background-color:${SURFACE};border-radius:12px;font-family:${FONT};font-size:15px;line-height:23px;color:${TEXT};">
${contentHtml}
          </td>
        </tr>
        <tr>
          <td style="padding:0 8px;">
${afterHtml}
          </td>
        </tr>
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td>
  </tr>
</table>
</body>
</html>`;
}

export default {
  renderDocument,
  isDocument,
  button,
  buttonRow,
  dataTable,
  note,
  link,
  escapeHtml,
  safeUrl,
  BRAND,
  MUTED,
  FONT,
  CONTENT_WIDTH,
};

export {
  renderDocument,
  isDocument,
  button,
  buttonRow,
  dataTable,
  note,
  link,
  escapeHtml,
  safeUrl,
  BRAND,
  MUTED,
  FONT,
  CONTENT_WIDTH,
};
