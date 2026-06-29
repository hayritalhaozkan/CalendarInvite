const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { buildApp } = require('../src/app');

describe('Admin Auth', () => {
  let app;

  before(async () => {
    app = buildApp({ dbPath: ':memory:', sessionSecret: 'test-secret-that-is-at-least-32-characters-long', encryptionKey: 'a'.repeat(64), googleClientId: 'test-id', googleClientSecret: 'test-secret', googleRedirectUri: 'http://localhost:3000/admin/calendars/callback/google' });
    await app.ready();

    const hash = await bcrypt.hash('correct-password', 10);
    app.db.prepare('INSERT INTO admin (username, password_hash, timezone) VALUES (?, ?, ?)').run('admin', hash, 'UTC');
  });

  after(async () => {
    await app.close();
  });

  describe('GET /admin/login', () => {
    it('renders a login form with username and password fields', async () => {
      const response = await app.inject({ method: 'GET', url: '/admin/login' });
      assert.equal(response.statusCode, 200);
      assert.ok(response.body.includes('name="username"'));
      assert.ok(response.body.includes('name="password"'));
      assert.ok(response.body.includes('type="hidden" name="_csrf"'));
    });
  });

  describe('POST /admin/login', () => {
    it('redirects to /admin/dashboard on valid credentials', async () => {
      const loginPage = await app.inject({ method: 'GET', url: '/admin/login' });
      const csrfToken = loginPage.body.match(/name="_csrf" value="([^"]+)"/)[1];
      const cookies = loginPage.headers['set-cookie'];

      const response = await app.inject({
        method: 'POST',
        url: '/admin/login',
        headers: { cookie: Array.isArray(cookies) ? cookies.join('; ') : cookies },
        payload: { username: 'admin', password: 'correct-password', _csrf: csrfToken },
      });
      assert.equal(response.statusCode, 302);
      assert.equal(response.headers.location, '/admin/dashboard');
    });

    it('re-renders login with error on wrong credentials', async () => {
      const loginPage = await app.inject({ method: 'GET', url: '/admin/login' });
      const csrfToken = loginPage.body.match(/name="_csrf" value="([^"]+)"/)[1];
      const cookies = loginPage.headers['set-cookie'];

      const response = await app.inject({
        method: 'POST',
        url: '/admin/login',
        headers: { cookie: Array.isArray(cookies) ? cookies.join('; ') : cookies },
        payload: { username: 'admin', password: 'wrong-password', _csrf: csrfToken },
      });
      assert.equal(response.statusCode, 200);
      assert.ok(response.body.includes('Invalid username or password'));
    });

    it('redirects to login when CSRF token is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/admin/login',
        payload: { username: 'admin', password: 'correct-password' },
      });
      assert.equal(response.statusCode, 302);
      assert.equal(response.headers.location, '/admin/login');
    });
  });

  describe('Protected routes', () => {
    it('redirects to login when accessing /admin/dashboard without session', async () => {
      const response = await app.inject({ method: 'GET', url: '/admin/dashboard' });
      assert.equal(response.statusCode, 302);
      assert.equal(response.headers.location, '/admin/login');
    });

    it('allows access to /admin/dashboard with valid session', async () => {
      const loginPage = await app.inject({ method: 'GET', url: '/admin/login' });
      const csrfToken = loginPage.body.match(/name="_csrf" value="([^"]+)"/)[1];
      const cookies = loginPage.headers['set-cookie'];

      const loginResponse = await app.inject({
        method: 'POST',
        url: '/admin/login',
        headers: { cookie: Array.isArray(cookies) ? cookies.join('; ') : cookies },
        payload: { username: 'admin', password: 'correct-password', _csrf: csrfToken },
      });

      const sessionCookies = loginResponse.headers['set-cookie'];
      const response = await app.inject({
        method: 'GET',
        url: '/admin/dashboard',
        headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
      });
      assert.equal(response.statusCode, 200);
      assert.ok(response.body.includes('Dashboard'));
    });
  });

  describe('POST /admin/logout', () => {
    it('destroys session and redirects to login', async () => {
      const loginPage = await app.inject({ method: 'GET', url: '/admin/login' });
      const csrfToken = loginPage.body.match(/name="_csrf" value="([^"]+)"/)[1];
      const cookies = loginPage.headers['set-cookie'];

      const loginResponse = await app.inject({
        method: 'POST',
        url: '/admin/login',
        headers: { cookie: Array.isArray(cookies) ? cookies.join('; ') : cookies },
        payload: { username: 'admin', password: 'correct-password', _csrf: csrfToken },
      });

      const sessionCookies = loginResponse.headers['set-cookie'];

      // Get a fresh CSRF token from the dashboard page
      const dashboardResponse = await app.inject({
        method: 'GET',
        url: '/admin/dashboard',
        headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
      });
      const logoutCsrf = dashboardResponse.body.match(/name="_csrf" value="([^"]+)"/)[1];
      const dashCookies = dashboardResponse.headers['set-cookie'] || sessionCookies;

      const logoutResponse = await app.inject({
        method: 'POST',
        url: '/admin/logout',
        headers: { cookie: Array.isArray(dashCookies) ? dashCookies.join('; ') : dashCookies },
        payload: { _csrf: logoutCsrf },
      });
      assert.equal(logoutResponse.statusCode, 302);
      assert.equal(logoutResponse.headers.location, '/admin/login');

      // Session should be invalid now - try accessing dashboard with old cookies
      const afterLogout = await app.inject({
        method: 'GET',
        url: '/admin/dashboard',
        headers: { cookie: Array.isArray(dashCookies) ? dashCookies.join('; ') : dashCookies },
      });
      assert.equal(afterLogout.statusCode, 302);
      assert.equal(afterLogout.headers.location, '/admin/login');
    });
  });
});
