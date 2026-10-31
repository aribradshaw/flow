// Vendored from OneProfileID src/native/sso-client.cjs (canonical server-only OIDC adapter).
// Keep in sync with that file. Passkeys and biometrics run on OneProfileID's own origin.
// Canonical server-only OIDC adapter. Keep application permissions in the caller.
const { randomBytes, createHash, createCipheriv, createDecipheriv } = require('node:crypto');
const { createNativeClient } = require('./opid-client.cjs');
const TX_NAME = 'opid_sso_tx';
function safeReturnTo(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\s\x00-\x1f\x7f]/.test(value)) return '/';
  const url = new URL(value, 'https://return.invalid');
  return url.origin === 'https://return.invalid' ? url.pathname + url.search + url.hash : '/';
}
function createSsoClient({ issuer, clientId, clientSecret, redirectUri, nativeBaseURL, appId, nativeSecret, origin, production = true }) {
  const issuerUrl = new URL(issuer), callback = new URL(redirectUri);
  if (issuerUrl.username || issuerUrl.password || issuerUrl.search || issuerUrl.hash || callback.origin !== origin || callback.search || callback.hash || typeof clientSecret !== 'string' || clientSecret.length < 32 || !clientId || (production && (issuerUrl.protocol !== 'https:' || callback.protocol !== 'https:'))) throw new Error('Invalid OneProfileID SSO configuration');
  if (!production && !['https:', 'http:'].includes(issuerUrl.protocol)) throw new Error('Invalid issuer protocol');
  const key = createHash('sha256').update('OneProfileID SSO transaction v1\0').update(clientSecret).digest();
  const aad = Buffer.from(`${issuer}\0${clientId}\0${redirectUri}`);
  const native = createNativeClient({ baseURL: nativeBaseURL, appId, secret: nativeSecret, origin, production });
  const serialize = (value, age) => `${TX_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${production ? '; Secure' : ''}`;
  const clearCookie = serialize('', 0);
  const seal = value => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  };
  const unseal = (cookie, resume = false) => {
    const value = String(cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${TX_NAME}=`))?.slice(TX_NAME.length + 1);
    if (!value || value.length > 4096) throw new Error('Missing sign-in transaction');
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.length < 29) throw new Error('Invalid sign-in transaction');
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAAD(aad); decipher.setAuthTag(bytes.subarray(12, 28));
    const data = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
    if (!Number.isFinite(data.expires) || data.expires + (resume ? 3300000 : 0) < Date.now() || data.expires > Date.now() + 301000) throw new Error('Expired sign-in transaction');
    return data;
  };
  let discovery;
  async function config() {
    const oidc = await import('openid-client');
    discovery ||= oidc.discovery(issuerUrl, clientId, clientSecret, oidc.ClientSecretBasic(clientSecret), issuerUrl.protocol === 'http:' && !production ? { execute: [oidc.allowInsecureRequests] } : undefined).catch(error => { discovery = undefined; throw error; });
    return { oidc, configuration: await discovery };
  }
  return {
    clearCookie,
    async start({ returnTo = '/', context = {}, cookie = '', resume = false } = {}) {
      // An expired transaction may restore navigation only. Always mint fresh
      // state, nonce and PKCE; callback verification keeps its five-minute bound.
      if (resume) {
        try { const previous = unseal(cookie, true); returnTo = previous.returnTo; context = previous.context; } catch {}
      }
      if (!context || typeof context !== 'object' || Array.isArray(context) || Buffer.byteLength(JSON.stringify(context)) > 1024) throw new Error('Invalid sign-in context');
      const { oidc, configuration } = await config();
      const state = oidc.randomState(), nonce = oidc.randomNonce(), verifier = oidc.randomPKCECodeVerifier();
      const url = oidc.buildAuthorizationUrl(configuration, { redirect_uri: redirectUri, response_type: 'code', scope: 'openid profile email opid:session', state, nonce, code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256' });
      return { url: url.href, cookie: serialize(seal({ state, nonce, verifier, returnTo: safeReturnTo(returnTo), context, expires: Date.now() + 300000 }), 3600) };
    },
    async callback({ url, cookie, ip = '', userAgent = '' }) {
      const actual = new URL(url);
      if (actual.origin !== callback.origin || actual.pathname !== callback.pathname) throw new Error('Invalid callback location');
      const tx = unseal(cookie);
      const { oidc, configuration } = await config();
      const tokens = await oidc.authorizationCodeGrant(configuration, actual, { pkceCodeVerifier: tx.verifier, expectedState: tx.state, expectedNonce: tx.nonce, idTokenExpected: true });
      const claims = tokens.claims();
      if (!claims?.sub || claims.iss !== issuer || !tokens.access_token) throw new Error('Invalid OneProfileID identity');
      const result = await native.request('/sso/exchange', { body: { accessToken: tokens.access_token, subject: claims.sub, clientId }, ip, userAgent });
      if (result.ok && result.payload?.user?.id !== claims.sub) throw new Error('OneProfileID identity mismatch');
      return { result, returnTo: safeReturnTo(tx.returnTo), context: tx.context, clearCookie };
    },
  };
}
exports.createSsoClient = createSsoClient;
exports.safeReturnTo = safeReturnTo;
