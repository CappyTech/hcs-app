/**
 * bootstrapEnv — the very first import in app.js.
 *
 * ESM hoists imports, so a statement in app.js runs only after every module it
 * imports has been evaluated — and encryptionService (reached through the user
 * model, totpService and several controllers) throws at import when
 * ENCRYPTION_KEY is unset. The environment therefore has to be complete before
 * app.js's own import list is walked, which is exactly what importing this
 * module first achieves: its body runs before the next import is evaluated.
 *
 * In order:
 *   1. .env (local development only; Docker uses compose.env)
 *   2. config/app-config.json — legacy, read-only: values a wizard wrote before
 *      bootstrap moved out of the image. Nothing writes it any more.
 *   3. <FILE_STORAGE_DIR>/.bootstrap/bootstrap.json — the Mongo connection the
 *      database wizard saved on the volume.
 *   4. ENCRYPTION_KEY — read from, or generated into, the key file on the volume.
 *
 * The environment wins at every step; nothing here overwrites a set variable.
 */

import dotenv from 'dotenv';
import configService from './configService.js';
import bootstrapSecrets from './bootstrapSecretsService.js';

dotenv.config();
configService.bootstrap();
bootstrapSecrets.applyBootstrapFile(bootstrapSecrets.readBootstrapFile());

export const encryptionKey = bootstrapSecrets.ensureEncryptionKey();
