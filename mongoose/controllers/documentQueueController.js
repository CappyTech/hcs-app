/**
 * documentQueueController.js — GET /paperless/queues/:queue (Paperless
 * migration H4). Read-only: the actions that move a document between queues
 * arrive with the entry screen (H5) and notifications (H6).
 */

import path from 'path';
import mdb from '../services/mongooseDatabaseService.js';
import queues from '../services/paperless/documentQueueService.js';
import logger from '../../services/loggerService.js';

export const getQueueHub = (req, res) => res.redirect('/paperless/queues/needs-entry');

export const getQueue = async (req, res, next) => {
  try {
    const key = req.params.queue;
    if (!queues.QUEUES[key]) {
      return res.status(404).render(path.join('tailwindcss', 'error'), {
        title: '404 - Not Found',
        error: { title: '404 - Not Found', message: 'No such document queue.' },
      });
    }
    await mdb.connect();
    const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);
    const sort = req.query.sort === 'read' ? 'read' : 'oldest';
    const data = await queues.loadQueue(mdb.PAPERLESS.OcrDocument, key, { page, sort });
    res.render(path.join('tailwindcss', 'paperless', 'queue'), {
      title: data.queue.label,
      ...data,
      queues: queues.QUEUES,
      paperlessUiBase: queues.paperlessUiBase(),
    });
  } catch (err) {
    logger.error(`[documentQueue] ${req.params.queue}: ${err.message}`);
    next(err);
  }
};

export default { getQueueHub, getQueue };
