const path = require('path');
const fs = require('fs').promises;
const sanitize = require('sanitize-filename');
const logger = require('../../services/loggerService');
const mdb = require('../services/mongooseDatabaseService');

const getBaseDir = (modelName) => path.join(__dirname, '../../', modelName.charAt(0).toUpperCase() + modelName.slice(1));

exports.renderUploadForm = async (req, res, next) => {
  const { model, uuid } = req.params;
  const modelName = model.toLowerCase();

  try {
    const item = await mdb[modelName]?.findOne({ uuid }).lean();
    if (!item) return res.status(404).send('Not found');

    res.render(path.join('tailwindcss', 'partials', 'form-upload'), {
      title: `Upload Documents`,
      item,
      modelName,
      basePath: modelName,
    });
  } catch (err) {
    next(err);
  }
};

exports.uploadFiles = async (req, res) => {
  const { model, uuid } = req.params;
  const modelName = model.toLowerCase();
  const dirName = sanitize(req.params.number || uuid);
  const baseDir = getBaseDir(modelName);
  const targetDir = path.join(baseDir, dirName);

  try {
    await fs.mkdir(targetDir, { recursive: true });

    for (const file of req.files) {
      const sanitizedFileName = sanitize(file.originalname);
      const filePath = path.join(targetDir, sanitizedFileName);

      await fs.rename(file.path, filePath);

      logger.info(`📄 Uploaded: ${sanitizedFileName} to ${modelName}/${dirName}`);

      if (mdb[`${modelName}_files`]) {
        await mdb[`${modelName}_files`].create({
          [`${modelName}UUID`]: uuid,
          [`${modelName}Ref`]: dirName,
          filename: sanitizedFileName,
          path: filePath,
          uploadedAt: new Date()
        });
      }
    }

    res.redirect(`/${modelName}/read/${uuid}`);
  } catch (err) {
    logger.error(`❌ Upload error for ${modelName}: ${err.message}`);
    res.status(500).send('File upload failed.');
  }
};

exports.downloadFile = async (req, res) => {
  const { model, uuid, filename } = req.params;
  const modelName = model.toLowerCase();
  const dirName = sanitize(req.params.number || uuid);
  const sanitizedFile = sanitize(filename);
  const baseDir = getBaseDir(modelName);
  const filePath = path.join(baseDir, dirName, sanitizedFile);

  try {
    res.download(filePath, sanitizedFile, (err) => {
      if (err) {
        logger.error(`❌ Download error for ${modelName}: ${err.message}`);
        res.status(404).send('File not found.');
      } else {
        logger.info(`⬇️ Downloaded: ${sanitizedFile} from ${modelName}/${dirName}`);
      }
    });
  } catch (err) {
    logger.error(`❌ Download route error for ${modelName}: ${err.message}`);
    res.status(500).send('Download failed.');
  }
};

exports.deleteFile = async (req, res) => {
  const { model, uuid, filename } = req.params;
  const modelName = model.toLowerCase();
  const dirName = sanitize(req.params.number || uuid);
  const sanitizedFile = sanitize(filename);
  const dirPath = getBaseDir(modelName);
  const filePath = path.join(dirPath, dirName, sanitizedFile);

  try {
    await fs.unlink(filePath);
    logger.info(`🗑️ Deleted: ${sanitizedFile} from ${modelName}/${dirName}`);
    res.redirect(`/${modelName}/read/${uuid}`);
  } catch (err) {
    logger.error(`❌ Delete error for ${modelName}: ${err.message}`);
    res.status(500).send('File deletion failed.');
  }
};