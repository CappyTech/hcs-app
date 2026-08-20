import helmet from 'helmet';
import { filterXSS } from 'xss';
import crypto from 'crypto';

// Fields that may contain Quill-generated rich-text HTML.
// These are sanitised with a permissive-but-safe whitelist that
// preserves formatting tags and class attributes while blocking
// event handlers, <script> tags, and javascript: URLs.
const RICH_TEXT_FIELDS = new Set(["contentHtml"]);

const richTextXssOptions = {
  whiteList: {
    p: ["class", "style"], div: ["class", "style"],
    h1: ["class"], h2: ["class"], h3: ["class"], h4: ["class"], h5: ["class"], h6: ["class"],
    ul: ["class"], ol: ["class", "type"], li: ["class"],
    strong: [], b: [], em: [], i: [], u: [], s: [], strike: [],
    blockquote: ["class"],
    pre: ["class"], code: ["class", "spellcheck"],
    br: [], hr: [],
    span: ["class", "style"],
    a: ["href", "target", "rel"],
    img: ["src", "alt", "width", "height"],
    table: ["class"], thead: [], tbody: [], tr: [],
    td: ["class", "colspan", "rowspan"], th: ["class", "colspan", "rowspan"],
  },
};

// Fields holding admin-authored email HTML (the platform-wide email header /
// footer, /admin/emails/branding). Email clients require inline `style`
// attributes and table-based layout, so this whitelist is broader than the
// Quill rich-text one — it permits inline styles on the layout/link/image tags
// while still stripping <script>, event handlers and javascript: URLs. The CSS
// values themselves are additionally filtered by the xss library's cssfilter.
const EMAIL_HTML_FIELDS = new Set(["headerHtml", "footerHtml"]);

const STYLE = ["style", "class"];
const emailHtmlXssOptions = {
  whiteList: {
    div: [...STYLE, "align"], p: [...STYLE, "align"], span: STYLE, center: [],
    h1: [...STYLE, "align"], h2: [...STYLE, "align"], h3: [...STYLE, "align"],
    h4: [...STYLE, "align"], h5: [...STYLE, "align"], h6: [...STYLE, "align"],
    ul: STYLE, ol: [...STYLE, "type"], li: STYLE,
    strong: STYLE, b: STYLE, em: STYLE, i: STYLE, u: STYLE, s: STYLE, small: STYLE,
    br: [], hr: STYLE,
    a: ["href", "title", "target", "rel", ...STYLE],
    img: ["src", "alt", "width", "height", ...STYLE],
    font: ["color", "face", "size"],
    table: [...STYLE, "width", "cellpadding", "cellspacing", "border", "align", "role", "bgcolor"],
    thead: [...STYLE, "align"], tbody: [...STYLE, "align"], tr: [...STYLE, "align", "bgcolor"],
    td: [...STYLE, "colspan", "rowspan", "width", "align", "valign", "bgcolor"],
    th: [...STYLE, "colspan", "rowspan", "width", "align", "valign", "bgcolor"],
  },
};

/**
 * Express middleware that sanitises req.body, req.query, and req.params
 * by stripping dangerous HTML/script content.  Replaces the abandoned
 * `xss-clean` package with the actively-maintained `xss` library.
 */
function xssSanitize(req, _res, next) {
  const clean = (obj) => {
    if (!obj || typeof obj !== "object") return obj;
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === "string") {
        if (EMAIL_HTML_FIELDS.has(key)) {
          obj[key] = filterXSS(obj[key], emailHtmlXssOptions);
        } else if (RICH_TEXT_FIELDS.has(key)) {
          obj[key] = filterXSS(obj[key], richTextXssOptions);
        } else {
          obj[key] = filterXSS(obj[key]);
        }
      } else if (typeof obj[key] === "object") {
        clean(obj[key]);
      }
    }
    return obj;
  };
  if (req.body) clean(req.body);
  if (req.query) clean(req.query);
  if (req.params) clean(req.params);
  next();
}

const isDev = process.env.NODE_ENV === "development";

const cspDirectives = {
  defaultSrc: ["'self'", "https://app.heroncs.co.uk"],
  baseUri: ["'self'"],
  objectSrc: ["'none'"],
  frameAncestors: ["'self'"],
  // Script, style and font origins are 'self' only. Alpine, Quill, Chart.js and Bootstrap
  // Icons now come from public/vendor/ (see scripts/vendor-assets.js), and the remaining
  // entries — jsDelivr, unpkg, cdn.tailwindcss.com, Google Fonts — were dead allowlist
  // left over from earlier designs: nothing in the app loaded from any of them. Cloudflare
  // Turnstile stays in scriptSrc; it is genuinely used by the auth views.
  //
  // imgSrc is deliberately NOT pruned the same way. Its third-party origins are unused in
  // source, but image URLs can come from database content, which a code search cannot see.
  // Tightening it needs a data audit, not a grep.
  styleSrc: [
    "'self'",
    (_req, res) => `'nonce-${res.locals.cspNonce}'`,
  ],
  scriptSrc: [
    "'self'",
    (_req, res) => `'nonce-${res.locals.cspNonce}'`,
    "https://challenges.cloudflare.com",
  ],
  fontSrc: ["'self'"],
  imgSrc: [
    "'self'",
    "data:",
    "otpauth:",
    "https://i.creativecommons.org",
    "https://licensebuttons.net",
    "https://sms.heroncs.co.uk",
    "https://a.tile.openstreetmap.org",
    "https://b.tile.openstreetmap.org",
    "https://c.tile.openstreetmap.org",
    "https://unpkg.com",
    "https://challenges.cloudflare.com",
    "https://placehold.co/",
  ],
  connectSrc: [
    "'self'",
    "https://app.heroncs.co.uk",
    "https://nominatim.openstreetmap.org",
    "https://api.openstreetmap.org",
    "https://challenges.cloudflare.com",
  ],
  frameSrc: ["'self'", "https://challenges.cloudflare.com"],
  // Violation reports POSTed by browsers to the unauthenticated endpoint in app.js
  reportUri: ["/csp-report"],
};

// WebSocket allowances
if (isDev) {
  cspDirectives.connectSrc.push("ws://localhost:*");
} else {
  cspDirectives.connectSrc.push("wss://app.heroncs.co.uk");
}

// Enable HSTS only in production by default; allow explicit override via ENABLE_HSTS
// Set ENABLE_HSTS=false in local/dev to avoid browsers forcing HTTPS for your domain.
const enableHsts =
  (process.env.ENABLE_HSTS || "").toLowerCase() === "true" ||
  (process.env.ENABLE_HSTS === undefined && !isDev);

function generateNonce(_req, res, next) {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  next();
}

// Permissions-Policy — helmet stopped setting this header at v5, so it is stated
// here. Everything this app never asks for is denied outright; a feature name a
// browser does not know is ignored, so listing more costs nothing.
//
// Two entries are deliberately NOT `()`:
//   - `clipboard-write` is absent, i.e. left at its default of `self`. The
//     admin log viewer copies with `navigator.clipboard`, and denying it there
//     would break a working control to satisfy a scanner.
//   - `fullscreen=(self)` rather than `()`, because it is the one feature a
//     bundled widget may reach for on a table or chart without us calling it.
const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "autoplay=()",
  "browsing-topics=()",
  "camera=()",
  "display-capture=()",
  "encrypted-media=()",
  "gamepad=()",
  "geolocation=()",
  "gyroscope=()",
  "idle-detection=()",
  "local-fonts=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "publickey-credentials-get=()",
  "screen-wake-lock=()",
  "serial=()",
  "usb=()",
  "xr-spatial-tracking=()",
  "fullscreen=(self)",
].join(", ");

function permissionsPolicy(_req, res, next) {
  res.setHeader("Permissions-Policy", PERMISSIONS_POLICY);
  next();
}

/**
 * Marks the request as HTTPS when TLS is terminated by an upstream that does not
 * say so, gated on TRUST_EDGE_TLS=true.
 *
 * This deployment is reached only through frp: edge Caddy terminates TLS, hands
 * the request to frps, and frps forwards it to frpc over plain HTTP — stamping
 * `X-Forwarded-Proto: http` on the way. Every request therefore arrives claiming
 * to be insecure (1,516 of 1,516 in a two-hour sample), `req.secure` is false,
 * and both cookies go out without `Secure`: express-session's `cookie.secure:
 * 'auto'` resolves to false, and csrfService reads `!!req.secure` directly.
 *
 * Setting `cookie.secure: true` instead is NOT the fix — express-session then
 * refuses to send the cookie at all on a connection it believes is plain HTTP
 * ("not secured"), which locks everyone out rather than protecting them.
 *
 * The override is safe only where TLS genuinely terminates upstream, which is
 * why it is opt-in: this container publishes no port and is reachable only
 * through that tunnel. Express still ignores the header unless the peer is a
 * trusted proxy, so a client that could reach the app directly cannot use this
 * to forge a secure connection.
 */
function trustEdgeTls(req, _res, next) {
  if (String(process.env.TRUST_EDGE_TLS || "").toLowerCase() === "true") {
    req.headers["x-forwarded-proto"] = "https";
  }
  next();
}

const securityService = [
  generateNonce,
  permissionsPolicy,
  helmet({
    contentSecurityPolicy: { directives: cspDirectives },
    referrerPolicy: { policy: "no-referrer" },
    crossOriginEmbedderPolicy: false, // adjust if you need COEP
    hsts: enableHsts ? { maxAge: 15552000, includeSubDomains: true } : false,
  }),
  xssSanitize,
];

export { trustEdgeTls, PERMISSIONS_POLICY };
export default securityService;
