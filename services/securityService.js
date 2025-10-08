const helmet = require('helmet');
const xss = require('xss-clean');

const isDev = process.env.NODE_ENV === 'development';

const cspDirectives = {
  defaultSrc: ["'self'", "https://app.heroncs.co.uk"],
  baseUri: ["'self'"],
  objectSrc: ["'none'"],
  frameAncestors: ["'self'"],
  styleSrc: [
    "'self'",
    // Ideally remove after moving inline styles to files
    "'unsafe-inline'",
    "https://cdn.jsdelivr.net",
    "https://fonts.googleapis.com",
    "https://unpkg.com",
    "https://cdn.tailwindcss.com/"
  ],
  scriptSrc: [
    "'self'",
    // Replace with nonces/hashes ASAP:
    "'unsafe-inline'",
    "https://cdn.jsdelivr.net",
    "https://unpkg.com",
    "https://challenges.cloudflare.com",
    "https://cdn.tailwindcss.com/"
  ],
  fontSrc: [
    "'self'",
    "https://cdn.jsdelivr.net",
    "https://fonts.gstatic.com",
    "https://fonts.googleapis.com"
  ],
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
    "https://placehold.co/"
  ],
  connectSrc: [
    "'self'",
    "https://app.heroncs.co.uk",
    "https://nominatim.openstreetmap.org",
    "https://api.openstreetmap.org",
    "https://challenges.cloudflare.com"
  ],
  frameSrc: [
    "'self'",
    "https://challenges.cloudflare.com"
  ]
};

// WebSocket allowances
if (isDev) {
  cspDirectives.connectSrc.push("ws://localhost:*");
} else {
  cspDirectives.connectSrc.push("wss://app.heroncs.co.uk");
}

const securityService = [
  helmet({
    contentSecurityPolicy: { directives: cspDirectives },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginEmbedderPolicy: false, // adjust if you need COEP
  }),
  xss()
];

module.exports = securityService;