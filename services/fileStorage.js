/**
 * Single source of truth for where uploaded documents live on disk.
 *
 * These files used to be written into `public/<model>/`, which express serves
 * wholesale under `/resources/`. That made every uploaded document — CIS records,
 * HR paperwork, project photos — fetchable by anyone who knew the URL, with no
 * session required. The store now lives outside `public/` entirely and is reachable
 * only through the authenticated routes in fileRoutes.js.
 *
 * Configure with FILE_STORAGE_DIR. It must be a mounted volume in production:
 * anything written inside the container's own filesystem is destroyed on the next
 * `docker compose pull && up -d`, which is how this stack deploys.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Default sits next to the app rather than inside public/. Overridden in Docker.
export const STORAGE_ROOT = process.env.FILE_STORAGE_DIR
  ? path.resolve(process.env.FILE_STORAGE_DIR)
  : path.join(__dirname, '..', 'storage');

// multer writes here first, then the controller renames into place. Keeping the
// temp dir inside the same root matters: fs.rename cannot cross filesystems
// (EXDEV), and the previous relative "uploads/" dest was resolved against the
// process working directory, which is not where anything else looked.
export const TEMP_DIR = path.join(STORAGE_ROOT, '.tmp');

/** Absolute directory holding a model's documents. */
export function getModelDir(modelName) {
  // Lowercased on both the write and read paths. The old code wrote to
  // public/<model> but built URLs with a capitalised name, which are different
  // paths on a case-sensitive filesystem.
  return path.join(STORAGE_ROOT, String(modelName).toLowerCase());
}

/** Absolute directory holding one record's documents. */
export function getRecordDir(modelName, safeUuid) {
  return path.join(getModelDir(modelName), safeUuid);
}

/**
 * Resolve a file path and refuse anything that escapes its record directory.
 * Callers already sanitise the segments; this is the backstop.
 */
export function resolveFilePath(modelName, safeUuid, safeFilename) {
  const recordDir = getRecordDir(modelName, safeUuid);
  const resolved = path.resolve(recordDir, safeFilename);
  if (resolved !== path.join(recordDir, safeFilename)) return null;
  if (!resolved.startsWith(path.resolve(recordDir) + path.sep)) return null;
  return resolved;
}

export function ensureStorageDirs() {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

export default {
  STORAGE_ROOT,
  TEMP_DIR,
  getModelDir,
  getRecordDir,
  resolveFilePath,
  ensureStorageDirs,
};
