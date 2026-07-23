// services/logRequestDetailsService.js

import logger from './loggerService.js';
const { sanitize } = logger;
import { getClientIp } from './ipService.js';

const SESSION_COOKIE_NAME = "hms.sid";

function hasCookie(req, cookieName) {
  try {
    const header = String((req.headers && req.headers.cookie) || "");
    if (!header) return false;
    return header
      .split(";")
      .some((part) => part.trim().startsWith(`${cookieName}=`));
  } catch (_) {
    return false;
  }
}

function maskId(value) {
  try {
    const v = String(value || "");
    if (!v) return "-";
    if (v.length <= 10) return `${v.slice(0, 2)}…${v.slice(-2)}`;
    return `${v.slice(0, 6)}…${v.slice(-4)}`;
  } catch (_) {
    return "-";
  }
}

function summarizeSetCookie(setCookieHeader) {
  try {
    const parts = String(setCookieHeader)
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);

    const namePart = parts[0] || "";
    const name = namePart.split("=")[0] || "cookie";

    const keep = [];
    for (const p of parts.slice(1)) {
      if (/^secure$/i.test(p)) keep.push("Secure");
      else if (/^httponly$/i.test(p)) keep.push("HttpOnly");
      else if (/^samesite=/i.test(p)) keep.push(p);
      else if (/^domain=/i.test(p)) keep.push(p);
      else if (/^path=/i.test(p)) keep.push(p);
      else if (/^max-age=/i.test(p)) keep.push(p);
      else if (/^expires=/i.test(p)) keep.push("Expires");
    }

    return `${name}{${keep.join(",")}}`;
  } catch (_) {
    return "cookie{?}";
  }
}

const logRequestDetailsService = (req, res, next) => {
  const userAgent = req.headers["user-agent"] || "";
  const clientHints = req.headers["sec-ch-ua"] || "";
  const platform = req.headers["sec-ch-ua-platform"] || "Unknown";
  const isMobile = req.headers["sec-ch-ua-mobile"] === "?1";

  // Detect browser
  const detectBrowser = () => {
    if (clientHints.includes("Brave")) return "Brave";
    if (clientHints.includes("Chrome")) return "Chrome";
    if (userAgent.includes("Firefox")) return "Firefox";
    if (userAgent.includes("Safari") && !userAgent.includes("Chrome"))
      return "Safari";
    if (userAgent.includes("Edge")) return "Edge";
    if (userAgent.includes("Opera") || userAgent.includes("OPR"))
      return "Opera";
    if (userAgent.includes("MSIE") || userAgent.includes("Trident"))
      return "Internet Explorer";
    return "Unknown";
  };

  const browser = detectBrowser();
  const version =
    userAgent.match(
      /(?:Chrome|Firefox|Version|MSIE|Opera|Safari|Edge|OPR)[/ ]([0-9.]+)/,
    )?.[1] || "Unknown";

  const clientIp = getClientIp(req);

  req.userDetails = {
    browser,
    version,
    os: platform,
    mobile: isMobile ? "Yes" : "No",
    ip: clientIp,
    timestamp: new Date().toISOString(),
  };

  const logUser = req.user?.username || "unknown user";

  const path = req.path || req.originalUrl || "";
  const isLogin = path === "/user/login";
  const isAuthRoute =
    isLogin ||
    path === "/user/logout" ||
    path.startsWith("/user/2fa") ||
    path.startsWith("/user/register");
  const isInteresting = isAuthRoute || path === "/";

  if (isInteresting) {
    const sidPresent = hasCookie(req, SESSION_COOKIE_NAME);
    const sessionId = maskId(req.sessionID);
    const hasSessionUser = !!(req.session && req.session.user);
    const hasReqUser = !!req.user;

    logger.info(
      `${sanitize(logUser)} accessed [${sanitize(req.method)}] ${sanitize(req.originalUrl)} from ${sanitize(browser)} on ${sanitize(platform)} (IP: ${sanitize(clientIp)}) ` +
        `sid=${sidPresent ? "Y" : "N"} sess=${sessionId} reqUser=${hasReqUser ? "Y" : "N"} sessUser=${hasSessionUser ? "Y" : "N"} ` +
        `secure=${req.secure ? "Y" : "N"} proto=${sanitize(req.protocol)} ` +
        `xfp=${sanitize(req.headers["x-forwarded-proto"] || "-")} xff=${sanitize((req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() || "-")}`,
    );

    if (isLogin && req.method === "POST") {
      const startMs = Date.now();
      res.on("finish", () => {
        try {
          const setCookie = res.getHeader("set-cookie");
          const location = res.getHeader("location");
          const cookies = Array.isArray(setCookie)
            ? setCookie.map(summarizeSetCookie)
            : setCookie
              ? [summarizeSetCookie(setCookie)]
              : [];

          logger.info(
            `[login response] status=${res.statusCode} location=${location || "-"} ` +
              `t=${Date.now() - startMs}ms setCookie=${cookies.length ? cookies.join(" ") : "none"}`,
          );
        } catch (_) {}
      });
    }
  } else {
    logger.info(
      `${sanitize(logUser)} accessed [${sanitize(req.method)}] ${sanitize(req.originalUrl)} from ${sanitize(browser)} on ${sanitize(platform)} (IP: ${sanitize(clientIp)})`,
    );
  }

  next();
};

export default logRequestDetailsService;
