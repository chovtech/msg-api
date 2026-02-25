/**
 * Wamator API Client
 * Centralized fetch wrapper — all API calls go through here.
 * Sends httpOnly cookie automatically via credentials: 'include'.
 */
const WamatorAPI = (() => {
  const BASE_URL = window.__WAMATOR_API_URL || 'http://localhost:3000';

  async function request(method, path, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include', // sends httpOnly cookie
    };

    if (body && method !== 'GET') {
      opts.body = JSON.stringify(body);
    }

    const res = await fetch(`${BASE_URL}${path}`, opts);

    // Auto-redirect to login on 401 (except for /session/ endpoints)
    if (res.status === 401 && !path.startsWith('/session/')) {
      window.location.href = '/auth/login.html';
      return;
    }

    const data = await res.json();

    if (!res.ok) {
      const err = new Error(data.message || 'Request failed');
      err.status = res.status;
      err.data = data;
      throw err;
    }

    return data;
  }

  return {
    get:    (path)       => request('GET', path),
    post:   (path, body) => request('POST', path, body),
    put:    (path, body) => request('PUT', path, body),
    patch:  (path, body) => request('PATCH', path, body),
    delete: (path, body) => request('DELETE', path, body),
    BASE_URL,
  };
})();
