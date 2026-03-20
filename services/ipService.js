"use strict";

const net = require("net");

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

function isTrustedProxyIp(ip) {
  if (!ip) return false;

  // IPv4 loopback
  if (ip === "127.0.0.1") return true;
  if (ip.startsWith("127.")) return true;

  // IPv6 loopback
  if (ip === "::1") return true;

  // IPv4 private ranges
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("192.168.")) return true;

  // 172.16.0.0/12
  if (ip.startsWith("172.")) {
    const parts = ip.split(".");
    const second = Number(parts[1]);
    if (!Number.isNaN(second) && second >= 16 && second <= 31) return true;
  }

  // IPv6 unique-local (fc00::/7)
  const lo = ip.toLowerCase();
  if (lo.startsWith("fc") || lo.startsWith("fd")) return true;

  return false;
}

function parseForwardedFor(headerValue) {
  // RFC 7239: Forwarded: for=192.0.2.43, for="[2001:db8:cafe::17]:4711"
  try {
    const v = String(headerValue || "");
    if (!v) return "";
    const first = v.split(",")[0].trim();
    const m = first.match(/for=([^;]+)/i);
    return m && m[1] ? String(m[1]).trim() : "";
  } catch (_) {
    return "";
  }
}

function getClientIp(req) {
  const remoteAddress = normalizeIp(
    req && req.socket && req.socket.remoteAddress,
  );

  // If the direct peer is a trusted proxy, prefer explicit forwarded headers.
  if (net.isIP(remoteAddress) && isTrustedProxyIp(remoteAddress)) {
    const headers = (req && req.headers) || {};

    const candidates = [
      headers["cf-connecting-ip"],
      headers["x-real-ip"],
      headers["x-forwarded-for"],
      parseForwardedFor(headers["forwarded"]),
    ];

    for (const c of candidates) {
      const ip = normalizeIp(c);
      if (net.isIP(ip)) return ip;
    }
  }

  // Otherwise rely on Express's computed IP first, then fall back to remoteAddress.
  const ip = normalizeIp(req && req.ip);
  if (net.isIP(ip)) return ip;

  if (net.isIP(remoteAddress)) return remoteAddress;

  // Last resort: return something stable-ish so downstream code doesn't throw.
  return ip || remoteAddress || "unknown";
}

module.exports = {
  normalizeIp,
  getClientIp,
};
