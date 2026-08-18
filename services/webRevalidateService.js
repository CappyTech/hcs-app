/**
 * Tells hcs-web that its mirror is stale.
 *
 * This is an optimisation and nothing more. hcs-web polls on a timer and would
 * pick the change up on its own; the hook just turns "within a few minutes"
 * into "within a second or two". Everything here follows from that:
 *
 * - **It never blocks or fails a save.** Errors are logged and swallowed. An
 *   editor must not see a save fail because a website on someone else's shared
 *   host did not answer.
 * - **It is fire-and-forget.** The caller does not await it.
 * - **It is not required to be delivered.** heroncs.co.uk runs several
 *   Passenger worker processes and this reaches exactly one of them; the others
 *   converge through the shared on-disk mirror on their next tick. Do not
 *   redesign this into something that assumes it hit them all.
 *
 * Unset WEB_REVALIDATE_URL disables it silently — the poll still works, which
 * is why this is not an error.
 */
import logger from './loggerService.js';

const TIMEOUT_MS = 5000;

export function notifyWebRevalidate(reason = 'content changed') {
  const url = String(process.env.WEB_REVALIDATE_URL || '').trim();
  const secret = String(process.env.WEB_REVALIDATE_SECRET || '').trim();
  if (!url || !secret) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ reason }),
    signal: controller.signal,
  })
    .then((r) => {
      if (!r.ok) logger.warn('[webRevalidate] hcs-web returned ' + r.status, { reason });
      else logger.info('[webRevalidate] hcs-web notified', { reason });
    })
    .catch((err) => {
      logger.warn('[webRevalidate] could not reach hcs-web: ' + err.message, { reason });
    })
    .finally(() => clearTimeout(timer));
}

export default { notifyWebRevalidate };
