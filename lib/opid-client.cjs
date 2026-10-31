// Vendored from OneProfileID src/native/client.cjs. Keep in sync.
// Canonical first-party server adapter. It never runs in the browser.
const COOKIE = /^(?:__Secure-)?oneprofileid\.(?:session_token|two_factor|dont_remember|trust_device)$/;
const METHODS = new Set(['GET', 'POST']);
function cookieName(pair) { return pair.slice(0, pair.indexOf('=')); }
function filterCookies(header = '') {
  return String(header).split(';').map(part => part.trim()).filter(part => COOKIE.test(cookieName(part))).join('; ');
}
function responseCookies(headers) {
  return (headers.getSetCookie?.() || []).filter(value => COOKIE.test(cookieName(value.split(';')[0]))).map(value => value.split(';').filter(attribute => !/^\s*domain=/i.test(attribute)).join(';'));
}
function createNativeClient({ baseURL, appId, secret, origin, fetchImpl = fetch, production = true }) {
  const base = new URL(baseURL);
  const appOrigin = new URL(origin);
  if (base.username || base.password || base.pathname !== '/' || base.search || base.hash ||
      (production && base.protocol !== 'https:') || !['https:', 'http:'].includes(base.protocol)) throw new Error('Invalid central authentication URL');
  if (appOrigin.origin !== origin || (production && appOrigin.protocol !== 'https:') || !/^[a-z0-9-]+$/.test(appId) || typeof secret !== 'string' || secret.length < 32) throw new Error('Invalid application credentials');
  return {
    // Options carry the current browser's OPID cookie, never a user selector.
    getAccountImage(options = {}) { return this.request('/profile/image', options); },
    setAccountImage(image, options = {}) { return this.request('/profile/image', { ...options, body: { image } }); },
    /** @param {string} path
     * @param {{body?: Record<string, unknown>, cookie?: string, ip?: string, userAgent?: string}} [options]
     */
    async request(path, { body, cookie = '', ip = '', userAgent = '' } = {}) {
      if (!/^\/[a-z-]+(?:\/[a-z-]+)*$/.test(path)) throw new Error('Invalid authentication route');
      const method = body === undefined ? 'GET' : 'POST';
      if (!METHODS.has(method)) throw new Error('Invalid authentication method');
      const headers = { origin, 'x-opid-app': appId, 'x-opid-client-secret': secret, 'content-type': 'application/json', cookie: filterCookies(cookie), 'x-opid-client-ip': ip, 'user-agent': userAgent };
      try {
        const response = await fetchImpl(new URL(`/internal/v1/auth${path}`, base), { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(8000), redirect: 'error' });
        const payload = await response.json();
        if (response.ok && payload !== null && (typeof payload !== 'object' || Array.isArray(payload))) throw new Error('Invalid central response');
        if (payload?.user && (typeof payload.user.id !== 'string' || !Array.isArray(payload.memberships))) throw new Error('Invalid identity response');
        return { ok: response.ok, status: response.status, payload, cookies: responseCookies(response.headers) };
      } catch {
        return { ok: false, status: 503, payload: { error: 'OneProfileID is temporarily unavailable. Try again shortly.' }, cookies: [] };
      }
    },
  };
}
exports.createNativeClient = createNativeClient;
exports.filterCookies = filterCookies;
exports.responseCookies = responseCookies;
