/**
 * passkeyService — WebAuthn passkeys for sign-in.
 *
 * A passkey is a public-key credential held by the person's device (phone,
 * laptop, security key or password manager). It always asks for the device's
 * own unlock (fingerprint, face or PIN — `userVerification: 'required'`), so a
 * passkey on its own is two factors: something you have plus something you
 * are or know. That is why a passkey sign-in counts as two-factor sign-in and
 * is offered BEFORE an authenticator-app code.
 *
 * Credentials live on the user document (`user.passkeys[]`). Only the public
 * key is stored; nothing here can sign in as anyone.
 *
 * Challenges are kept in the session for CHALLENGE_TTL_MS and used once.
 *
 * The relying party (RP) is this app's own host: BASE_URL when set (managed at
 * /admin/config), otherwise the host the browser reached. A passkey is bound
 * to that host by the browser, so changing the public domain means people
 * re-register their passkeys.
 */
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { companyShortName } from "./organisationService.js";

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const MAX_PASSKEYS = 10;
const NAME_MAX = 60;

function configuredUrl() {
  const raw = String(process.env.BASE_URL || "").trim();
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** The RP ID (a bare hostname) and the origins a response may come from. */
export function relyingParty(req) {
  const cfg = configuredUrl();
  const reqHost = String(req.hostname || "").trim() || "localhost";
  const reqOrigin = `${req.protocol}://${req.get("host") || reqHost}`;
  const rpID = cfg ? cfg.hostname : reqHost;
  const origins = new Set();
  if (cfg) origins.add(cfg.origin);
  // The host the browser actually used, when it is the same RP (covers a
  // non-default port in development and http→https proxy differences).
  if (!cfg || reqHost === rpID) origins.add(reqOrigin);
  return { rpID, rpName: companyShortName() || "Sign in", origins: [...origins] };
}

function toBase64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64Url(str) {
  return new Uint8Array(Buffer.from(String(str || ""), "base64url"));
}

/** Store a one-use challenge in the session under `key`. */
function rememberChallenge(req, key, challenge, extra = {}) {
  req.session[key] = { challenge, at: Date.now(), ...extra };
}

/**
 * Take (and clear) a challenge from the session. Returns null when it is
 * missing or older than CHALLENGE_TTL_MS.
 */
export function takeChallenge(req, key, now = Date.now()) {
  const stored = req.session?.[key];
  if (req.session) delete req.session[key];
  if (!stored || typeof stored.challenge !== "string") return null;
  if (!Number.isFinite(stored.at) || now - stored.at > CHALLENGE_TTL_MS) return null;
  return stored;
}

/** A label for the passkey list: trimmed, single-line, bounded. */
export function cleanName(raw, fallback = "Passkey") {
  const v = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NAME_MAX);
  return v || fallback;
}

/** Whether a user has at least one passkey. */
export function hasPasskeys(user) {
  return Array.isArray(user?.passkeys) && user.passkeys.length > 0;
}

/** Options for adding a passkey to a signed-in user. */
export async function registrationOptions(req, user) {
  const { rpID, rpName } = relyingParty(req);
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: user.email || user.username,
    userDisplayName: user.username,
    userID: new TextEncoder().encode(String(user.uuid || user._id)),
    attestationType: "none",
    excludeCredentials: (user.passkeys || []).map((p) => ({
      id: p.credentialId,
      transports: p.transports?.length ? p.transports : undefined,
    })),
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
  });
  rememberChallenge(req, "passkeyRegistration", options.challenge, { userId: String(user._id) });
  return options;
}

/**
 * Check a registration response. Returns the passkey record to push onto
 * `user.passkeys`, or throws with a message fit to show the person.
 */
export async function verifyRegistration(req, user, response, name) {
  const stored = takeChallenge(req, "passkeyRegistration");
  if (!stored || stored.userId !== String(user._id)) {
    throw new Error("That passkey request has expired. Try adding it again.");
  }
  if ((user.passkeys || []).length >= MAX_PASSKEYS) {
    throw new Error(`You can keep up to ${MAX_PASSKEYS} passkeys. Remove one first.`);
  }
  const { rpID, origins } = relyingParty(req);
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: stored.challenge,
    expectedOrigin: origins,
    expectedRPID: rpID,
    requireUserVerification: true,
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw new Error("The passkey could not be verified.");
  }
  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  if ((user.passkeys || []).some((p) => p.credentialId === credential.id)) {
    throw new Error("That passkey is already on your account.");
  }
  return {
    credentialId: credential.id,
    publicKey: toBase64Url(credential.publicKey),
    counter: credential.counter || 0,
    transports: Array.isArray(credential.transports) ? credential.transports : [],
    deviceType: credentialDeviceType,
    backedUp: !!credentialBackedUp,
    name: cleanName(name),
    createdAt: new Date(),
    lastUsedAt: null,
  };
}

/**
 * Options for signing in with a passkey. With `user`, only that person's
 * passkeys are allowed (the 2FA step after a password); without, the browser
 * offers any passkey it holds for this site (sign-in without a username).
 */
export async function authenticationOptions(req, { key, user = null } = {}) {
  const { rpID } = relyingParty(req);
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "required",
    allowCredentials: user
      ? (user.passkeys || []).map((p) => ({
          id: p.credentialId,
          transports: p.transports?.length ? p.transports : undefined,
        }))
      : [],
  });
  rememberChallenge(req, key, options.challenge, user ? { userId: String(user._id) } : {});
  return options;
}

/**
 * Check a sign-in response.
 *
 * `findUser(credentialId)` resolves the account that holds the credential.
 * On success the passkey's counter and lastUsedAt are updated on the returned
 * user (the caller saves it). Throws with a message fit to show the person.
 */
export async function verifyAuthentication(req, { key, response, findUser }) {
  const stored = takeChallenge(req, key);
  if (!stored) throw new Error("That passkey request has expired. Try again.");
  const credentialId = typeof response?.id === "string" ? response.id : "";
  if (!credentialId) throw new Error("No passkey was given.");

  const user = await findUser(credentialId);
  if (!user) throw new Error("That passkey is not registered here.");
  if (stored.userId && stored.userId !== String(user._id)) {
    throw new Error("That passkey belongs to a different account.");
  }
  const passkey = (user.passkeys || []).find((p) => p.credentialId === credentialId);
  if (!passkey) throw new Error("That passkey is not registered here.");

  const { rpID, origins } = relyingParty(req);
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: stored.challenge,
    expectedOrigin: origins,
    expectedRPID: rpID,
    requireUserVerification: true,
    credential: {
      id: passkey.credentialId,
      publicKey: fromBase64Url(passkey.publicKey),
      counter: passkey.counter || 0,
      transports: passkey.transports,
    },
  });
  if (!verification.verified) throw new Error("The passkey could not be verified.");

  passkey.counter = verification.authenticationInfo.newCounter;
  passkey.lastUsedAt = new Date();
  if (typeof user.markModified === "function") user.markModified("passkeys");
  return { user, passkey };
}

export default {
  CHALLENGE_TTL_MS,
  MAX_PASSKEYS,
  relyingParty,
  takeChallenge,
  cleanName,
  hasPasskeys,
  registrationOptions,
  verifyRegistration,
  authenticationOptions,
  verifyAuthentication,
};
