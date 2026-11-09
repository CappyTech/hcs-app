/**
 * Where a model's list page lives. listRoutes registers the route from this,
 * and everything that links or redirects back to a list asks here, so an
 * irregular address (/countries, /rams) can't turn into a 404 like /countrys.
 */
import listControllerConfig from '../config/listControllerConfig.js';

export function listPathFor(model, config = listControllerConfig[model] || {}) {
  if (config.pathOverride) {
    return config.pathOverride.startsWith('/') ? config.pathOverride : `/${config.pathOverride}`;
  }
  // modelRename may be nested: 'paperless/ocrdocument' -> '/paperless/ocrdocuments'
  const parts = (config.modelRename || model).toLowerCase().split('/').filter(Boolean);
  const last = parts.pop();
  return `/${[...parts, `${last}s`].join('/')}`;
}

export default { listPathFor };
