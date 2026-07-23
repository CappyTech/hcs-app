import mongoose from 'mongoose';
import crypto from 'crypto';

/**
 * Persisted background-job state.
 *
 * The job scheduler (jobSchedulerService) tracks last-run in memory only, so it
 * resets on restart. Jobs that need to survive restarts/reboots — e.g. the
 * unsubscribe-token rotation, which must not re-fire on every deploy — record
 * their last run here and read it back on the next run.
 */
const jobStateSchema = new mongoose.Schema(
  {
    uuid: { type: String, unique: true, required: true, default: () => crypto.randomUUID() },
    name: { type: String, required: true, unique: true, trim: true },
    lastRunAt: { type: Date, default: null },
    lastOutcome: { type: String, default: null }, // 'ok' | 'error' | 'skipped'
    lastResult: { type: mongoose.Schema.Types.Mixed, default: null },
    lastError: { type: String, default: null },
  },
  { timestamps: true },
);

export default { modelName: 'jobState', schema: jobStateSchema };
