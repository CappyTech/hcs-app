import logger from './loggerService.js';
import mdb from '../mongoose/services/mongooseDatabaseService.js';

/**
 * Mongo-backed store for express-rate-limit (v6 Store interface).
 *
 * The previous in-memory store reset on every container restart and could not
 * share state across replicas. Buckets live in the INTERNAL database
 * ('rateLimits' collection) with a TTL index for cleanup.
 *
 * FAILS OPEN: while MongoDB is unavailable (startup, restart mid-operation)
 * each request is counted as the first hit of a fresh window, so rate
 * limiting degrades gracefully instead of blocking traffic or crashing.
 */

const COLLECTION = 'rateLimits';

class RateLimitMongoStore {
  /**
   * @param {object} [opts]
   * @param {string} [opts.prefix='rl:'] – key prefix so multiple limiters can share the collection
   */
  constructor({ prefix = 'rl:' } = {}) {
    this.prefix = prefix;
    this.windowMs = 60 * 1000;
    this._indexEnsured = false;
  }

  /** Called by express-rate-limit with the limiter's options. */
  init(options) {
    this.windowMs = options.windowMs;
  }

  /** Returns the native collection, or null while Mongo is not connected. */
  _collection() {
    // Lazy require: this module is loaded (via rateLimiterService) before
    // mongooseDatabaseService.connect() runs in app.js Phase 2.
    const conn = mdb.INTERNAL?.connection;
    if (!conn || conn.readyState !== 1) return null;
    const coll = conn.db.collection(COLLECTION);
    if (!this._indexEnsured) {
      this._indexEnsured = true;
      coll.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch((err) => {
        this._indexEnsured = false;
        logger.warn('[rateLimitMongoStore] TTL index creation failed: ' + err.message);
      });
    }
    return coll;
  }

  async increment(key) {
    const now = new Date();
    const freshResetTime = new Date(now.getTime() + this.windowMs);
    const coll = this._collection();
    if (!coll) {
      return { totalHits: 1, resetTime: freshResetTime };
    }

    const _id = this.prefix + key;
    try {
      // Bump the live bucket if its window has not elapsed…
      const live = await coll.findOneAndUpdate(
        { _id, expiresAt: { $gt: now } },
        { $inc: { hits: 1 } },
        { returnDocument: 'after' },
      );
      if (live) {
        return { totalHits: live.hits, resetTime: live.expiresAt };
      }

      // …otherwise start a new window (upsert covers both "no bucket" and
      // "expired bucket awaiting TTL deletion").
      await coll.updateOne(
        { _id },
        { $set: { hits: 1, expiresAt: freshResetTime } },
        { upsert: true },
      );
      return { totalHits: 1, resetTime: freshResetTime };
    } catch (err) {
      // Duplicate-key from a concurrent window reset, or transient DB error —
      // fail open with a single hit.
      if (err.code !== 11000) {
        logger.warn('[rateLimitMongoStore] increment failed (failing open): ' + err.message);
      }
      return { totalHits: 1, resetTime: freshResetTime };
    }
  }

  async decrement(key) {
    const coll = this._collection();
    if (!coll) return;
    try {
      await coll.updateOne(
        { _id: this.prefix + key, hits: { $gt: 0 } },
        { $inc: { hits: -1 } },
      );
    } catch (err) {
      logger.warn('[rateLimitMongoStore] decrement failed: ' + err.message);
    }
  }

  async resetKey(key) {
    const coll = this._collection();
    if (!coll) return;
    try {
      await coll.deleteOne({ _id: this.prefix + key });
    } catch (err) {
      logger.warn('[rateLimitMongoStore] resetKey failed: ' + err.message);
    }
  }
}

export default RateLimitMongoStore;
