/**
 * Which addresses can actually be opened in a browser: the app's GET routes
 * with no parameters. routeAccess also holds permission prefixes and
 * form-only (POST) paths, which aren't pages to link to.
 */
const cache = new WeakMap();

function walk(stack, out) {
  for (const layer of stack || []) {
    if (layer.route) {
      if (!layer.route.methods?.get) continue;
      for (const p of [].concat(layer.route.path)) {
        if (typeof p === 'string' && !p.includes(':')) out.add(p.toLowerCase());
      }
    } else if (layer.name === 'router' && layer.regexp?.fast_slash) {
      walk(layer.handle?.stack, out);
    }
  }
  return out;
}

/** Lowercased GET paths of an Express 4 app (routers mounted at the root). */
export function pagePaths(app) {
  if (!app?._router) return new Set();
  if (!cache.has(app)) cache.set(app, walk(app._router.stack, new Set()));
  return cache.get(app);
}

/**
 * Keeps the routes that are pages. With no route table to check against it
 * keeps everything, so a change in Express can't empty the list.
 */
export function onlyPages(routes, app) {
  const pages = pagePaths(app);
  return pages.size ? routes.filter((r) => pages.has(r.toLowerCase())) : routes;
}

export default { pagePaths, onlyPages };
