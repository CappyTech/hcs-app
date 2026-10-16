import path from 'path';
import searchService from '../services/searchService.js';
import logger from '../../services/loggerService.js';

/**
 * GET /search?q=term            every entity the person may list, a few hits each
 * GET /search?q=term&type=key   one entity, up to TYPE_LIMIT hits
 */
const view = path.join('tailwindcss', 'search', 'index');

export const getSearch = async (req, res, next) => {
  try {
    const q = searchService.normaliseQuery(req.query.q);
    const typeRaw = typeof req.query.type === 'string' ? req.query.type.trim() : '';
    const type = searchService.ENTITIES.some((e) => e.key === typeRaw) ? typeRaw : null;
    const entity = type ? searchService.ENTITIES.find((e) => e.key === type) : null;
    const result = await searchService.search(req, q, {
      type,
      limit: type ? searchService.TYPE_LIMIT : searchService.DEFAULT_LIMIT,
    });
    const hits = result.groups.reduce((n, g) => n + g.items.length, 0);
    if (q) logger.info(`[search] ${req.user ? req.user.username : '-'} searched (${q.length} chars${type ? ', ' + type : ''}): ${result.groups.length} group(s), ${hits} hit(s)`);
    res.render(view, {
      title: type ? `Search ${entity.label.toLowerCase()}` : 'Search',
      q: result.q,
      type,
      typeLabel: entity ? entity.label : '',
      groups: result.groups,
      hits,
      tooShort: result.tooShort,
      minLength: searchService.MIN_QUERY_LENGTH,
      maxLength: searchService.MAX_QUERY_LENGTH,
    });
  } catch (err) {
    next(err);
  }
};

export default { getSearch };
