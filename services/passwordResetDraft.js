/**
 * Password reset draft — carries the new password across one failed
 * verification attempt.
 *
 * The reset verification handlers redirect on failure, which clears the form.
 * Combined with a one-time code that expires (30s for an authenticator), a user
 * whose code rolled mid-form loses both passwords as well and starts over from
 * blank. This parks the two password fields for exactly one redirect so the
 * retry only costs them a fresh code.
 *
 * The draft is a plaintext password sitting in session state, so its lifetime is
 * kept as short as it can usefully be:
 *
 *  - it lives *inside* `req.session.passwordResetPending`, so every existing
 *    teardown of the reset flow (success, start over, session expiry) takes it
 *    with it — there is no second thing to remember to delete;
 *  - `take()` is single-use: the render that repopulates the form also removes
 *    it, so it survives one redirect and no more;
 *  - `TTL_MS` caps it independently, in case a redirect is never followed;
 *  - `dropOnLeave` clears it the moment the browser navigates to any page
 *    outside the reset flow, so it does not sit around waiting for a return
 *    visit.
 *
 * Sessions are stored in Mongo through connect-mongo with `crypto.secret` set,
 * so the draft is encrypted at rest in the `sessions` collection.
 */

// Requests to these paths are "inside the reset area" and leave the draft alone.
const RESET_PATHS = new Set([
  "/user/forgot-password",
  "/user/forgot-password/choose",
  "/user/verify-sms-otp",
  "/user/verify-totp-reset",
  "/user/reset-password",
]);

// A draft only ever needs to outlive a single 302. Anything older is abandoned.
const TTL_MS = 5 * 60 * 1000;

const normalisePath = (req) => String(req.path || "").replace(/\/+$/, "") || "/";

/** True when this request is a top-level page navigation rather than a sub-resource. */
const isNavigation = (req) => {
  if (req.method !== "GET") return false;
  const dest = req.get("sec-fetch-dest");
  if (dest) return dest === "document";
  // Older browsers send no Sec-Fetch-Dest; fall back to content negotiation.
  return String(req.get("accept") || "").includes("text/html");
};

/**
 * Remember the passwords entered on a failed attempt.
 * No-op unless a reset is actually in progress.
 */
const stash = (req, { password, confirmPassword } = {}) => {
  const pending = req.session?.passwordResetPending;
  if (!pending || !password) return;
  pending.draft = { password, confirmPassword, at: Date.now() };
};

/**
 * Read the draft and remove it in the same breath — repopulating the form
 * consumes it, so a later visit to the same page starts blank.
 *
 * @returns {{ password: string, confirmPassword: string }} empty strings when
 *          there is no usable draft, so views can interpolate it unconditionally.
 */
const take = (req) => {
  const empty = { password: "", confirmPassword: "" };
  const pending = req.session?.passwordResetPending;
  const draft = pending?.draft;
  if (!draft) return empty;

  delete pending.draft;

  if (!draft.at || Date.now() - draft.at > TTL_MS) return empty;
  return {
    password: draft.password || "",
    confirmPassword: draft.confirmPassword || "",
  };
};

/** Discard the draft without reading it. */
const clear = (req) => {
  if (req.session?.passwordResetPending?.draft) {
    delete req.session.passwordResetPending.draft;
  }
};

/**
 * Middleware: drop the draft as soon as the user navigates out of the reset
 * flow. Sub-resource requests (assets, the service worker, favicons) are
 * ignored — only a real page navigation counts as leaving.
 */
const dropOnLeave = (req, res, next) => {
  if (
    req.session?.passwordResetPending?.draft &&
    isNavigation(req) &&
    !RESET_PATHS.has(normalisePath(req))
  ) {
    clear(req);
  }
  next();
};

export default { stash, take, clear, dropOnLeave, RESET_PATHS, TTL_MS };
export { stash, take, clear, dropOnLeave, RESET_PATHS, TTL_MS };
