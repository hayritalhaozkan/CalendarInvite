const { describe, it, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { buildApp } = require('../src/app');
const { decrypt } = require('../src/encryption');

const TEST_ENCRYPTION_KEY = 'a'.repeat(64);
const TEST_SESSION_SECRET = 'test-secret-that-is-at-least-32-characters-long';
const TEST_MS_CONFIG = {
  microsoftClientId: 'test-client-id',
  microsoftClientSecret: 'test-client-secret',
  microsoftRedirectUri: 'http://localhost:3000/admin/calendars/callback/microsoft',
  microsoftTenantId: 'test-tenant-id',
};

async function loginAsAdmin(app) {
  const loginPage = await app.inject({ method: 'GET', url: '/admin/login' });
  const csrfToken = loginPage.body.match(/name="_csrf" value="([^"]+)"/)[1];
  const cookies = loginPage.headers['set-cookie'];

  const loginResponse = await app.inject({
    method: 'POST',
    url: '/admin/login',
    headers: { cookie: Array.isArray(cookies) ? cookies.join('; ') : cookies },
    payload: { username: 'admin', password: 'correct-password', _csrf: csrfToken },
  });

  return loginResponse.headers['set-cookie'];
}

describe('Microsoft OAuth2 Calendar Connection', () => {
  let app;
  let sessionCookies;

  before(async () => {
    app = buildApp({
      dbPath: ':memory:',
      sessionSecret: TEST_SESSION_SECRET,
      encryptionKey: TEST_ENCRYPTION_KEY,
      ...TEST_MS_CONFIG,
    });
    await app.ready();

    const hash = await bcrypt.hash('correct-password', 10);
    app.db.prepare('INSERT INTO admin (username, password_hash, timezone) VALUES (?, ?, ?)').run('admin', hash, 'UTC');

    sessionCookies = await loginAsAdmin(app);
  });

  after(async () => {
    await app.close();
  });

  describe('GET /admin/calendars', () => {
    it('shows a Connect Office 365 Calendar button', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/admin/calendars',
        headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
      });
      assert.equal(response.statusCode, 200);
      assert.ok(response.body.includes('Connect Office 365 Calendar'));
    });
  });

  describe('GET /admin/calendars/connect/microsoft', () => {
    it('redirects to Microsoft OAuth2 consent with Calendars.ReadWrite scope', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/admin/calendars/connect/microsoft',
        headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
      });
      assert.equal(response.statusCode, 302);
      const location = response.headers.location;
      assert.ok(location.startsWith('https://login.microsoftonline.com/test-tenant-id/oauth2/v2.0/authorize'));
      const url = new URL(location);
      assert.equal(url.searchParams.get('client_id'), 'test-client-id');
      assert.equal(url.searchParams.get('response_type'), 'code');
      assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:3000/admin/calendars/callback/microsoft');
      assert.ok(url.searchParams.get('scope').includes('Calendars.ReadWrite'));
    });
  });

  describe('GET /admin/calendars (with connection)', () => {
    it('shows connected Microsoft account email and status', async () => {
      const { encrypt: enc } = require('../src/encryption');
      app.db.prepare(`
        INSERT INTO calendar_connections (provider, encrypted_access_token, encrypted_refresh_token, token_expiry, email, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('microsoft', enc('tok', TEST_ENCRYPTION_KEY), enc('ref', TEST_ENCRYPTION_KEY), '2099-01-01T00:00:00Z', 'connected@outlook.com', 'connected');

      const response = await app.inject({
        method: 'GET',
        url: '/admin/calendars',
        headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
      });
      assert.equal(response.statusCode, 200);
      assert.ok(response.body.includes('connected@outlook.com'));
      assert.ok(response.body.includes('microsoft'));
      assert.ok(response.body.includes('connected'));
      assert.ok(response.body.includes('Disconnect'));

      app.db.prepare('DELETE FROM calendar_connections WHERE email = ?').run('connected@outlook.com');
    });
  });

  describe('POST /admin/calendars/:id/disconnect', () => {
    it('removes the calendar connection and redirects to calendars page', async () => {
      const { encrypt: enc } = require('../src/encryption');
      const result = app.db.prepare(`
        INSERT INTO calendar_connections (provider, encrypted_access_token, encrypted_refresh_token, token_expiry, email, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('microsoft', enc('tok', TEST_ENCRYPTION_KEY), enc('ref', TEST_ENCRYPTION_KEY), '2099-01-01T00:00:00Z', 'disconnect@outlook.com', 'connected');

      const calPage = await app.inject({
        method: 'GET',
        url: '/admin/calendars',
        headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
      });
      const csrfToken = calPage.body.match(/name="_csrf" value="([^"]+)"/)[1];
      const pageCookies = calPage.headers['set-cookie'] || sessionCookies;

      const response = await app.inject({
        method: 'POST',
        url: `/admin/calendars/${result.lastInsertRowid}/disconnect`,
        headers: { cookie: Array.isArray(pageCookies) ? pageCookies.join('; ') : pageCookies },
        payload: { _csrf: csrfToken },
      });

      assert.equal(response.statusCode, 302);
      assert.equal(response.headers.location, '/admin/calendars');

      const connection = app.db.prepare('SELECT * FROM calendar_connections WHERE id = ?').get(result.lastInsertRowid);
      assert.equal(connection, undefined);
    });
  });

  describe('GET /admin/calendars/callback/microsoft', () => {
    it('exchanges code for tokens, encrypts them, and stores in calendar_connections', async () => {
      const mockFetch = mock.fn(async (url, options) => {
        if (url.includes('/oauth2/v2.0/token')) {
          return {
            ok: true,
            json: async () => ({
              access_token: 'ms-access-token-123',
              refresh_token: 'ms-refresh-token-456',
              expires_in: 3600,
            }),
          };
        }
        if (url.includes('/me')) {
          return {
            ok: true,
            json: async () => ({ mail: 'user@outlook.com' }),
          };
        }
      });

      app.fetchFn = mockFetch;

      const response = await app.inject({
        method: 'GET',
        url: '/admin/calendars/callback/microsoft?code=auth-code-xyz',
        headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
      });

      assert.equal(response.statusCode, 302);
      assert.equal(response.headers.location, '/admin/calendars');

      const connection = app.db.prepare('SELECT * FROM calendar_connections WHERE provider = ?').get('microsoft');
      assert.ok(connection);
      assert.equal(connection.email, 'user@outlook.com');
      assert.equal(connection.status, 'connected');
      assert.equal(decrypt(connection.encrypted_access_token, TEST_ENCRYPTION_KEY), 'ms-access-token-123');
      assert.equal(decrypt(connection.encrypted_refresh_token, TEST_ENCRYPTION_KEY), 'ms-refresh-token-456');
      assert.ok(connection.token_expiry);

      // Clean up for other tests
      app.db.prepare('DELETE FROM calendar_connections WHERE id = ?').run(connection.id);
    });
  });
});
