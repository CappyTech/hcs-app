// services/logRequestDetailsService.js

const logger = require('./loggerService');

const logRequestDetailsService = (req, res, next) => {
  const userAgent = req.headers['user-agent'] || '';
  const clientHints = req.headers['sec-ch-ua'] || '';
  const platform = req.headers['sec-ch-ua-platform'] || 'Unknown';
  const isMobile = req.headers['sec-ch-ua-mobile'] === '?1';

  // Browser Detection
  let browser = 'Unknown';
  if (clientHints.includes('Brave')) {
    browser = 'Brave';
  } else if (clientHints.includes('Chrome')) {
    browser = 'Chrome';
  } else if (userAgent.includes('Firefox')) {
    browser = 'Firefox';
  } else if (userAgent.includes('Safari') && !userAgent.includes('Chrome')) {
    browser = 'Safari';
  } else if (userAgent.includes('Edge')) {
    browser = 'Edge';
  } else if (userAgent.includes('Opera') || userAgent.includes('OPR')) {
    browser = 'Opera';
  } else if (userAgent.includes('MSIE') || userAgent.includes('Trident')) {
    browser = 'Internet Explorer';
  }

  // Attach metadata to the request for downstream use (optional)
  req.userDetails = {
    browser,
    version: userAgent.match(/(?:Chrome|Firefox|Version|MSIE|Opera|Safari|Edge|OPR)[/ ]([0-9.]+)/)?.[1] || 'Unknown',
    os: platform,
    mobile: isMobile ? 'Yes' : 'No',
    ip: req.ip,
    timestamp: new Date().toISOString(),
  };

  // Log Request Summary
  logger.info(`[${req.method}] ${req.originalUrl} from ${browser} on ${platform} (IP: ${req.ip})`);

  next();
};

module.exports = logRequestDetailsService;
