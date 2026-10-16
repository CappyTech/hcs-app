import net from 'net';

function normalizeIp(raw) {
  if (raw === undefined || raw === null) return "";

  let value = String(raw).trim();
  if (!value) return "";

  // Some proxies might pass a list even where a single IP is expected.
  if (value.includes(",")) {
    value = value.split(",")[0].trim();
  }

  // Forwarded: for=1.2.3.4:1234;proto=https;by=...
  if (/^for=/i.test(value)) {
    const match = value.match(/^for=([^;]+)$/i);
    if (match && match[1]) value = match[1].trim();
  }

  // Strip optional quotes
  value = value.replace(/^"|"$/g, "");

  // Handle bracketed IPv6 with port: [::1]:1234
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end !== -1) {
      value = value.slice(1, end);
    }
  }

  // Normalize IPv4-mapped IPv6
  value = value.replace(/^::ffff:/, "");

  if (net.isIP(value)) return value;

  // Strip a trailing :port if present (IPv4:port or IPv6:port without brackets)
  const lastColon = value.lastIndexOf(":");
  if (lastColon > -1) {
    const base = value.slice(0, lastColon).replace(/^::ffff:/, "");
    const port = value.slice(lastColon + 1);
    if (/^\d+$/.test(port) && net.isIP(base)) {
      return base;
    }

    // Common case: IPv4:port (e.g. 82.20.87.8:44741)
    if (value.includes(".")) {
      const ipv4Base = value.split(":")[0];
      if (net.isIP(ipv4Base)) return ipv4Base;
    }
  }

  return value;
}

/**
 * The client IP for rate limiting, lockout audit and request logs.
 *
 * Express already resolves the client address into `req.ip` from the
 * `trust proxy` setting in app.js (loopback and 172.16.0.0/12 by default, or
 * TRUST_PROXY): it walks X-Forwarded-For from the right and stops at the
 * first hop that is not a trusted proxy. That is the only forwarded value
 * honoured here. Headers such as CF-Connecting-IP, X-Real-IP and Forwarded
 * are never consulted: nothing in front of this app sets or strips them, so
 * a client could pick its own value and give every request a fresh
 * rate-limit bucket.
 */
function getClientIp(req) {
  const ip = normalizeIp(req && req.ip);
  if (net.isIP(ip)) return ip;

  const remoteAddress = normalizeIp(
    req && req.socket && req.socket.remoteAddress,
  );
  if (net.isIP(remoteAddress)) return remoteAddress;

  // Last resort: return something stable-ish so downstream code doesn't throw.
  return ip || remoteAddress || "unknown";
}

export default {
  normalizeIp,
  getClientIp,
};

export { normalizeIp, getClientIp };
