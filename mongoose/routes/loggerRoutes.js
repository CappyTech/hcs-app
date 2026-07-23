import express from 'express';
const router = express.Router();
import authService from '../../services/authService.js';
import ctrl from '../controllers/loggerController.js';

router.get("/logs", authService.ensureRole(), ctrl.getLogs);
router.get("/logs/api", authService.ensureRole(), ctrl.getLogsApi);
router.get("/logs/download", authService.ensureRole(), ctrl.downloadLogs);
router.delete("/logs/clear", authService.ensureRole(), ctrl.clearLogs);

router.get("/logs/kashflow", authService.ensureRole(), ctrl.getKashflowApiLogs);
router.get("/logs/kashflow/data", authService.ensureRole(), ctrl.getKashflowApiLogsData);
router.get("/logs/paperless", authService.ensureRole(), ctrl.getPaperlessApiLogs);
router.get("/logs/paperless/data", authService.ensureRole(), ctrl.getPaperlessApiLogsData);

export default router;
