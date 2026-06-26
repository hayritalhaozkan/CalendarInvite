const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { buildApp } = require('../src/app');

async function loginAndGetSession(app) {
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

async function getCsrfFromPage(app, url, sessionCookies) {
  const page = await app.inject({
    method: 'GET',
    url,
    headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
  });
  const csrf = page.body.match(/name="_csrf" value="([^"]+)"/)[1];
  const updatedCookies = page.headers['set-cookie'] || sessionCookies;
  return { csrf, cookies: updatedCookies, body: page.body, statusCode: page.statusCode };
}

describe('Admin Settings', () => {
  let app;

  before(async () => {
    app = buildApp({ dbPath: ':memory:', sessionSecret: 'test-secret-that-is-at-least-32-characters-long', encryptionKey: 'a'.repeat(64) });
    await app.ready();

    const hash = await bcrypt.hash('correct-password', 10);
    app.db.prepare('INSERT INTO admin (username, password_hash, timezone) VALUES (?, ?, ?)').run('admin', hash, 'UTC');
  });

  after(async () => {
    await app.close();
  });

  describe('GET /admin/settings', () => {
    it('requires authentication', async () => {
      const response = await app.inject({ method: 'GET', url: '/admin/settings' });
      assert.equal(response.statusCode, 302);
      assert.equal(response.headers.location, '/admin/login');
    });

    it('renders settings form with timezone dropdown and password fields', async () => {
      const sessionCookies = await loginAndGetSession(app);
      const response = await app.inject({
        method: 'GET',
        url: '/admin/settings',
        headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
      });
      assert.equal(response.statusCode, 200);
      assert.ok(response.body.includes('name="timezone"'));
      assert.ok(response.body.includes('America/New_York'));
      assert.ok(response.body.includes('name="current_password"'));
      assert.ok(response.body.includes('name="new_password"'));
      assert.ok(response.body.includes('name="confirm_password"'));
    });

    it('shows current timezone as selected', async () => {
      const sessionCookies = await loginAndGetSession(app);
      const response = await app.inject({
        method: 'GET',
        url: '/admin/settings',
        headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
      });
      assert.ok(response.body.includes('value="UTC" selected'));
    });
  });

  describe('POST /admin/settings/timezone', () => {
    it('updates timezone in the database', async () => {
      const sessionCookies = await loginAndGetSession(app);
      const { csrf, cookies } = await getCsrfFromPage(app, '/admin/settings', sessionCookies);

      const response = await app.inject({
        method: 'POST',
        url: '/admin/settings/timezone',
        headers: { cookie: Array.isArray(cookies) ? cookies.join('; ') : cookies },
        payload: { timezone: 'America/New_York', _csrf: csrf },
      });
      assert.equal(response.statusCode, 302);
      assert.equal(response.headers.location, '/admin/settings');

      const admin = app.db.prepare('SELECT timezone FROM admin WHERE username = ?').get('admin');
      assert.equal(admin.timezone, 'America/New_York');
    });

    it('rejects invalid timezone', async () => {
      const sessionCookies = await loginAndGetSession(app);
      const { csrf, cookies } = await getCsrfFromPage(app, '/admin/settings', sessionCookies);

      const response = await app.inject({
        method: 'POST',
        url: '/admin/settings/timezone',
        headers: { cookie: Array.isArray(cookies) ? cookies.join('; ') : cookies },
        payload: { timezone: 'Invalid/Timezone', _csrf: csrf },
      });
      assert.equal(response.statusCode, 302);
      assert.equal(response.headers.location, '/admin/settings');
    });

    it('requires CSRF token', async () => {
      const sessionCookies = await loginAndGetSession(app);
      const response = await app.inject({
        method: 'POST',
        url: '/admin/settings/timezone',
        headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
        payload: { timezone: 'America/New_York' },
      });
      assert.equal(response.statusCode, 403);
    });
  });

  describe('POST /admin/settings/password', () => {
    it('changes password with correct current password', async () => {
      const sessionCookies = await loginAndGetSession(app);
      const { csrf, cookies } = await getCsrfFromPage(app, '/admin/settings', sessionCookies);

      const response = await app.inject({
        method: 'POST',
        url: '/admin/settings/password',
        headers: { cookie: Array.isArray(cookies) ? cookies.join('; ') : cookies },
        payload: {
          current_password: 'correct-password',
          new_password: 'new-secure-password',
          confirm_password: 'new-secure-password',
          _csrf: csrf,
        },
      });
      assert.equal(response.statusCode, 302);
      assert.equal(response.headers.location, '/admin/settings');

      const admin = app.db.prepare('SELECT password_hash FROM admin WHERE username = ?').get('admin');
      const matches = await bcrypt.compare('new-secure-password', admin.password_hash);
      assert.ok(matches);

      // Reset password for other tests
      const resetHash = await bcrypt.hash('correct-password', 10);
      app.db.prepare('UPDATE admin SET password_hash = ? WHERE username = ?').run(resetHash, 'admin');
    });

    it('rejects when current password is wrong', async () => {
      const sessionCookies = await loginAndGetSession(app);
      const { csrf, cookies } = await getCsrfFromPage(app, '/admin/settings', sessionCookies);

      const response = await app.inject({
        method: 'POST',
        url: '/admin/settings/password',
        headers: { cookie: Array.isArray(cookies) ? cookies.join('; ') : cookies },
        payload: {
          current_password: 'wrong-password',
          new_password: 'new-secure-password',
          confirm_password: 'new-secure-password',
          _csrf: csrf,
        },
      });
      assert.equal(response.statusCode, 302);
      assert.equal(response.headers.location, '/admin/settings');

      // Password should NOT have changed
      const admin = app.db.prepare('SELECT password_hash FROM admin WHERE username = ?').get('admin');
      const matches = await bcrypt.compare('correct-password', admin.password_hash);
      assert.ok(matches);
    });

    it('rejects when new password and confirmation do not match', async () => {
      const sessionCookies = await loginAndGetSession(app);
      const { csrf, cookies } = await getCsrfFromPage(app, '/admin/settings', sessionCookies);

      const response = await app.inject({
        method: 'POST',
        url: '/admin/settings/password',
        headers: { cookie: Array.isArray(cookies) ? cookies.join('; ') : cookies },
        payload: {
          current_password: 'correct-password',
          new_password: 'new-password',
          confirm_password: 'different-password',
          _csrf: csrf,
        },
      });
      assert.equal(response.statusCode, 302);
      assert.equal(response.headers.location, '/admin/settings');

      // Password should NOT have changed
      const admin = app.db.prepare('SELECT password_hash FROM admin WHERE username = ?').get('admin');
      const matches = await bcrypt.compare('correct-password', admin.password_hash);
      assert.ok(matches);
    });

    it('requires CSRF token', async () => {
      const sessionCookies = await loginAndGetSession(app);
      const response = await app.inject({
        method: 'POST',
        url: '/admin/settings/password',
        headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
        payload: {
          current_password: 'correct-password',
          new_password: 'new-password',
          confirm_password: 'new-password',
        },
      });
      assert.equal(response.statusCode, 403);
    });
  });
});
