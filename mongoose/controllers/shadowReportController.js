/**
 * shadowReportController.js — GET /paperless/shadow-report (Paperless
 * migration H8): the live comparison for a recent window, the saved daily
 * reports, and the cutover checklist.
 */

import path from 'path';
import mdb from '../services/mongooseDatabaseService.js';
import shadow from '../services/paperless/shadowReportService.js';
import { followEnabled } from '../services/paperless/documentIngestService.js';
import { paperlessUiBase } from '../services/paperless/documentQueueService.js';
import logger from '../../services/loggerService.js';

export const getShadowReport = async (req, res, next) => {
  try {
    await mdb.connect();
    const { OcrDocument, NotificationLog, ShadowReport } = mdb.PAPERLESS;
    const days = Math.min(Math.max(parseInt(req.query.days || '1', 10) || 1, 1), 14);
    const now = new Date();
    const from = new Date(now.getTime() - days * 86_400_000);
    const live = await shadow.compareWindow({ OcrDocument, NotificationLog, from, to: now, now });
    const saved = ShadowReport
      ? await ShadowReport.find({}).sort({ day: -1 }).limit(14).select('day clean mode totals generatedAt').lean()
      : [];
    res.render(path.join('tailwindcss', 'paperless', 'shadowReport'), {
      title: 'Shadow report',
      days,
      live,
      saved,
      followTags: followEnabled(),
      paperlessUiBase: paperlessUiBase(),
    });
  } catch (err) {
    logger.error(`[shadowReport] page: ${err.message}`);
    next(err);
  }
};

export default { getShadowReport };
