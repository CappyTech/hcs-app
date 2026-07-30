import path from 'path';
import fsp from 'fs/promises';
import mime from 'mime-types';
import sanitize from 'sanitize-filename';
import logger from '../../services/loggerService.js';
import mdb from '../services/mongooseDatabaseService.js';
import fileStorage from '../../services/fileStorage.js';

const { getRecordDir, resolveFilePath } = fileStorage;

/**
 * Documents are served through the authenticated download route, never as static
 * files. They used to be written into public/<model>/ and linked as
 * /resources/<Model>/<uuid>/<file>, which express served to anyone — no session
 * required. See services/fileStorage.js.
 */
const buildFileUrl = (modelName, safeDir, safeFile) =>
  `/${modelName}/download/${encodeURIComponent(safeDir)}/${encodeURIComponent(safeFile)}`;

export const viewFile = async (req, res, next) => {
  try {
    const { model, uuid, filename } = req.params;
    const modelName = model.toLowerCase();
    const safeDir = sanitize(String(uuid));
    const safeFile = sanitize(String(filename));

    const filePath = resolveFilePath(modelName, safeDir, safeFile);
    if (!filePath) {
      return next({ statusCode: 400, name: 'BadRequestError', message: 'Invalid file path' });
    }

    await fsp.access(filePath); // Throws if not found

    const mimeType = mime.lookup(filePath);
    const fileUrl = buildFileUrl(modelName, safeDir, safeFile);

    if (mimeType?.startsWith('image/')) {
      return res.render('tailwindcss/partials/view-file', {
        title: `Viewing ${safeFile}`,
        fileUrl,
        fileType: 'image',
        filename: safeFile,
        uuid,
        basePath: modelName,
      });
    }

    if (mimeType === 'application/pdf') {
      return res.render('tailwindcss/partials/view-file', {
        title: `Viewing ${safeFile}`,
        fileUrl,
        fileType: 'pdf',
        filename: safeFile,
        uuid,
        basePath: modelName,
      });
    }

    // Unsupported → fallback to download
    return res.download(filePath, safeFile);
  } catch (err) {
    logger.error(`[fileController] Error in viewFile: ${err.message}`);
    next(err);
  }
};

export const renderUploadForm = async (req, res, next) => {
  const { model, uuid } = req.params;
  const modelName = model.toLowerCase();

  try {
    // ensureCanAccessRecord has already loaded and authorised the parent record.
    const item = req.parentRecord || (await mdb[modelName]?.findOne({ uuid }).lean());
    if (!item) return res.status(404).send('Not found');

    res.render(path.join('tailwindcss', 'partials', 'form-upload'), {
      title: 'Upload Documents',
      item,
      modelName,
      basePath: modelName,
    });
  } catch (err) {
    next(err);
  }
};

export const uploadFiles = async (req, res, next) => {
  const { model, uuid } = req.params;
  const modelName = model.toLowerCase();
  const dirName = sanitize(uuid);
  const targetDir = getRecordDir(modelName, dirName);

  try {
    await fsp.mkdir(targetDir, { recursive: true });

    for (const file of req.files) {
      const sanitizedFileName = sanitize(file.originalname);
      const filePath = resolveFilePath(modelName, dirName, sanitizedFileName);
      if (!filePath) {
        logger.warn(`[fileController] Rejected suspicious filename: ${file.originalname}`);
        await fsp.unlink(file.path).catch(() => {});
        continue;
      }

      await fsp.rename(file.path, filePath);

      logger.info(`📄 Uploaded: ${sanitizedFileName} to ${modelName}/${dirName}`);

      if (mdb[`${modelName}_files`]) {
        await mdb[`${modelName}_files`].create({
          [`${modelName}UUID`]: uuid,
          [`${modelName}Ref`]: dirName,
          filename: sanitizedFileName,
          path: filePath,
          uploadedAt: new Date(),
        });
      }
    }

    req.flash('success', 'File uploaded successfully.');
    res.redirect(`/${modelName}/read/${uuid}`);
  } catch (err) {
    logger.error(`[fileController] Upload error for ${modelName}: ${err.message}`);
    req.flash('error', 'Failed to upload file.');
    next(err);
  }
};

export const downloadFile = async (req, res, next) => {
  const { model, uuid, filename } = req.params;
  const modelName = model.toLowerCase();
  const dirName = sanitize(uuid);
  const sanitizedFile = sanitize(filename);
  const filePath = resolveFilePath(modelName, dirName, sanitizedFile);

  if (!filePath) {
    return next({ statusCode: 400, name: 'BadRequestError', message: 'Invalid file path' });
  }

  try {
    await fsp.access(filePath); // throws if file doesn't exist
    res.download(filePath, sanitizedFile, (err) => {
      if (err) return next(err);
      logger.info(
        `[fileController] Downloaded: ${sanitizedFile} from ${modelName}/${dirName}`,
      );
    });
  } catch (err) {
    logger.warn(`[fileController] File not found or error downloading: ${filePath}`);
    next(err);
  }
};

export const deleteFile = async (req, res, next) => {
  const { model, uuid, filename } = req.params;
  const modelName = model.toLowerCase();
  const dirName = sanitize(uuid);
  const sanitizedFile = sanitize(filename);
  const filePath = resolveFilePath(modelName, dirName, sanitizedFile);

  if (!filePath) {
    return next({ statusCode: 400, name: 'BadRequestError', message: 'Invalid file path' });
  }

  try {
    await fsp.unlink(filePath);
    logger.info(`[fileController] Deleted: ${sanitizedFile} from ${modelName}/${dirName}`);
    req.flash('success', 'File deleted successfully.');
    res.redirect(`/${modelName}/read/${uuid}`);
  } catch (err) {
    logger.error(`[fileController] Delete error for ${modelName}: ${err.message}`);
    req.flash('error', 'Failed to delete file.');
    next(err);
  }
};

export default { viewFile, renderUploadForm, uploadFiles, downloadFile, deleteFile };
