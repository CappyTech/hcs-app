const helmet = require('helmet');
const xss = require('xss-clean');

const securityService = [
    helmet(),
    helmet.contentSecurityPolicy({
        directives: {
            defaultSrc: [
                "'self'", 
                "https://app.heroncs.co.uk"
            ],
            styleSrc: [
                "'self'", 
                "'unsafe-inline'", 
                "https://cdn.jsdelivr.net", 
                "https://fonts.googleapis.com", 
                "https://unpkg.com",
                "https://cdn.tailwindcss.com/"
            ],
            scriptSrc: [
                "'self'", 
                "'unsafe-inline'", 
                "https://cdn.jsdelivr.net", 
                "https://unpkg.com", 
                "https://challenges.cloudflare.com",
                "https://cdn.tailwindcss.com/"
            ],
            fontSrc: ["'self'", 
                "'unsafe-inline'", 
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
            ],
        },
    }),
    xss()
];

module.exports = securityService;