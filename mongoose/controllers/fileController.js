import path from 'path';
import fs from 'fs'; // for existsSync
const fsp = __fs.promises; // for async file ops if needed
import mime from 'mime-types';
import sanitize from 'sanitize-filename';
import logger from '../../services/loggerService.js';
import mdb from '../services/mongooseDatabaseService.js';
import __fs from 'fs';
import { fileURLToPath } from 'node:url';
import { dirname as _esmDirname } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = _esmDirname(__filename);

const getBaseDir = (modelName) =>
  path.join(__dirname, "../../public", modelName.toLowerCase());

export const viewFile = async (req, res, next) => {
  try {
    const { model, uuid, filename } = req.params;
    const safeDir = sanitize(String(uuid));
    const safeFile = sanitize(String(filename));
    const modelName = model.toLowerCase();
    const baseDir = getBaseDir(modelName);
    const filePath = path.join(baseDir, safeDir, safeFile);

    await fsp.access(filePath); // Throws if not found

    const mimeType = mime.lookup(filePath);
    const modelDisplay = model.charAt(0).toUpperCase() + model.slice(1);
    const fileUrl = `/resources/${modelDisplay}/${safeDir}/${safeFile}`;

    if (mimeType?.startsWith("image/")) {
      return res.render("tailwindcss/partials/view-file", {
        title: `Viewing ${safeFile}`,
        fileUrl,
        fileType: "image",
        filename: safeFile,
        uuid,
        basePath: modelName,
      });
    }

    if (mimeType === "application/pdf") {
      return res.render("tailwindcss/partials/view-file", {
        title: `Viewing ${safeFile}`,
        fileUrl,
        fileType: "pdf",
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
    const item = await mdb[modelName]?.findOne({ uuid }).lean();
    if (!item) return res.status(404).send("Not found");

    res.render(path.join("tailwindcss", "partials", "form-upload"), {
      title: `Upload Documents`,
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
  const baseDir = getBaseDir(modelName);
  const targetDir = path.join(baseDir, dirName);

  try {
    await fsp.mkdir(targetDir, { recursive: true });

    for (const file of req.files) {
      const sanitizedFileName = sanitize(file.originalname);
      const filePath = path.join(targetDir, sanitizedFileName);

      await fsp.rename(file.path, filePath);

      logger.info(
        `📄 Uploaded: ${sanitizedFileName} to ${modelName}/${dirName}`,
      );

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
  const baseDir = getBaseDir(modelName);
  const filePath = path.join(baseDir, dirName, sanitizedFile);

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
  const dirPath = getBaseDir(modelName);
  const filePath = path.join(dirPath, dirName, sanitizedFile);

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
