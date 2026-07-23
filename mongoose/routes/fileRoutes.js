import express from 'express';
const router = express.Router();
import multer from 'multer';
import path from 'path';
import authService from '../../services/authService.js';
import ensureHandlesDocuments from '../../services/ensureHandlesDocuments.js';
import fileController from '../controllers/fileController.js';
import csrfService from '../../services/csrfService.js';

const upload = multer({
  dest: "uploads/",
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = /\.(jpeg|jpg|png|pdf|doc|docx)$/;
    const allowedMime = /jpeg|jpg|png|pdf|msword|vnd.openxmlformats/;

    const isValid = allowedExts.test(ext) && allowedMime.test(file.mimetype);
    cb(isValid ? null : new Error("Invalid file type."), isValid);
  },
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.get(
  "/:model/:uuid/view/:filename",
  authService.ensureAuthenticated,
  authService.ensureRole("admin"),
  ensureHandlesDocuments,
  fileController.viewFile,
);

router.get(
  "/:model/upload/:uuid",
  authService.ensureAuthenticated,
  authService.ensureRole("admin"),
  ensureHandlesDocuments,
  fileController.renderUploadForm,
);

router.post(
  "/:model/upload/:uuid",
  authService.ensureAuthenticated,
  authService.ensureRole("admin"),
  ensureHandlesDocuments,
  upload.array("files", 10),
  csrfService.validate,
  fileController.uploadFiles,
);

router.get(
  "/:model/download/:uuid/:filename",
  authService.ensureAuthenticated,
  authService.ensureRole("admin"),
  ensureHandlesDocuments,
  fileController.downloadFile,
);

router.post(
  "/:model/delete/:uuid/:filename",
  authService.ensureAuthenticated,
  authService.ensureRole("admin"),
  ensureHandlesDocuments,
  fileController.deleteFile,
);

export default router;
