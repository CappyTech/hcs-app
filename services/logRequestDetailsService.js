// services/logRequestDetailsService.js

const logger = require('./loggerService');
const { getClientIp } = require('./ipService');

const logRequestDetailsService = (req, res, next) => {
  const userAgent = req.headers['user-agent'] || '';
  const clientHints = req.headers['sec-ch-ua'] || '';
  const platform = req.headers['sec-ch-ua-platform'] || 'Unknown';
  const isMobile = req.headers['sec-ch-ua-mobile'] === '?1';

  // Detect browser
  const detectBrowser = () => {
    if (clientHints.includes('Brave')) return 'Brave';
    if (clientHints.includes('Chrome')) return 'Chrome';
    if (userAgent.includes('Firefox')) return 'Firefox';
    if (userAgent.includes('Safari') && !userAgent.includes('Chrome')) return 'Safari';
    if (userAgent.includes('Edge')) return 'Edge';
    if (userAgent.includes('Opera') || userAgent.includes('OPR')) return 'Opera';
    if (userAgent.includes('MSIE') || userAgent.includes('Trident')) return 'Internet Explorer';
    return 'Unknown';
  };

  const browser = detectBrowser();
  const version = userAgent.match(/(?:Chrome|Firefox|Version|MSIE|Opera|Safari|Edge|OPR)[/ ]([0-9.]+)/)?.[1] || 'Unknown';

  const clientIp = getClientIp(req);

  req.userDetails = {
    browser,
    version,
    os: platform,
    mobile: isMobile ? 'Yes' : 'No',
    ip: clientIp,
    timestamp: new Date().toISOString(),
  };

  const logUser = req.user?.username || 'unknown user';
  logger.info(`${logUser} accessed [${req.method}] ${req.originalUrl} from ${browser} on ${platform} (IP: ${clientIp})`);

  next();
};

module.exports = logRequestDetailsService;
