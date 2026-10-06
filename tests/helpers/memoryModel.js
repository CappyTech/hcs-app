/**
 * An in-memory stand-in for a Mongoose model, enough for services that use
 * find/findOne (select/sort/limit/lean), updateOne (upsert, $set/$inc/$unset),
 * deleteOne and countDocuments with plain filters: equality, RegExp, $ne, $in,
 * $nin, $exists, $lt, $or and dotted paths.
 */
const get = (doc, p) => p.split('.').reduce((v, k) => (v == null ? undefined : v[k]), doc);
const set = (doc, p, val) => {
  const keys = p.split('.');
  let o = doc;
  keys.slice(0, -1).forEach((k) => { o[k] ??= {}; o = o[k]; });
  o[keys.at(-1)] = val;
};
const unset = (doc, p) => {
  const keys = p.split('.');
  const parent = keys.slice(0, -1).reduce((v, k) => v?.[k], doc);
  if (parent) delete parent[keys.at(-1)];
};

function test(value, cond) {
  if (cond instanceof RegExp) return typeof value === 'string' && cond.test(value);
  if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
    return Object.entries(cond).every(([op, arg]) => {
      if (op === '$ne') return !test(value, arg);
      if (op === '$in') return arg.some((a) => test(value, a));
      if (op === '$nin') return !arg.some((a) => test(value, a));
      if (op === '$exists') return (value !== undefined) === arg;
      if (op === '$lt') return value != null && value < arg;
      return test(value?.[op], arg);
    });
  }
  if (cond === null) return value == null;
  return value === cond;
}

export function matches(doc, filter = {}) {
  return Object.entries(filter).every(([k, cond]) => {
    if (k === '$or') return cond.some((f) => matches(doc, f));
    return test(get(doc, k), cond);
  });
}

class Query {
  constructor(run) { this.run = run; this.opts = {}; }
  select() { return this; }
  sort(s) { this.opts.sort = s; return this; }
  limit(n) { this.opts.limit = n; return this; }
  skip(n) { this.opts.skip = n; return this; }
  lean() { return Promise.resolve(this.run(this.opts)); }
  then(a, b) { return this.lean().then(a, b); }
}

export function memoryModel(rows = []) {
  const docs = rows.map((r) => structuredClone(r));
  const copy = (d) => (d ? structuredClone(d) : null);
  return {
    docs,
    find(filter) {
      return new Query(({ sort, limit, skip }) => {
        let out = docs.filter((d) => matches(d, filter));
        if (sort) {
          const [[k, dir]] = Object.entries(sort);
          out = out.sort((a, b) => (get(a, k) > get(b, k) ? dir : get(a, k) < get(b, k) ? -dir : 0));
        }
        if (skip) out = out.slice(skip);
        if (limit) out = out.slice(0, limit);
        return out.map(copy);
      });
    },
    findOne(filter) { return new Query(() => copy(docs.find((d) => matches(d, filter)))); },
    async updateOne(filter, update, { upsert = false } = {}) {
      let doc = docs.find((d) => matches(d, filter));
      if (!doc) {
        if (!upsert) return { matchedCount: 0 };
        doc = Object.fromEntries(Object.entries(filter).filter(([k]) => !k.startsWith('$')));
        docs.push(doc);
      }
      for (const [p, v] of Object.entries(update.$set || {})) set(doc, p, structuredClone(v));
      for (const [p, v] of Object.entries(update.$inc || {})) set(doc, p, (get(doc, p) || 0) + v);
      for (const p of Object.keys(update.$unset || {})) unset(doc, p);
      return { matchedCount: 1 };
    },
    async deleteOne(filter) {
      const i = docs.findIndex((d) => matches(d, filter));
      if (i >= 0) docs.splice(i, 1);
      return { deletedCount: i >= 0 ? 1 : 0 };
    },
    async countDocuments(filter) { return docs.filter((d) => matches(d, filter)).length; },
  };
}

export default memoryModel;
