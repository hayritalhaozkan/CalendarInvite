const { describe, it, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { buildApp } = require('../src/app');
const { encrypt, decrypt } = require('../src/encryption');

const TEST_ENCRYPTION_KEY = 'a'.repeat(64);

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

describe('Google OAuth2 Calendar Connection', () => {
  let app;
  let sessionCookies;

  before(async () => {
    app = buildApp({
      dbPath: ':memory:',
      sessionSecret: 'test-secret-that-is-at-least-32-characters-long',
      encryptionKey: TEST_ENCRYPTION_KEY,
      googleClientId: 'test-client-id',
      googleClientSecret: 'test-client-secret',
      googleRedirectUri: 'http://localhost:3000/admin/calendars/callback/google',
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
    it('shows Calendar Connections page with Connect Google Calendar button', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/admin/calendars',
        headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
      });
      assert.equal(response.statusCode, 200);
      assert.ok(response.body.includes('Calendar Connections'));
      assert.ok(response.body.includes('Connect Google Calendar'));
    });

    it('redirects to login when not authenticated', async () => {
      const response = await app.inject({ method: 'GET', url: '/admin/calendars' });
      assert.equal(response.statusCode, 302);
      assert.equal(response.headers.location, '/admin/login');
    });

    it('shows connected Google account email and status', async () => {
      const accessToken = encrypt('fake-access-token', TEST_ENCRYPTION_KEY);
      const refreshToken = encrypt('fake-refresh-token', TEST_ENCRYPTION_KEY);
      app.db.prepare(
        'INSERT INTO calendar_connections (provider, encrypted_access_token, encrypted_refresh_token, token_expiry, email, status) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('google', accessToken, refreshToken, '2099-01-01T00:00:00Z', 'user@gmail.com', 'connected');

      const response = await app.inject({
        method: 'GET',
        url: '/admin/calendars',
        headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
      });
      assert.equal(response.statusCode, 200);
      assert.ok(response.body.includes('user@gmail.com'));
      assert.ok(response.body.includes('connected'));
    });
  });

  describe('GET /admin/calendars/connect/google', () => {
    it('redirects to Google OAuth2 consent URL with correct scopes', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/admin/calendars/connect/google',
        headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
      });
      assert.equal(response.statusCode, 302);
      const location = response.headers.location;
      assert.ok(location.startsWith('https://accounts.google.com/o/oauth2/v2/auth'));
      assert.ok(location.includes('scope='));
      assert.ok(location.includes('calendar.readonly'));
      assert.ok(location.includes('calendar.events'));
      assert.ok(location.includes('client_id=test-client-id'));
      assert.ok(location.includes('redirect_uri='));
      assert.ok(location.includes('response_type=code'));
      assert.ok(location.includes('access_type=offline'));
    });

    it('redirects to login when not authenticated', async () => {
      const response = await app.inject({ method: 'GET', url: '/admin/calendars/connect/google' });
      assert.equal(response.statusCode, 302);
      assert.equal(response.headers.location, '/admin/login');
    });
  });

  describe('GET /admin/calendars/callback/google', () => {
    it('exchanges code for tokens, encrypts and stores them', async () => {
      // Mock the Google token exchange and userinfo
      const originalFetch = global.fetch;
      global.fetch = mock.fn(async (url, opts) => {
        if (url === 'https://oauth2.googleapis.com/token') {
          return {
            ok: true,
            json: async () => ({
              access_token: 'new-access-token',
              refresh_token: 'new-refresh-token',
              expires_in: 3600,
              token_type: 'Bearer',
            }),
          };
        }
        if (url === 'https://www.googleapis.com/oauth2/v2/userinfo') {
          return {
            ok: true,
            json: async () => ({ email: 'oauth-user@gmail.com' }),
          };
        }
        return { ok: false, status: 404 };
      });

      try {
        const response = await app.inject({
          method: 'GET',
          url: '/admin/calendars/callback/google?code=test-auth-code&state=google',
          headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
        });

        assert.equal(response.statusCode, 302);
        assert.equal(response.headers.location, '/admin/calendars');

        // Verify tokens are stored encrypted
        const conn = app.db.prepare("SELECT * FROM calendar_connections WHERE email = 'oauth-user@gmail.com'").get();
        assert.ok(conn);
        assert.equal(conn.provider, 'google');
        assert.equal(conn.status, 'connected');
        assert.equal(decrypt(conn.encrypted_access_token, TEST_ENCRYPTION_KEY), 'new-access-token');
        assert.equal(decrypt(conn.encrypted_refresh_token, TEST_ENCRYPTION_KEY), 'new-refresh-token');
        assert.ok(conn.token_expiry);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('redirects to calendars page with error on failed token exchange', async () => {
      const originalFetch = global.fetch;
      global.fetch = mock.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: 'invalid_grant' }),
      }));

      try {
        const response = await app.inject({
          method: 'GET',
          url: '/admin/calendars/callback/google?code=bad-code&state=google',
          headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
        });
        assert.equal(response.statusCode, 302);
        assert.ok(response.headers.location.includes('/admin/calendars'));
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('POST /admin/calendars/:id/disconnect', () => {
    it('deletes the calendar connection', async () => {
      const accessToken = encrypt('to-delete-access', TEST_ENCRYPTION_KEY);
      const refreshToken = encrypt('to-delete-refresh', TEST_ENCRYPTION_KEY);
      const result = app.db.prepare(
        'INSERT INTO calendar_connections (provider, encrypted_access_token, encrypted_refresh_token, token_expiry, email, status) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('google', accessToken, refreshToken, '2099-01-01T00:00:00Z', 'delete-me@gmail.com', 'connected');

      const connId = result.lastInsertRowid;

      // Get CSRF token
      const page = await app.inject({
        method: 'GET',
        url: '/admin/calendars',
        headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
      });
      const csrfToken = page.body.match(/name="_csrf" value="([^"]+)"/)[1];
      const pageCookies = page.headers['set-cookie'] || sessionCookies;

      const response = await app.inject({
        method: 'POST',
        url: `/admin/calendars/${connId}/disconnect`,
        headers: { cookie: Array.isArray(pageCookies) ? pageCookies.join('; ') : pageCookies },
        payload: { _csrf: csrfToken },
      });

      assert.equal(response.statusCode, 302);
      assert.equal(response.headers.location, '/admin/calendars');

      const conn = app.db.prepare('SELECT * FROM calendar_connections WHERE id = ?').get(connId);
      assert.equal(conn, undefined);
    });
  });
});

describe('Google Calendar API utilities', () => {
  let app;

  before(async () => {
    app = buildApp({
      dbPath: ':memory:',
      sessionSecret: 'test-secret-that-is-at-least-32-characters-long',
      encryptionKey: TEST_ENCRYPTION_KEY,
      googleClientId: 'test-client-id',
      googleClientSecret: 'test-client-secret',
      googleRedirectUri: 'http://localhost:3000/admin/calendars/callback/google',
    });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  describe('token refresh', () => {
    it('refreshes expired token before making API calls', async () => {
      const accessToken = encrypt('expired-access-token', TEST_ENCRYPTION_KEY);
      const refreshToken = encrypt('valid-refresh-token', TEST_ENCRYPTION_KEY);
      const expiredTime = new Date(Date.now() - 3600000).toISOString();

      const result = app.db.prepare(
        'INSERT INTO calendar_connections (provider, encrypted_access_token, encrypted_refresh_token, token_expiry, email, status) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('google', accessToken, refreshToken, expiredTime, 'refresh-test@gmail.com', 'connected');
      const connId = result.lastInsertRowid;

      const originalFetch = global.fetch;
      const fetchCalls = [];
      global.fetch = mock.fn(async (url, opts) => {
        fetchCalls.push({ url, opts });
        if (url === 'https://oauth2.googleapis.com/token') {
          return {
            ok: true,
            json: async () => ({
              access_token: 'refreshed-access-token',
              expires_in: 3600,
              token_type: 'Bearer',
            }),
          };
        }
        if (url === 'https://www.googleapis.com/calendar/v3/freeBusy') {
          return {
            ok: true,
            json: async () => ({
              calendars: {
                primary: {
                  busy: [{ start: '2024-01-01T09:00:00Z', end: '2024-01-01T10:00:00Z' }],
                },
              },
            }),
          };
        }
        return { ok: false, status: 404 };
      });

      try {
        const { getGoogleBusySlots } = require('../src/google');
        const result = await getGoogleBusySlots(app.db, TEST_ENCRYPTION_KEY, connId, '2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z', 'test-client-id', 'test-client-secret');

        // Verify refresh was called
        const refreshCall = fetchCalls.find(c => c.url === 'https://oauth2.googleapis.com/token');
        assert.ok(refreshCall, 'Token refresh should have been called');

        // Verify the stored token was updated
        const conn = app.db.prepare('SELECT * FROM calendar_connections WHERE id = ?').get(connId);
        assert.equal(decrypt(conn.encrypted_access_token, TEST_ENCRYPTION_KEY), 'refreshed-access-token');

        // Verify busy slots returned correctly
        assert.deepEqual(result, [{ start: '2024-01-01T09:00:00Z', end: '2024-01-01T10:00:00Z' }]);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('getGoogleBusySlots', () => {
    it('returns busy time ranges from Google FreeBusy API', async () => {
      const accessToken = encrypt('valid-access-token', TEST_ENCRYPTION_KEY);
      const refreshToken = encrypt('valid-refresh-token', TEST_ENCRYPTION_KEY);
      const futureExpiry = new Date(Date.now() + 3600000).toISOString();

      const result = app.db.prepare(
        'INSERT INTO calendar_connections (provider, encrypted_access_token, encrypted_refresh_token, token_expiry, email, status) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('google', accessToken, refreshToken, futureExpiry, 'busy-test@gmail.com', 'connected');
      const connId = result.lastInsertRowid;

      const originalFetch = global.fetch;
      global.fetch = mock.fn(async (url, opts) => {
        if (url === 'https://www.googleapis.com/calendar/v3/freeBusy') {
          const body = JSON.parse(opts.body);
          assert.equal(body.timeMin, '2024-06-01T00:00:00Z');
          assert.equal(body.timeMax, '2024-06-02T00:00:00Z');
          return {
            ok: true,
            json: async () => ({
              calendars: {
                primary: {
                  busy: [
                    { start: '2024-06-01T09:00:00Z', end: '2024-06-01T10:00:00Z' },
                    { start: '2024-06-01T14:00:00Z', end: '2024-06-01T15:30:00Z' },
                  ],
                },
              },
            }),
          };
        }
        return { ok: false, status: 404 };
      });

      try {
        const { getGoogleBusySlots } = require('../src/google');
        const slots = await getGoogleBusySlots(app.db, TEST_ENCRYPTION_KEY, connId, '2024-06-01T00:00:00Z', '2024-06-02T00:00:00Z', 'test-client-id', 'test-client-secret');

        assert.deepEqual(slots, [
          { start: '2024-06-01T09:00:00Z', end: '2024-06-01T10:00:00Z' },
          { start: '2024-06-01T14:00:00Z', end: '2024-06-01T15:30:00Z' },
        ]);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('createGoogleEvent', () => {
    it('creates an event and returns the event ID', async () => {
      const accessToken = encrypt('valid-access-token', TEST_ENCRYPTION_KEY);
      const refreshToken = encrypt('valid-refresh-token', TEST_ENCRYPTION_KEY);
      const futureExpiry = new Date(Date.now() + 3600000).toISOString();

      const result = app.db.prepare(
        'INSERT INTO calendar_connections (provider, encrypted_access_token, encrypted_refresh_token, token_expiry, email, status) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('google', accessToken, refreshToken, futureExpiry, 'event-test@gmail.com', 'connected');
      const connId = result.lastInsertRowid;

      const originalFetch = global.fetch;
      global.fetch = mock.fn(async (url, opts) => {
        if (url === 'https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all') {
          const body = JSON.parse(opts.body);
          assert.equal(body.summary, 'Meeting with Alice');
          assert.equal(body.start.dateTime, '2024-06-15T10:00:00Z');
          assert.equal(body.end.dateTime, '2024-06-15T10:30:00Z');
          assert.ok(body.attendees.length >= 1);
          assert.ok(body.description.includes('https://meet.google.com/abc-def'));
          return {
            ok: true,
            json: async () => ({ id: 'created-event-id-123' }),
          };
        }
        return { ok: false, status: 404 };
      });

      try {
        const { createGoogleEvent } = require('../src/google');
        const eventId = await createGoogleEvent(app.db, TEST_ENCRYPTION_KEY, connId, {
          title: 'Meeting with Alice',
          start: '2024-06-15T10:00:00Z',
          end: '2024-06-15T10:30:00Z',
          attendees: ['alice@example.com', 'bob@example.com'],
          meetingLink: 'https://meet.google.com/abc-def',
          description: 'Discuss project updates',
        }, 'test-client-id', 'test-client-secret');

        assert.equal(eventId, 'created-event-id-123');
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('includes attendees, meeting link, start/end time, and title in the event', async () => {
      const accessToken = encrypt('valid-access-token', TEST_ENCRYPTION_KEY);
      const refreshToken = encrypt('valid-refresh-token', TEST_ENCRYPTION_KEY);
      const futureExpiry = new Date(Date.now() + 3600000).toISOString();

      const result = app.db.prepare(
        'INSERT INTO calendar_connections (provider, encrypted_access_token, encrypted_refresh_token, token_expiry, email, status) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('google', accessToken, refreshToken, futureExpiry, 'event-test2@gmail.com', 'connected');
      const connId = result.lastInsertRowid;

      let capturedBody;
      const originalFetch = global.fetch;
      global.fetch = mock.fn(async (url, opts) => {
        if (url === 'https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all') {
          capturedBody = JSON.parse(opts.body);
          return {
            ok: true,
            json: async () => ({ id: 'event-456' }),
          };
        }
        return { ok: false, status: 404 };
      });

      try {
        const { createGoogleEvent } = require('../src/google');
        await createGoogleEvent(app.db, TEST_ENCRYPTION_KEY, connId, {
          title: 'Sprint Review',
          start: '2024-06-20T14:00:00Z',
          end: '2024-06-20T15:00:00Z',
          attendees: ['team@example.com'],
          meetingLink: 'https://teams.microsoft.com/meet/123',
          description: 'Weekly sprint review',
        }, 'test-client-id', 'test-client-secret');

        assert.equal(capturedBody.summary, 'Sprint Review');
        assert.equal(capturedBody.start.dateTime, '2024-06-20T14:00:00Z');
        assert.equal(capturedBody.end.dateTime, '2024-06-20T15:00:00Z');
        assert.deepEqual(capturedBody.attendees, [{ email: 'team@example.com' }]);
        assert.ok(capturedBody.description.includes('https://teams.microsoft.com/meet/123'));
        assert.ok(capturedBody.description.includes('Weekly sprint review'));
      } finally {
        global.fetch = originalFetch;
      }
    });
  });
});
