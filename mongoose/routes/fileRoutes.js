import express from 'express';
const router = express.Router();
import multer from 'multer';
import path from 'path';
import authService from '../../services/authService.js';
import ensureHandlesDocuments from '../../services/ensureHandlesDocuments.js';
import ensureCanAccessRecord from '../../services/ensureCanAccessRecord.js';
import fileController from '../controllers/fileController.js';
import csrfService from '../../services/csrfService.js';
import fileStorage from '../../services/fileStorage.js';

fileStorage.ensureStorageDirs();

const upload = multer({
  // Absolute, and on the same filesystem as the final destination. The previous
  // "uploads/" was relative to the process working directory — not where anything
  // else looked, and in the container it resolved to a path with no volume behind it.
  dest: fileStorage.TEMP_DIR,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = /\.(jpeg|jpg|png|pdf|doc|docx)$/;
    const allowedMime = /jpeg|jpg|png|pdf|msword|vnd.openxmlformats/;

    const isValid = allowedExts.test(ext) && allowedMime.test(file.mimetype);
    cb(isValid ? null : new Error("Invalid file type."), isValid);
  },
  limits: { fileSize: 5 * 1024 * 1024 },
});

// Authorisation is per parent record rather than a flat admin check: a user may see
// a document exactly when they may see the record it hangs off. Reading a document
// needs 'r' on the model; adding or removing one needs 'u'. Admin keeps its bypass
// via rbac.canAccess. See services/ensureCanAccessRecord.js.

router.get(
  "/:model/:uuid/view/:filename",
  authService.ensureAuthenticated,
  ensureHandlesDocuments,
  ensureCanAccessRecord('r'),
  fileController.viewFile,
);

router.get(
  "/:model/upload/:uuid",
  authService.ensureAuthenticated,
  ensureHandlesDocuments,
  ensureCanAccessRecord('u'),
  fileController.renderUploadForm,
);

router.post(
  "/:model/upload/:uuid",
  authService.ensureAuthenticated,
  ensureHandlesDocuments,
  ensureCanAccessRecord('u'),
  upload.array("files", 10),
  csrfService.validate,
  fileController.uploadFiles,
);

router.get(
  "/:model/download/:uuid/:filename",
  authService.ensureAuthenticated,
  ensureHandlesDocuments,
  ensureCanAccessRecord('r'),
  fileController.downloadFile,
);

router.post(
  "/:model/delete/:uuid/:filename",
  authService.ensureAuthenticated,
  ensureHandlesDocuments,
  ensureCanAccessRecord('u'),
  fileController.deleteFile,
);

export default router;
