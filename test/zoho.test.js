const { describe, it, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { buildApp } = require('../src/app');
const { encrypt, decrypt } = require('../src/encryption');

const ENCRYPTION_KEY = 'a'.repeat(64);

function createTestApp() {
  return buildApp({
    dbPath: ':memory:',
    sessionSecret: 'test-secret-that-is-at-least-32-characters-long',
    encryptionKey: ENCRYPTION_KEY,
    zohoClientId: 'test-client-id',
    zohoClientSecret: 'test-client-secret',
    zohoRedirectUri: 'http://localhost:3000/admin/calendars/zoho/callback',
  });
}

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

describe('Zoho Calendar Connection', () => {
  let app;
  let sessionCookies;

  before(async () => {
    app = createTestApp();
    await app.ready();

    const hash = await bcrypt.hash('correct-password', 10);
    app.db.prepare('INSERT INTO admin (username, password_hash, timezone) VALUES (?, ?, ?)').run('admin', hash, 'UTC');

    sessionCookies = await loginAsAdmin(app);
  });

  after(async () => {
    await app.close();
  });

  describe('GET /admin/calendars', () => {
    it('shows Calendar Connections page with Connect Zoho button', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/admin/calendars',
        headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
      });
      assert.equal(response.statusCode, 200);
      assert.ok(response.body.includes('Connect Zoho Calendar'));
      assert.ok(response.body.includes('Calendar Connections'));
    });

    it('requires authentication', async () => {
      const response = await app.inject({ method: 'GET', url: '/admin/calendars' });
      assert.equal(response.statusCode, 302);
      assert.equal(response.headers.location, '/admin/login');
    });
  });

  describe('GET /admin/calendars/connect/zoho', () => {
    it('redirects to Zoho OAuth2 consent screen with correct scopes', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/admin/calendars/connect/zoho',
        headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
      });
      assert.equal(response.statusCode, 302);
      const location = response.headers.location;
      assert.ok(location.startsWith('https://accounts.zoho.com/oauth/v2/auth'));
      assert.ok(location.includes('client_id=test-client-id'));
      assert.ok(location.includes('redirect_uri='));
      assert.ok(location.includes('scope='));
      assert.ok(location.includes('ZohoCalendar'));
      assert.ok(location.includes('response_type=code'));
      assert.ok(location.includes('access_type=offline'));
    });
  });

  describe('GET /admin/calendars/zoho/callback', () => {
    it('exchanges code for tokens and stores encrypted tokens', async () => {
      const mockFetch = mock.fn(async (url, opts) => {
        if (url.includes('oauth/v2/token')) {
          return {
            ok: true,
            json: async () => ({
              access_token: 'zoho-access-token-123',
              refresh_token: 'zoho-refresh-token-456',
              expires_in: 3600,
            }),
          };
        }
        if (url.includes('calendar/v1/calendars')) {
          return {
            ok: true,
            json: async () => ({
              calendars: [{ uid: 'cal-1', name: 'My Calendar', color: { background: '#000' } }],
            }),
          };
        }
        // User info
        return {
          ok: true,
          json: async () => ({ Email: 'admin@zoho.com' }),
        };
      });

      app.zohoFetch = mockFetch;

      const response = await app.inject({
        method: 'GET',
        url: '/admin/calendars/zoho/callback?code=auth-code-123',
        headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
      });

      assert.equal(response.statusCode, 302);
      assert.equal(response.headers.location, '/admin/calendars');

      const connection = app.db.prepare('SELECT * FROM calendar_connections WHERE provider = ?').get('zoho');
      assert.ok(connection);
      assert.equal(connection.email, 'admin@zoho.com');
      assert.equal(connection.status, 'connected');

      const decryptedAccess = decrypt(connection.encrypted_access_token, ENCRYPTION_KEY);
      assert.equal(decryptedAccess, 'zoho-access-token-123');

      const decryptedRefresh = decrypt(connection.encrypted_refresh_token, ENCRYPTION_KEY);
      assert.equal(decryptedRefresh, 'zoho-refresh-token-456');

      app.zohoFetch = null;
    });

    it('shows connected account on Calendar Connections page', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/admin/calendars',
        headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
      });
      assert.equal(response.statusCode, 200);
      assert.ok(response.body.includes('admin@zoho.com'));
      assert.ok(response.body.includes('connected'));
    });
  });

  describe('DELETE /admin/calendars/:id (disconnect)', () => {
    it('removes a calendar connection', async () => {
      const conn = app.db.prepare('SELECT id FROM calendar_connections WHERE provider = ?').get('zoho');
      assert.ok(conn, 'Expected a zoho connection to exist');

      const calPage = await app.inject({
        method: 'GET',
        url: '/admin/calendars',
        headers: { cookie: Array.isArray(sessionCookies) ? sessionCookies.join('; ') : sessionCookies },
      });
      const csrf = calPage.body.match(/name="_csrf" value="([^"]+)"/)[1];
      const pageCookies = calPage.headers['set-cookie'] || sessionCookies;

      const response = await app.inject({
        method: 'POST',
        url: `/admin/calendars/${conn.id}/disconnect`,
        headers: { cookie: Array.isArray(pageCookies) ? pageCookies.join('; ') : pageCookies },
        payload: { _csrf: csrf },
      });

      assert.equal(response.statusCode, 302);
      assert.equal(response.headers.location, '/admin/calendars');

      const deleted = app.db.prepare('SELECT * FROM calendar_connections WHERE id = ?').get(conn.id);
      assert.equal(deleted, undefined);
    });
  });
});

describe('Zoho Token Refresh', () => {
  let app;

  before(async () => {
    app = createTestApp();
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it('refreshes expired token before making API calls', async () => {
    const { getZohoClient } = require('../src/zoho');

    const expiredTime = new Date(Date.now() - 60000).toISOString();
    app.db.prepare(
      'INSERT INTO calendar_connections (provider, encrypted_access_token, encrypted_refresh_token, token_expiry, email, status) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      'zoho',
      encrypt('expired-access-token', ENCRYPTION_KEY),
      encrypt('valid-refresh-token', ENCRYPTION_KEY),
      expiredTime,
      'test@zoho.com',
      'connected'
    );

    const conn = app.db.prepare('SELECT id FROM calendar_connections WHERE email = ?').get('test@zoho.com');

    const mockFetch = mock.fn(async (url, opts) => {
      if (url.includes('oauth/v2/token')) {
        return {
          ok: true,
          json: async () => ({
            access_token: 'new-access-token',
            expires_in: 3600,
          }),
        };
      }
      return { ok: true, json: async () => ({ calendars: [] }) };
    });

    const client = getZohoClient({
      db: app.db,
      encryptionKey: ENCRYPTION_KEY,
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      fetchFn: mockFetch,
    });

    await client.getAccessToken(conn.id);

    const updated = app.db.prepare('SELECT * FROM calendar_connections WHERE id = ?').get(conn.id);
    const newToken = decrypt(updated.encrypted_access_token, ENCRYPTION_KEY);
    assert.equal(newToken, 'new-access-token');
    assert.ok(new Date(updated.token_expiry) > new Date());
  });
});

describe('Zoho Calendar Utilities', () => {
  let app;
  let connectionId;

  before(async () => {
    app = createTestApp();
    await app.ready();

    const futureExpiry = new Date(Date.now() + 3600000).toISOString();
    app.db.prepare(
      'INSERT INTO calendar_connections (provider, encrypted_access_token, encrypted_refresh_token, token_expiry, email, status) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      'zoho',
      encrypt('valid-access-token', ENCRYPTION_KEY),
      encrypt('valid-refresh-token', ENCRYPTION_KEY),
      futureExpiry,
      'util-test@zoho.com',
      'connected'
    );
    const conn = app.db.prepare('SELECT id FROM calendar_connections WHERE email = ?').get('util-test@zoho.com');
    connectionId = conn.id;
  });

  after(async () => {
    await app.close();
  });

  describe('getZohoBusySlots', () => {
    it('returns busy time ranges from Zoho Calendar', async () => {
      const { getZohoClient } = require('../src/zoho');

      const mockFetch = mock.fn(async (url, opts) => {
        if (url.includes('freebusy')) {
          return {
            ok: true,
            json: async () => ({
              fb_data: [
                {
                  fbtype: 'busy',
                  s_datetime: '20260701T090000+0000',
                  e_datetime: '20260701T100000+0000',
                },
                {
                  fbtype: 'busy',
                  s_datetime: '20260701T140000+0000',
                  e_datetime: '20260701T150000+0000',
                },
              ],
            }),
          };
        }
        return { ok: true, json: async () => ({}) };
      });

      const client = getZohoClient({
        db: app.db,
        encryptionKey: ENCRYPTION_KEY,
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        fetchFn: mockFetch,
      });

      const busySlots = await client.getBusySlots(connectionId, '2026-07-01T00:00:00Z', '2026-07-01T23:59:59Z');

      assert.equal(busySlots.length, 2);
      assert.ok(busySlots[0].start);
      assert.ok(busySlots[0].end);
      assert.ok(busySlots[1].start);
      assert.ok(busySlots[1].end);
    });
  });

  describe('createZohoEvent', () => {
    it('creates an event and returns the event ID', async () => {
      const { getZohoClient } = require('../src/zoho');

      const mockFetch = mock.fn(async (url, opts) => {
        if (url.includes('calendars') && !url.includes('events')) {
          return {
            ok: true,
            json: async () => ({
              calendars: [{ uid: 'primary-cal-uid', name: 'Primary', isprimary: true }],
            }),
          };
        }
        if (url.includes('events') && opts && opts.method === 'POST') {
          return {
            ok: true,
            json: async () => ({
              events: [{ uid: 'event-uid-789' }],
            }),
          };
        }
        return { ok: true, json: async () => ({}) };
      });

      const client = getZohoClient({
        db: app.db,
        encryptionKey: ENCRYPTION_KEY,
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        fetchFn: mockFetch,
      });

      const eventId = await client.createEvent(connectionId, {
        title: 'Meeting with Alice',
        description: 'Join: https://meet.example.com/room',
        start: '2026-07-01T10:00:00Z',
        end: '2026-07-01T10:30:00Z',
        attendees: ['alice@example.com', 'bob@example.com'],
      });

      assert.equal(eventId, 'event-uid-789');

      const fetchCalls = mockFetch.mock.calls;
      const eventCall = fetchCalls.find(c => c.arguments[0].includes('events') && c.arguments[1]?.method === 'POST');
      assert.ok(eventCall);
      const body = JSON.parse(eventCall.arguments[1].body);
      assert.equal(body.eventdata.title, 'Meeting with Alice');
      assert.ok(body.eventdata.attendees.length >= 2);
    });
  });
});
