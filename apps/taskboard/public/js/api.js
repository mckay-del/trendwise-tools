// JSON API client. Mutations carry X-Requested-With for CSRF protection.
export class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function request(method, path, body) {
  const opts = { method, headers: { Accept: 'application/json' }, credentials: 'same-origin' };
  if (method !== 'GET') { opts.headers['Content-Type'] = 'application/json'; opts.headers['X-Requested-With'] = 'taskboard'; opts.body = JSON.stringify(body ?? {}); }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/auth')) location.hash = '#/login';
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b),
  put: (p, b) => request('PUT', p, b),
  del: (p) => request('DELETE', p),
};
