const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const { encrypt } = require('../src/encryption');
const { createDatabase } = require('../src/db');

const TEST_ENCRYPTION_KEY = 'a'.repeat(64);

describe('Microsoft Graph Utilities', () => {
  let db;
  let connectionId;

  before(() => {
    db = createDatabase(':memory:');
    const result = db.prepare(`
      INSERT INTO calendar_connections (provider, encrypted_access_token, encrypted_refresh_token, token_expiry, email, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'microsoft',
      encrypt('valid-access-token', TEST_ENCRYPTION_KEY),
      encrypt('valid-refresh-token', TEST_ENCRYPTION_KEY),
      new Date(Date.now() + 3600000).toISOString(),
      'user@outlook.com',
      'connected'
    );
    connectionId = result.lastInsertRowid;
  });

  after(() => {
    db.close();
  });

  describe('token refresh', () => {
    it('refreshes expired token before making API calls', async () => {
      const { createMicrosoftClient } = require('../src/microsoft');

      db.prepare('UPDATE calendar_connections SET token_expiry = ? WHERE id = ?')
        .run(new Date(Date.now() - 60000).toISOString(), connectionId);

      const mockFetch = mock.fn(async (url, options) => {
        if (url.includes('/oauth2/v2.0/token')) {
          return {
            ok: true,
            json: async () => ({
              access_token: 'new-access-token',
              refresh_token: 'new-refresh-token',
              expires_in: 3600,
            }),
          };
        }
        if (url.includes('/me/calendar/getSchedule')) {
          return {
            ok: true,
            json: async () => ({ value: [{ scheduleItems: [] }] }),
          };
        }
      });

      const client = createMicrosoftClient({
        db,
        encryptionKey: TEST_ENCRYPTION_KEY,
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        tenantId: 'test-tenant-id',
        fetchFn: mockFetch,
      });

      await client.getMicrosoftBusySlots(connectionId, '2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z');

      // Verify token was refreshed
      const tokenCall = mockFetch.mock.calls.find(c => c.arguments[0].includes('/oauth2/v2.0/token'));
      assert.ok(tokenCall, 'Should have called token endpoint for refresh');

      const { decrypt } = require('../src/encryption');
      const conn = db.prepare('SELECT * FROM calendar_connections WHERE id = ?').get(connectionId);
      assert.equal(decrypt(conn.encrypted_access_token, TEST_ENCRYPTION_KEY), 'new-access-token');
      assert.equal(decrypt(conn.encrypted_refresh_token, TEST_ENCRYPTION_KEY), 'new-refresh-token');

      // Restore for next tests
      db.prepare('UPDATE calendar_connections SET token_expiry = ?, encrypted_access_token = ?, encrypted_refresh_token = ? WHERE id = ?')
        .run(new Date(Date.now() + 3600000).toISOString(), encrypt('valid-access-token', TEST_ENCRYPTION_KEY), encrypt('valid-refresh-token', TEST_ENCRYPTION_KEY), connectionId);
    });
  });

  describe('getMicrosoftBusySlots', () => {
    it('returns busy time ranges from Graph API getSchedule', async () => {
      const { createMicrosoftClient } = require('../src/microsoft');

      const mockFetch = mock.fn(async (url, options) => {
        if (url.includes('/me/calendar/getSchedule')) {
          return {
            ok: true,
            json: async () => ({
              value: [{
                scheduleItems: [
                  { status: 'busy', start: { dateTime: '2024-01-15T09:00:00', timeZone: 'UTC' }, end: { dateTime: '2024-01-15T10:00:00', timeZone: 'UTC' } },
                  { status: 'tentative', start: { dateTime: '2024-01-15T14:00:00', timeZone: 'UTC' }, end: { dateTime: '2024-01-15T15:00:00', timeZone: 'UTC' } },
                ],
              }],
            }),
          };
        }
      });

      const client = createMicrosoftClient({
        db,
        encryptionKey: TEST_ENCRYPTION_KEY,
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        tenantId: 'test-tenant-id',
        fetchFn: mockFetch,
      });

      const slots = await client.getMicrosoftBusySlots(connectionId, '2024-01-15T00:00:00Z', '2024-01-16T00:00:00Z');

      assert.equal(slots.length, 2);
      assert.deepEqual(slots[0], { start: '2024-01-15T09:00:00', end: '2024-01-15T10:00:00' });
      assert.deepEqual(slots[1], { start: '2024-01-15T14:00:00', end: '2024-01-15T15:00:00' });
    });
  });

  describe('createMicrosoftEvent', () => {
    it('creates an event with attendees, meeting link, start/end time, and title', async () => {
      const { createMicrosoftClient } = require('../src/microsoft');

      const mockFetch = mock.fn(async (url, options) => {
        if (url.includes('/me/events')) {
          const body = JSON.parse(options.body);
          return {
            ok: true,
            json: async () => ({ id: 'event-id-123', ...body }),
          };
        }
      });

      const client = createMicrosoftClient({
        db,
        encryptionKey: TEST_ENCRYPTION_KEY,
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        tenantId: 'test-tenant-id',
        fetchFn: mockFetch,
      });

      const eventData = {
        title: 'Team Meeting',
        startTime: '2024-01-15T10:00:00Z',
        endTime: '2024-01-15T11:00:00Z',
        attendees: ['alice@example.com', 'bob@example.com'],
        meetingLink: 'https://teams.microsoft.com/meet/123',
      };

      const eventId = await client.createMicrosoftEvent(connectionId, eventData);

      assert.equal(eventId, 'event-id-123');

      const call = mockFetch.mock.calls.find(c => c.arguments[0].includes('/me/events'));
      const requestBody = JSON.parse(call.arguments[1].body);
      assert.equal(requestBody.subject, 'Team Meeting');
      assert.deepEqual(requestBody.start, { dateTime: '2024-01-15T10:00:00Z', timeZone: 'UTC' });
      assert.deepEqual(requestBody.end, { dateTime: '2024-01-15T11:00:00Z', timeZone: 'UTC' });
      assert.equal(requestBody.attendees.length, 2);
      assert.equal(requestBody.attendees[0].emailAddress.address, 'alice@example.com');
      assert.ok(requestBody.body.content.includes('https://teams.microsoft.com/meet/123'));
    });
  });
});
