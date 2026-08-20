import mongoose from 'mongoose';

/**
 * Managed application configuration.
 *
 * One document per setting. This is the store that lets an admin change
 * configuration without a redeploy, and it lives in Mongo rather than in
 * `config/app-config.json` for two reasons: the container mounts only
 * `./storage` and `./logs`, so a file under `/app/config` is destroyed by every
 * `docker compose pull && up -d` (pull_policy is always), and Mongo is dumped
 * nightly while the image is not.
 *
 * Being an INTERNAL model, it picks up auditPlugin automatically — so every
 * configuration change carries who made it and what the previous value was.
 * Secrets are stored encrypted (see configStoreService); the audit trail
 * therefore records that a secret changed, never the secret itself.
 */
const appConfigSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    // Encrypted at rest when `secret` is true.
    value: { type: String, default: '' },
    secret: { type: Boolean, default: false },
    // Username of whoever last saved it, for the settings UI.
    updatedBy: { type: String, default: null },
  },
  { collection: 'appconfigs', timestamps: true },
);

export default {
  modelName: 'appConfig',
  schema: appConfigSchema,
};
