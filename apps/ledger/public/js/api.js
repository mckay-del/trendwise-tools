// JSON API client. Mutations carry X-Requested-With for CSRF protection.
export class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function request(method, path, body) {
  const opts = { method, headers: { Accept: 'application/json' }, credentials: 'same-origin' };
  if (method !== 'GET') { opts.headers['Content-Type'] = 'application/json'; opts.headers['X-Requested-With'] = 'ledger'; opts.body = JSON.stringify(body ?? {}); }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/auth')) { location.hash = '#/login'; }
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`);
  return data;
}

const qs = (q) => { const p = new URLSearchParams(Object.entries(q ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '')); const s = p.toString(); return s ? `?${s}` : ''; };

export const api = {
  get: (p, q) => request('GET', p + qs(q)),
  post: (p, b) => request('POST', p, b),
  put: (p, b) => request('PUT', p, b),
  del: (p) => request('DELETE', p),
  qs,
};

/** Company-scoped helper with a small cache of lookup lists. */
export function companyApi(cid) {
  const base = `/api/c/${cid}`;
  const cache = new Map();
  const c = {
    id: cid,
    get: (p, q) => api.get(base + p, q),
    post: (p, b) => api.post(base + p, b).finally(() => c.invalidate()),
    put: (p, b) => api.put(base + p, b).finally(() => c.invalidate()),
    del: (p) => api.del(base + p).finally(() => c.invalidate()),
    url: (p, q) => base + p + qs(q),
    cached(key, path) { if (!cache.has(key)) cache.set(key, api.get(base + path).catch((e) => { cache.delete(key); throw e; })); return cache.get(key); },
    accounts: () => c.cached('accounts', '/accounts'),
    customers: () => c.cached('customers', '/customers'),
    vendors: () => c.cached('vendors', '/vendors'),
    items: () => c.cached('items', '/items'),
    taxRates: () => c.cached('tax', '/tax-rates'),
    invalidate: () => cache.clear(),
  };
  return c;
}
