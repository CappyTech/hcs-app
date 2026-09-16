// services/microsoftSsoService.js
//
// Microsoft Entra (Azure AD) sign-in via OpenID Connect Authorization Code flow
// with PKCE. Sign-IN only: the caller matches the returned email to an existing
// hcs-app account and refuses when there is none — no account is ever created
// here. All settings are read through configService (managed store → env), like
// every other integration.

import axios from 'axios';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import configService from './configService.js';

const AUTH_TTL_MS = 10 * 60 * 1000; // a pending sign-in is valid for 10 minutes

function get(key) {
  return configService.get(key);
}

/** Enabled only when the toggle is on AND the three required fields are set. */
function isEnabled() {
  return (
    String(get('MS_SSO_ENABLED') || '').toLowerCase() === 'true' &&
    !!get('MS_SSO_TENANT_ID') &&
    !!get('MS_SSO_CLIENT_ID') &&
    !!get('MS_SSO_CLIENT_SECRET')
  );
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The redirect URI Entra will call back. Configurable; otherwise derived from BASE_URL / host. */
function redirectUriFor(req) {
  const configured = get('MS_SSO_REDIRECT_URI');
  if (configured) return configured;
  const base = get('BASE_URL');
  const origin = base ? String(base).replace(/\/+$/, '') : `${req.protocol}://${req.get('host')}`;
  return `${origin}/auth/microsoft/callback`;
}

/**
 * Begin sign-in: stash state/nonce/PKCE verifier in the session and return the
 * Entra authorize URL to redirect the browser to.
 */
function buildAuthUrl(req, next = null) {
  const tenant = get('MS_SSO_TENANT_ID');
  const clientId = get('MS_SSO_CLIENT_ID');
  const state = base64url(crypto.randomBytes(24));
  const nonce = base64url(crypto.randomBytes(24));
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());

  req.session.msSso = { state, nonce, verifier, next: next || null, at: Date.now() };

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUriFor(req),
    response_mode: 'query',
    scope: 'openid profile email',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize?${params.toString()}`;
}

/**
 * Complete sign-in: validate state, exchange the code for tokens, validate the
 * id_token claims, and return the verified email (lower-cased) plus the stashed
 * `next`. Throws with a user-safe message on any failure.
 *
 * The id_token is obtained on the server-to-server back channel directly from
 * Microsoft's token endpoint over TLS, so it is trusted without re-verifying its
 * signature; we still validate audience, issuer, expiry and nonce.
 */
async function exchangeAndVerify(req, { code, state } = {}) {
  const saved = req.session.msSso;
  if (!saved || !saved.state) {
    throw new Error('the sign-in session expired — please try again');
  }
  // One-time: clear immediately so a replayed callback cannot reuse it.
  delete req.session.msSso;

  if (!code) throw new Error('no authorization code was returned');
  if (!state || state !== saved.state) throw new Error('state check failed');
  if (Date.now() - (saved.at || 0) > AUTH_TTL_MS) throw new Error('the sign-in timed out — please try again');

  const tenant = get('MS_SSO_TENANT_ID');
  const clientId = get('MS_SSO_CLIENT_ID');
  const clientSecret = get('MS_SSO_CLIENT_SECRET');

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUriFor(req),
    code_verifier: saved.verifier,
    scope: 'openid profile email',
  });

  let data;
  try {
    const resp = await axios.post(
      `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
      body.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 },
    );
    data = resp.data;
  } catch (err) {
    const detail = err.response?.data?.error_description || err.message;
    throw new Error(`token exchange failed: ${detail}`);
  }

  const idToken = data.id_token;
  if (!idToken) throw new Error('Microsoft did not return an id_token');

  const claims = jwt.decode(idToken);
  if (!claims || typeof claims !== 'object') throw new Error('the id_token could not be read');
  if (claims.aud !== clientId) throw new Error('id_token audience mismatch');
  if (typeof claims.iss !== 'string' || !claims.iss.includes(tenant)) throw new Error('id_token issuer mismatch');
  if (claims.nonce !== saved.nonce) throw new Error('id_token nonce mismatch');
  if (claims.exp && Date.now() / 1000 > Number(claims.exp) + 60) throw new Error('the id_token has expired');

  const email = String(claims.email || claims.preferred_username || '').trim().toLowerCase();
  if (!email || !email.includes('@')) throw new Error('the Microsoft account has no usable email address');

  return { email, claims, next: saved.next || null };
}

export default { isEnabled, buildAuthUrl, exchangeAndVerify, redirectUriFor };
